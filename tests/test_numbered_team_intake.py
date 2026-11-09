"""Numbered team intake on a dedicated empty PostgreSQL instance with the official v6 originals.

AWARDS_NUMBERED_TESTS=live explicitly enables two billable Studio jobs; 'local' uses worker results.
No delivery worker is started.
"""
import json
import os
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import httpx

from operations.preparation import prepare
from operations.store import configuration, connect
from operations.studio_worker import run_studio
from service import studio
from tests.official_inputs import official_files
from tests.test_intake_postgres import login


@unittest.skipUnless(os.getenv("AWARDS_NUMBERED_TESTS") in ("live", "local"), "Use a dedicated local test database.")
class NumberedIntake(unittest.TestCase):
    def setUp(self):
        self.cfg = configuration()
        url = os.environ["INTAKE_TEST_URL"]
        self.assertEqual((httpx.URL(url).host, self.cfg["MAIL_MODE"]), ("127.0.0.1", "local"))
        self.assertEqual(httpx.URL(self.cfg["AWARDS_DB_URL"].removeprefix("jdbc:")).host, "127.0.0.1")
        self.db = self.enterContext(connect(self.cfg))
        self.assertFalse(self.db.execute("SELECT EXISTS(SELECT FROM award_event WHERE name NOT LIKE '팀 묶음 검증 %') AS other").fetchone()["other"],
                         "다른 대회가 있는 DB에서는 전역 작업 큐를 실행하지 않습니다.")
        self.assertFalse(self.db.execute("SELECT EXISTS(SELECT FROM review_job_status WHERE state IN ('queued','running')) AS busy").fetchone()["busy"])
        self.staff = self.enterContext(httpx.Client(base_url=url, trust_env=False, timeout=60))
        self.worker = self.enterContext(httpx.Client(base_url=url + "/api/worker/", timeout=45, trust_env=False,
            headers={"Authorization": "Bearer " + self.cfg["AWARDS_REVIEW_WORKER_TOKEN"]}))
        login(self.staff, os.environ["INTAKE_TEST_LOGIN_A"], os.environ["INTAKE_TEST_PASSWORD_A"])
        self.event = self.staff.post("/api/events", json={"name": "팀 묶음 검증 " + uuid4().hex[:8]}).raise_for_status().json()["id"]

    def upload(self, files, key=None, **fields):
        fields.setdefault("mode", "bundle")
        return self.staff.post("/api/intake-batches", data=dict(fields, event=self.event,
            manifest=json.dumps([{"name": n, "size": len(b)} for n, b in files])),
            headers={"Idempotency-Key": key or str(uuid4())}, files=[("files", (n, b)) for n, b in files])

    def get(self, path):
        return self.staff.get(path).raise_for_status().json()

    def drain(self):
        for _ in range(40):
            if not prepare(self.db, self.worker):
                return
        self.fail("접수 판독이 끝나지 않았습니다.")

    def submit_result(self, detail, name, refs, verdict="성공"):
        job = detail["teams"][0]["review_job"]["review_job_id"]
        task = self.worker.post("review-jobs/claim", json={"worker_id":"numbered-test","review_job_id":job}).raise_for_status().json()
        body = {"state":"done","studio_job_id":"local-" + job,"verdict":verdict,"reason":"시험 판정",
                "output":{"team_name":name,"rep":"시험 대표","documents":{"01":[{"id":fid,"page":1} for fid in refs]}}}
        for _ in range(2):
            self.worker.put("review-jobs/" + job + "/result", headers={"X-Claim-Token":task["claim_token"]}, json=body).raise_for_status()

    @unittest.skipUnless(os.getenv("AWARDS_NUMBERED_TESTS") == "local", "Local controlled worker responses only.")
    def test_concurrent_receipts_and_later_application_keep_identity(self):
        missing, complete = official_files("set12"), official_files("set01")
        duplicate, distinct = str(uuid4()), str(uuid4())
        with ThreadPoolExecutor(max_workers=3) as pool:
            replies = list(pool.map(lambda args: self.upload(*args).raise_for_status().json()["status_url"],
                                    [(missing,duplicate),(missing,duplicate),(complete,distinct)]))
        first, again, second = replies
        self.assertEqual(first,again)
        self.assertNotEqual(first,second)
        self.drain()
        a, b = (self.get(path) for path in (first,second))
        self.assertEqual({a["batch"]["intake_number"],b["batch"]["intake_number"]},{1,2})
        a_id, b_id = (d["batch"]["target_team_id"] for d in (a,b))
        number = a["batch"]["intake_number"]
        # An extraction attributed to an original in another receipt cannot name this one.
        source = b["files"][0]["item_id"]
        self.submit_result(a,"잘못된 타 팀명",[source],"재제출요청")
        self.assertEqual(self.get(first)["batch"]["team_name"],f"접수 {number}팀")
        self.submit_result(b,"동명 팀",[source])
        base = a["teams"][0]["submission_id"]
        correction = self.upload(complete[:1],mode="existing",target=a_id,base=base).raise_for_status().json()["status_url"]
        self.drain()
        corrected = self.get(correction)
        self.assertEqual((corrected["batch"]["intake_number"],corrected["teams"][0]["version"]),(number,2))
        self.submit_result(corrected,"동명 팀",[corrected["files"][0]["item_id"]])
        self.assertEqual(self.get(first)["batch"]["team_name"],"동명 팀")
        teams = self.get(f"/api/events/{self.event}/teams")
        self.assertEqual({(t["id"],t["name"]) for t in teams},{(a_id,"동명 팀"),(b_id,"동명 팀")})
        # Existing manual registration still deduplicates its own entries independently.
        catalog = f"/api/events/{self.event}/teams"
        manual = [self.staff.post(catalog,json={"name":"동명 팀","rep":"시험 대표"}).raise_for_status().json()["id"] for _ in range(2)]
        self.assertEqual(manual[0],manual[1])
        self.assertNotIn(manual[0], (a_id,b_id))

    def test_official_bundles(self):
        batches, team_ids = [], []
        for number, case in enumerate(("set01", "set12"), 1):
            files, key = official_files(case), str(uuid4())
            receipt = self.upload(files,key).raise_for_status().json()
            self.assertEqual(self.upload(files,key).raise_for_status().json()["batch_id"],receipt["batch_id"])
            self.assertEqual(self.upload(files,key,mode="existing").status_code,409)
            detail = self.get(receipt["status_url"])
            team = detail["batch"]["target_team_id"]
            self.assertEqual((detail["batch"]["intake_number"],detail["batch"]["team_name"]), (number,f"접수 {number}팀"))
            self.assertEqual({(f["team"],f["state"]) for f in detail["files"]},{(team,"assigned")})
            batches.append(receipt["status_url"])
            team_ids.append(team)
        self.assertNotEqual(team_ids[0],team_ids[1])
        self.drain()
        for number, path in enumerate(batches, 1):
            detail = self.get(path)
            self.assertEqual(detail["batch"]["team_name"],f"접수 {number}팀")
            self.assertEqual([(t["team"],t["version"],t["review_job"]["state"]) for t in detail["teams"]],
                             [(team_ids[number-1],1,"queued")])
        if os.environ["AWARDS_NUMBERED_TESTS"] == "live":
            self.assertEqual(self.cfg.get("UPSTAGE_CONFIG_ID",studio.CONFIG),"23")
            external = self.enterContext(studio.client(self.cfg))
            baseline = None
            deadline = time.monotonic() + 3600
            while time.monotonic() < deadline:
                run_studio(self.db,self.worker,external,self.cfg)
                states = self.db.execute("""SELECT t.intake_number AS n,e.phase,e.remote_id,s.state
                    FROM ops_submission s JOIN award_team t ON t.id=s.team_id
                    LEFT JOIN studio_execution e ON e.job_id=s.review_job_id WHERE t.event_id=%s ORDER BY n""",(self.event,)).fetchall()
                if states != baseline:
                    print("Studio:", [(r["n"],r["phase"],r["remote_id"],r["state"]) for r in states], flush=True)
                    baseline = states
                if all(r["state"]=="done" for r in states):
                    break
                self.assertFalse(any(r["state"] in ("uncertain","invalid","failed","access","paused") for r in states),states)
                time.sleep(2)
            else:
                self.fail("Studio 결과 조회 시간 초과")
        else:
            for i, path in enumerate(batches):
                detail = self.get(path)
                self.submit_result(detail,"가상검토팀01" if i==0 else "출처 없는 이름",
                                   [detail["files"][0]["item_id"]] if i==0 else [],"성공" if i==0 else "재제출요청")
        self.assertEqual(len(self.get(f"/api/events/{self.event}/teams")),2)
        for i, path in enumerate(batches):
            batch = self.get(path)
            team = batch["teams"][0]
            submission = self.get("/api/operations/submissions/" + team["submission_id"])
            expected = ("가상검토팀01","접수 2팀")[i]
            result = submission["result"]
            print(f"set{(1,12)[i]:02} · 접수 {i+1}팀 · {submission['team_name']} · {submission['state']} · {result['verdict']} · 01 {len(result['documents']['01'])}부",flush=True)
            self.assertEqual((batch["batch"]["batch_id"],batch["batch"]["target_team_id"],team["team"]),
                             (path.rsplit("/",1)[-1],team_ids[i],team_ids[i]))
            self.assertEqual((submission["team_name"],batch["batch"]["team_name"],submission["intake_number"]),
                             (expected,expected,i+1))
            self.assertEqual((team["review_job"]["state"],submission["state"]),("done","done"))
            if i == 0:
                self.assertEqual(result["team_name"],expected)
                self.assertEqual(len(result["documents"]["01"]),1)
            else:
                self.assertFalse(result["documents"]["01"])
                self.assertEqual(result["verdict"],"재제출요청")
