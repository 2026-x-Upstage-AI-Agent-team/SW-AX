"""Durable Studio execution. Each tick runs under the database-wide Studio worker lock."""
import random
import re
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime

import httpx

from service import studio
from service.documents import preview
from .store import cached_file


def status(db, task, phase, error="", *, delay=0, failures=0, slot=False, remote=None):
    with db.transaction():
        db.execute("""UPDATE studio_execution SET phase=%s,error=%s,failures=%s,occupies_slot=%s,
            remote_id=coalesce(%s,remote_id),updated_at=now(),due=now()+%s*interval '1 second' WHERE job_id=%s""",
                   (phase, error, failures, slot, remote, delay, task["id"]))
        if task["phase"] != phase or error != task["error"] or failures:
            db.execute("""INSERT INTO workflow_audit(submission_id,actor,action,stage,remote_id,attempts,due)
                SELECT %s,'@workflow',%s,phase,remote_id,failures,due FROM studio_execution WHERE job_id=%s""",
                       (task["submission_id"], "Studio " + phase + (" · " + error if error else ""), task["id"]))


def choose(db):
    return db.execute("""SELECT j.id,j.submission_id,j.worker_id,j.claim_token,j.studio_job_id,
        j.lease_until>now() AS leased,j.work_state,coalesce(e.phase,'queued') AS phase,e.remote_id,
        coalesce(e.failures,0) AS failures,coalesce(e.error,'') AS error,coalesce(e.occupies_slot,false) AS slot,
        extract(epoch FROM now()-e.started_at) AS elapsed,r.state AS effective,e.agent,e.config,e.config_id,
        (e.due IS NULL OR e.due<=now()) AS ready
        FROM review_job j JOIN review_job_status r ON r.review_job_id=j.id
        JOIN team_submission s ON s.id=j.submission_id LEFT JOIN studio_execution e ON e.job_id=j.id
        WHERE e.occupies_slot OR (r.state IN ('queued','running') AND NOT ops_team_held(s.team_id)
            AND (e.phase IS NULL OR e.phase IN ('queued','polling')) AND (e.due IS NULL OR e.due<=now())
            AND (j.work_state='queued' OR j.lease_until<=now() OR j.worker_id='studio-dispatch')
            AND NOT EXISTS(SELECT FROM studio_execution WHERE phase='access'))
        ORDER BY coalesce(e.occupies_slot,false) DESC,j.registered_at,j.id LIMIT 1""").fetchone()


def backoff(db, task, exc, creating):
    response = exc.response if isinstance(exc, httpx.HTTPStatusError) else None
    code = response.status_code if response is not None else 0
    remote = bool(task["remote_id"] or task["studio_job_id"])
    if code in (401, 402, 403):
        status(db, task, "access", f"Upstage 조직 키·사용량을 확인하고 재개하세요. HTTP {code}", slot=remote)
    elif creating and (not code or code == 408 or code >= 500):
        status(db, task, "uncertain", "생성 응답이 불명확합니다. Studio에서 기존 실행을 확인하세요.", slot=True)
    elif not code or code in (408, 429) or code >= 500:
        count = task["failures"] + 1
        if count > 3:
            status(db, task, "paused", "통신 재시도 한도에 도달했습니다. 실행 이력을 확인하세요.", failures=count, slot=remote)
            return
        delay = 2 ** count + random.random()
        after = response.headers.get("Retry-After", "") if response is not None else ""
        try:
            wait = int(after) if after.isdecimal() else (parsedate_to_datetime(after) - datetime.now(timezone.utc)).total_seconds()
            delay = max(delay, wait)
        except (ValueError, TypeError, OverflowError):
            pass
        status(db, task, "polling" if remote else "queued", "통신 오류로 재시도를 기다립니다.",
               failures=count, delay=delay, slot=remote)
    else:
        status(db, task, "paused", f"Studio 설정·입력을 확인하세요. HTTP {code}", slot=remote)


