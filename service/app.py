import hashlib
import json
import re
import shutil
import smtplib
from contextlib import asynccontextmanager
from email import policy
from email.parser import BytesParser
from html import escape
from pathlib import Path
from urllib.parse import urlsplit
from zipfile import BadZipFile, ZipFile

import httpx
from fastapi import FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, SecretStr
from starlette.middleware.trustedhost import TrustedHostMiddleware

from . import gmail_oauth
from .document_versions import router as document_versions
from .db import DATA, ROOT, database, dump, initialize, now, row, rows, settings, smtp_enabled, uid
from .documents import preview
from .mailing import connect_gmail, mail_settings, mailbox_address
from .mail_drafts import detail as mail_detail
from .studio import CONFIG, ISSUES, is_masked_rrn
from .worker import REPORT_NAME, Worker
from .workflow import (audit, check_report, effective_fields, enqueue_mail, files_for, held, missing_payouts,
                       pending_payouts, report_snapshot, require, require_payouts, synchronize)


@asynccontextmanager
async def lifespan(app):
    initialize()
    worker = Worker()
    worker.start()
    try:
        yield
    finally:
        worker.close()


app = FastAPI(title="시상금 서류 검토", lifespan=lifespan, docs_url=None, redoc_url=None)
app.include_router(document_versions)
app.add_middleware(TrustedHostMiddleware, allowed_hosts=["127.0.0.1","localhost","[::1]"])
STATIC = ROOT / "service/static"
MAX_FILE = 40 * 1024**2


@app.middleware("http")
async def local_browser(request: Request, call_next):
    origin = request.headers.get("origin")
    if request.method not in ("GET","HEAD","OPTIONS"):
        if request.headers.get("x-award-client") != "staff" or (origin and urlsplit(origin).netloc != request.headers.get("host")):
            return JSONResponse({"detail":"이 PC의 담당자 화면에서 요청하세요."},403)
    response = await call_next(request)
    response.headers.update({"Cache-Control":"no-store","X-Content-Type-Options":"nosniff", "Referrer-Policy":"no-referrer",
                             "X-Frame-Options":"SAMEORIGIN"})
    return response


class TextValue(BaseModel):
    name: str = Field(min_length=1, max_length=170)
    rep: str = Field(default="",max_length=60)


def clean(value):
    return value.strip()


def changed(current, revision):
    if current["revision"] != revision:
        raise HTTPException(409,"다른 변경이 있습니다. 최신 화면에서 다시 확인하세요.")


def active(db, sid):
    s = require(db,"submissions",sid)
    t = require(db,"teams",s["team"])
    if t["current"] != sid or held(db,t["id"]):
        raise HTTPException(409,"이 제출본의 팀 배정과 최신 버전을 확인하세요.")
    return s,t


def file_info(f):
    return {k:f[k] for k in ("id","name","kind","state","team","reason","pages","size")} | {
        "candidates":json.loads(f["candidates"]), "excluded":json.loads(f["excluded"]),
        "page":json.loads(f["signals"]).get("page",1), "url":f"/api/files/{f['id']}/preview" if f["pages"] else ""}


def sub_info(s):
    res = json.loads(s["result"] or "{}")
    fields = effective_fields(s)
    return {k:s[k] for k in ("id","team","version","created","updated","state","error","job","agent_id","config_version","config_id","decision","revision","attempts","started","due")} | {
        "verdict":res.get("verdict"), "students":len(fields["members"]), "count":len(json.loads(s["files"])),
        "award_type":fields.get("award_type"), "support_amount":fields.get("support_amount"),
        "status_url":f"/api/submissions/{s['id']}"}


