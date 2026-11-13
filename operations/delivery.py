"""Send a single outbox notice while holding its current team/version stable."""
import smtplib
from email.message import EmailMessage
from email.policy import SMTP

import httpx

from service import gmail_oauth
from service.db import DATA, smtp_enabled
from service.mailing import GMAIL_HOST, mail_settings, smtp_connection


def send(msg, cfg, path):
    sending = False
    accepted = False
    try:
        if cfg.get("GMAIL_OAUTH"):
            with httpx.Client(timeout=15) as client:
                token = gmail_oauth.access_token(client, cfg)
                sending = True
                gmail_oauth.send_message(client, token, msg)
                accepted = True
        elif smtp_enabled(cfg):
            with smtp_connection(cfg) as server:
                sending = True
                server.send_message(msg, to_addrs=[str(msg["To"])])
                accepted = True
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.with_suffix(".part").write_bytes(msg.as_bytes())
            path.with_suffix(".part").replace(path)
            return "local"
    except gmail_oauth.ReconnectRequired:
        return "waiting"
    except (smtplib.SMTPRecipientsRefused, smtplib.SMTPResponseException, smtplib.SMTPNotSupportedError):
        return "sent" if accepted else "failed"
    except httpx.HTTPStatusError as exc:
        return "uncertain" if sending and (exc.response.status_code == 408 or exc.response.status_code >= 500) else "failed"
    except (OSError, smtplib.SMTPException, httpx.RequestError, ValueError, KeyError):
        return "sent" if accepted else "uncertain" if sending else "failed"
    return "sent"


