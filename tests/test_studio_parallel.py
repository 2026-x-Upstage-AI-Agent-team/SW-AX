"""Parallel background Studio jobs against an isolated PostgreSQL/Spring API."""
from io import BytesIO
import json
import os
import unittest
from uuid import uuid4

import httpx
from pypdf import PdfWriter

from operations.store import configuration, connect
from operations.studio_worker import run_studio
from tests.test_intake_postgres import login


@unittest.skipUnless(os.getenv("AWARDS_PARALLEL_TESTS")=="1", "Requires a dedicated local test API.")
class ParallelStudio(unittest.TestCase):
    def test_parallel_jobs_keep_independent_results_and_recovery(self):
        cfg=dict(configuration(), UPSTAGE_AGENT_ID="test-agent", UPSTAGE_API_KEY="offline")
        url=os.environ["INTAKE_TEST_URL"]
        self.assertEqual(httpx.URL(url).host,"127.0.0.1")
        self.assertEqual(httpx.URL(cfg["AWARDS_DB_URL"].removeprefix("jdbc:")).host,"127.0.0.1")
        db=connect(cfg)
        self.addCleanup(db.close)
        self.assertFalse(db.execute("SELECT EXISTS(SELECT FROM review_job) AS used").fetchone()["used"])
        clients=[]
        events=[]
        for suffix in ("A","B"):
            web=httpx.Client(base_url=url,trust_env=False)
            self.addCleanup(web.close)
            login(web,os.environ["INTAKE_TEST_LOGIN_"+suffix],os.environ["INTAKE_TEST_PASSWORD_"+suffix])
            clients.append(web)
            events.append(web.post("/api/events",json={"name":"parallel "+uuid4().hex}).raise_for_status().json()["id"])
        api=httpx.Client(base_url=url+"/api/worker/",trust_env=False,
                         headers={"Authorization":"Bearer "+cfg["AWARDS_REVIEW_WORKER_TOKEN"]})
        self.addCleanup(api.close)
        def submit(owner=0):
            web=clients[owner]
            team=web.post(f"/api/events/{events[owner]}/teams",json={"name":uuid4().hex,"rep":"fixture"}).raise_for_status().json()["id"]
            pdf=BytesIO()
            writer=PdfWriter()
            writer.add_blank_page(width=500+len(teams),height=842)
            writer.write(pdf)
            raw=pdf.getvalue()
            name=f"01-{team}.hwp"
            receipt=web.post("/api/intake-batches",data={"event":events[owner],"target":team,
                "manifest":json.dumps([{"name":name,"size":len(raw)}])},files=[("files",(name,raw))],
                headers={"Idempotency-Key":str(uuid4())}).raise_for_status().json()
            batch=receipt["batch_id"]
            file=web.get(receipt["status_url"]).raise_for_status().json()["files"][0]["item_id"]
            db.execute("INSERT INTO original_analysis(file_id,kind,pages,pdf) VALUES(%s,'01',1,%s)",(file,raw))
            web.put(f"/api/intake-batches/{batch}/files/{file}/assignment",
                    json={"action":"assign","revision":0,"reason":"synthetic fixture","team":team}).raise_for_status()
            db.execute("UPDATE intake_preparation SET state='ready' WHERE batch_id=%s",(batch,))
            api.put(f"review-jobs/preparations/{batch}/confirm").raise_for_status()
            submission=web.get(receipt["status_url"]).raise_for_status().json()["teams"][0]["submission_id"]
            teams.append(submission)
            return submission
        def row(sid):
            return db.execute("SELECT e.* FROM studio_execution e JOIN review_job j ON j.id=e.job_id WHERE j.submission_id=%s",(sid,)).fetchone()
        def due(sid):
            db.execute("UPDATE studio_execution SET due=now()-interval '1 second' WHERE job_id=(SELECT id FROM review_job WHERE submission_id=%s)",(sid,))
        def detail(sid,owner=0):
            return clients[owner].get("/api/operations/submissions/"+sid).raise_for_status().json()
        teams=[]
        creates=[]
        polls=[]
        modes={}
        creation="ok"
        def upstream(request):
            if "configs" in request.url.path:
                return httpx.Response(200,json={"id":"cfg_test"})
            if request.method=="POST":
                body=json.loads(request.content)
                self.assertTrue(body["background"])
                self.assertEqual(len(body["input"][0]["content"]),1)
                if creation=="denied":return httpx.Response(403)
                if creation=="throttle":return httpx.Response(429,headers={"Retry-After":"20"})
                creates.append(body)
                if creation=="lost":raise httpx.ReadTimeout("lost",request=request)
                return httpx.Response(200,json={"id":"job_"+str(len(creates))})
            job=request.url.path.rsplit("/",1)[-1]
            polls.append(job)
            state=modes.get(job,"in_progress")
            if state=="throttle":return httpx.Response(429,headers={"Retry-After":"20"})
            return httpx.Response(200,json={"id":job,"status":state,"output":[
                {"model":"Instruct - 최종판정","content":[{"text":{"enum":"성공","reason":"synthetic "+job}}]}]})
        remote=httpx.Client(base_url="https://studio.invalid/",transport=httpx.MockTransport(upstream))
        self.addCleanup(remote.close)
        def tick():return run_studio(db,api,remote,cfg)

        first=submit()
        second=submit(1)
        self.assertTrue(tick())
        self.assertTrue(tick(),"Do not wait for team one to finish before starting team two")
        self.assertEqual([row(s)["phase"] for s in (first,second)],["polling","polling"])
        self.assertEqual(len(creates),2)
        self.assertNotEqual(creates[0]["input"],creates[1]["input"],"Teams must keep separate files")
        self.assertEqual(polls,[])
        self.assertEqual(clients[0].get("/api/operations/submissions/"+second).status_code,404)
        self.assertFalse(tick(),"Future poll due dates must not spin or start duplicate jobs")
        # A second dispatcher cannot own the database lock while this one is active.
        self.assertTrue(db.execute("SELECT pg_try_advisory_lock(175703111,1) AS locked").fetchone()["locked"])
        with connect(cfg) as other:
            self.assertFalse(other.execute("SELECT pg_try_advisory_lock(175703111,1) AS locked").fetchone()["locked"])
        db.execute("SELECT pg_advisory_unlock(175703111,1)")

        # Expired leases resume known IDs, with out-of-order success/failure.
        db.execute("UPDATE review_job SET lease_until=now()-interval '1 second'")
        modes["job_2"]="completed"
        due(second);tick()
        self.assertEqual(detail(second,1)["state"],"done")
        self.assertEqual(row(first)["phase"],"polling")
        modes["job_1"]="failed"
        due(first);tick()
        self.assertEqual(row(first)["phase"],"failed")
        self.assertEqual(len(creates),2)

        # Lost POST responses pause only that team's creation; they never repost it.
        third=submit()
        creation="lost";tick()
        self.assertEqual(row(third)["phase"],"uncertain")
        fourth=submit(1)
        creation="ok";tick()
        self.assertEqual(row(fourth)["phase"],"polling")
        self.assertEqual(len(creates),4)
        self.assertEqual(clients[0].post("/api/submissions/"+third+"/retry",json={}).status_code,409)
        clients[0].post("/api/submissions/"+third+"/retry",json={"job":"job_3"}).raise_for_status()
        tick()
        self.assertEqual(row(third)["remote_id"],"job_3")
        self.assertEqual(len(creates),4)

        # A valid claim owned by another worker must not occupy the dispatcher's head.
        db.execute("UPDATE review_job SET worker_id='other-fixture',lease_until=now()+interval '10 minutes' WHERE submission_id=%s",(third,))
        db.execute("UPDATE studio_execution SET due=now()-interval '1 day' WHERE remote_id='job_3'")

        # Retry-After applies to the shared Upstage key, including newly queued teams.
        modes["job_4"]="throttle"
        due(fourth);tick()
        self.assertEqual(row(fourth)["last_http_status"],429)
        fifth=submit()
        before=len(polls)
        self.assertFalse(tick())
        self.assertEqual(len(polls),before)
        self.assertEqual(len(creates),4)
        modes["job_4"]="in_progress"
        due(fourth)
        tick();tick()
        self.assertEqual(row(fifth)["phase"],"polling")

        # Unresolved/paused jobs do not prevent independent work from progressing.
        db.execute("UPDATE studio_execution SET phase='paused',due=now()-interval '1 day' WHERE remote_id='job_3'")
        modes["job_4"]="completed"
        due(fourth);tick()
        self.assertEqual(row(fourth)["phase"],"done")
        modes["job_5"]="completed"
        due(fifth);tick()
        self.assertEqual(row(fifth)["phase"],"done")
        # Creation throttling must also hold new teams without losing either request.
        sixth=submit()
        creation="throttle";tick()
        self.assertEqual((row(sixth)["phase"],row(sixth)["last_http_status"]),("queued",429))
        seventh=submit(1)
        self.assertFalse(tick())
        self.assertIsNone(row(seventh))
        creation="ok"
        due(sixth);tick();tick()
        self.assertEqual(len(creates),7)
        for sid,job in ((sixth,"job_6"),(seventh,"job_7")):
            modes[job]="completed"
            due(sid);tick()
            self.assertEqual(row(sid)["phase"],"done")
        # Even after POST permission fails, a new team must not bypass the auth hold.
        eighth=submit()
        creation="denied";tick()
        self.assertEqual(row(eighth)["phase"],"access")
        ninth=submit(1)
        self.assertFalse(tick())
        self.assertIsNone(row(ninth))
        self.assertEqual(len(creates),7)
        self.assertFalse(db.execute("SELECT EXISTS(SELECT FROM review_mail WHERE state IN ('sent','local')) AS sent").fetchone()["sent"])


if __name__=="__main__":unittest.main()