@app.get("/api/dashboard")
def dashboard(event: str = "wave"):
    with database() as db:
        require(db,"events",event)
        teams = rows(db,"SELECT id,name,rep,email,current FROM teams WHERE event=? ORDER BY rowid",event)
        for t in teams:
            t["held"] = held(db,t["id"])
            t["submission"] = sub_info(require(db,"submissions",t["current"])) if t["current"] else None
        batches = rows(db,"""SELECT b.id,b.state,b.created,count(f.id) AS count,
             sum(CASE WHEN f.state NOT IN ('assigned','outside') THEN 1 ELSE 0 END) AS pending
             FROM batches b JOIN files f ON f.batch=b.id WHERE b.event=? GROUP BY b.id ORDER BY b.rowid DESC""",event)
        reports = rows(db,"SELECT id,version,state,error,created FROM reports WHERE event=? ORDER BY version DESC",event)
        mails = rows(db,"""SELECT m.id,m.submission,m.kind,m.state,m.sent_to,m.created,m.sent_at,s.version,t.name FROM mail m JOIN submissions s ON m.submission=s.id
                     JOIN teams t ON t.id=s.team WHERE t.event=? AND m.kind IN ('보완 요청','검토 완료') ORDER BY m.rowid DESC""",event)
        cfg = mail_settings(settings())
        return {"events":rows(db,"SELECT * FROM events ORDER BY rowid"),"teams":teams,"batches":batches,"reports":reports,
                "mail":mails,"smtp":smtp_enabled(cfg), "gmail_account":cfg.get("SMTP_USER") if "GMAIL_CREDENTIAL" in cfg else None,
                "gmail_oauth_connected":bool(cfg.get("GMAIL_OAUTH")),
                "mail_ready":cfg["MAIL_READY"], "config":cfg.get("UPSTAGE_CONFIG_ID",CONFIG),
                "connected":bool(cfg.get("UPSTAGE_API_KEY")), "event":event}


class GmailConnection(BaseModel):
    app_password: SecretStr


class GoogleClient(BaseModel):
    client_json: SecretStr


def gmail_account():
    cfg = mail_settings(settings())
    if "GMAIL_CREDENTIAL" not in cfg or not cfg["ADMIN_EMAIL"]:
        raise HTTPException(409, "이 서비스의 담당자 Gmail 주소를 먼저 설정하세요.")
    return cfg["ADMIN_EMAIL"]


@app.post("/api/settings/gmail/oauth/start")
def gmail_oauth_start(body: GoogleClient, request: Request):
    client_json = body.client_json.get_secret_value()
    if len(client_json) > 32768:
        raise HTTPException(422, "Google Cloud 클라이언트 JSON 파일을 선택하세요.")
    redirect = str(request.url.replace(path=gmail_oauth.CALLBACK, query=""))
    try:
        state, url = gmail_oauth.begin(gmail_account(), redirect, client_json)
    except gmail_oauth.SetupError as exc:
        raise HTTPException(422, str(exc)) from None
    response = JSONResponse({"url": url})
    response.set_cookie(gmail_oauth.COOKIE, state, max_age=gmail_oauth.TTL, path=gmail_oauth.CALLBACK,
                        httponly=True, samesite="lax", secure=request.url.scheme == "https")
    return response


@app.get(gmail_oauth.CALLBACK)
def gmail_callback(request: Request, state: str = "", code: str = "", error: str = ""):
    failure = ""
    try:
        gmail_oauth.finish(gmail_account(), state, request.cookies.get(gmail_oauth.COOKIE), code, error)
    except gmail_oauth.SetupError as exc:
        failure = str(exc)
    except (httpx.HTTPError, OSError, KeyError, TypeError, ValueError):
        failure = "Google 인증을 저장하지 못했습니다. Gmail API 사용 설정과 OAuth 클라이언트를 확인하세요."
    if failure:
        response = HTMLResponse('<html lang="ko"><meta charset="utf-8"><title>Gmail 연결</title><main><h1>Gmail 연결</h1><p>'
                                + escape(failure) + '</p><a href="/#mail">이메일 발송으로 돌아가기</a></main></html>', status_code=400)
    else:
        response = RedirectResponse("/#mail", status_code=303)
    response.delete_cookie(gmail_oauth.COOKIE, path=gmail_oauth.CALLBACK)
    return response


@app.post("/api/settings/gmail/connect")
def gmail_connect(body: GmailConnection):
    address = gmail_account()
    try:
        connect_gmail(address, body.app_password.get_secret_value())
    except ValueError:
        raise HTTPException(422, "Google에서 발급한 16자리 앱 비밀번호를 입력하세요.") from None
    except smtplib.SMTPAuthenticationError:
        raise HTTPException(422, "Google 인증이 거절됐습니다. 담당자 계정과 앱 비밀번호를 확인하세요.") from None
    except (smtplib.SMTPException, OSError):
        raise HTTPException(503, "Gmail 연결 또는 자격 증명 저장에 실패했습니다. 네트워크와 Windows 계정을 확인하세요.") from None
    return {"connected": True, "address": address}


