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
from tests.mail_approval import approve_ready_notices
from tests.official_inputs import ARCHIVE, fixture_slot, official_files
from operations.preparation import prepare
from operations.store import cached_file, configuration, connect
from service.db import DATA
from service.documents import match_file
from service.studio import parse_result
from tests.test_intake_postgres import login


class ReviewEvidence(unittest.TestCase):
    def test_agent_evidence_in_checks_and_safe_leader_mail(self):
        validate = "01 대표 성명과 03 신분증 성명이 일치하는가"
        reason = "01 지급확인서 2쪽 첫째 행에 학번이 없습니다. 원문 참조 123456-1234567."
        job = {"output":[{"model":"Validate - 증빙검증","content":[{"additional_values":{"checks":[{"name":validate,"passed":False}]}}]},
                         {"model":"Instruct - 최종판정","content":[{"text":{"enum":"재제출요청","reason":reason}}]}]}
        files = [{"id":"doc"+k,"kind":k,"signals":"{}","pages":2} for k in ("01","02","03")]
        result = parse_result(job,files)
        self.assertEqual(result["reason"],reason)
        checks = {c["label"]:c for c in result["checks"]}
        self.assertEqual(checks[validate]["refs"],[{"id":"doc01","page":1},{"id":"doc03","page":1}])
        self.assertEqual(checks[reason.split(". ")[0]+"."]["refs"],[{"id":"doc01","page":2,"row":1}])
        self.assertIn("student_id",result["issues"])
        self.assertIn("representative",result["issues"])

        final = {"enum":"재제출요청","reason":"01 학번은 누락 없이 기재됐습니다. 03 신분증이 없습니다."}
        result = parse_result({"output":[{"model":"Instruct - 최종판정","content":[{"text":final}]}]}, files[:2])
        self.assertEqual(result["verdict"],"재제출요청")
        self.assertNotIn("student_id",result["issues"])
        self.assertIn("identity",result["issues"])

    def test_repeated_student_id_preserves_the_agent_verdict_and_reason(self):
        application = {"representative_name":"대표", "representative_student_id":"1001",
                       "members":[{"name":"팀원", "student_id":"1001"}]}
        for verdict, reason in (("성공","증빙 확인 완료"), ("담당자확인","학번 중복 확인 필요")):
            with self.subTest(verdict=verdict):
                job = {"output":[{"model":"Information Extract - 지급확인서","content":[{"text":application}]},
                                 {"model":"Instruct - 최종판정","content":[{"text":{"enum":verdict,"reason":reason}}]}]}
                result = parse_result(job, [{"id":"form","kind":"01","signals":"{}"}])
                self.assertEqual((result["verdict"], result["reason"]), (verdict, reason))
                self.assertEqual([m["student_id"] for m in result["members"]], ["1001","1001"])

    def test_only_representative_addresses_from_submitted_applications_are_candidates(self):
        app = {"representative_email":" studio@award.test ","members":[{"name":"팀원","email":"member@award.test"}]}
        job = {"output":[{"model":"Information Extract - 지급확인서","content":[{"text":app}]},
                         {"model":"Instruct - 최종판정","content":[{"text":{"enum":"재제출요청","reason":"서류 누락"}}]}]}
        signals = {"apps":[{"representative_emails":["form@award.test"]}]}
        file = {"id":"f","kind":"01","signals":json.dumps(signals)}
        self.assertEqual(parse_result(job,[file])["representative_emails"],["form@award.test","studio@award.test"])
        self.assertEqual(parse_result(job,[dict(file,kind="03")])["representative_emails"],[])

    def test_report_bank_name_uses_the_studio_extract(self):
        cases = [
            ("국민", ["KB 국민은행"]),
            ("국민", ["은행명: KB국민은행 통장사본"]),
            ("카카오", ["한국카카오은행(주) 확인서"]),
            ("토스뱅크", ["토스뱅크"]),
            ("국민", ["KB 국민은행", "국민은행"]),
            ("", ["KB 국민은행"]),
        ]
        files = [{"id":"copy","kind":"03","signals":"{}"}]
        for bank, lines in cases:
            with self.subTest(bank=bank, lines=lines):
                job = {"output":[
                    {"model":"step_1_parse","content":[{"text":{"elements":[
                        {"page":1,"content":{"text":line}} for line in lines
                    ]}}]},
                    {"model":"step_2_classify","content":[{"text":"신분증·통장 사본",
                        "additional_values":{"page_ranges":[[1,1]]}}]},
                    {"model":"Information Extract - 신분증정보","content":[{"text":{"bank_name":bank}}]},
                    {"model":"Instruct - 최종판정","content":[{"text":{"enum":"성공","reason":"증빙 확인 완료"}}]},
                ]}
                result = parse_result(job, files)
                self.assertEqual(result["recipient"]["bank_name"], bank)
                self.assertEqual(result["verdict"], "성공")

    def test_report_fields_preserve_the_extracted_values(self):
        application = {
            "program_name":"가상 대회", "team_name":"가상 팀", "representative_name":"김예린",
            "representative_student_id":"00202601", "representative_affiliation":"가상대학교",
            "representative_department":"컴퓨터공학과",
            "members":[{"name":"이서준","student_id":"00202602", "affiliation":"가상대학교",
                        "department":"인공지능학과"}],
        }
        job = {"output":[
            {"model":"Information Extract - 지급확인서","content":[{"text":application}]},
            {"model":"Information Extract - 신분증정보","content":[{"text":{
                "bank_name":"NH농협은행", "account_number":"001-002-0003", "account_holder":"김예린",
            }}]},
            {"model":"step_1_parse","content":[{"text":{"elements":[
                {"page":3,"content":{"text":"020101-3******"}},
            ]}}]},
            {"model":"step_2_classify","content":[{"text":"신분증·통장 사본",
                "additional_values":{"page_ranges":[[3,3]]}}]},
            {"model":"Instruct - 최종판정","content":[{"text":{"enum":"성공","reason":"증빙 확인 완료"}}]},
        ]}
        result = parse_result(job, [{"id":"copy","kind":"03","signals":"{}"}])
        self.assertEqual((result["program"],result["team_name"],result["rep"]),
                         ("가상 대회","가상 팀","김예린"))
        self.assertEqual(result["members"], [
            {"role":"대표","name":"김예린","student_id":"00202601","school":"가상대학교","major":"컴퓨터공학과"},
            {"role":"팀원","name":"이서준","student_id":"00202602","school":"가상대학교","major":"인공지능학과"},
        ])
        self.assertEqual(result["recipient"], {
            "rrn_display":"020101-3******", "bank_name":"NH농협은행",
            "account_number":"001-002-0003", "account_holder":"김예린",
        })

    def test_member_evidence_uses_the_original_file_page_and_row(self):
        def source(fid, kind, **signals):
            return {"id": fid, "kind": kind, "signals": json.dumps(signals)}

        files = [
            source("a", "01", apps=[{"page":2,"roster":[{"name":"최가람"},{"name":"김한별"}]}]),
            source("b", "02", page=3, consent=[{"name":"최가람","page":1},{"name":"김한별","page":3}]),
            source("c", "02", page=2, consent=[{"name":"최가람","page":2}]),
        ]
        values = {
            "Instruct - 최종판정":{"enum":"재제출요청","reason":"서명 확인"},
            "Information Extract - 지급확인서":{"representative_name":"최가람","members":[{"name":"김한별"}]},
            "Information Extract - 개인정보동의":{"beneficiaries":[{"name":"최가람"},{"name":"김한별","signed":False}]},
        }
        result = parse_result({"output":[{"model":name,"content":[{"text":value}]} for name,value in values.items()]}, files)
        row = next(c for c in result["checks"] if c["label"] == "김한별 · 동의 표시 또는 서명 확인")
        self.assertEqual(row["refs"], [{"id":"a","page":2,"row":2},{"id":"b","page":3,"row":1}])

    def test_validate_uses_its_extract_nodes_and_only_names_the_field_in_mail(self):
        def operand(node,field,value):
            return {"nodeType":"extract","nodeName":node,"field":field,"value":value}
        phone = operand("지급확인서","representative_phone","010-private")
        consent = operand("개인정보동의","project_name","private program")
        checks = [{"name":"전화 길이","passed":False,"conditions":{"kind":"condition","left":phone}},
                  {"name":"코드 대조","passed":True,"conditions":{"conditions":[{"left":phone,"right":consent}]}}]
        job = {"output":[{"model":"Validate - 증빙검증","content":[{"additional_values":{"checks":checks}}]},
                         {"model":"Instruct - 최종판정","content":[{"text":{"enum":"재제출요청","reason":"전화 길이를 확인하세요."}}]}]}
        files = [{"id":k,"kind":k,"signals":"{}"} for k in ("01","02","03")]
        result = parse_result(job,files)
        grouped = {c["label"]:c for c in result["checks"]}
        self.assertEqual(grouped["전화 길이"]["refs"],[{"id":"01","page":1}])
        self.assertEqual(grouped["코드 대조"]["refs"],[{"id":"01","page":1},{"id":"02","page":1}])
        self.assertEqual(grouped["전화 길이"]["fields"],["representative_phone"])


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
        self.assertEqual(classify("03","Alpha.hwpx",identity="가나다\n라마바"),(None,{"a","b"},True))
        for boundary in ("\n신분증 사본 ", "\f", "\n운전면허증 "):
            text = "신분증 가나다 통장 사본 예금주 가나다" + boundary + "라마바 통장 사본"
            self.assertEqual(classify("03","Alpha.hwpx",identity=text),(None,{"a","b"},True))
        self.assertEqual(classify("03","Alpha.hwpx",identity="가나다\f통장 사본 예금주 라마바"),("a",{"a"},False))
        people=[{"name":"가나다","major":"전산"},{"name":"라마바","major":"정보"}]
        self.assertEqual(classify("02","합본.hwp",consent=people),(None,{"a","b"},True))
        teams[1]["name"]="Alpha"
        self.assertEqual(classify("02","Alpha.hwp",consent=[{"name":"한가람","major":"정보"}]),(None,{"a","b"},False))

    def test_each_partial_consent_row_must_identify_one_team(self):
        one = {"name":"김하나","major":"전산"}
        shared = {"name":"이두리","major":"수학"}
        three = {"name":"박세진","major":"국문"}
        teams = [{"id":"a","name":"Alpha","rep":one["name"],"roster":[one,shared,three]},
                 {"id":"b","name":"Beta","rep":shared["name"],"roster":[shared]}]
        sig = dict(body="",consent=[one,shared],page=1)
        file = {"name":"동의서.hwp","kind":"02"}
        for target in (None,"a"):
            self.assertEqual(match_file(file,sig,teams,target)[:2],(None,{"a","b"}))
        teams[1]["roster"] = [dict(shared,major="물리")]
        for target in (None,"a"):
            self.assertEqual(match_file(file,sig,teams,target)[:2],("a",{"a"}))


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
        with ZipFile(ARCHIVE) as archive:
            for case in ("set03","set04","set05","set10"):
                with self.subTest(case=case):
                    docs=sorted((Path(n).name,archive.read(n)) for n in archive.namelist()
                                if Path(n).parent.parts==("upstage_data",case) and Path(n).suffix.lower() in (".hwp",".hwpx"))
                    count = 2 if case == "set04" else 3
                    self.assertEqual(len(docs),count)
                    fields={"event":event,"manifest":json.dumps([{"name":n,"size":len(v)} for n,v in docs])}
                    if case == "set04":
                        # Provide the homonymous team explicitly for this assignment regression.
                        staff.post(f"/api/events/{event}/teams", json={"name":"가상검토팀04","rep":"다른대표"}).raise_for_status()
                        team = staff.post(f"/api/events/{event}/teams", json={"name":"가상검토팀04","rep":""}).raise_for_status().json()["id"]
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
                        def confirm(revision=count):
                            return staff.put(f"{receipt}/teams/{team}/submission", json={"revision": revision})
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
                        # The application name matches both registered teams.
                        ready = staff.get(receipt).raise_for_status().json()
                        self.assertEqual(confirm(ready["revision"]).status_code,409)
                        pending = [f for f in ready["files"] if f["state"]=="unassigned"]
                        self.assertTrue(any(team in f["candidates"] and len(f["candidates"])>1 for f in pending))
                        for item in pending:
                            staff.put(f"{receipt}/files/{item['item_id']}/assignment",json={"team":team,"action":"assign",
                                "revision":ready["revision"],"reason":"동명 팀의 대표와 원접수 대조"}).raise_for_status()
                            ready=staff.get(receipt).raise_for_status().json()
                        link = confirm(ready["revision"]).raise_for_status().json()
                        self.assertEqual(link, confirm(ready["revision"]).raise_for_status().json())
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
                            # set10 has a missing, repeated, and additional name on its consent form.
                            if case=="set10" and f["kind"]=="02":
                                self.assertIn(team,f["candidates"])
                            else:
                                self.assertEqual(f["kind"],"03",f"{case} 원본 {f['state']} · {f['reason']}")
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
                        roster = Counter(p["name"] for p in names)
                        consent_roster = Counter(p["name"] for p in consent)
                        self.assertEqual(sum((roster - consent_roster).values()),1)
                        self.assertEqual(len(consent_roster.keys() - roster.keys()),1)
                        self.assertEqual(sum(consent_roster.values())-len(consent_roster),1)
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
                    if case == "set04":
                        self.assertEqual(next(c["refs"] for c in result["checks"] if c["label"] == "동의서 0부 접수"), [])
                    if case=="set03":
                        refs=next(c["refs"] for c in result["checks"] if "예금주" in c["label"])
                        self.assertEqual({r["id"] for r in refs},{f["id"] for f in files if f["kind"] in ("01","03")})
                    staff.put(f"/api/teams/{team}/email",json={"email":case+"@award.test"}).raise_for_status()
                    job=api.post("review-jobs/claim",json={"worker_id":"controlled","event_id":event}).raise_for_status().json()
                    self.assertEqual(job["submission_id"],detail()["teams"][0]["submission_id"])
                    self.assertEqual({x["item_id"] for x in job["files"]},{f["id"] for f in files})
                    if case=="set04":
                        # A worker can return only its own address. Also check the confirmed original.
                        result.pop("representative_emails")
                        result["representative_email"]=case+"@award.test"
                    api.put("review-jobs/"+job["review_job_id"]+"/result",headers={"X-Claim-Token":job["claim_token"]},
                            json={"state":"done","studio_job_id":"job_mock_"+job["review_job_id"],"verdict":result["verdict"],"reason":result["reason"],"output":result}).raise_for_status()
                    self.assertFalse(deliver(db,cfg))
                    approve_ready_notices(staff,job["submission_id"])
                    while deliver(db,cfg):
                        pass
                    sid = job["submission_id"]
                    review = staff.get("/api/operations/submissions/"+sid).raise_for_status().json()
                    self.assertTrue(review["application_emails"])
                    if case=="set04":
                        self.assertGreater(len(review["application_emails"]),1)
                        self.assertIn(case+"@award.test",review["application_emails"])
                    self.assertTrue(review["email_needs_confirmation"])
                    self.assertEqual({m["kind"]:m["state"] for m in review["mail"]},
                                     {"보완 요청":"recipient_check"})
                    leader, = [m for m in review["mail"] if m["kind"]=="보완 요청"]
                    self.assertFalse((DATA/"operations/mail"/(leader["id"]+".eml")).exists())
                    confirm_address = {"email":case+"@award.test","submission":sid}
                    for _ in range(2):
                        staff.put(f"/api/teams/{team}/email",json=confirm_address).raise_for_status()
                        approve_ready_notices(staff,sid)
                        while deliver(db,cfg):
                            pass
                    self.assertEqual(staff.get("/api/mail/"+leader["id"]).json()["sent_to"],case+"@award.test")
                    notices=db.execute("SELECT id,kind,state FROM review_mail WHERE submission_id=%s",(job["submission_id"],)).fetchall()
                    self.assertEqual({m["kind"]:m["state"] for m in notices},{"보완 요청":"local"})
                    self.assertEqual(len(notices),2)
                    self.assertTrue(all((DATA/"operations/mail"/(str(m["id"])+".eml")).is_file() for m in notices))

    def test_preassigned_application_conflicts_with_its_file_name(self):
        cfg = configuration()
        url = os.environ["INTAKE_TEST_URL"]
        self.assertEqual((httpx.URL(url).host,cfg["MAIL_MODE"]),("127.0.0.1","local"))
        self.assertEqual(httpx.URL(cfg["AWARDS_DB_URL"].removeprefix("jdbc:")).host,"127.0.0.1")
        with connect(cfg) as db, httpx.Client(base_url=url,trust_env=False) as staff, httpx.Client(
                base_url=url+"/api/worker/",headers={"Authorization":"Bearer "+cfg["AWARDS_REVIEW_WORKER_TOKEN"]}) as api:
            login(staff,os.environ["INTAKE_TEST_LOGIN_A"],os.environ["INTAKE_TEST_PASSWORD_A"])
            event=staff.post("/api/events",json={"name":"배정 충돌 "+uuid4().hex[:8]}).raise_for_status().json()["id"]
            prior=staff.post(f"/api/events/{event}/teams",json={"name":"Alpha","rep":""}).raise_for_status().json()["id"]
            name,original=next(f for f in official_files("set01") if fixture_slot(f[0])=="01")
            filename="Alpha_신청서"+Path(name).suffix
            receipt=staff.post("/api/intake-batches",headers={"Idempotency-Key":str(uuid4())},
                data={"event":event,"manifest":json.dumps([{"name":filename,"size":len(original)}])},
                files=[("files",(filename,original))]).raise_for_status().json()["status_url"]
            fid=staff.get(receipt).json()["files"][0]["item_id"]
            assignment=f"{receipt}/files/{fid}/assignment"
            staff.put(assignment,json={"action":"assign","team":prior,"reason":"판독 전 원접수 기준","revision":0}).raise_for_status()
            while prepare(db,api):
                pass
            batch=staff.get(receipt).raise_for_status().json()
            item=batch["files"][0]
            self.assertEqual((item["state"],item["team"],len(item["candidates"])),("unassigned",None,2))
            other, = set(item["candidates"])-{prior}
            for team in (prior,other):
                self.assertEqual(staff.put(f"{receipt}/teams/{team}/submission",json={"revision":batch["revision"]}).status_code,409)
            self.assertEqual(batch["teams"],[])
            self.assertEqual(api.post("review-jobs/claim",json={"worker_id":"before-review","event_id":event}).status_code,204)
            history=staff.get(assignment+"/history").raise_for_status().json()
            self.assertEqual((history[-1]["before_team_id"],history[-1]["after_team_id"],history[-1]["actor"]),(prior,None,"@workflow"))
            staff.put(assignment,json={"action":"assign","team":other,"reason":"신청서 원문과 접수 경로 재대조","revision":batch["revision"]}).raise_for_status()
            job=api.post("review-jobs/claim",json={"worker_id":"after-review","event_id":event}).raise_for_status().json()
            self.assertEqual((job["team"],job["files"][0]["item_id"]),(other,fid))
