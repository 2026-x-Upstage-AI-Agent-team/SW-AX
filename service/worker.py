import json
import msvcrt
import random
import re
import shutil
import smtplib
import subprocess
import sys
import threading
import time
from email.message import EmailMessage
from email.utils import parsedate_to_datetime
from pathlib import Path
from zipfile import ZipFile

import httpx
from lxml import etree
from pypdf import PdfReader

from reporting.fill_award_form import HP, text_of
from reporting.verify_evidence import verify

from . import gmail_oauth, studio
from .db import DATA, ROOT, database, dump, now, row, rows, settings, smtp_enabled
from .documents import convert, powershell, preview, read_signals, source
from .mailing import discard_revoked_oauth, mail_recipient, mail_settings, smtp_connection
from .workflow import audit, enqueue_mail, files_for, held, identify_batch, require

REPORT_NAME = "시상금_지급내역서"


def status(sid, state, error="", **updates):
    with database(True) as db:
        fields = {"state": state, "error": error, "updated": now(), **updates}
        db.execute("UPDATE submissions SET " + ",".join(k + "=?" for k in fields) + " WHERE id=?", (*fields.values(), sid))
        audit(db, sid, state, {"error": error, **{k: v for k,v in updates.items() if k in ("job","attempts","due")}}, "서비스")


def failure(s, exc, creating=False):
    code = exc.response.status_code if isinstance(exc, httpx.HTTPStatusError) else 0
    if code in (401,402,403):
        status(s["id"], "access", f"Upstage 인증·권한·크레딧을 확인한 뒤 재개하세요. HTTP {code}")
    elif creating and code != 429 and (not code or code >= 500):
        status(s["id"], "uncertain", "생성 응답을 확인하지 못했습니다. Studio 실행 이력에서 기존 Job을 연결하세요.")
    elif code in (408,429) or code >= 500 or not code:
        attempt = s["attempts"] + 1
        if attempt > 3:
            status(s["id"], "paused", "연속 조회 또는 접속 실패입니다. 네트워크와 Studio 이력을 확인한 뒤 재개하세요.")
            return
        delay = 2 ** attempt + random.random()
        if isinstance(exc, httpx.HTTPStatusError):
            after = exc.response.headers.get("Retry-After","")
            try:
                delay = max(delay, float(after) if after.isdigit() else parsedate_to_datetime(after).timestamp() - time.time())
            except (TypeError, ValueError):
                pass
        status(s["id"], "polling" if s["job"] else "queued", "일시적인 통신 오류로 재시도 대기 중입니다.",
               attempts=attempt, due=time.time() + delay)
    else:
        status(s["id"], "paused", f"요청을 처리하지 못했습니다. Studio 설정과 입력을 확인하세요. HTTP {code}")


