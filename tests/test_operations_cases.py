"""Exercise real local reading and delivery on official fixtures with controlled Studio results."""
import json
import os
import unittest
from collections import Counter
from pathlib import Path
from uuid import uuid4
from zipfile import ZipFile

import httpx

from operations.delivery import deliver
from operations.preparation import prepare
from operations.store import cached_file, configuration, connect
from service.db import DATA, ROOT
from service.documents import match_file
from service.studio import parse_result
from tests.test_intake_postgres import login


class AssignmentEvidence(unittest.TestCase):
    def test_conflicting_and_incomplete_evidence(self):
        teams = [{"id":"a","name":"Alpha","rep":"가나다","roster":[{"name":"가나다","major":"전산"},{"name":"한가람","major":"전산"}]},
                 {"id":"b","name":"Beta","rep":"라마바","roster":[{"name":"라마바","major":"정보"},{"name":"한가람","major":"정보"}]}]
        def classify(kind, name, **values):
            signals = dict(body="",apps=[],consent=[],identity="",mixed=False,page=1)
            signals.update(values)
            chosen, candidates, _ = match_file({"name":name,"kind":kind},signals,teams,None)
            return chosen,candidates,signals["mixed"]
        self.assertEqual(classify("02","동의.hwp",consent=[{"name":"한가람","major":"정보"}]),(None,{"a","b"},False))
        self.assertEqual(classify("01","Beta.hwp",apps=[{"name":"Alpha","rep":"가나다"}]),(None,{"a","b"},False))
        self.assertEqual(classify("03","사본.hwpx",identity="가나다"),(None,{"a"},False))
        self.assertEqual(classify("03","Alpha대회.hwpx"),(None,{"a"},False))
        people=[{"name":"가나다","major":"전산"},{"name":"라마바","major":"정보"}]
        self.assertEqual(classify("02","합본.hwp",consent=people),(None,{"a","b"},True))
        teams[1]["name"]="Alpha"
        self.assertEqual(classify("02","Alpha.hwp",consent=[{"name":"한가람","major":"정보"}]),(None,{"a","b"},False))