def deliver(db, raw_cfg):
    personal_gmail = raw_cfg.get("MAIL_MODE", "").lower() == "gmail"
    cfg = dict(raw_cfg) if personal_gmail else mail_settings(raw_cfg)
    mailbox = DATA / "operations" / "mail"
    # A prior process may have died after SMTP accepted its message.
    for item in db.execute("SELECT id FROM review_mail WHERE state='sending'").fetchall():
        envelope = mailbox / (str(item["id"]) + ".eml")
        try:
            filed_at = envelope.stat().st_mtime
        except FileNotFoundError:
            filed_at = None
        db.execute("UPDATE review_mail SET state=%s,sent_at=to_timestamp(%s) WHERE id=%s AND state='sending'",
                   ("local" if filed_at is not None else "uncertain",filed_at,item["id"]))
    db.execute("""UPDATE review_mail m SET state='obsolete' FROM review_job_status j
        WHERE m.submission_id=j.submission_id AND j.state='superseded' AND m.state IN ('draft','approved','failed')""")
    db.execute("""UPDATE review_mail SET state='obsolete',sent_to=NULL,approved_by=NULL,approved_at=NULL
        WHERE kind='담당자 알림' AND state IN ('draft','approved','failed','uncertain')""")
    if not personal_gmail and not cfg.get("MAIL_READY"):
        return False
    reopen = "state='draft',sent_to=NULL,approved_by=NULL,approved_at=NULL,revision=m.revision+1"
    if personal_gmail:
        # An approval is tied to the sender the staff member reviewed, never a later account.
        db.execute(f"""UPDATE review_mail m SET {reopen} FROM staff_gmail g
            WHERE m.state='approved' AND m.approved_by=g.login AND m.sender_address IS DISTINCT FROM g.address""")
    db.execute(f"""UPDATE review_mail m SET {reopen} FROM ops_submission s JOIN award_team t ON t.id=s.team_id
        JOIN ops_leader_recipient r ON r.submission_id=s.id WHERE m.submission_id=s.id AND m.state='approved'
        AND (m.sent_to IS DISTINCT FROM t.email OR r.needs_confirmation)""")
    query = """SELECT m.id,m.submission_id,m.subject,m.body,m.approved_by,m.sender_address,t.id AS team,
        t.email AS address
        FROM review_mail m JOIN ops_submission s ON s.id=m.submission_id JOIN award_team t ON t.id=s.team_id
        JOIN intake_team_confirmation c ON c.submission_id=s.id AND c.state='confirmed'
        JOIN ops_leader_recipient r ON r.submission_id=s.id
        WHERE s.state='done' AND NOT ops_team_held(t.id)
        AND m.approved_by IS NOT NULL AND m.approved_at IS NOT NULL AND m.subject IS NOT NULL AND m.body IS NOT NULL
        AND NOT r.needs_confirmation
        AND m.sent_to<>'' AND m.sent_to=t.email
        AND ((m.kind='보완 요청' AND (s.verdict IN ('재제출요청','보완필요') OR s.decision='보완 필요'))
          OR (m.kind='검토 완료' AND (s.decision='승인' OR s.verdict='성공'))) """
    with db.transaction():
        ready = """AND EXISTS(SELECT FROM staff_gmail g WHERE g.login=m.approved_by AND g.address=m.sender_address
            AND (g.credential<>'' OR g.oauth<>'')) """ if personal_gmail else ""
        m = db.execute(query + ready + "AND m.state='approved' ORDER BY m.created_at,m.id LIMIT 1 FOR UPDATE OF t,c,m").fetchone()
        if not m:
            return False
        msg = EmailMessage(policy=SMTP)
        msg["From"] = m["sender_address"] if personal_gmail else cfg.get("SMTP_FROM") or "review@award.test"
        msg["To"] = m["address"]
        msg["Subject"] = m["subject"]
        msg["Message-ID"] = f"<{m['id']}@{msg['From'].addresses[0].domain}>"
        msg.set_content(m["body"])
        db.execute("UPDATE review_mail SET state='sending' WHERE id=%s",(m["id"],))
    with db.transaction():
        # Read the address and its version confirmation in a fresh snapshot after taking the team lock.
        db.execute("SELECT id FROM award_team WHERE id=%s FOR NO KEY UPDATE", (m["team"],))
        valid = db.execute(query + "AND m.id=%s AND m.state='sending' FOR UPDATE OF t,c,m", (m["id"],)).fetchone()
        if valid and valid["address"] == m["address"]:
            account = db.execute("SELECT * FROM staff_gmail WHERE login=%s FOR SHARE", (m["approved_by"],)).fetchone() if personal_gmail else None
            changed = personal_gmail and (not account or account["address"] != m["sender_address"])
            waiting = personal_gmail and account and not (account["credential"] or account["oauth"])
            if changed:
                db.execute(f"UPDATE review_mail m SET {reopen} WHERE id=%s", (m["id"],))
                return True
            if account:
                cfg = dict(raw_cfg, MAIL_MODE="smtp", SMTP_HOST=GMAIL_HOST, SMTP_PORT="465", SMTP_USER=account["address"],
                           SMTP_FROM=account["address"], ADMIN_EMAIL=account["address"], GMAIL_CREDENTIAL=account["credential"],
                           GMAIL_OAUTH=account["oauth"])
            final = "waiting" if waiting else send(msg,cfg,mailbox / (str(m["id"])+".eml"))
            if final == "waiting":  # Gmail will resume this approved envelope after reconnection.
                if account and not waiting:
                    db.execute("""UPDATE staff_gmail SET credential='',oauth='',generation=generation+1,updated_at=clock_timestamp()
                        WHERE login=%s AND generation=%s""", (m["approved_by"],account["generation"]))
                final = "approved"
            db.execute("""UPDATE review_mail SET state=%s,sent_at=CASE WHEN %s THEN clock_timestamp() END WHERE id=%s""",
                       (final,final in ("sent","local"),m["id"]))
        else:
            final = "draft"
            db.execute(f"UPDATE review_mail m SET {reopen} WHERE id=%s",(m["id"],))
        db.execute("INSERT INTO workflow_audit(submission_id,actor,action) VALUES(%s,'@workflow',%s)",
                   (m["submission_id"],"메일 "+final))
    return True
