"""Durability and ownership checks with official inputs. Studio traffic stays in MockTransport."""
import json
import os
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient

from service import app as web
from service import db, documents, studio, worker, workflow
from tests.official_inputs import official_files


def official(case):
    try:
        return official_files(case)
    except FileNotFoundError as exc:
        raise unittest.SkipTest(str(exc)) from exc


class LocalServiceTests(unittest.TestCase):
    def setUp(self):
        root = db.ROOT / "var" / "tests"
        root.mkdir(parents=True,exist_ok=True)
        self.scope = ExitStack()
        self.addCleanup(self.scope.close)
        location = Path(self.scope.enter_context(tempfile.TemporaryDirectory(dir=root)))
        for mod in (db,web,documents,worker):
            self.scope.enter_context(patch.object(mod,"DATA",location))
        self.scope.enter_context(patch.object(worker,"settings",return_value={"MAIL_MODE":"local","UPSTAGE_AGENT_ID":"test-agent"}))
        # Any unexpected external request is a test failure.
        self.scope.enter_context(patch.object(studio,"client",side_effect=AssertionError("unexpected network request")))
        db.initialize()
        self.client = TestClient(web.app,base_url="http://127.0.0.1",headers={"X-Award-Client":"staff"})
        self.scope.callback(self.client.close)

    def upload(self, items, key, **fields):
        manifest = [{"name":name,"size":len(value)} for name,value in items]
        return self.client.post("/api/intake-batches",headers={"Idempotency-Key":key},
            files=[("files",(n,b)) for n,b in items],data={"manifest":json.dumps(manifest),"event":"wave",**fields})

    def test_replays_and_interrupted_storage(self):
        items = official("set01")
        with ThreadPoolExecutor(2) as pool:
            results = list(pool.map(lambda _:self.upload(items,"one-request").json(),range(2)))
        self.assertEqual(results[0]["batch_id"],results[1]["batch_id"])
        self.assertEqual(409,self.upload([("새 이름.hwp",items[0][1])],"one-request").status_code)
        self.assertEqual(415,self.upload([("00. 지급내역서.hwp",items[0][1])],"reject-template").status_code)
        r=self.client.post("/api/intake-batches",headers={"Idempotency-Key":"missing-file"},files=[("files",items[0])],
            data={"event":"wave","manifest":json.dumps([{"name":n,"size":len(v)} for n,v in items])})
        self.assertEqual(422,r.status_code)
        with patch.object(Path,"open",side_effect=OSError("no space")):
            with self.assertRaises(OSError):
                self.upload(items,"disk-failure")
        with db.database() as con:
            self.assertEqual(1,con.execute("SELECT count(*) FROM batches").fetchone()[0])
            self.assertEqual(0,con.execute("SELECT count(*) FROM submissions").fetchone()[0])
        self.assertEqual(1,len(list((web.DATA/"files").iterdir())))

    def test_assignment_evidence_and_conflicts(self):
        teams=[{"id":"a","name":"AI","rep":"대표가","roster":[{"name":"대표가","major":"학부"},{"name":"공통인","major":"가과"},{"name":"학생가","major":"가과"}]},
               {"id":"b","name":"AI팀","rep":"대표나","roster":[{"name":"대표나","major":"나과"},{"name":"공통인","major":"나과"}]}]
        sig={"apps":[],"body":"","identity":"","consent":[{"name":"대표가","major":"학부"},{"name":"학생가","major":"가과"}],"page":2}
        choice=lambda kind,s,name="공통파일.hwp",target=None:documents.match_file({"kind":kind,"name":name},s,teams,target)
        self.assertEqual("a",choice("02",sig)[0])
        self.assertIsNone(choice("02",dict(sig,consent=[{"name":"공통인","major":"가과"}]))[0])
        self.assertIsNone(choice("03",dict(sig,identity="대표가"))[0])
        self.assertEqual("a",choice("03",dict(sig,identity="대표가"),"03_AI.hwp")[0])
        self.assertIsNone(choice("03",dict(sig,identity="대표가",body="AI팀"),"03_AI.hwp")[0])
        self.assertIsNone(choice("?",dict(sig,mixed=True),target="a")[0])

    def test_set04_offline_from_originals_to_one_local_message(self):
        items=official("set04")
        self.assertEqual(2,len(items))
        # On a desktop with Hangul ready, also exercise native rendering and the real PDF payload builder.
        # Ordinary regression runs replay the set04 reading at this boundary without opening a security dialog.
        if os.environ.get("AWARD_NATIVE_TESTS") != "1":
            def observed(f):
                application = "신분증" not in f["name"]
                roster = [{"name":"김종인","major":""}]
                return ("01" if application else "03",1,{"body":"","identity":"","mixed":False,"consent":[],"page":1,
                        "apps":[{"name":"3팀","rep":"김종인","roster":roster}] if application else []})
            def stub_input(files, config, agent):
                return {"input":[{"role":"user","content":[{"source_hash":f["hash"]} for f in files]}]}
            self.scope.enter_context(patch.object(worker,"read_signals",side_effect=observed))
            self.scope.enter_context(patch.object(studio,"payload",side_effect=stub_input))
        batch=self.upload(items,"set04-offline").json()["batch_id"]
        url="/api/intake-batches/"+batch
        for _ in range(len(items)+1):
            with db.database() as con:
                b=workflow.require(con,"batches",batch)
            worker.prepare(b)
        details=self.client.get(url).json()
        self.assertEqual({"01","03"},{f["kind"] for f in details["files"]})
        team,=self.client.get("/api/dashboard").json()["teams"]
        for f in details["files"]:
            if f["state"]=="unassigned":
                cmd={"action":"assign","team":team["id"],"revision":self.client.get(url).json()["revision"],"reason":"공식 set04 원접수 대조"}
                self.assertEqual(200,self.client.put(url+"/files/"+f["id"]+"/assignment",json=cmd).status_code)
                self.assertEqual(200,self.client.put(url+"/files/"+f["id"]+"/assignment",json=cmd).status_code)
        sid,= [t["submission_id"] for t in self.client.get(url).json()["teams"]]
        calls=[]
        def remote(req):
            calls.append((req.method,req.url.path))
            if req.url.path.endswith("/configs/23"):
                return httpx.Response(200,json={"id":"cfg_offline"})
            if req.method=="POST":
                self.assertEqual(2,len(json.loads(req.content)["input"][0]["content"]))
                return httpx.Response(200,json={"id":"job_offline04"})
            return httpx.Response(200,json={"id":"job_offline04","status":"completed","output":[
                {"model":"Instruct - 최종판정","content":[{"text":json.dumps({"enum":"재제출요청","reason":"02 개인정보 동의서 누락"})}]}]})
        def sub():
            with db.database() as con:
                return workflow.require(con,"submissions",sid)
        with patch.object(studio,"client",lambda cfg:httpx.Client(transport=httpx.MockTransport(remote),base_url="https://offline.test/v2/")):
            worker.run_studio(sub())
            worker.run_studio(sub())
            worker.run_studio(sub())  # A repeated completed response also goes through the unique outbox.
        with db.database() as con:
            mail,=db.rows(con,"SELECT * FROM mail")
        worker.deliver(mail,{"MAIL_MODE":"local"})
        message=self.client.get("/api/mail/"+mail["id"]).json()
        self.assertEqual("local",message["state"])
        self.assertIn("개인정보 동의서",message["body"])
        self.assertNotRegex(message["body"],r"\d{6}|@")
        self.assertEqual(1,sum(method=="POST" for method,_ in calls))
        self.assertEqual(200,self.upload(items,"set04-offline").status_code)
        self.assertEqual(1,len(list((web.DATA/"mail").glob("*.eml"))))
        # Correct only one existing item, preserving the rest, including multiple identical copies.
        old=sub()
        old_files=json.loads(old["files"])
        new=self.upload([items[1],items[1]],"set04-correction",target=team["id"],base=sid,removed=json.dumps([old_files[1]]))
        self.assertEqual(202,new.status_code)
        with db.database(True) as con:
            b=workflow.require(con,"batches",new.json()["batch_id"])
            con.execute("UPDATE files SET team=?,state='assigned' WHERE batch=?",(team["id"],b["id"]))
            workflow.synchronize(con,b)
            current=workflow.require(con,"teams",team["id"])["current"]
            second=workflow.require(con,"submissions",current)
            self.assertEqual((2,3),(second["version"],len(json.loads(second["files"]))))
            self.assertIn(old_files[0],json.loads(second["files"]))
        self.assertEqual(409,self.client.post("/api/reports",json={"event":"wave","submissions":[sid]}).status_code)

    def test_timeout_and_existing_job_recovery(self):
        with db.database(True) as con:
            con.execute("INSERT INTO teams(id,event,name,current) VALUES('a','wave','테스트','s')")
            con.execute("INSERT INTO submissions(id,team,version,files,digest,created,updated) VALUES('s','a',1,'[]','digest',1,1)")
        def sub():
            with db.database() as con:
                return workflow.require(con,"submissions","s")
        worker.failure(sub(),httpx.ReadTimeout("offline"),creating=True)
        self.assertEqual("uncertain",sub()["state"])
        self.assertEqual(409,self.client.post("/api/submissions/s/retry",json={}).status_code)
        self.client.post("/api/submissions/s/retry",json={"job":"job_known"})
        for _ in range(4):
            worker.failure(sub(),httpx.ReadTimeout("offline"))
        self.assertEqual(("paused","job_known"),(sub()["state"],sub()["job"]))
        self.client.post("/api/submissions/s/retry",json={})
        self.assertEqual(("polling","job_known",0),(sub()["state"],sub()["job"],sub()["attempts"]))

    def test_explicit_same_origin_requests(self):
        self.assertEqual(403,self.client.post("/api/events",headers={"Origin":"https://outside.test"},json={"name":"x"}).status_code)
        self.assertEqual(400,self.client.get("/api/dashboard",headers={"Host":"outside.test"}).status_code)


if __name__=="__main__":
    unittest.main()