@unittest.skipUnless(os.getenv("AWARDS_OFFLINE_CASES")=="1","Requires an isolated DB, Hancom and the official ZIP.")
class OfficialCases(unittest.TestCase):
    def test_account_duplicate_and_partial_consent(self):
        cfg=configuration()
        url=os.environ["INTAKE_TEST_URL"]
        self.assertEqual((httpx.URL(url).host,cfg["MAIL_MODE"]),("127.0.0.1","local"))
        self.assertEqual(httpx.URL(cfg["AWARDS_DB_URL"].removeprefix("jdbc:")).host,"127.0.0.1")
        db=connect(cfg)
        self.addCleanup(db.close)
        self.assertFalse(db.execute("SELECT EXISTS(SELECT FROM intake_batch) AS used").fetchone()["used"])
        staff=httpx.Client(base_url=url,timeout=60,trust_env=False)
        api=httpx.Client(base_url=url+"/api/worker/",headers={"Authorization":"Bearer "+cfg["AWARDS_REVIEW_WORKER_TOKEN"]})
        self.addCleanup(staff.close)
        self.addCleanup(api.close)
        login(staff,os.environ["INTAKE_TEST_LOGIN_A"],os.environ["INTAKE_TEST_PASSWORD_A"])
        event=staff.post("/api/events",json={"name":"공식 오류 사례 검증"}).raise_for_status().json()["id"]
        with ZipFile(ROOT/"test case"/"유잇_미션2_테스트set.zip") as archive:
            for case in ("set03","set04","set05","set10"):
                with self.subTest(case=case):
                    docs=[(Path(n).name,archive.read(n)) for n in archive.namelist()
                          if Path(n).parent.name==case and Path(n).suffix.lower() in (".hwp",".hwpx")]
                    count = 2 if case == "set04" else 3
                    self.assertEqual(len(docs),count)
                    fields={"event":event,"manifest":json.dumps([{"name":n,"size":len(v)} for n,v in docs])}
                    if case == "set04":
                        # The application inside set04 names its team "3팀".
                        team = staff.post(f"/api/events/{event}/teams", json={"name":"3팀","rep":""}).raise_for_status().json()["id"]
                        fields["target"] = team
                    bid=staff.post("/api/intake-batches",data=fields,headers={"Idempotency-Key":str(uuid4())},
                                   files=[("files",(n,v)) for n,v in docs]).raise_for_status().json()["batch_id"]
                    if case == "set04":
                        receipt = f"/api/intake-batches/{bid}"
                        items = staff.get(receipt).raise_for_status().json()["files"]
                        for revision, item in enumerate(items):
                            staff.put(f"{receipt}/files/{item['item_id']}/assignment", json={
                                "team": team, "action": "assign", "revision": revision, "reason": "공식 자료 판독 전 수동 배정 시험"
                            }).raise_for_status()
                        def confirm():
                            return staff.put(f"{receipt}/teams/{team}/submission", json={"revision": count})
                        for read in range(count + 1):
                            self.assertEqual(db.execute("""SELECT count(*) AS n FROM original_analysis a JOIN intake_file f
                                ON a.file_id=f.id WHERE f.batch_id=%s AND a.pdf IS NOT NULL""", (bid,)).fetchone()["n"], read)
                            denied = confirm()
                            self.assertEqual(denied.status_code, 409)
                            self.assertIn("판독", denied.json()["detail"])
                            self.assertEqual(staff.get(receipt).json()["teams"], [])
                            self.assertFalse(db.execute("SELECT 1 FROM review_job_status WHERE team_id=%s", (team,)).fetchone())
                            self.assertEqual(api.post("review-jobs/claim", json={"event_id":event,"worker_id":"early"}).status_code, 204)
                            self.assertTrue(prepare(db, api))
                        link = confirm().raise_for_status().json()
                        self.assertEqual(link, confirm().raise_for_status().json())
                        self.assertEqual(db.execute("SELECT count(*) AS n FROM review_job_status WHERE team_id=%s", (team,)).fetchone()["n"], 1)
                    while prepare(db,api):
                        pass
                    def detail():
                        return staff.get("/api/operations/batches/"+bid).raise_for_status().json()
                    batch=detail()
                    self.assertEqual(len(batch["files"]),count)
                    team=next(f["team"] for f in batch["files"] if f["kind"]=="01")
                    for f in batch["files"]:
                        if not f["team"]:
                            # set10 has two of three signers and 학과/학부 disagree. The operator checks the source.
                            if case=="set10" and f["kind"]=="02":
                                self.assertIn(team,f["candidates"])
                            else:
                                self.assertEqual(f["kind"],"03","전체 명단이 맞는 02는 자동 배정합니다.")
                            staff.put(f"/api/intake-batches/{bid}/files/{f['id']}/assignment",
                                      json={"action":"assign","team":team,"revision":detail()["revision"],
                                            "reason":"시험 접수 목록과 대표 원본 대조"}).raise_for_status()
                    files=[cached_file(db,f["id"]) for f in batch["files"]]
                    kinds=Counter(f["kind"] for f in files)
                    print(case,"원본 판독",dict(kinds),flush=True)
                    expected_kinds = {"set04":{"01":1,"03":1},"set05":{"01":1,"02":2}}
                    self.assertEqual(kinds,Counter(expected_kinds.get(case, {"01":1,"02":1,"03":1})))
                    app=next(json.loads(f["signals"])["apps"][0] for f in files if f["kind"]=="01")
                    names=app["roster"]
                    consent=next((json.loads(f["signals"])["consent"] for f in files if f["kind"]=="02"), [])
                    if case=="set10":
                        self.assertGreater(len(names),len(consent))
                        self.assertGreaterEqual(len(consent),2)
                    structured={"Information Extract - 지급확인서":{"team_name":app["name"],"representative_name":app["rep"],
                                "representative_department":names[0]["major"],"representative_account":"00100",
                                "members":[{"name":p["name"],"department":p["major"]} for p in names[1:]]},
                                "Information Extract - 개인정보동의":{"beneficiaries":[dict(p,department=p["major"],
                                    signed=True,collection_consent=True,identifier_consent=True,third_party_consent=True) for p in consent]},
                                "Instruct - 최종판정":{"enum":"재제출요청","reason":"통제된 오류 사례 판정"}}
                    if case!="set05":
                        structured["Information Extract - 신분증정보"]={"account_holder":app["rep"],"account_number":"00999" if case=="set03" else "00100"}
                    result=parse_result({"output":[{"model":k,"content":[{"text":v}]} for k,v in structured.items()]},files)
                    expected={"set03":{"account"},"set04":{"consent"},"set05":{"duplicate","identity"},"set10":{"consent"}}[case]
                    self.assertTrue(expected<=set(result["issues"]))
                    if case=="set03":
                        refs=next(c["refs"] for c in result["checks"] if "예금주" in c["label"])
                        self.assertEqual({r["id"] for r in refs},{f["id"] for f in files if f["kind"] in ("01","03")})
                    staff.put(f"/api/teams/{team}/email",json={"email":case+"@award.test"}).raise_for_status()
                    job=api.post("review-jobs/claim",json={"worker_id":"controlled","event_id":event}).raise_for_status().json()
                    self.assertEqual(job["submission_id"],detail()["teams"][0]["submission_id"])
                    self.assertEqual({x["item_id"] for x in job["files"]},{f["id"] for f in files})
                    api.put("review-jobs/"+job["review_job_id"]+"/result",headers={"X-Claim-Token":job["claim_token"]},
                            json={"state":"done","studio_job_id":"job_mock_"+job["review_job_id"],"verdict":result["verdict"],"reason":result["reason"],"output":result}).raise_for_status()
                    while deliver(db,cfg):
                        pass
                    notices=db.execute("SELECT id,kind,state FROM review_mail WHERE submission_id=%s",(job["submission_id"],)).fetchall()
                    self.assertEqual({m["kind"]:m["state"] for m in notices},{"담당자 알림":"local","보완 요청":"local"})
                    self.assertEqual(len(notices),2)
                    self.assertTrue(all((DATA/"operations/mail"/(str(m["id"])+".eml")).is_file() for m in notices))