@app.post("/api/events")
def create_event(body: TextValue):
    name = clean(body.name)
    if not name or not name.isprintable():
        raise HTTPException(422,"대회명을 입력하세요.")
    with database(True) as db:
        db.execute("INSERT OR IGNORE INTO events VALUES(?,?)",(uid(),name))
        return row(db,"SELECT * FROM events WHERE name=?",name)


@app.get("/api/events/{event}/draft")
def payment_draft(event: str):
    with database() as db:
        require(db,"events",event)
        result = []
        for team in rows(db,"SELECT * FROM teams WHERE event=? ORDER BY rowid",event):
            s = row(db,"SELECT * FROM submissions WHERE id=?",team["current"])
            fields = effective_fields(s) if s else {"members":[],"recipient":{}}
            extracted = json.loads(s["result"] or "{}") if s else {}
            pending = []
            if not s or held(db,team["id"]):
                pending.append("팀 배정 확인")
            if not s or s["decision"] != "승인" or s["state"] != "done":
                pending.append("현재 제출본 승인")
            result.append(dict(team=extracted.get("team_name") or "",submission=team["current"],rep=extracted.get("rep") or "",
                               revision=s["revision"] if s else None,
                               version=s["version"] if s else None,pending=pending,missing_payouts=missing_payouts(fields),**fields))
        return {"teams":result}


@app.post("/api/events/{event}/teams")
def create_team(event: str, body: TextValue):
    name, rep = clean(body.name), clean(body.rep)
    if not name or not name.isprintable() or (rep and not rep.isprintable()):
        raise HTTPException(422,"원접수에서 확인한 팀명을 입력하세요.")
    with database(True) as db:
        require(db,"events",event)
        db.execute("INSERT OR IGNORE INTO teams(id,event,name,rep) VALUES(?,?,?,?)",(uid(),event,name,rep))
        return row(db,"SELECT id,name,rep FROM teams WHERE event=? AND name=? AND rep=?",event,name,rep)


def json_list(value):
    try:
        parsed = json.loads(value)
        if isinstance(parsed,list):
            return parsed
    except ValueError:
        pass
    raise HTTPException(422,"선택 목록을 다시 확인하세요.")


@app.post("/api/intake-batches")
def intake(files: list[UploadFile] = File(), event: str = Form(), manifest: str = Form(), target: str = Form(""),
           base: str = Form(""), removed: str = Form("[]"), key: str = Header(alias="Idempotency-Key")):
    listing, remove = json_list(manifest), json_list(removed)
    if not re.fullmatch(r"[A-Za-z0-9_-]{8,100}",key) or not 0 < len(files) == len(listing) <= 100:
        raise HTTPException(422,"선택한 파일의 개수 또는 요청 키를 확인하세요.")
    if not all(isinstance(i,str) for i in remove) or (remove and not base):
        raise HTTPException(422,"교체할 이전 원본을 확인하세요.")
    with database() as db:
        require(db,"events",event)
        if target and require(db,"teams",target)["event"] != event:
            raise HTTPException(422,"같은 대회의 팀을 선택하세요.")
        if base and require(db,"submissions",base)["team"] != target:
            raise HTTPException(422,"보완할 팀과 이전 버전을 확인하세요.")
    bid = uid()
    directory = DATA / "files" / bid
    directory.mkdir(parents=True)
    entries, published, total = [], False, 0
    try:
        for pos,(upload,expected) in enumerate(zip(files,listing)):
            name = Path((upload.filename or "").replace("\\","/")).name
            ext = Path(name).suffix.lower()
            if ext not in (".hwp",".hwpx") or re.match(r"^00(?:\D|$)",name):
                raise HTTPException(415,"01·02·03 한글 원본(HWP, HWPX)을 선택하세요. 00은 출력 양식입니다.")
            if not isinstance(expected,dict) or name != expected.get("name") or upload.size != expected.get("size"):
                raise HTTPException(422,"선택 목록과 전송한 파일이 다릅니다. 다시 전송하세요.")
            if not upload.size or upload.size > MAX_FILE or total + upload.size > 300 * 1024**2:
                raise HTTPException(413,"파일당 40MB, 한 번에 300MB까지 접수할 수 있습니다. 빈 파일은 교체하세요.")
            fid, h, size = uid(), hashlib.sha256(), 0
            with (directory / (fid+ext)).open("xb") as out:
                while block := upload.file.read(1024**2):
                    out.write(block)
                    h.update(block)
                    size += len(block)
            if size != expected["size"]:
                raise HTTPException(422,"전송이 중단됐습니다. 같은 선택 목록으로 다시 보내세요.")
            total += size
            entries.append((fid,bid,pos,name,ext,h.hexdigest(),size))
        digest = hashlib.sha256(dump([event,target,base,sorted(remove),[(f[3],f[5],f[6]) for f in entries]]).encode()).hexdigest()
        with database(True) as db:
            existing = row(db,"SELECT * FROM batches WHERE reqkey=?",key)
            if existing and existing["digest"] != digest:
                raise HTTPException(409,"같은 요청 키에 다른 파일이 있습니다. 새 접수를 시작하세요.")
            if existing:
                result, state = existing["id"], existing["state"]
            else:
                if base:
                    old,t = active(db,base)
                    if not set(remove) <= set(json.loads(old["files"])):
                        raise HTTPException(422,"이전 버전에 속한 파일만 교체할 수 있습니다.")
                    if row(db,"SELECT id FROM batches WHERE base=? AND state!='assigned'",base):
                        raise HTTPException(409,"같은 제출본의 보완 파일을 이미 처리 중입니다.")
                db.execute("""INSERT INTO batches(id,event,reqkey,digest,target,base,removed,created) VALUES(?,?,?,?,?,?,?,?)""",
                           (bid,event,key,digest,target or None,base or None,dump(remove),now()))
                db.executemany("INSERT INTO files(id,batch,pos,name,ext,hash,size) VALUES(?,?,?,?,?,?,?)",entries)
                result, state = bid, "preparing"
            pending = row(db,"""SELECT s.id FROM batch_teams l JOIN submissions s ON s.id=l.submission
                         WHERE l.batch=? AND s.state IN ('queued','creating','polling') LIMIT 1""",result)
        published = result == bid
        url = "/api/intake-batches/" + result
        return JSONResponse({"batch_id":result,"status":state,"status_url":url},202 if state != "assigned" or pending else 200,headers={"Location":url})
    finally:
        if not published and directory.resolve().parent == (DATA / "files").resolve():
            shutil.rmtree(directory)


