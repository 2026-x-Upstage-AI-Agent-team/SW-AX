"""Official fictional HWP inputs, real Hancom/OCR and PostgreSQL, controlled Studio responses."""
import json
import os
import subprocess
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Barrier
from uuid import uuid4

import httpx

from operations.delivery import deliver
from operations.preparation import prepare
from operations.store import configuration, connect
from operations.studio_worker import run_studio
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
        while deliver(self.db,self.cfg):
            pass
        notices = self.detail("/api/operations/submissions/"+sid)["mail"]
        self.assertEqual({m["kind"] for m in notices},{"보완 요청","담당자 알림"})
        self.assertEqual(len(notices),2)
        self.assertTrue(all(m["state"]=="local" for m in notices))
        self.browser(INTAKE_TEST_CONFLICT_BATCH=second["batch"]["batch_id"])
        for _ in range(2):
            self.staff.put(two+"/conflict-review",json={}).raise_for_status()
        checked = self.detail("/api/operations/batches/"+second["batch"]["batch_id"])
        self.assertEqual((checked["state"],checked["reviewed_by"]),("conflict_reviewed",os.environ["INTAKE_TEST_LOGIN_A"]))
        self.assertTrue(checked["reviewed_at"])
        self.assertEqual(self.detail(two)["teams"],[])
        self.assertEqual(self.staff.put(f"{two}/teams/{team}/submission",json={"revision":second["revision"]}).status_code,409)