def run_studio(s):
    cfg = settings()
    with database() as db:
        files = files_for(db, json.loads(s["files"]))
    creating = False
    try:
        with studio.client(cfg) as client:
            if not s["job"]:
                agent = s.get("agent_id") or cfg.get("UPSTAGE_AGENT_ID")
                if not agent:
                    status(s["id"], "access", "서버의 UPSTAGE_AGENT_ID를 설정한 뒤 재개하세요.")
                    return
                config = s.get("config_version") or cfg.get("UPSTAGE_CONFIG_ID", studio.CONFIG)
                response = client.get(f"agents/{agent}/configs/{config}")
                response.raise_for_status()
                config_id = response.json()["id"]
                body = studio.payload(files, config_id, agent)
                with database(True) as db:
                    t = require(db, "teams", s["team"])
                    if t["current"] != s["id"] or held(db, t["id"]):
                        return
                    db.execute("""UPDATE submissions SET state='creating',started=?,updated=?,agent_id=?,
                               config_version=?,config_id=? WHERE id=?""",(now(),now(),agent,config,config_id,s["id"]))
                creating = True
                response = client.post("responses", json=body)
                response.raise_for_status()
                job = response.json().get("id", "")
                if not re.fullmatch(r"job_[\w-]+", job):
                    raise ValueError("Job 식별자 확인 필요")
                status(s["id"], "polling", job=job, attempts=0, due=now()+5)
                return
            response = client.get("responses/" + s["job"], params=[("include[]","all")])
            response.raise_for_status()
            job = response.json()
            if job.get("id") != s["job"]:
                raise ValueError("요청한 Job과 응답 ID가 다릅니다.")
            if job["status"] in ("in_progress","queued"):
                elapsed = now() - (s["started"] or now())
                status(s["id"], "polling", "장기 실행 중입니다. Studio 이력을 확인하세요." if elapsed >= 3600
                       else "처리 지연" if elapsed >= 900 else "", attempts=0,
                       due=now() + (60 if elapsed >= 3600 else 15 if elapsed >= 60 else 5))
                return
            if job["status"] != "completed":
                status(s["id"], "failed", "Studio Job이 실패 종료됐습니다. 원본과 Studio 실행 이력을 확인하세요.")
                return
            result = studio.parse_result(job, files)
            with database(True) as db:
                t = require(db,"teams",s["team"])
                conflict = bool(result["team_name"] and (result["team_name"] != t["name"] or
                                (t["rep"] and result["rep"] and result["rep"] != t["rep"])))
                state = "ownership" if conflict else "done"
                db.execute("UPDATE submissions SET state=?,result=?,error=?,updated=?,attempts=0 WHERE id=?",
                           (state,dump(result),"추출된 팀·대표가 배정과 다릅니다. 원접수를 대조해 배정을 정정하세요." if conflict else "",now(),s["id"]))
                audit(db,s["id"],"Studio 판정",{"verdict":result["verdict"],"job":s["job"]},"서비스")
                if not conflict and t["current"] == s["id"]:
                    if result["verdict"] == "재제출요청":
                        enqueue_mail(db,s["id"],"보완 요청")
                    elif result["verdict"] == "성공" and s["version"] > 1:
                        enqueue_mail(db,s["id"],"검토 완료")
    except httpx.HTTPError as exc:
        failure(s, exc, creating)
    except (ValueError, KeyError, TypeError, AttributeError, OSError):
        status(s["id"], "uncertain" if creating else "invalid",
               "Studio 생성 이력을 확인하세요." if creating else "실행 결과의 노드·원본·파일 구조를 확인한 뒤 재개하세요.")


def prepare(batch):
    with database() as db:
        f = row(db, "SELECT * FROM files WHERE batch=? AND state='waiting' ORDER BY pos LIMIT 1", batch["id"])
    if f:
        try:
            kind, pages, sig = read_signals(f)
            with database(True) as db:
                db.execute("UPDATE files SET kind=?,pages=?,signals=?,state='read' WHERE id=?", (kind,pages,dump(sig),f["id"]))
        except Exception:
            with database(True) as db:
                db.execute("UPDATE files SET state='error',reason=? WHERE id=?",
                           ("원본을 열거나 변환할 수 없습니다. 열린 한글의 보안 설정 및 파일의 손상·암호를 확인하세요.",f["id"]))
    else:
        with database(True) as db:
            identify_batch(db, batch)


