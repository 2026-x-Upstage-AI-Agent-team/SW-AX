"""Exercise recovery, corrections and the outbox against a dedicated empty PostgreSQL/Spring instance."""
import json
import os
import subprocess
import unittest
from email import policy
from email.parser import BytesParser
from unittest.mock import patch
from io import BytesIO
from uuid import uuid4

import httpx
from pypdf import PdfWriter

from operations.delivery import deliver
from tests.mail_approval import approve_ready_notices
from tests.official_inputs import fixture_slot, official_files
from operations.store import configuration, connect
from operations.studio_worker import run_studio
from operations.worker import serve
from tests.test_intake_postgres import login, mark_batch_read
from service.db import ROOT


@unittest.skipUnless(os.getenv("AWARDS_RECOVERY_TESTS")=="1","Requires a dedicated local test API.")
class Recovery(unittest.TestCase):
    def test_recover_and_replace(self):
        cfg = dict(configuration(), MAIL_MODE="local", UPSTAGE_AGENT_ID="test-agent", UPSTAGE_API_KEY="offline")
        url = os.environ["INTAKE_TEST_URL"]
        self.assertEqual(httpx.URL(url).host,"127.0.0.1")
        self.assertEqual(httpx.URL(cfg["AWARDS_DB_URL"].removeprefix("jdbc:")).host,"127.0.0.1")
        db = connect(cfg)
        self.addCleanup(db.close)
        self.assertFalse(db.execute("SELECT EXISTS(SELECT FROM review_job) AS used").fetchone()["used"],"Use an empty test database")
        staff = httpx.Client(base_url=url,trust_env=False)
        api = httpx.Client(base_url=url+"/api/worker/",headers={"Authorization":"Bearer "+cfg["AWARDS_REVIEW_WORKER_TOKEN"]},trust_env=False)
        self.addCleanup(staff.close)
        self.addCleanup(api.close)
        login(staff,os.environ["INTAKE_TEST_LOGIN_A"],os.environ["INTAKE_TEST_PASSWORD_A"])
        event = staff.post("/api/events",json={"name":"복구 시험 "+uuid4().hex[:8]}).raise_for_status().json()["id"]
        team = staff.post(f"/api/events/{event}/teams",json={"name":"복구 시험팀","rep":"대표"}).raise_for_status().json()["id"]
        inputs = {fixture_slot(name):(name,content) for name,content in official_files("set01")}
        pdf = BytesIO()
        doc = PdfWriter()
        doc.add_blank_page(width=595,height=842)
        doc.write(pdf)
        def submit(kinds,base=None,removed=(),owner=team):
            files = [inputs[k] for k in kinds]
            fields = {"event":event,"target":owner,"manifest":json.dumps([{"name":n,"size":len(v)} for n,v in files])}
            if base:
                fields.update(base=base,removed=json.dumps(list(removed)))
            batch = staff.post("/api/intake-batches",data=fields,headers={"Idempotency-Key":str(uuid4())},
                               files=[("files",(n,v)) for n,v in files]).raise_for_status().json()["batch_id"]
            items = staff.get("/api/intake-batches/"+batch).raise_for_status().json()["files"]
            for i,(k,item) in enumerate(zip(kinds,items,strict=True)):
                db.execute("INSERT INTO original_analysis(file_id,kind,pages,pdf) VALUES(%s,%s,1,%s)",(item["item_id"],k,pdf.getvalue()))
                staff.put(f"/api/intake-batches/{batch}/files/{item['item_id']}/assignment",
                          json={"action":"assign","revision":i,"reason":"원본 대조","team":owner}).raise_for_status()
            db.execute("UPDATE intake_preparation SET state='ready' WHERE batch_id=%s",(batch,))
            api.put(f"review-jobs/preparations/{batch}/confirm").raise_for_status()
            return staff.get("/api/intake-batches/"+batch).raise_for_status().json()["teams"][0]["submission_id"],items
        first,originals=submit(("01","03"))
        sid=first
        response_status="queued"
        verdict="재제출요청"
        creates=[]
        denied_creates=[]
        mode="lost"
        output_team="복구 시험팀"
        candidate="leader@award.test"
        def upstream(request):
            nonlocal mode
            if mode=="key-recovery" and request.headers.get("Authorization")!="Bearer restored-test-key":
                self.assertEqual(request.method,"GET","키 확인 전에는 새 작업을 요청하지 않습니다.")
                return httpx.Response(401)
            if mode=="create-denied" and request.method=="POST" and request.headers.get("Authorization")!="Bearer creation-restored":
                denied_creates.append(request.url.path)
                return httpx.Response(403)
            if "configs" in request.url.path:
                return httpx.Response(200,json={"id":"cfg_test"})
            if request.method=="POST":
                creates.append(len(json.loads(request.content)["input"][0]["content"]))
                if mode=="lost":
                    raise httpx.ReadTimeout("test",request=request)
                return httpx.Response(200,json={"id":"job_"+str(len(creates))})
            if mode=="throttle":
                return httpx.Response(429,headers={"Retry-After":"20"},text="private upstream detail")
            if mode=="denied":
                return httpx.Response(403)
            if mode=="unavailable":
                return httpx.Response(503,text="private upstream detail")
            if mode=="read-timeout":
                raise httpx.ReadTimeout("test",request=request)
            remote=request.url.path.split("/")[-1]
            return httpx.Response(200,json={"id":remote,"status":response_status,"output":[
                {"model":"Instruct - 최종판정","content":[{"text":{"enum":verdict,"reason":"공식 가상 원본 대조"}}]},
                {"model":"Information Extract - 지급확인서","content":[{"text":{"team_name":output_team,"representative_name":"대표",
                    "representative_email":candidate}}]}]})
        def tick():
            with httpx.Client(base_url="https://studio.invalid/",headers={"Authorization":"Bearer "+cfg["UPSTAGE_API_KEY"]},
                              transport=httpx.MockTransport(upstream)) as remote:
                return run_studio(db,api,remote,cfg)
        def execution():
            return db.execute("""SELECT e.*,extract(epoch FROM due-updated_at) AS delay FROM studio_execution e
                              JOIN review_job j ON j.id=e.job_id WHERE j.submission_id=%s""",(sid,)).fetchone()
        def due():
            # Advance this job ahead of other eligible teams when checking its recovery.
            db.execute("UPDATE studio_execution SET due=now()-interval '1 day' WHERE job_id=(SELECT id FROM review_job WHERE submission_id=%s)",(sid,))
        def retry(**body):
            return staff.post("/api/submissions/"+sid+"/retry", json=body)
        def submission_status():
            return staff.get(f"/api/operations/submissions/{sid}").raise_for_status().json()
        def set_age(minutes):
            db.execute("UPDATE studio_execution SET started_at=now()-%s*interval '1 minute' WHERE job_id=%s",
                       (minutes,execution()["job_id"]))
        tick()
        self.assertEqual(execution()["phase"],"uncertain")
        self.assertIsNone(submission_status()["last_polled_at"])
        self.assertFalse(tick())
        self.assertEqual(retry().status_code,409)
        retry(job="job_found").raise_for_status()
        set_age(15)
        status=submission_status()
        self.assertTrue(status["polling_delayed"])
        self.assertIsNone(status["last_polled_at"])
        set_age(14)
        mode="throttle"
        tick()
        self.assertGreaterEqual(execution()["delay"],20)
        self.assertTrue(execution()["occupies_slot"])
        status=submission_status()
        self.assertFalse(status["polling_delayed"])
        last_poll=status["last_polled_at"]
        self.assertAlmostEqual(last_poll,execution()["last_polled_at"].timestamp(),places=5)
        set_age(15)
        status=submission_status()
        self.assertTrue(status["polling_delayed"])
        self.assertEqual(status["last_polled_at"],last_poll)
        for mode in ("unavailable", "read-timeout", "throttle"):
            due()
            tick()
            next_poll=submission_status()["last_polled_at"]
            self.assertGreater(next_poll,last_poll)
            last_poll=next_poll
        self.assertEqual(execution()["phase"],"paused")
        detail = submission_status()
        self.assertTrue(detail["polling_delayed"])
        self.assertEqual(detail["attempts"],4)
        retries = [row for row in reversed(detail["audit"]) if row["attempts"]]
        self.assertEqual([(r["http_status"], r["error_code"], r["attempts"]) for r in retries],
                         [(429, "RATE_LIMITED", 1), (503, "SERVICE_UNAVAILABLE", 2),
                          (None, "TIMEOUT", 3), (429, "RATE_LIMITED", 4)])
        self.assertTrue(all(r["job"] == "job_found" and r["due"] >= r["ts"] - 1 for r in retries))
        self.assertNotIn("private upstream detail", json.dumps(retries))
        if os.getenv("INTAKE_TEST_STATUS_BROWSER")=="1":
            subprocess.run(["node","--test","tests/review-navigation.mjs"],cwd=ROOT/"frontend",check=True,timeout=75,
                           env=dict(os.environ,INTAKE_TEST_DELAYED_SUBMISSION=sid))
        else:
            retry().raise_for_status()
        resumed=submission_status()
        self.assertEqual(resumed["attempts"],0)
        self.assertTrue(resumed["polling_delayed"])
        self.assertEqual(resumed["last_polled_at"],last_poll)
        self.assertTrue(any(row["attempts"]==4 and row["http_status"]==429 for row in resumed["audit"]))
        mode="denied"
        tick()
        self.assertEqual(execution()["phase"],"access")
        retry().raise_for_status()
        mode="ok"
        db.execute("UPDATE studio_execution SET started_at=now()-interval '61 minutes' WHERE job_id=%s",(execution()["job_id"],))
        tick()
        self.assertGreaterEqual(execution()["delay"],60)
        self.assertEqual(len(creates),1)
        # Lose the local process and its lease. A known Studio id is always polled again.
        db.execute("UPDATE review_job SET lease_until=now()-interval '1 second' WHERE submission_id=%s",(sid,))
        due()
        response_status="completed"
        tick()
        self.assertFalse(submission_status()["polling_delayed"])
        self.assertFalse(deliver(db,cfg))
        approve_ready_notices(staff,sid)
        while deliver(db,cfg):
            pass
        notices = db.execute("SELECT kind,state FROM review_mail WHERE submission_id=%s",(sid,)).fetchall()
        self.assertEqual({x["kind"]:x["state"] for x in notices},{"보완 요청":"draft"})
        legacy = db.execute("""INSERT INTO review_mail(submission_id,kind,state,sent_to,subject,body,approved_by,approved_at)
            VALUES(%s,'담당자 알림','approved','staff@award.test','이전 알림','이전 본문',%s,now()) RETURNING id""",
            (sid,os.environ["INTAKE_TEST_LOGIN_A"])).fetchone()["id"]
        legacy_url = "/api/mail/"+str(legacy)
        self.assertEqual(staff.get(legacy_url).status_code,404)
        self.assertEqual(staff.post(legacy_url+"/approve",json={"revision":0,"subject":"이전 알림","body":"이전 본문",
                         "recipient":"staff@award.test"}).status_code,404)
        self.assertEqual(staff.post(legacy_url+"/retry",json={}).status_code,404)
        self.assertFalse(deliver(db,cfg))
        self.assertEqual(db.execute("SELECT state FROM review_mail WHERE id=%s",(legacy,)).fetchone()["state"],"obsolete")
        db.execute("DELETE FROM review_mail WHERE id=%s",(legacy,))
        staff.put("/api/teams/"+team+"/email",json={"email":"leader@award.test"}).raise_for_status()
        self.assertFalse(deliver(db,cfg))
        leader, = [m for m in submission_status()["mail"] if m["kind"]=="보완 요청"]
        url_mail = "/api/mail/" + leader["id"]
        draft = staff.get(url_mail).raise_for_status().json()
        self.assertTrue(draft["subject"] and draft["body"])
        edited = dict(draft,subject="담당자가 확인한 보완 안내",body=draft["body"]+"\n금요일까지 회신해 주세요.")
        saved = staff.put(url_mail+"/draft",json=edited).raise_for_status().json()
        self.assertEqual(staff.post(url_mail+"/approve",json=edited).status_code,409)
        self.assertFalse(deliver(db,cfg))
        self.assertEqual(staff.get(url_mail).json()["body"],edited["body"])
        self.assertEqual(staff.post(url_mail+"/approve",json=dict(saved,recipient="wrong@award.test")).status_code,409)
        if os.getenv("INTAKE_TEST_MAIL_BROWSER")=="1":
            subprocess.run(["node","--test","tests/review-navigation.mjs"],cwd=ROOT/"frontend",check=True,timeout=90,
                           env=dict(os.environ,INTAKE_TEST_DRAFT_MAIL=leader["id"],INTAKE_TEST_MAIL_EVENT=event))
            edited["body"]+="\n브라우저 검토 완료"
        else:
            staff.post(url_mail+"/approve",json=saved).raise_for_status()
        self.assertEqual(staff.post(url_mail+"/approve",json=saved).status_code,409)
        while deliver(db,cfg):
            pass
        sent=staff.get(url_mail).raise_for_status().json()
        self.assertEqual((sent["state"],sent["body"],sent["approved_by"]),("local",edited["body"],os.environ["INTAKE_TEST_LOGIN_A"]))
        from service.db import DATA
        envelope=BytesParser(policy=policy.default).parsebytes((DATA/"operations/mail"/(leader["id"]+".eml")).read_bytes())
        self.assertEqual((str(envelope["Subject"]),str(envelope["To"]),envelope.get_content().splitlines()),
                         (edited["subject"],saved["recipient"],edited["body"].splitlines()))
        self.assertFalse(deliver(db,cfg))
        self.assertEqual(len(creates),1)
        # Adding only the missing 02 retains the exact previously confirmed 01/03 originals.
        second,added=submit(("02",),first)
        sid=second
        corrected=staff.get("/api/submissions/"+second).raise_for_status().json()
        self.assertEqual(corrected["version"],2)
        self.assertEqual({f["item_id"] for f in corrected["files"]},{f["item_id"] for f in originals+added})
        tick()
        self.assertEqual(creates,[2,3])
        due()
        response_status="queued"
        tick()
        # A second correction makes the running v2 obsolete before its terminal response.
        mode="denied"
        due()
        tick()
        self.assertEqual(execution()["phase"],"access")
        old_remote=execution()["remote_id"]
        third,duplicates=submit(("02","02"),second,(added[0]["item_id"],))
        mode="regular"
        due()
        response_status="completed"
        tick()
        self.assertEqual((execution()["phase"],execution()["remote_id"]),("superseded",old_remote))
        self.assertFalse(db.execute("SELECT 1 FROM review_mail WHERE submission_id=%s",(second,)).fetchone())
        sid=third
        verdict="담당자확인"
        tick()
        due()
        tick()
        self.assertEqual(creates,[2,3,4])
        detail=staff.get("/api/operations/submissions/"+third).raise_for_status().json()
        self.assertEqual(detail["mail"],[])
        body=dict(detail["fields"],revision=detail["revision"],decision="보완 필요",note="중복된 동의서 확인",issues=["duplicate"])
        staff.put("/api/submissions/"+third+"/review",json=body).raise_for_status()
        self.assertEqual(staff.put("/api/submissions/"+third+"/review",json=body).status_code,409)
        approve_ready_notices(staff,third)
        while deliver(db,cfg):
            pass
        self.assertEqual(db.execute("SELECT count(*) AS n FROM review_mail WHERE submission_id=%s AND kind='보완 요청' AND state='local'",
                                    (third,)).fetchone()["n"],1)

        fourth,_=submit(("02",),third,[f["item_id"] for f in duplicates])
        sid=fourth
        response_status="failed"
        tick()
        due()
        tick()
        self.assertEqual(execution()["phase"],"failed")
        self.assertIsNotNone(submission_status()["last_polled_at"])
        self.assertFalse(db.execute("SELECT 1 FROM review_mail WHERE submission_id=%s",(sid,)).fetchone())
        retry().raise_for_status()
        self.assertIsNone(submission_status()["last_polled_at"])
        tick()
        remote=execution()["remote_id"]
        self.assertNotEqual(remote,"job_4")
        self.assertIsNone(submission_status()["last_polled_at"])
        self.assertFalse(submission_status()["polling_delayed"])
        for mode,delay in (("unavailable",2),("read-timeout",4)):
            due()
            tick()
            self.assertEqual(execution()["remote_id"],remote)
            self.assertGreaterEqual(execution()["delay"],delay)
        mode="regular"
        response_status="completed"
        verdict="잘못된 규격"
        due()
        tick()
        self.assertEqual(execution()["phase"],"invalid")
        self.assertFalse(db.execute("SELECT 1 FROM review_mail WHERE submission_id=%s",(sid,)).fetchone())
        retry().raise_for_status()
        verdict="성공"
        tick()
        self.assertEqual(execution()["remote_id"],remote)
        approve_ready_notices(staff,sid)
        while deliver(db,cfg):
            pass
        notices=db.execute("SELECT kind,state FROM review_mail WHERE submission_id=%s",(sid,)).fetchall()
        self.assertEqual(notices,[{"kind":"검토 완료","state":"local"}])
        # A fresh intake with changed bytes is not a response to a previous correction request.
        name,original=inputs["01"]
        inputs["01"]=(name,original+b"\x00")
        sid,_=submit(("01","02","03"))
        tick()
        due()
        tick()
        self.assertEqual(execution()["phase"],"done")
        self.assertFalse(db.execute("SELECT 1 FROM review_mail WHERE submission_id=%s",(sid,)).fetchone())

        # A 401 before creation holds all new Jobs even after the failing version is replaced.
        mode="key-recovery"
        sid,_=submit(("01","03"))
        tick()
        self.assertEqual((execution()["phase"],execution()["remote_id"]),("access",None))
        retired=sid
        next_team=staff.post(f"/api/events/{event}/teams",json={"name":"다음 시험팀","rep":"대표"}).raise_for_status().json()["id"]
        next_sid,_=submit(("01","03"),owner=next_team)
        replacement,_=submit(("02",),retired)
        before=len(creates)
        retry().raise_for_status()
        self.assertFalse(tick())
        self.assertEqual(len(creates),before)
        self.assertEqual(execution()["phase"],"access")
        cfg["UPSTAGE_API_KEY"]="restored-test-key"
        due()  # The next scheduled read uses the restored credentials.
        previous_config=dict(cfg,UPSTAGE_API_KEY="expired-test-key",AWARDS_API_URL=url)
        probe=httpx.Client(base_url="https://studio.invalid/",headers={"Authorization":"Bearer expired-test-key"},
                           transport=httpx.MockTransport(upstream))
        with patch("operations.worker.configuration",return_value=cfg), patch("operations.worker.studio.client",return_value=probe):
            serve("studio",previous_config,once=True)
        self.assertEqual((execution()["phase"],execution()["remote_id"]),("superseded",None))
        candidate="new-leader@award.test"
        verdict="재제출요청"
        for sid,output_team in ((next_sid,"다음 시험팀"),(replacement,"복구 시험팀")):
            tick()
            self.assertEqual(execution()["phase"],"polling")
            due()
            tick()
            self.assertEqual(execution()["phase"],"done")
        self.assertEqual(len(creates),before+2)
        self.assertFalse(db.execute("SELECT 1 FROM review_mail WHERE submission_id=%s",(retired,)).fetchone())
        # The registered address is valid, but differs from this version's extracted address.
        approve_ready_notices(staff,next_sid)
        approve_ready_notices(staff,replacement)
        while deliver(db,cfg):
            pass
        recipient_url=f"/api/teams/{team}/email"
        def recipients():
            return {m["kind"]:m["state"] for m in staff.get("/api/operations/submissions/"+replacement).json()["mail"]}
        self.assertEqual(recipients(),{"보완 요청":"recipient_check"})
        for stale in (retired,next_sid):
            self.assertEqual(staff.put(recipient_url,json={"email":"leader@award.test","submission":stale}).status_code,409)
        for _ in range(2):
            staff.put(recipient_url,json={"email":"leader@award.test","submission":replacement}).raise_for_status()
            approve_ready_notices(staff,replacement)
            while deliver(db,cfg):
                pass
        self.assertEqual(recipients(),{"보완 요청":"local"})
        sid,_ = submit(("02",),replacement)
        tick()
        due()
        tick()
        approve_ready_notices(staff,sid)
        while deliver(db,cfg):
            pass
        detail=staff.get("/api/operations/submissions/"+sid).raise_for_status().json()
        self.assertTrue(detail["email_needs_confirmation"])
        self.assertEqual({m["kind"]:m["state"] for m in detail["mail"]},{"보완 요청":"recipient_check"})

        # Config lookup can succeed even while Job creation is forbidden.
        mode="create-denied"
        sid,_=submit(("01",),owner=next_team)
        tick()
        self.assertEqual(execution()["phase"],"access")
        replacement_b,_=submit(("02",),sid,owner=next_team)
        due()
        self.assertFalse(tick())
        self.assertEqual(execution()["phase"],"access")
        self.assertEqual(len(denied_creates),1)
        cfg["UPSTAGE_API_KEY"]="creation-restored"
        due()
        tick()
        self.assertEqual((execution()["phase"],execution()["remote_id"]),("superseded",None))
        sid=replacement_b
        output_team="다음 시험팀"
        tick()
        due()
        tick()
        self.assertEqual(execution()["phase"],"done")

    def test_upload_while_studio_is_slow(self):
        import threading
        import time
        from concurrent.futures import ThreadPoolExecutor

        cfg = configuration()
        url = os.environ["INTAKE_TEST_URL"]
        self.assertEqual(httpx.URL(url).host,"127.0.0.1")
        staff = httpx.Client(base_url=url,timeout=90,trust_env=False)
        worker = httpx.Client(base_url=url+"/api/worker/review-jobs/",timeout=30,trust_env=False,
                              headers={"Authorization":"Bearer "+cfg["AWARDS_REVIEW_WORKER_TOKEN"]})
        self.addCleanup(staff.close)
        self.addCleanup(worker.close)
        login(staff,os.environ["INTAKE_TEST_LOGIN_A"],os.environ["INTAKE_TEST_PASSWORD_A"])
        event = staff.post("/api/events",json={"name":"지연 시험 "+uuid4().hex[:8]}).raise_for_status().json()["id"]
        team = staff.post(f"/api/events/{event}/teams",json={"name":"지연 검증","rep":""}).raise_for_status().json()["id"]
        files = official_files("set01")
        def request(items):
            return staff.build_request("POST","/api/intake-batches",headers={"Idempotency-Key":str(uuid4())},
                    files=[("files",(n,b)) for n,b in items],
                    data={"event":event,"manifest":json.dumps([{"name":n,"size":len(b)} for n,b in items])})
        seed=staff.send(request(files[:1])).raise_for_status().json()["status_url"]
        mark_batch_read(seed)
        file=staff.get(seed).raise_for_status().json()["files"][0]["item_id"]
        staff.put(f"{seed}/files/{file}/assignment",json={"action":"assign","team":team,"revision":0,"reason":"지연 검증"}).raise_for_status()
        staff.put(f"{seed}/teams/{team}/submission",json={"revision":1}).raise_for_status()
        job=worker.post("claim",json={"worker_id":"delayed-test","event_id":event}).raise_for_status().json()
        start=threading.Event()
        def delayed():
            headers={"X-Claim-Token":job["claim_token"]}
            path=job["review_job_id"]
            for _ in range(12):
                worker.put(path+"/lease",headers=headers,json={"studio_job_id":"job_delay_"+path}).raise_for_status()
                start.set()
                time.sleep(5)
            worker.put(path+"/result",headers=headers,json={"state":"done","verdict":"성공","reason":"모의 지연 응답"}).raise_for_status()
        marks=[]
        pending=request(files)
        original_stream=pending.stream
        class TimedBody(httpx.SyncByteStream):
            def __iter__(self):
                yield from original_stream
                marks.append(time.perf_counter())
        pending.stream=TimedBody()
        with ThreadPoolExecutor(max_workers=1) as pool:
            future=pool.submit(delayed)
            self.assertTrue(start.wait(10))
            received=staff.send(pending)
            latency=time.perf_counter()-marks[0]
            self.assertFalse(future.done())
            self.assertEqual(received.status_code,202)
            self.assertEqual(len(staff.get(received.headers["location"]).raise_for_status().json()["files"]),3)
            print(f"공식 set01 마지막 전송 후 202 응답 {latency:.3f}초 (모의 판정 60초)",flush=True)
            self.assertLess(latency,1)
            future.result()