@app.get("/api/intake-batches/{bid}")
def batch_detail(bid: str):
    with database() as db:
        b = require(db,"batches",bid)
        return {k:b[k] for k in ("id","event","state","revision","created","target","base")} | {
            "files":[file_info(f) for f in rows(db,"SELECT * FROM files WHERE batch=? ORDER BY pos",bid)],
            "teams":rows(db,"SELECT team,submission AS submission_id,'/api/submissions/'||submission AS status_url FROM batch_teams WHERE batch=?",bid)}


class Assignment(BaseModel):
    action: str
    team: str = ""
    reason: str = Field(min_length=2,max_length=500)
    revision: int
    exclude: list[str] = Field(default_factory=list)


@app.put("/api/intake-batches/{bid}/files/{fid}/assignment")
def assign(bid: str, fid: str, body: Assignment):
    with database(True) as db:
        b, f = require(db,"batches",bid), require(db,"files",fid)
        if b["state"] == "preparing" or f["batch"] != bid:
            raise HTTPException(409,"판독을 마친 접수 목록을 확인하세요.")
        for tid in set(body.exclude + ([body.team] if body.team else [])):
            if require(db,"teams",tid)["event"] != b["event"]:
                raise HTTPException(422,"같은 대회의 팀만 선택할 수 있습니다.")
        if body.action == "assign" and body.team:
            if f["kind"] == "00" or not f["pages"] or json.loads(f["signals"]).get("mixed"):
                raise HTTPException(422,"팀별로 분리되고 열리는 원본을 확보해 접수하세요.")
            state, team, excluded = "assigned",body.team,[]
        elif body.action == "outside":
            state, team, excluded = "outside",None,[]
        elif body.action == "hold":
            state, team, excluded = "unassigned",None,sorted(set(body.exclude))
        else:
            raise HTTPException(422,"배정 결정을 선택하세요.")
        if (state,team,excluded,body.reason) == (f["state"],f["team"],json.loads(f["excluded"]),f["reason"]):
            return {"saved":True}
        changed(b,body.revision)
        if b["base"] and team and team != b["target"]:
            raise HTTPException(409,"팀 보완본의 다른 팀 서류는 대상 외로 처리하고 해당 팀으로 다시 접수하세요.")
        for link in rows(db,"SELECT l.submission,t.current FROM batch_teams l JOIN teams t ON t.id=l.team WHERE batch=?",bid):
            if link["submission"] != link["current"]:
                raise HTTPException(409,"후속 제출 버전이 있습니다. 현재 버전에서 보완 접수하세요.")
        audit(db,fid,"배정 변경",{"before":f["team"],"after":team,"state":state,"reason":body.reason,"excluded":excluded})
        db.execute("UPDATE files SET state=?,team=?,excluded=?,reason=? WHERE id=?",(state,team,dump(excluded),body.reason,fid))
        db.execute("UPDATE batches SET revision=revision+1 WHERE id=?",(bid,))
        synchronize(db,b)
    return {"saved":True}