def deliver(mail, cfg):
    if not cfg.get("MAIL_READY", True):
        return
    sid = mail["submission"]
    with database(True) as db:
        mail = require(db,"mail",mail["id"])
        if mail["kind"] not in ("보완 요청","검토 완료") or mail["state"] != "approved" or mail["approved_at"] is None or not mail["subject"] or not mail["body"]:
            return
        s = require(db, "submissions", sid)
        t = require(db, "teams", s["team"])
        if t["current"] != sid or held(db,t["id"]) or s["state"] != "done":
            return
        smtp = smtp_enabled(cfg)
        address = mail_recipient(mail["kind"], cfg, t["email"], t["id"])
        if not address or address != mail["sent_to"]:
            db.execute("UPDATE mail SET state='draft',sent_to=NULL,approved_at=NULL,revision=revision+1 WHERE id=?", (mail["id"],))
            return
        message = EmailMessage()
        message["From"] = (cfg.get("SMTP_FROM") or "review@award.test") if smtp else "review@award.test"
        message["To"] = address
        domain = cfg["SMTP_FROM"].split("@")[-1] if "GMAIL_CREDENTIAL" in cfg else "award.test"
        message["Message-ID"] = f"<{mail['id']}@{domain}>"
        message["Subject"] = mail["subject"]
        message.set_content(mail["body"])
        db.execute("UPDATE mail SET state='sending' WHERE id=?", (mail["id"],))
    final = "failed"
    sending = False
    try:
        mailbox = DATA / "mail"
        mailbox.mkdir(exist_ok=True)
        path = mailbox / (mail["id"] + ".eml")
        path.with_suffix(".part").write_bytes(message.as_bytes())
        path.with_suffix(".part").replace(path)
        if cfg.get("GMAIL_OAUTH"):
            with httpx.Client(timeout=15) as client:
                token = gmail_oauth.access_token(client, cfg)
                sending = True
                gmail_oauth.send_message(client, token, message)
                final = "sent"
        elif smtp:
            with smtp_connection(cfg) as server:
                sending = True
                server.send_message(message, to_addrs=[address])
                final = "sent"
        else:
            final = "local"
    except (smtplib.SMTPRecipientsRefused, smtplib.SMTPResponseException, smtplib.SMTPNotSupportedError):
        pass  # A rejected message remains failed. A QUIT error after acceptance leaves it sent.
    except gmail_oauth.ReconnectRequired:
        discard_revoked_oauth(cfg)
        final = "approved"
    except httpx.HTTPStatusError as exc:
        if sending and (exc.response.status_code == 408 or exc.response.status_code >= 500):
            final = "uncertain"
    except (OSError, smtplib.SMTPException, httpx.RequestError, ValueError, KeyError):
        if sending and final != "sent":
            final = "uncertain"
    with database(True) as db:
        db.execute("UPDATE mail SET state=?,sent_at=? WHERE id=?", (final,now() if final in ("sent","local") else None,mail["id"]))
        audit(db,sid,"메일 "+final,{"mail":mail["id"]},"서비스")


def verify_edited_pair(hwpx, pdf, snapshot):
    with ZipFile(hwpx) as archive:
        section = etree.fromstring(archive.read("Contents/section0.xml"))
    expected = {"시상구분": sum(len(t["members"]) for t in snapshot["teams"])+2,
                "차인지급액": len(snapshot["teams"])+2}
    for table in section.iter(HP+"tbl"):
        header = table.find(HP+"tr")
        if header is None:
            continue
        for label in list(expected):
            if label in text_of(header) and int(table.get("rowCnt",0)) == expected[label]:
                del expected[label]
    if expected:
        raise ValueError("편집본의 지급 표와 명단을 확인하세요.")
    with database() as db:
        evidence = [f for t in snapshot["teams"] for f in files_for(db,t["file_ids"])]
    with pdf.open("rb") as stream:
        cover_pages = len(PdfReader(stream).pages) - sum(f["pages"] for f in evidence)
    if cover_pages < 1:
        raise ValueError("편집본에 원본 증빙이 누락됐습니다.")
    verify(pdf,cover_pages,[preview(f) for f in evidence])


def build_report(r):
    directory = DATA / "reports" / r["id"]
    directory.mkdir(parents=True, exist_ok=True)
    output = directory / "output"
    try:
        # Normal publishing is atomic. A restart after publication can reuse this pair.
        if not all((output / (REPORT_NAME + ext)).is_file() for ext in (".hwpx",".pdf")):
            if r["parent"]:
                edited = directory / "edited.hwpx"
                convert(edited, directory / "edited.pdf")
                verify_edited_pair(edited,directory / "edited.pdf",json.loads(r["snapshot"]))
                staging = directory / "pair"
                staging.mkdir(exist_ok=True)
                shutil.copyfile(edited, staging / (REPORT_NAME + ".hwpx"))
                (directory / "edited.pdf").replace(staging / (REPORT_NAME + ".pdf"))
                staging.rename(output)
            else:
                snap = json.loads(r["snapshot"])
                with database() as db:
                    for t in snap["teams"]:
                        t["documents"] = [str(source(f)) for f in files_for(db,t["file_ids"])]
                data = directory / "input.json"
                data.write_text(dump(snap), encoding="utf-8")
                template, = ROOT.glob("0_RE*/*00*상금*지급내역서*.hwp")
                powershell(ROOT / "reporting/build_report.ps1", "-Template", template, "-DataPath", data,
                           "-OutputDirectory", output, "-Python", sys.executable, timeout=1200)
        state, error = "preview", ""
    except subprocess.TimeoutExpired:
        state, error = "failed", "한글 응답 시간이 지났습니다. 파일 접근 확인창을 확인하고 보고서를 다시 생성하세요."
    except ValueError:
        state, error = "failed", "지급 표 또는 첨부 증빙이 승인한 제출본과 일치하지 않습니다. 편집본과 원본을 대조하세요."
    except Exception:
        state, error = "failed", "한글에서 양식·원본을 열고 편철한 결과를 검증하지 못했습니다. 한글 설정과 확정값을 확인한 뒤 재생성하세요."
    with database(True) as db:
        db.execute("UPDATE reports SET state=?,error=? WHERE id=?", (state,error,r["id"]))


