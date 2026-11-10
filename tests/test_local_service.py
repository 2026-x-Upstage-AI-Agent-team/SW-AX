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
from tests.official_inputs import fixture_slot, official_files


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
        self.scope.enter_context(patch.object(web,"settings",return_value={"MAIL_MODE":"local"}))
        # Any unexpected external request is a test failure.
        self.scope.enter_context(patch.object(studio,"client",side_effect=AssertionError("unexpected network request")))
        db.initialize()
        self.client = TestClient(web.app,base_url="http://127.0.0.1",headers={"X-Award-Client":"staff"})
        self.scope.callback(self.client.close)

    def upload(self, items, key, **fields):
        manifest = [{"name":name,"size":len(value)} for name,value in items]
        return self.client.post("/api/intake-batches",headers={"Idempotency-Key":key},
            files=[("files",(n,b)) for n,b in items],data={"manifest":json.dumps(manifest),"event":"wave",**fields})

    def test_document_edit_versions_are_separate_from_receipt(self):
        original, edited = official("set04")
        receipt = self.upload([original], "edit-versions").raise_for_status().json()
        fid = self.client.get("/api/intake-batches/" + receipt["batch_id"]).json()["files"][0]["id"]
        path = f"/api/files/{fid}/versions"
        def save(base, data):
            return self.client.post(path, data={"baseVersion": str(base)}, files={"document": ("edit.hwpx", data)})
        self.assertEqual([], self.client.get(path).json()["versions"])
        self.assertEqual(415, save(0, original[1]).status_code)
        first = save(0, edited[1]).raise_for_status().json()
        self.assertTrue(first["saved_at"])
        self.assertEqual(first, save(0, edited[1]).json())
        other = next(data for name, data in official("set01") if name.lower().endswith(".hwpx"))
        self.assertEqual(409, save(0, other).status_code)
        self.assertEqual(2, save(1, other).json()["version"])
        self.assertEqual([2, 1], [v["version"] for v in self.client.get(path).json()["versions"]])
        for i, data in enumerate((original[1], edited[1], other)):
            self.assertEqual(data, self.client.get(f"{path}/{i}/content").raise_for_status().content)

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
                application = fixture_slot(f["name"]) == "01"
                roster = [{"name":"김종인","major":""}]
                return ("01" if application else "03",1,{"body":"","identity":"","mixed":False,"consent":[],"page":1,
                        "apps":[{"name":"가상검토팀04","rep":"김종인","roster":roster}] if application else []})
            def stub_input(files, config, agent):
                return {"input":[{"role":"user","content":[{"source_hash":f["hash"]} for f in files]}]}
            self.scope.enter_context(patch.object(worker,"read_signals",side_effect=observed))
            self.scope.enter_context(patch.object(studio,"payload",side_effect=stub_input))
        batch=self.upload(items,"set04-offline").json()["batch_id"]
        url="/api/intake-batches/"+batch
        for _ in range(len(items)+1):
            self.assertEqual(len(items), self.client.get("/api/dashboard").json()["batches"][0]["pending"])
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
        self.assertEqual(0, self.client.get("/api/dashboard").json()["batches"][0]["pending"])
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
        mail_url="/api/mail/"+mail["id"]
        draft=self.client.get(mail_url).json()
        self.assertEqual("draft",draft["state"])
        self.assertIn("개인정보 동의서",draft["body"])
        self.assertEqual(200,self.client.post(mail_url+"/approve",json=draft).status_code)
        worker.deliver(mail,{"MAIL_MODE":"local"})
        message=self.client.get(mail_url).json()
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

    def test_report_team_name_uses_the_agent_and_preserves_staff_corrections(self):
        from reporting.fill_award_form import display
        from service.mail_drafts import detail

        fields = {"team_name": "이전 등록 팀명", "award_type": "대상", "support_amount": "100",
                  "members": [{"role": "대표", "name": "담당자 수정 성명", "student_id": "00000001"}],
                  "recipient": {"bank_name": "담당자 수정 은행", "gross_amount": "100", "tax_amount": "0", "net_amount": "100"}}
        for i, name in enumerate(("API 팀명", "", None, "  ")):
            sid = f"source-{i}"
            result = {"rep": "", "members": [{"role": "대표", "name": "추출 성명"}],
                      "documents": {**{k: [{"id": k}] for k in ("01", "02", "03")}, "?": []}}
            if name is not None:
                result["team_name"] = name
            with db.database(True) as con:
                con.execute("INSERT INTO teams(id,event,name,rep,current) VALUES(?,'wave',?,'등록 대표',?)",
                            (sid, f"등록 팀명 {i}", sid))
                con.execute("""INSERT INTO submissions(id,team,version,files,digest,created,updated,state,decision,result,fields)
                    VALUES(?,?,1,'[]','test',1,1,'done','승인',?,?)""", (sid, sid, db.dump(result), db.dump(fields)))
            draft = next(t for t in self.client.get("/api/events/wave/draft").raise_for_status().json()["teams"] if t["submission"] == sid)
            self.assertEqual(draft["team"], name or "")
            self.assertEqual(draft["rep"], "")
            rid = self.client.post("/api/reports", json={"event": "wave", "submissions": [sid]}).raise_for_status().json()["id"]
            with db.database() as con:
                saved = json.loads(workflow.require(con, "reports", rid)["snapshot"])["teams"][0]
                notice = detail(con, {"submission": sid, "kind": "검토 완료", "state": "draft", "subject": None, "body": None},
                                {"MAIL_MODE": "local"})
            self.assertEqual(saved["team_name"], name or "")
            self.assertEqual(saved["members"], fields["members"])
            self.assertEqual(saved["recipient"], fields["recipient"])
            self.assertEqual(display(saved["team_name"]), "API 팀명" if name == "API 팀명" else "미확인")
            self.assertTrue(notice["subject"].endswith("API 팀명" if name == "API 팀명" else "미확인"))
            self.assertNotIn(f"등록 팀명 {i}", notice["body"])

    def test_report_checks_only_included_teams_and_requires_all_payouts(self):
        result = {"verdict":"성공","program":db.WAVE,"documents":{k:[{"id":k}] for k in ("01","02","03")}}
        result["documents"]["?"] = []
        fields = {"award_type":"대상","support_amount":"100","members":[],
                  "recipient":{"gross_amount":"100","tax_amount":0,"net_amount":"100"}}
        with db.database(True) as con:
            for team in ("A","B"):
                con.execute("INSERT INTO teams(id,event,name,current) VALUES(?,'wave',?,?)",(team,team,team))
                con.execute("""INSERT INTO submissions(id,team,version,files,digest,created,updated,state,decision,result,fields)
                    VALUES(?,?,1,'[]','test',1,1,'done',?,?,?)""",
                    (team,team,"승인" if team=="A" else None,db.dump(dict(result,team_name=team)),db.dump(fields) if team=="A" else None))
        order=lambda selection:self.client.post("/api/reports",json={"event":"wave","submissions":selection})
        pay=dict(award_type="대상",support_amount="100",gross_amount="100",tax_amount="0",net_amount="100")
        review=dict(revision=0,decision="승인",note="",members=[{"role":"대표","name":"대표"}],recipient={})
        self.assertEqual(self.client.put("/api/submissions/B/payment",json=dict(pay,revision=0)).status_code,409)
        self.client.put("/api/submissions/B/review",json=review).raise_for_status()
        b=next(t for t in self.client.get("/api/events/wave/draft").json()["teams"] if t["submission"]=="B")
        self.assertEqual((b["pending"],b["missing_payouts"]),([],["시상구분","지원액","지급총액","세액","차인지급액"]))
        self.client.put("/api/submissions/B/payment",json=dict(pay,tax_amount="",revision=1)).raise_for_status()
        blocked=order(["A","B"])
        self.assertEqual(blocked.status_code,409)
        self.assertIn("B · 세액",blocked.json()["detail"])
        with db.database() as con:
            self.assertEqual(con.execute("SELECT count(*) FROM reports").fetchone()[0],0)
        rid=order(["A"]).raise_for_status().json()["id"]
        url="/api/reports/"+rid
        with db.database(True) as con:
            con.execute("UPDATE reports SET state='preview' WHERE id=?",(rid,))
        self.assertEqual(self.client.post(url+"/confirm").status_code,200)
        self.assertEqual(self.client.put("/api/submissions/B/payment",json=dict(pay,revision=1)).status_code,409)
        self.client.put("/api/submissions/B/payment",json=dict(pay,revision=2)).raise_for_status()
        self.client.put("/api/submissions/B/review",json=dict(review,revision=3,note="원본 확인")).raise_for_status()
        combined=order(["A","B"]).raise_for_status().json()["id"]
        self.assertEqual(self.client.get("/api/reports/"+combined).json()["missing_payouts"],[])
        # An old preview with a missing tax may still exist when the service is upgraded.
        with db.database(True) as con:
            con.execute("UPDATE reports SET state='preview',snapshot=json_set(snapshot,'$.teams[1].recipient.tax_amount','') WHERE id=?",(combined,))
        self.assertEqual(self.client.post("/api/reports/"+combined+"/confirm").status_code,409)
        self.upload([("미상.hwpx",official("set01")[0][1])],"other-receipt",target="B").raise_for_status()
        self.assertFalse(self.client.get(url).json()["stale"])
        self.assertEqual(self.client.post(url+"/confirm").status_code,200)

    def test_partial_extraction_can_be_saved_and_corrected_before_approval(self):
        source = {"verdict":"성공", "program":"가상 대회", "members":[
            {"role":"대표", "name":"", "student_id":"00202601", "major":"가상학과", "school":"가상대학교"}],
            "recipient":{"bank_name":"가상은행", "account_number":"001-0002", "rrn_display":"020101 - XXXXXXX"},
            "extracted":{"Information Extract - 지급확인서":[{"representative_student_id":"00202601"}]}}
        with db.database(True) as con:
            con.execute("INSERT INTO teams(id,event,name,current) VALUES('transfer','wave','가상팀','transfer')")
            con.execute("""INSERT INTO submissions(id,team,version,files,digest,created,updated,state,result)
                VALUES('transfer','transfer',1,'[]','test',1,1,'done',?)""",(db.dump(source),))
        body = {"revision":0, "decision":"작성 중", "note":"원본 대조", "members":source["members"], "recipient":source["recipient"]}
        self.client.put('/api/submissions/transfer/review',json=body).raise_for_status()
        detail = self.client.get('/api/submissions/transfer').raise_for_status().json()
        self.assertEqual(detail["fields"]["members"],source["members"])
        self.assertEqual(detail["fields"]["recipient"]["rrn_display"],source["recipient"]["rrn_display"])
        self.assertEqual(detail["result"]["extracted"],source["extracted"])
        body.update(revision=detail["revision"], decision="승인")
        self.assertEqual(self.client.put('/api/submissions/transfer/review',json=body).status_code,409)
        body["members"] = [dict(source["members"][0],name="가상대표")]
        self.client.put('/api/submissions/transfer/review',json=body).raise_for_status()
        detail = self.client.get('/api/submissions/transfer').raise_for_status().json()
        self.assertEqual(detail["fields"]["members"][0]["name"],"가상대표")
        self.assertEqual(detail["fields"]["recipient"]["account_number"],"001-0002")

    def test_explicit_same_origin_requests(self):
        self.assertEqual(403,self.client.post("/api/events",headers={"Origin":"https://outside.test"},json={"name":"x"}).status_code)
        self.assertEqual(400,self.client.get("/api/dashboard",headers={"Host":"outside.test"}).status_code)


if __name__=="__main__":
    unittest.main()