@app.get("/api/files/{fid}/preview")
def show_file(fid: str):
    with database() as db:
        f = require(db,"files",fid)
    if not f["pages"] or not preview(f).is_file():
        raise HTTPException(404,"검토용 PDF를 준비 중입니다.")
    return FileResponse(preview(f),media_type="application/pdf")


@app.post("/api/intake-batches/{bid}/files/{fid}/retry")
def retry_conversion(bid: str, fid: str):
    with database(True) as db:
        b, f = require(db,"batches",bid), require(db,"files",fid)
        if f["batch"] != bid or f["state"] != "error":
            raise HTTPException(409,"파일 오류가 표시된 현재 항목을 선택하세요.")
        preview(f).unlink(missing_ok=True)
        db.execute("UPDATE files SET state='waiting',reason='',pages=0 WHERE id=?",(fid,))
        db.execute("UPDATE batches SET state='preparing',revision=revision+1 WHERE id=?",(b["id"],))
        audit(db,fid,"원본 판독 재개",{})
    return {"saved":True}


@app.get("/api/submissions/{sid}")
def submission(sid: str):
    with database() as db:
        s = require(db,"submissions",sid)
        t = require(db,"teams",s["team"])
        return sub_info(s) | {"team_name":t["name"],"rep":t["rep"],"email":t["email"],"held":held(db,t["id"]),
            "current":t["current"],"note":s["note"],"fields":effective_fields(s),"result":json.loads(s["result"] or "null"),
            "files":[file_info(f) for f in files_for(db,json.loads(s["files"]))],
            "history":rows(db,"SELECT id,version,state,job,decision FROM submissions WHERE team=? ORDER BY version DESC",t["id"]),
            "mail":rows(db,"SELECT id,submission,kind,state,sent_to,created,sent_at FROM mail WHERE submission=? AND kind IN ('보완 요청','검토 완료') ORDER BY rowid",sid),
            "audit":rows(db,"SELECT ts,action,actor FROM audit WHERE subject=? ORDER BY id DESC LIMIT 30",sid)}


class Recovery(BaseModel):
    job: str = ""
    confirmed_absent: bool = False


@app.post("/api/submissions/{sid}/retry")
def retry(sid: str, body: Recovery):
    with database(True) as db:
        s = require(db,"submissions",sid)
        if s["state"] in ("queued","creating","polling","done"):
            return sub_info(s)
        job = s["job"]
        if s["state"] == "uncertain":
            if body.job and re.fullmatch(r"job_[A-Za-z0-9_-]+",body.job):
                if row(db,"SELECT id FROM submissions WHERE job=? AND id!=?",body.job,sid):
                    raise HTTPException(409,"이미 다른 제출본에 연결된 Job입니다.")
                job = body.job
            elif not body.confirmed_absent:
                raise HTTPException(409,"Studio에서 확인한 Job ID 또는 미생성 확인이 필요합니다.")
        elif s["state"] == "failed":
            job = None
        elif s["state"] == "ownership":
            raise HTTPException(409,"접수 화면에서 파일 소속을 정정하세요.")
        audit(db,sid,"처리 재개",{"previous_job":s["job"],"job":job,"confirmed_absent":body.confirmed_absent})
        db.execute("UPDATE submissions SET state=?,job=?,due=0,attempts=0,error='',updated=? WHERE id=?",
                   ("polling" if job else "queued",job,now(),sid))
        return sub_info(require(db,"submissions",sid))


class Member(BaseModel):
    role: str
    name: str = Field(max_length=80)
    student_id: str = Field(default="",max_length=60)
    major: str = Field(default="",max_length=150)
    school: str = Field(default="",max_length=100)