class Worker:
    def __init__(self):
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self.loop, daemon=True, name="award-worker")

    def start(self):
        self.lock = (DATA / "worker.lock").open("a+b")
        self.lock.seek(0)
        try:
            msvcrt.locking(self.lock.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError as exc:
            self.lock.close()
            raise RuntimeError("이 자료 폴더를 사용하는 담당자 서비스가 이미 실행 중입니다.") from exc
        with database(True) as db:
            db.execute("UPDATE submissions SET state='uncertain',error='재시작 전에 생성 요청이 전송됐습니다. Studio 실행 이력을 확인하세요.' WHERE state='creating'")
            db.execute("UPDATE mail SET state='uncertain' WHERE state='sending'")
            db.execute("UPDATE reports SET state='queued' WHERE state='building'")
            folder = DATA / "files"
            if folder.exists():
                for path in folder.iterdir():
                    if path.is_dir() and path.resolve().parent == folder.resolve() and re.fullmatch("[a-f0-9]{32}",path.name) and not row(db,"SELECT id FROM batches WHERE id=?",path.name):
                        shutil.rmtree(path)
        self.thread.start()

    def close(self):
        self.stop.set()
        self.thread.join()
        self.lock.close()

    def step(self):
        cfg = mail_settings(settings())
        with database() as db:
            active = row(db,"SELECT * FROM submissions WHERE state='polling' AND due<=? ORDER BY due LIMIT 1",time.time())
            blocked = row(db,"""SELECT id FROM submissions WHERE state IN ('creating','uncertain','polling','access')
                            OR (job IS NOT NULL AND state='paused') LIMIT 1""")
            waiting = rows(db,"""SELECT s.* FROM submissions s JOIN teams t ON t.current=s.id
                           WHERE s.state='queued' AND due<=? ORDER BY s.rowid""",time.time())
            new = next((s for s in waiting if not held(db,s["team"])), None) if not blocked else None
            batch = row(db,"SELECT * FROM batches WHERE state='preparing' ORDER BY rowid LIMIT 1")
            report = row(db,"SELECT * FROM reports WHERE state='queued' ORDER BY rowid LIMIT 1")
            mails = rows(db,"""SELECT m.*,t.id AS tid,t.email FROM mail m JOIN submissions s ON m.submission=s.id
                       JOIN teams t ON t.current=s.id WHERE m.state='approved' AND m.kind IN ('보완 요청','검토 완료')
                       AND m.approved_at IS NOT NULL AND s.state='done' ORDER BY m.rowid""")
            mail = next((m for m in mails if not held(db, m["tid"])), None) if cfg["MAIL_READY"] else None
        if active or new:
            run_studio(active or new)
        elif batch:
            prepare(batch)
        elif mail:
            deliver(mail,cfg)
        elif report:
            with database(True) as db:
                db.execute("UPDATE reports SET state='building' WHERE id=?", (report["id"],))
            build_report(report)
        else:
            return False
        return True

    def loop(self):
        while not self.stop.is_set():
            try:
                worked = self.step()
            except Exception as exc:
                # No original filenames, document contents, server responses or credentials in logs.
                print("작업 대기열 점검:", type(exc).__name__, flush=True)
                worked = False
            if not worked:
                self.stop.wait(0.8)
