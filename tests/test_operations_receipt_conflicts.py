"""Official fictional HWP inputs, real Hancom/OCR and PostgreSQL, controlled Studio responses."""
import hashlib
import json
import os
import subprocess
import unittest
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Barrier
from uuid import uuid4

import httpx
from pypdf import PdfWriter

from operations.delivery import deliver
from operations.preparation import prepare
from operations.printer import print_one, worker_api
from operations.reports import report_tick
from operations.store import configuration, connect
from operations.studio_worker import run_studio
from reporting.merge_hwpx import compile_sections, save
from service.db import ROOT
from tests.official_inputs import official_files
from tests.test_intake_postgres import login


@unittest.skipUnless(os.getenv("AWARDS_OFFLINE_CASES") == "1", "Requires a dedicated local database and Hancom.")
class ReceiptConflicts(unittest.TestCase):
    def setUp(self):
        self.cfg = configuration()
        self.url = os.environ["INTAKE_TEST_URL"]
        self.assertEqual((httpx.URL(self.url).host, self.cfg["MAIL_MODE"]), ("127.0.0.1", "local"))
        self.assertEqual(httpx.URL(self.cfg["AWARDS_DB_URL"].removeprefix("jdbc:")).host, "127.0.0.1")
        self.db = self.enterContext(connect(self.cfg))
        self.staff = self.enterContext(httpx.Client(base_url=self.url, trust_env=False, timeout=60))
        self.worker = self.enterContext(httpx.Client(base_url=self.url + "/api/worker/", trust_env=False,
            headers={"Authorization":"Bearer " + self.cfg["AWARDS_REVIEW_WORKER_TOKEN"]}))
        login(self.staff, os.environ["INTAKE_TEST_LOGIN_A"], os.environ["INTAKE_TEST_PASSWORD_A"])
        self.event = self.staff.post("/api/events", json={"name":"접수 충돌 검증 " + uuid4().hex[:8]}).raise_for_status().json()["id"]
        self.teams = [self.staff.post(f"/api/events/{self.event}/teams", json={"name":name,"rep":rep}).raise_for_status().json()["id"]
                      for name, rep in (("Nextify","박찬건"), ("AutoAI","김종훈"))]
        self.docs = {}
        for index, group in enumerate(("set01", "set02")):
            for name,content in official_files(group):
                kind = "03" if "신분증" in name else name[:2]
                self.docs[index,kind] = (name,content)

    def upload(self, files, team=None, base=None):
        fields = {"event":self.event,"manifest":json.dumps([{"name":n,"size":len(b)} for n,b in files])}
        if team:
            fields["target"] = team
        if base:
            fields["base"] = base
        response = self.staff.post("/api/intake-batches", data=fields, headers={"Idempotency-Key":str(uuid4())},
                                   files=[("files",(n,b)) for n,b in files]).raise_for_status()
        self.assertEqual(response.status_code, 202)
        return response.json()["status_url"]

    def drain(self):
        for _ in range(40):
            if not prepare(self.db,self.worker):
                return
        self.fail("판독·확정 대기열에 같은 접수가 남아 있습니다.")

    def detail(self, receipt):
        return self.staff.get(receipt).raise_for_status().json()

    def browser(self, **scenario):
        if os.getenv("INTAKE_TEST_STATUS_BROWSER")=="1":
            subprocess.run(["node","--test","tests/review-navigation.mjs"],cwd=ROOT/"frontend",
                           env=dict(os.environ,**scenario),check=True,timeout=80)

    def test_named_combined_ids_hold_both_teams(self):
        with TemporaryDirectory() as directory:
            work = Path(directory)
            a,b = work/"a.hwpx", work/"b.hwpx"
            a.write_bytes(self.docs[0,"03"][1])
            b.write_bytes(self.docs[1,"03"][1])
            combined = work/"Nextify.hwpx"
            save(combined, compile_sections(a,[b],work))
            receipt = self.upload([self.docs[0,"01"],self.docs[1,"01"],(combined.name,combined.read_bytes())])
        fid = self.detail(receipt)["files"][2]["item_id"]
        assignment = f"{receipt}/files/{fid}/assignment"
        def assign(team, rev):
            return self.staff.put(assignment,json={"team":team,"revision":rev,"action":"assign","reason":"원접수 대조"})
        assign(self.teams[0],0).raise_for_status()
        self.drain()
        batch = self.detail(receipt)
        merged = batch["files"][2]
        self.assertEqual((merged["team"],merged["state"],set(merged["candidates"])),(None,"unassigned",set(self.teams)))
        self.assertIn("팀별 원본",merged["reason"])
        self.assertEqual(batch["teams"],[])
        for team in self.teams:
            self.assertEqual(assign(team,batch["revision"]).status_code,409)
            self.assertEqual(self.staff.put(f"{receipt}/teams/{team}/submission",json={"revision":batch["revision"]}).status_code,409)
        self.assertEqual(self.worker.post("review-jobs/claim",json={"worker_id":"mixed","event_id":self.event}).status_code,204)

    def test_two_corrections_and_next_team(self):
        team, other = self.teams
        first = self.upload([self.docs[0,"01"]],team)
        self.drain()
        base = self.detail(first)["teams"][0]["submission_id"]
        gate = Barrier(2)
        def correction(kind):
            gate.wait(timeout=10)
            return self.upload([self.docs[0,kind]],team,base), self.docs[0,kind][1]
        with ThreadPoolExecutor(max_workers=2) as pool:
            corrections = dict(pool.map(correction,("02","03")))
        following = self.upload([self.docs[1,k] for k in ("01","02","03")],other)
        following_id = following.split("/")[-1]
        self.db.execute("UPDATE intake_batch SET created_at=created_at-interval '1 hour' WHERE id=%s",(following_id,))
        self.drain()
        one, = [r for r in corrections if self.detail(r)["teams"]]
        two, = set(corrections)-{one}
        current, = self.detail(one)["teams"]
        second = self.detail(two)
        self.assertEqual(current["version"],2)
        self.assertEqual((second["batch"]["status"],second["batch"]["current_submission"],second["teams"]),
                         ("conflict",current["submission_id"],[]))
        self.assertEqual(self.detail("/api/operations/batches/" + second["batch"]["batch_id"])["state"],"conflict")
        self.assertEqual(self.staff.get(two+"/files/"+second["files"][0]["item_id"]+"/original").content,corrections[two])
        for receipt in (one,two,two):
            self.worker.put("review-jobs/preparations/"+receipt.split("/")[-1]+"/confirm").raise_for_status()
        self.assertEqual(self.staff.put(f"{two}/teams/{team}/submission",json={"revision":second["revision"]}).status_code,409)
        next_link, = self.detail(following)["teams"]
        self.assertEqual((next_link["team"], next_link["version"]),(other,1))
        dashboard = self.staff.get("/api/dashboard",params={"event":self.event}).raise_for_status().json()
        next_sub = next(t["submission"] for t in dashboard["teams"] if t["id"] == other)
        self.assertEqual(next_sub["received"], next(b["created"] for b in dashboard["batches"] if b["id"]==following_id))
        self.assertGreater(next_sub["created"] - next_sub["received"],3500)
        self.browser(INTAKE_TEST_QUEUE_EVENT=self.event)
        created = []
        def studio(request):
            if "configs" in request.url.path:
                return httpx.Response(200,json={"id":"cfg_offline"})
            if request.method == "POST":
                created.append(len(json.loads(request.content)["input"][0]["content"]))
                return httpx.Response(200,json={"id":"job_isolation_"+str(len(created))})
            is_next = request.url.path.endswith("_2")
            values = {"Instruct - 최종판정":{"enum":"성공" if is_next else "재제출요청",
                      "reason":"증빙 확인" if is_next else "01 지급확인서 1쪽 첫째 행에 학번이 없습니다."},
                      "Information Extract - 지급확인서":{"team_name":"AutoAI" if is_next else "Nextify",
                        "representative_name":"김종훈" if is_next else "박찬건"}}
            return httpx.Response(200,json={"id":request.url.path.split("/")[-1],"status":"completed",
                "output":[{"model":n,"content":[{"text":v}]} for n,v in values.items()]})
        with httpx.Client(base_url="https://studio.test/",transport=httpx.MockTransport(studio)) as remote:
            for _ in range(4):
                self.db.execute("UPDATE studio_execution SET due=now() WHERE phase='polling'")
                self.assertTrue(run_studio(self.db,self.worker,remote,self.cfg))
            self.assertFalse(run_studio(self.db,self.worker,remote,self.cfg))
        self.assertEqual(created,[2,3])
        self.assertEqual(self.detail(following)["teams"][0]["review_job"]["verdict"],"성공")
        self.assertEqual(self.detail(one)["teams"][0]["review_job"]["verdict"],"재제출요청")
        self.assertEqual(self.db.execute("SELECT count(*) AS n FROM team_submission WHERE team_id=%s",(team,)).fetchone()["n"],2)
        self.assertEqual(self.detail(two)["teams"],[])
        sid = current["submission_id"]
        self.staff.put(f"/api/teams/{team}/email",json={"email":"leader@award.test","submission":sid}).raise_for_status()
        self.db.execute("UPDATE review_mail SET created_at=created_at-interval '1 hour' WHERE submission_id=%s",(sid,))
        while deliver(self.db,self.cfg):
            pass
        notices = self.detail("/api/operations/submissions/"+sid)["mail"]
        self.assertEqual({m["kind"] for m in notices},{"보완 요청","담당자 알림"})
        self.assertEqual(len(notices),2)
        self.assertTrue(all(m["state"]=="local" and m["sent_at"]-m["created"]>3500 for m in notices))
        leader, = [m for m in notices if m["kind"]=="보완 요청"]
        self.assertIn("[01 1쪽 1행]", self.detail("/api/mail/"+leader["id"])["body"])
        self.browser(INTAKE_TEST_CONFLICT_BATCH=second["batch"]["batch_id"],INTAKE_TEST_REASON_SUBMISSION=sid)
        for _ in range(2):
            self.staff.put(two+"/conflict-review",json={}).raise_for_status()
        checked = self.detail("/api/operations/batches/"+second["batch"]["batch_id"])
        self.assertEqual((checked["state"],checked["reviewed_by"]),("conflict_reviewed",os.environ["INTAKE_TEST_LOGIN_A"]))
        self.assertTrue(checked["reviewed_at"])
        self.assertEqual(self.detail(two)["teams"],[])
        self.assertEqual(self.staff.put(f"{two}/teams/{team}/submission",json={"revision":second["revision"]}).status_code,409)

    def test_failed_pdf_can_reprint_identical_hwpx(self):
        team = self.teams[1]
        receipt = self.upload([self.docs[1,k] for k in ("01","02","03")],team)
        self.drain()
        job = self.worker.post("review-jobs/claim",json={"event_id":self.event,"worker_id":"report-test"}).raise_for_status().json()
        sid = job["submission_id"]
        result = {"documents":{k:[{"id":f["item_id"],"page":1}] for k,f in zip(("01","02","03"),self.detail(receipt)["files"],strict=True)}}
        self.worker.put("review-jobs/"+job["review_job_id"]+"/result",headers={"X-Claim-Token":job["claim_token"]},
            json={"state":"done","studio_job_id":"job_print_"+sid,"verdict":"성공","reason":"원본 대조","output":result}).raise_for_status()
        fields = json.loads((ROOT/"test case"/"유잇_set01-set02_출력검증입력.json").read_text(encoding="utf-8-sig"))["teams"][1]
        self.staff.put(f"/api/submissions/{sid}/review",json=dict(fields,decision="승인",note="가상 원본 대조",revision=0,
            award_type="최우수상",support_amount="100000",issues=[])).raise_for_status()
        rid = self.staff.post("/api/reports",json={"event":self.event,"submissions":[sid]}).raise_for_status().json()["id"]
        url = "/api/reports/"+rid
        self.assertTrue(report_tick(self.db,self.cfg))
        with worker_api(self.url,self.cfg["AWARDS_OUTPUT_WORKER_TOKEN"]) as printer:
            job = printer.post("claim",json={"worker_id":"first"}).raise_for_status().json()
            token = {"X-Claim-Token":job["claim_token"]}
            original = printer.get(rid+"/hwpx",headers=token).raise_for_status().content
            printer.put(rid+"/failure",headers=token).raise_for_status()
            failed = self.detail(url)
            self.assertEqual((failed["state"],failed["can_retry_print"]),("failed",True))
            with httpx.Client(base_url=self.url,trust_env=False) as peer:
                self.db.execute("INSERT INTO event_staff(event_id,login) VALUES(%s,%s)",(self.event,os.environ["INTAKE_TEST_LOGIN_B"]))
                login(peer,os.environ["INTAKE_TEST_LOGIN_B"],os.environ["INTAKE_TEST_PASSWORD_B"])
                self.assertEqual(peer.post(url+"/retry-print").status_code,404)
            self.browser(INTAKE_TEST_PRINT_REPORT=rid)
            for _ in range(2):
                self.assertEqual(self.staff.post(url+"/retry-print").raise_for_status().json(),{"id":rid,"version":failed["version"]})
            self.assertEqual(printer.get(rid+"/hwpx",headers=token).status_code,409)
            self.assertTrue(print_one(printer,"restored"))
            self.assertFalse(print_one(printer,"restored"))
        self.assertTrue(report_tick(self.db,self.cfg))
        verified = self.detail(url)
        self.assertEqual((verified["state"],verified["version"],verified["can_retry_print"]),("preview",failed["version"],False))
        self.staff.post(url+"/confirm").raise_for_status()
        self.assertEqual(hashlib.sha256(self.staff.get(url+"/hwpx").raise_for_status().content).hexdigest(),job["sha256"])
        self.assertEqual(original,self.staff.get(url+"/hwpx").raise_for_status().content)
        self.assertTrue(self.staff.get(url+"/pdf").raise_for_status().content.startswith(b"%PDF-"))
        edited = self.staff.post(url+"/edited",files={"file":("동일_편집본.hwpx",original)}).raise_for_status().json()["id"]
        with worker_api(self.url,self.cfg["AWARDS_OUTPUT_WORKER_TOKEN"]) as printer:
            lease = printer.post("claim",json={"worker_id":"wrong-pages"}).raise_for_status().json()
            self.assertEqual(lease["id"],edited)
            bad = PdfWriter()
            bad.add_blank_page(width=595,height=842)
            pdf = BytesIO()
            bad.write(pdf)
            printer.put(edited+"/pdf",content=pdf.getvalue(),headers={"X-Claim-Token":lease["claim_token"],
                "X-Hwpx-Sha256":lease["sha256"],"Content-Type":"application/pdf"}).raise_for_status()
        self.assertTrue(report_tick(self.db,self.cfg))
        failed_verification = self.detail("/api/reports/"+edited)
        self.assertEqual((failed_verification["state"],failed_verification["can_retry_print"]),("failed",False))
        self.assertEqual(self.staff.post("/api/reports/"+edited+"/retry-print").status_code,409)