def run_studio(db, api, external, cfg):
    t = choose(db)
    if not t or not t["ready"] or t["phase"] in ("uncertain", "paused", "access", "invalid"):
        return False
    jid = t["id"]
    if t["phase"] == "creating":
        status(db, t, "uncertain", "생성 중 워커가 종료됐습니다. Studio에서 요청 시각과 실행 번호를 대조하세요.", slot=True)
        return True
    active = t["effective"] in ("queued", "running")
    remote = t["remote_id"] or t["studio_job_id"]
    if t["effective"] in ("done", "failed"):
        status(db,t,t["effective"])
        return True
    if not active and not remote:
        status(db, t, "superseded")
        return True
    endpoint = f"review-jobs/{jid}"
    headers = {}
    if active:
        if not (t["worker_id"] == "studio-dispatch" and t["leased"]):
            response = api.post("review-jobs/claim", json={"worker_id":"studio-dispatch", "review_job_id":str(jid)})
            response.raise_for_status()
            if response.status_code == 204:
                return False
            claim = response.json()
            t["claim_token"] = claim["claim_token"]
            remote = remote or claim["studio_job_id"]
        headers = {"X-Claim-Token":str(t["claim_token"])}
        checkpoint = api.put(endpoint + "/lease", headers=headers, json={"studio_job_id":remote})
        if checkpoint.status_code == 409:
            return False
        checkpoint.raise_for_status()
    db.execute("INSERT INTO studio_execution(job_id) VALUES(%s) ON CONFLICT DO NOTHING", (jid,))
    creating = False
    terminal = False
    files = []
    if active:
        for f in db.execute("SELECT file_id FROM team_submission_file WHERE submission_id=%s ORDER BY position", (t["submission_id"],)).fetchall():
            item = cached_file(db, f["file_id"])
            if not preview(item).is_file():
                pdf = db.execute("SELECT pdf FROM original_analysis WHERE file_id=%s", (f["file_id"],)).fetchone()
                if not pdf or not pdf["pdf"]:
                    status(db, t, "invalid", "입력 원본을 판독하고 검토용 PDF를 준비하세요.", slot=bool(remote))
                    return True
                preview(item).write_bytes(pdf["pdf"])
            files.append(item)
    try:
        if not remote:
            agent = t["agent"] or cfg.get("UPSTAGE_AGENT_ID")
            version = t["config"] or cfg.get("UPSTAGE_CONFIG_ID", studio.CONFIG)
            if not agent or not cfg.get("UPSTAGE_API_KEY"):
                status(db, t, "access", "서버의 Studio 에이전트와 조직 키를 설정한 뒤 재개하세요.")
                return True
            config_id = t["config_id"] or external.get(f"agents/{agent}/configs/{version}").raise_for_status().json()["id"]
            body = studio.payload(files, config_id, agent)
            with db.transaction():
                row = db.execute("""SELECT j.id FROM review_job j JOIN team_submission s ON s.id=j.submission_id
                    JOIN intake_team_confirmation c ON c.submission_id=s.id WHERE j.id=%s AND c.state='confirmed'
                    AND j.claim_token=%s AND j.lease_until>now() AND NOT ops_team_held(s.team_id)
                    FOR UPDATE OF c,j""", (jid,t["claim_token"])).fetchone()
                if not row:
                    return False
                db.execute("UPDATE studio_execution SET agent=%s,config=%s,config_id=%s,started_at=now() WHERE job_id=%s",
                           (agent,version,config_id,jid))
                status(db,t,"creating",slot=True)
            creating = True
            remote = external.post("responses", json=body).raise_for_status().json()["id"]
            if not re.fullmatch(r"job_[A-Za-z0-9_-]{1,140}", remote):
                raise ValueError("Studio 실행 번호")
            status(db,t,"polling",remote=remote,slot=True,delay=5)
            return True
        job = external.get(f"responses/{remote}", params=[("include[]","all")]).raise_for_status().json()
        if job["id"] != remote:
            raise ValueError("Studio 실행 불일치")
        if job["status"] in ("in_progress","queued"):
            elapsed = t["elapsed"] or 0
            status(db,t,"polling","장기 실행 중입니다. Studio 이력을 확인하세요." if elapsed >= 3600 else
                   "처리 지연" if elapsed >= 900 else "",slot=True,delay=60 if elapsed >= 3600 else 15 if elapsed >= 60 else 5)
            return True
        if job["status"] not in ("completed","failed","cancelled","canceled","incomplete"):
            status(db,t,"paused","Studio 실행 상태를 확인하세요.",slot=True)
            return True
        terminal = True
        if not active:
            status(db,t,"superseded","이전 제출본의 원격 실행 종료를 확인했습니다.")
            return True
        if job["status"] == "completed":
            result = studio.parse_result(job, files)
            body = {"state":"done","studio_job_id":remote,"verdict":result["verdict"],"reason":result["reason"],"output":result}
        else:
            body = {"state":"failed","studio_job_id":remote,"reason":"Studio 실행이 실패 종료됐습니다. 원본과 실행 이력을 확인하세요."}
    except httpx.HTTPError as exc:
        backoff(db,t,exc,creating)
        return True
    except (ValueError,KeyError,TypeError,AttributeError,OSError):
        status(db,t,"uncertain" if creating else "invalid","Studio의 실행 이력·결과 노드·원본을 확인하세요.",
               slot=creating or (bool(remote) and not terminal))
        return True
    # If this local API call fails, the saved remote id stays available for the next tick.
    response = api.put(endpoint+"/result", headers=headers, json=body)
    if response.status_code == 409:
        return False
    response.raise_for_status()
    status(db,t,body["state"],body["reason"] if body["state"]=="failed" else "")
    return True