class Review(BaseModel):
    revision: int
    decision: str
    note: str = Field(default="",max_length=1000)
    members: list[Member] = Field(max_length=150)
    recipient: dict[str,str]
    issues: list[str] = Field(default_factory=list)


@app.put("/api/submissions/{sid}/review")
def save_review(sid: str, body: Review):
    if body.decision not in ("승인","보완 필요","작성 중") or any(k not in ISSUES for k in body.issues):
        raise HTTPException(422,"검토 결론과 보완 항목을 확인하세요.")
    recipient = {k:body.recipient.get(k,"").strip() for k in ("bank_name","account_number","account_holder","rrn_display")}
    if recipient["rrn_display"] and not is_masked_rrn(recipient["rrn_display"]):
        raise HTTPException(422,"주민번호는 원본에 표시된 마스킹 표기로 입력하세요.")
    with database(True) as db:
        s,t = active(db,sid)
        changed(s,body.revision)
        if s["state"] != "done":
            raise HTTPException(409,"Studio 검토 완료 후 기록할 수 있습니다.")
        res = json.loads(s["result"])
        if body.decision == "승인" and res.get("program") != require(db,"events",t["event"])["name"] and not clean(body.note):
            raise HTTPException(422,"신청서 프로그램명과 선택 대회명이 다릅니다. 확인 근거를 기록하세요.")
        if body.decision == "승인" and (res["verdict"] == "재제출요청" or
              any(not m.name.strip() for m in body.members) or
              sum(m.role == "대표" for m in body.members) != 1 or any(m.role not in ("대표","팀원") for m in body.members)):
            raise HTTPException(409,"보완된 원본과 대표 한 명을 포함한 명단을 확인하세요.")
        if res["verdict"] == "담당자확인" and body.decision != "작성 중" and not clean(body.note):
            raise HTTPException(422,"원본과 대조한 결과를 한 줄로 기록하세요.")
        decision = None if body.decision == "작성 중" else body.decision
        if s["decision"] and s["decision"] != decision:
            raise HTTPException(409,"이미 안내한 검토 결론을 바꾸려면 새 보완본을 접수하세요.")
        if decision == "보완 필요" and not body.issues:
            raise HTTPException(422,"팀장에게 안내할 보완 항목을 선택하세요.")
        saved = json.loads(s["fields"] or "{}")
        recipient.update({k:saved.get("recipient",{}).get(k,"") for k in ("gross_amount","tax_amount","net_amount")})
        fields = {"members":[m.model_dump() for m in body.members], "recipient":recipient,
                  "award_type":saved.get("award_type",""), "support_amount":saved.get("support_amount","")}
        db.execute("UPDATE submissions SET fields=?,note=?,decision=?,updated=?,revision=revision+1 WHERE id=?",
                   (dump(fields),body.note,decision,now(),sid))
        audit(db,sid,"검토 저장",{"decision":decision,"issues":body.issues})
        if res["verdict"] == "담당자확인" and decision:
            enqueue_mail(db,sid,"검토 완료" if decision == "승인" else "보완 요청")
        elif decision == "보완 필요":
            enqueue_mail(db,sid,"보완 요청")
    return {"saved":True}


class Payment(BaseModel):
    revision: int
    award_type: str = Field(max_length=60)
    support_amount: str
    gross_amount: str
    tax_amount: str
    net_amount: str


@app.put("/api/submissions/{sid}/payment")
def save_payment(sid: str, body: Payment):
    amounts = {k:getattr(body,k).strip() for k in ("support_amount","gross_amount","tax_amount","net_amount")}
    if any(value and not re.fullmatch(r"[0-9]{1,13}|[0-9]{1,3}(?:,[0-9]{3}){1,4}",value) for value in amounts.values()):
        raise HTTPException(422,"금액은 0 이상의 원 단위 정수로 입력하세요.")
    with database(True) as db:
        s,_ = active(db,sid)
        changed(s,body.revision)
        if s["decision"] != "승인" or s["state"] != "done":
            raise HTTPException(409,"현재 제출본의 서류를 먼저 승인하세요.")
        fields = effective_fields(s)
        fields.update(award_type=body.award_type.strip(),support_amount=amounts.pop("support_amount"))
        fields["recipient"].update(amounts)
        db.execute("UPDATE submissions SET fields=?,updated=?,revision=revision+1 WHERE id=?",(dump(fields),now(),sid))
        audit(db,sid,"지급 정보 저장",{})
    return {"saved":True}


