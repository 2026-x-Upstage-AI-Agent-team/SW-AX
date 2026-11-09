"""Official fictional HWP inputs, real Hancom/OCR and PostgreSQL, controlled Studio responses."""
import json
import os
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from uuid import uuid4

import httpx

from operations.preparation import prepare
from operations.store import configuration, connect
from reporting.merge_hwpx import compile_sections, save
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

    def upload(self, files):
        fields = {"event":self.event,"manifest":json.dumps([{"name":n,"size":len(b)} for n,b in files])}
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
