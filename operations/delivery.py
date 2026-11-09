"""Send a single outbox notice while holding its current team/version stable."""
import smtplib
from email.message import EmailMessage
from email.policy import SMTP

import httpx

from service import gmail_oauth, studio
from service.db import DATA, smtp_enabled
from service.mailing import ADMIN_NOTICE, discard_revoked_oauth, mail_settings, smtp_connection


def issue_location(issue, documents, checks=()):
    kinds = {"application":("01",),"consent":("02",),"identity":("03",),"account":("01","03"),
             "signature":("01","02"),"affiliation":("01","02"),"student_id":("01",),
             "representative":("01","03")}.get(issue, ())
    if issue == "duplicate":
        kinds = [kind for kind in ("01","02","03") if len(documents.get(kind,[])) > 1]
    locations = []
    evidence = [ref for check in checks if check.get("issue")==issue and check.get("passed") is False for ref in check.get("refs",())]
    by_id = {ref["id"]:kind for kind,refs in documents.items() for ref in refs if ref.get("id")}
    for ref in evidence:
        kind = by_id.get(ref.get("id"))
        page,row = ref.get("page"),ref.get("row")
        if kind in ("01","02","03") and type(page) is int and 0 < page <= 999:
            location = f"{kind} {page}쪽"
            if type(row) is int and 0 < row <= 999:
                location += f" {row}행"
            if location not in locations:
                locations.append(location)
    has_locations = bool(locations)
    for kind in kinds:
        if kind not in documents:
            continue
        refs = documents[kind]
        if has_locations and refs:
            continue
        pages = sorted({ref["page"] for ref in refs if type(ref.get("page")) is int and ref["page"] > 0})
        if not refs:
            locations.append(f"접수 목록 {kind} 미제출")
        elif len(refs) > 1:
            locations.append(f"{kind} {len(refs)}부")
        else:
            locations.append(kind + (" " + "·".join(map(str,pages)) + "쪽" if pages else ""))
    return ", ".join(locations)


def message_for(m, cfg):
    msg = EmailMessage(policy=SMTP)
    name = " ".join(m["name"].splitlines())
    msg["Subject"] = f"[시상금 서류 {m['kind']}] {name}"
    msg["From"] = cfg.get("SMTP_FROM") or "review@award.test"
    msg["To"] = m["address"]
    msg["Message-ID"] = f"<{m['id']}@{msg['From'].addresses[0].domain}>"
    if m["kind"] == ADMIN_NOTICE:
        lines = [f"{name} 팀의 {m['version']}차 판정은 {m['verdict']}입니다.", "팀별 서류 검토에서 원본과 확인 항목을 열어 주세요."]
    else:
        lines = [f"{name} 팀장님, 제출 {m['version']}차 서류의 검토 결과입니다.", ""]
        if m["kind"] == "보완 요청":
            output = m["output"] or {}
            issues = m["issues"] if m["decision"] == "보완 필요" else output.get("issues", [])
            for key in dict.fromkeys(issues or ["other"]):
                if key in studio.ISSUES:
                    checks = output.get("checks",[])
                    location = issue_location(key,output.get("documents",{}),checks)
                    fields = dict.fromkeys(studio.FIELD_LABELS[field] for check in checks
                                           if check.get("issue")==key and check.get("passed") is False
                                           for field in check.get("fields",()) if field in studio.FIELD_LABELS)
                    hint = " · ".join(filter(None,(location,", ".join(fields))))
                    lines.append((f"[{hint}] " if hint else "")+studio.ISSUES[key])
            lines.append("보완한 서류는 기존 제출 경로로 담당자에게 보내 주세요.")
        else:
            lines.append("제출한 서류의 검토를 완료했습니다.")
    msg.set_content("\n".join(lines))
    return msg


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
        discard_revoked_oauth(cfg)
        return "waiting"
    except (smtplib.SMTPRecipientsRefused, smtplib.SMTPResponseException, smtplib.SMTPNotSupportedError):
        return "sent" if accepted else "failed"
    except httpx.HTTPStatusError as exc:
        return "uncertain" if sending and (exc.response.status_code == 408 or exc.response.status_code >= 500) else "failed"
    except (OSError, smtplib.SMTPException, httpx.RequestError, ValueError, KeyError):
        return "sent" if accepted else "uncertain" if sending else "failed"
    return "sent"


def deliver(db, raw_cfg):
    cfg = mail_settings(raw_cfg)
    mailbox = DATA / "operations" / "mail"
    # A prior process may have died after SMTP accepted its message.
    for item in db.execute("SELECT id FROM review_mail WHERE state='sending'").fetchall():
        state = "local" if (mailbox / (str(item["id"]) + ".eml")).exists() else "uncertain"
        db.execute("UPDATE review_mail SET state=%s WHERE id=%s AND state='sending'", (state,item["id"]))
    db.execute("""UPDATE review_mail m SET state='obsolete' FROM review_job_status j
        WHERE m.submission_id=j.submission_id AND j.state='superseded' AND m.state IN ('waiting','failed')""")
    if not cfg.get("MAIL_READY"):
        return False
    admin = cfg.get("ADMIN_EMAIL") or ("" if smtp_enabled(cfg) else "admin@award.test")
    query = """SELECT m.id,m.submission_id,m.kind,t.id AS team,t.name,s.version,s.verdict,s.output,s.issues,s.decision,
        CASE WHEN m.kind='담당자 알림' THEN %s ELSE t.email END AS address
        FROM review_mail m JOIN ops_submission s ON s.id=m.submission_id JOIN award_team t ON t.id=s.team_id
        JOIN intake_team_confirmation c ON c.submission_id=s.id AND c.state='confirmed'
        JOIN ops_leader_recipient r ON r.submission_id=s.id
        WHERE s.state='done' AND NOT ops_team_held(t.id)
        AND (m.kind='담당자 알림' OR NOT r.needs_confirmation)
        AND (CASE WHEN m.kind='담당자 알림' THEN %s ELSE t.email END)<>''
        AND (m.kind='담당자 알림' OR (m.kind='보완 요청' AND (s.verdict='재제출요청' OR s.decision='보완 필요'))
          OR (m.kind='검토 완료' AND (s.decision='승인' OR s.verdict='성공'))) """
    with db.transaction():
        m = db.execute(query + "AND m.state='waiting' ORDER BY m.created_at,m.id LIMIT 1 FOR UPDATE OF t,c,m", (admin,admin)).fetchone()
        if not m:
            return False
        msg = message_for(m,cfg)
        db.execute("UPDATE review_mail SET state='sending',sent_to=%s,subject=%s,body=%s WHERE id=%s",
                   (m["address"],str(msg["Subject"]),msg.get_content(),m["id"]))
    with db.transaction():
        # Read the address and its version confirmation in a fresh snapshot after taking the team lock.
        db.execute("SELECT id FROM award_team WHERE id=%s FOR NO KEY UPDATE", (m["team"],))
        valid = db.execute(query + "AND m.id=%s AND m.state='sending' FOR UPDATE OF t,c,m", (admin,admin,m["id"])).fetchone()
        if valid and valid["address"] == m["address"]:
            final = send(msg,cfg,mailbox / (str(m["id"])+".eml"))
        else:
            final = "waiting"
        db.execute("UPDATE review_mail SET state=%s WHERE id=%s", (final,m["id"]))
        db.execute("INSERT INTO workflow_audit(submission_id,actor,action) VALUES(%s,'@workflow',%s)",
                   (m["submission_id"],"메일 "+final))
    return True