class Address(BaseModel):
    email: str = Field(max_length=254)


@app.put("/api/teams/{tid}/email")
def set_email(tid: str, body: Address):
    try:
        address = mailbox_address(body.email) if body.email else ""
    except ValueError:
        raise HTTPException(422,"원접수에서 확인한 팀장 이메일 주소 한 개를 입력하세요.") from None
    with database(True) as db:
        team = require(db,"teams",tid)
        db.execute("UPDATE teams SET email=? WHERE id=?",(address,tid))
        if address != team["email"]:
            db.execute("""UPDATE mail SET state='draft',sent_to=NULL,approved_at=NULL,revision=revision+1
                WHERE state='approved' AND kind IN ('보완 요청','검토 완료')
                AND submission IN (SELECT id FROM submissions WHERE team=?)""",(tid,))
    return {"saved":True}


@app.get("/api/mail/{mid}")
def show_mail(mid: str):
    with database() as db:
        m = mail_detail(db,leader_mail(db,mid),mail_settings(settings()))
    if m["body"] is not None:
        return m
    path = DATA / "mail" / (mid+".eml")
    if not path.is_file():
        return m | {"body":"발송된 본문이 없습니다."}
    message = BytesParser(policy=policy.default).parsebytes(path.read_bytes())
    return m | {"body":message.get_body().get_content(),"subject":str(message["Subject"])}


class MailEdit(BaseModel):
    revision: int
    subject: str = Field(min_length=1,max_length=255)
    body: str = Field(min_length=1,max_length=50000)
    recipient: str = ""


def leader_mail(db, mid):
    mail = require(db,"mail",mid)
    if mail["kind"] not in ("보완 요청","검토 완료"):
        raise HTTPException(404,"메일을 찾을 수 없습니다.")
    return mail


def edit_mail(mid, form, approve):
    if not form.subject.strip() or any(ord(c)<32 or 127<=ord(c)<=159 for c in form.subject) or not form.body.strip() or "\0" in form.body:
        raise HTTPException(422,"한 줄 제목과 본문을 입력하세요.")
    with database(True) as db:
        m = leader_mail(db,mid)
        active(db,m["submission"])
        if m["state"]!="draft" or form.revision!=m["revision"]:
            raise HTTPException(409,"초안이 변경되었습니다. 다시 열어 확인하세요.")
        cfg = mail_settings(settings())
        detail = mail_detail(db,m,cfg)
        if approve and (not detail["can_approve"] or detail["recipient"]!=form.recipient):
            raise HTTPException(409,"현재 제출본의 수신 주소를 다시 확인한 뒤 승인하세요.")
        db.execute("""UPDATE mail SET subject=?,body=?,revision=revision+1,state=?,approved_at=?,sent_to=? WHERE id=?""",
                   (form.subject,form.body.replace("\r\n","\n"),"approved" if approve else "draft",
                    now() if approve else None,form.recipient if approve else None,mid))
        if approve:
            audit(db,m["submission"],m["kind"]+" 메일 발송 승인",{"mail":mid})
        return mail_detail(db,leader_mail(db,mid),cfg)


@app.put("/api/mail/{mid}/draft")
def save_mail(mid: str, body: MailEdit):
    return edit_mail(mid,body,False)


@app.post("/api/mail/{mid}/approve")
def approve_mail(mid: str, body: MailEdit):
    return edit_mail(mid,body,True)


@app.post("/api/mail/{mid}/retry")
def retry_mail(mid: str, body: Recovery):
    with database(True) as db:
        m = leader_mail(db,mid)
        active(db,m["submission"])
        if m["state"] == "uncertain" and not body.confirmed_absent:
            raise HTTPException(409,"미발송을 확인한 뒤 다시 시도하세요.")
        if m["state"] in ("failed","uncertain"):
            db.execute("UPDATE mail SET state='draft',approved_at=NULL,sent_to=NULL,revision=revision+1 WHERE id=?",(mid,))
            audit(db,m["submission"],"메일 초안 다시 열기",{"mail":mid})
    return {"saved":True}


class ReportOrder(BaseModel):
    event: str
    submissions: list[str]


def insert_report(db, event, selection, snapshot, parent=None):
    rid = uid()
    version = db.execute("SELECT COALESCE(MAX(version),0)+1 FROM reports WHERE event=?",(event,)).fetchone()[0]
    db.execute("INSERT INTO reports(id,event,version,selection,snapshot,created,parent) VALUES(?,?,?,?,?,?,?)",
               (rid,event,version,dump(selection),dump(snapshot),now(),parent))
    return {"id":rid,"version":version,"status_url":"/api/reports/"+rid}


