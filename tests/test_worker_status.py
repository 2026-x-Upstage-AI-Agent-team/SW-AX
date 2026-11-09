"""Run with a dedicated, empty local intake database and API."""
import os
import unittest
from urllib.parse import urlparse
from uuid import uuid4

import httpx

from operations.store import configuration, connect
from operations.worker import ROLES
from tests.test_intake_postgres import login


@unittest.skipUnless(os.getenv("AWARDS_WORKER_STATUS_TESTS") == "1", "Requires a dedicated local test API.")
class WorkerStatusTest(unittest.TestCase):
    def test_role_locks_idle_printer_and_lease_renewal(self):
        base = os.environ["INTAKE_TEST_URL"]
        cfg = configuration()
        for url in (base, cfg["AWARDS_DB_URL"].removeprefix("jdbc:")):
            self.assertIn(urlparse(url).hostname, {"localhost", "127.0.0.1", "::1"})
        path = "/api/operations/worker-status"
        with connect(cfg) as db, httpx.Client(base_url=base, trust_env=False) as staff, httpx.Client(base_url=base, trust_env=False) as printer:
            self.assertEqual(db.execute("SELECT count(*) AS n FROM award_event").fetchone()["n"], 0, "Use an empty test database.")
            self.assertEqual(staff.get(path).status_code, 401)
            start = "/api/operations/worker-start"
            self.assertEqual(staff.post(start, headers={"Sec-Fetch-Site": "same-origin"}).status_code, 401)
            login(staff, os.environ["INTAKE_TEST_LOGIN_A"], os.environ["INTAKE_TEST_PASSWORD_A"])
            self.assertEqual(staff.post(start, headers={"X-CSRF-TOKEN": "", "Sec-Fetch-Site": "cross-site"}).status_code, 403)

            def status():
                return staff.get(path).raise_for_status().json()

            initial = status()
            self.assertEqual(initial["state"], "stopped")
            self.assertEqual(initial["online"], [])
            self.assertIsNone(initial["printer_last_seen"])
            with connect(cfg) as other_start:
                other_start.execute("SELECT pg_advisory_lock(175703111,4)")
                self.assertEqual(status()["state"], "starting")
                self.assertEqual(staff.post(start).raise_for_status().json()["state"], "starting")
            with connect(cfg) as worker:
                for slot, role in enumerate(ROLES):
                    with self.subTest(role=role):
                        worker.execute("SELECT pg_advisory_lock(175703111,%s)", (slot,))
                        self.assertCountEqual(status()["online"], ROLES[:slot + 1])
            self.assertEqual(status()["online"], [])

            claim = "/api/worker/output/claim"
            self.assertEqual(printer.post(claim, json={"worker_id": "test"}).status_code, 401)
            printer.headers["Authorization"] = "Bearer " + cfg["AWARDS_OUTPUT_WORKER_TOKEN"]
            self.assertEqual(printer.post(claim, json={"worker_id": ""}).status_code, 422)
            self.assertIsNone(status()["printer_last_seen"])
            self.assertEqual(printer.post(claim, json={"worker_id": "test"}).status_code, 204)
            self.assertEqual(status()["online"], ["printer"])
            with connect(cfg) as worker:
                for slot in range(len(ROLES)):
                    worker.execute("SELECT pg_advisory_lock(175703111,%s)", (slot,))
                self.assertEqual(status()["state"], "running")
                self.assertEqual(staff.post(start).raise_for_status().json()["state"], "running")

            event = staff.post("/api/events", json={"name": "워커 상태 시험"}).raise_for_status().json()["id"]
            db.execute("""INSERT INTO award_report(event_id,version,created_by,selection,snapshot,state,hwpx)
                VALUES (%s,1,%s,'{}','{}','printing',%s)""", (event, os.environ["INTAKE_TEST_LOGIN_A"], b"test"))
            job = printer.post(claim, json={"worker_id": "test"}).raise_for_status().json()
            db.execute("UPDATE workflow_health SET updated_at=now()-interval '46 seconds' WHERE role='printer'")
            stale = status()
            self.assertIsNotNone(stale["printer_last_seen"])
            self.assertEqual(stale["online"], [])
            renew = "/api/worker/output/" + job["id"] + "/lease"
            self.assertEqual(printer.put(renew, headers={"X-Claim-Token": str(uuid4())}).status_code, 409)
            self.assertEqual(status()["printer_last_seen"], stale["printer_last_seen"])
            self.assertEqual(printer.put(renew, headers={"X-Claim-Token": job["claim_token"]}).status_code, 204)
            self.assertEqual(status()["online"], ["printer"])
