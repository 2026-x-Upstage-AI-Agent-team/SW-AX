"""Exercise recovery, corrections and the outbox against a dedicated empty PostgreSQL/Spring instance."""
import json
import os
import unittest
from io import BytesIO
from pathlib import Path
from uuid import uuid4
from zipfile import ZipFile

import httpx
from pypdf import PdfWriter

from operations.delivery import deliver
from operations.store import configuration, connect
from operations.studio_worker import run_studio
from tests.test_intake_postgres import login
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
        with ZipFile(ROOT/"test case"/"유잇_미션2_테스트set.zip") as archive:
            inputs = {Path(n).name[:2]:(Path(n).name,archive.read(n)) for n in archive.namelist()
                     if Path(n).parent.name=="set01" and Path(n).suffix.lower() in (".hwp",".hwpx")}
        pdf = BytesIO()
        doc = PdfWriter()
        doc.add_blank_page(width=595,height=842)
        doc.write(pdf)
        def submit(kinds,base=None,removed=()):
            files = [inputs[k] for k in kinds]
            fields = {"event":event,"target":team,"manifest":json.dumps([{"name":n,"size":len(v)} for n,v in files])}
            if base:
                fields.update(base=base,removed=json.dumps(list(removed)))
            batch = staff.post("/api/intake-batches",data=fields,headers={"Idempotency-Key":str(uuid4())},
                               files=[("files",(n,v)) for n,v in files]).raise_for_status().json()["batch_id"]
            items = staff.get("/api/intake-batches/"+batch).raise_for_status().json()["files"]
            for i,(k,item) in enumerate(zip(kinds,items,strict=True)):
                db.execute("INSERT INTO original_analysis(file_id,kind,pages,pdf) VALUES(%s,%s,1,%s)",(item["item_id"],k,pdf.getvalue()))
                staff.put(f"/api/intake-batches/{batch}/files/{item['item_id']}/assignment",
                          json={"action":"assign","revision":i,"reason":"원본 대조","team":team}).raise_for_status()
            db.execute("UPDATE intake_preparation SET state='ready' WHERE batch_id=%s",(batch,))
            api.put(f"review-jobs/preparations/{batch}/confirm").raise_for_status()
            return staff.get("/api/intake-batches/"+batch).raise_for_status().json()["teams"][0]["submission_id"],items
        first,originals=submit(("01","03"))
        sid=first
        response_status="queued"
        verdict="재제출요청"
        creates=[]
        mode="lost"
        def upstream(request):
            nonlocal mode
            if "configs" in request.url.path:
                return httpx.Response(200,json={"id":"cfg_test"})
            if request.method=="POST":
                creates.append(len(json.loads(request.content)["input"][0]["content"]))
                if mode=="lost":
                    raise httpx.ReadTimeout("test",request=request)
                return httpx.Response(200,json={"id":"job_"+str(len(creates))})
            if mode=="throttle":
                return httpx.Response(429,headers={"Retry-After":"20"})
            if mode=="denied":
                return httpx.Response(403)
            if mode=="unavailable":
                return httpx.Response(503)
            if mode=="read-timeout":
                raise httpx.ReadTimeout("test",request=request)
            remote=request.url.path.split("/")[-1]
            return httpx.Response(200,json={"id":remote,"status":response_status,"output":[
                {"model":"Instruct - 최종판정","content":[{"text":{"enum":verdict,"reason":"공식 가상 원본 대조"}}]},
                {"model":"Information Extract - 지급확인서","content":[{"text":{"team_name":"복구 시험팀","representative_name":"대표"}}]}]})
        def tick():
            with httpx.Client(base_url="https://studio.invalid/",transport=httpx.MockTransport(upstream)) as remote:
                return run_studio(db,api,remote,cfg)
        def execution():
            return db.execute("""SELECT e.*,extract(epoch FROM due-updated_at) AS delay FROM studio_execution e
                              JOIN review_job j ON j.id=e.job_id WHERE j.submission_id=%s""",(sid,)).fetchone()
        def due():
            db.execute("UPDATE studio_execution SET due=now() WHERE job_id=(SELECT id FROM review_job WHERE submission_id=%s)",(sid,))
        def retry(**body):
            return staff.post("/api/submissions/"+sid+"/retry", json=body)
        tick()
        self.assertEqual(execution()["phase"],"uncertain")
        self.assertFalse(tick())
        self.assertEqual(retry().status_code,409)
        retry(job="job_found").raise_for_status()
        mode="throttle"
        tick()
        self.assertGreaterEqual(execution()["delay"],20)
        self.assertTrue(execution()["occupies_slot"])
        for _ in range(3):
            due()
            tick()
        self.assertEqual(execution()["phase"],"paused")
        retry().raise_for_status()
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
        while deliver(db,cfg):
            pass
        notices = db.execute("SELECT kind,state FROM review_mail WHERE submission_id=%s",(sid,)).fetchall()
        self.assertEqual({x["kind"]:x["state"] for x in notices},{"담당자 알림":"local","보완 요청":"waiting"})
        staff.put("/api/teams/"+team+"/email",json={"email":"leader@award.test"}).raise_for_status()
        while deliver(db,cfg):
            pass
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
        third,duplicates=submit(("02","02"),second,(added[0]["item_id"],))
        due()
        response_status="completed"
        tick()
        self.assertFalse(db.execute("SELECT 1 FROM review_mail WHERE submission_id=%s",(second,)).fetchone())
        sid=third
        verdict="담당자확인"
        tick()
        due()
        tick()
        self.assertEqual(creates,[2,3,4])
        detail=staff.get("/api/operations/submissions/"+third).raise_for_status().json()
        self.assertEqual([m["kind"] for m in detail["mail"]],["담당자 알림"])
        body=dict(detail["fields"],revision=detail["revision"],decision="보완 필요",note="중복된 동의서 확인",issues=["duplicate"])
        staff.put("/api/submissions/"+third+"/review",json=body).raise_for_status()
        self.assertEqual(staff.put("/api/submissions/"+third+"/review",json=body).status_code,409)
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
        self.assertFalse(db.execute("SELECT 1 FROM review_mail WHERE submission_id=%s",(sid,)).fetchone())
        retry().raise_for_status()
        tick()
        remote=execution()["remote_id"]
        self.assertNotEqual(remote,"job_4")
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
        with ZipFile(ROOT/"test case"/"유잇_미션2_테스트set.zip") as archive:
            files = [(Path(n).name,archive.read(n)) for n in archive.namelist() if Path(n).parent.name=="set01" and Path(n).suffix]
        def request(items):
            return staff.build_request("POST","/api/intake-batches",headers={"Idempotency-Key":str(uuid4())},
                    files=[("files",(n,b)) for n,b in items],
                    data={"event":event,"manifest":json.dumps([{"name":n,"size":len(b)} for n,b in items])})
        seed=staff.send(request(files[:1])).raise_for_status().json()["status_url"]
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