@app.post("/api/reports",status_code=202)
def new_report(body: ReportOrder):
    with database(True) as db:
        snap = report_snapshot(db,body.event,body.submissions)
        require_payouts(snap)
        existing = row(db,"SELECT id,version FROM reports WHERE snapshot=? AND event=? AND parent IS NULL AND state!='failed' ORDER BY version DESC LIMIT 1",dump(snap),body.event)
        return existing or insert_report(db,body.event,body.submissions,snap)


@app.get("/api/reports/{rid}")
def view_report(rid: str):
    with database() as db:
        r = require(db,"reports",rid)
        try:
            check_report(db,r)
            stale = False
        except HTTPException:
            stale = True
        snapshot = json.loads(r["snapshot"])
        return {k:r[k] for k in ("id","version","state","created","error","parent")} | {"stale":stale,
                "missing_payouts":pending_payouts(snapshot),"teams":[t["team_name"] for t in snapshot["teams"]]}


@app.post("/api/reports/{rid}/confirm")
def confirm(rid: str):
    with database(True) as db:
        r = require(db,"reports",rid)
        require_payouts(json.loads(r["snapshot"]))
        check_report(db,r)
        if r["state"] not in ("preview","confirmed"):
            raise HTTPException(409,"미리보기가 완성된 버전을 확인하세요.")
        db.execute("UPDATE reports SET state='confirmed' WHERE id=?",(rid,))
    return {"saved":True}


@app.post("/api/reports/{rid}/edited",status_code=202)
def edited_report(rid: str, file: UploadFile):
    if Path(file.filename or "").suffix.lower() != ".hwpx" or not file.size or file.size > 100*1024**2:
        raise HTTPException(415,"편집한 HWPX 파일을 선택하세요.")
    try:
        with ZipFile(file.file) as z:
            if "Contents/section0.xml" not in z.namelist() or sum(i.file_size for i in z.infolist()) > 524288000:
                raise ValueError()
    except (BadZipFile,ValueError):
        raise HTTPException(422,"열 수 있는 HWPX인지 확인하세요.")
    file.file.seek(0)
    with database(True) as db:
        r = require(db,"reports",rid)
        require_payouts(json.loads(r["snapshot"]))
        check_report(db,r)
        if r["state"] != "confirmed":
            raise HTTPException(409,"확정한 보고서의 편집본을 선택하세요.")
        new = insert_report(db,r["event"],json.loads(r["selection"]),json.loads(r["snapshot"]),rid)
        folder = DATA / "reports" / new["id"]
        folder.mkdir(parents=True)
        with (folder / "edited.hwpx").open("xb") as dest:
            shutil.copyfileobj(file.file,dest)
    return new


@app.get("/api/reports/{rid}/{kind}")
def download_report(rid: str, kind: str):
    if kind not in ("preview","hwpx","pdf"):
        raise HTTPException(404)
    with database() as db:
        r = require(db,"reports",rid)
        if r["state"] not in ("preview","confirmed") or (kind != "preview" and r["state"] != "confirmed"):
            raise HTTPException(409,"미리본 버전을 확정한 뒤 내려받으세요.")
        if kind != "preview":
            require_payouts(json.loads(r["snapshot"]))
        check_report(db,r)
    ext = "pdf" if kind == "preview" else kind
    path = DATA/"reports"/rid/"output"/(REPORT_NAME+"."+ext)
    return FileResponse(path,media_type="application/pdf" if ext == "pdf" else "application/hwp+zip",
                        filename=None if kind == "preview" else f"{REPORT_NAME}_v{r['version']}.{ext}")


editor_dist = ROOT / "frontend/dist"


@app.get("/document-editor")
def editor_page():
    if not (editor_dist / "rhwp/viewer.html").is_file():
        raise HTTPException(503, "frontend 폴더에서 npm run build를 실행하고 서비스를 다시 시작해 주세요.")
    return FileResponse(editor_dist / "index.html")


for directory in ("assets", "rhwp"):
    if (editor_dist / directory).is_dir():
        app.mount("/" + directory, StaticFiles(directory=editor_dist / directory), name="editor-" + directory)
app.mount("/",StaticFiles(directory=STATIC,html=True),name="staff")
