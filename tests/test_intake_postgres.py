"""Run against a separate Spring Boot instance backed by a real test PostgreSQL database."""
import hashlib
import json
import os
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path
from threading import Barrier
from urllib.parse import urlparse
from uuid import uuid4
from zipfile import ZipFile

import httpx


ROOT = Path(__file__).resolve().parents[1]
URL = os.getenv("INTAKE_TEST_URL")
WORKER = "/api/worker/review-jobs"
requires_worker = unittest.skipUnless(os.getenv("AWARDS_REVIEW_WORKER_TOKEN"), "Set the test server's worker token.")

def login(client, username, password):
    headers = {"Accept": "application/json", "X-CSRF-TOKEN": client.get("/api/auth/session").json()["csrf_token"]}
    response = client.post("/login", data={"username": username, "password": password}, headers=headers)
    if response.status_code != 204:
        raise AssertionError(f"Login failed: HTTP {response.status_code}")
    session = client.get("/api/auth/session").raise_for_status().json()
    assert session["login"] == username
    client.headers["X-CSRF-TOKEN"] = session["csrf_token"]


@unittest.skipUnless(URL, "Set INTAKE_TEST_URL to the local test instance.")
class PostgresIntakeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if urlparse(URL).hostname not in {"localhost", "127.0.0.1", "::1"}:
            raise ValueError("Use a local test database and API.")
        cls.http = httpx.Client(base_url=URL, timeout=90, trust_env=False)
        cls.addClassCleanup(cls.http.close)
        cls.peer = httpx.Client(base_url=URL, timeout=90, trust_env=False)
        cls.addClassCleanup(cls.peer.close)
        for client, suffix in ((cls.http, "A"), (cls.peer, "B")):
            login(client, os.environ["INTAKE_TEST_LOGIN_" + suffix], os.environ["INTAKE_TEST_PASSWORD_" + suffix])
        cls.sets = {}
        with ZipFile(ROOT / "test case" / "유잇_미션2_테스트set.zip") as archive:
            for member in archive.namelist():
                path = Path(member)
                if path.suffix.lower() in {".hwp", ".hwpx"}:
                    cls.sets.setdefault(path.parent.name, []).append((path.name, archive.read(member)))

    def setUp(self):
        self.event = self.http.post("/api/events", json={"name": "접수 검증 " + uuid4().hex[:12]}).raise_for_status().json()["id"]

    def send(self, files, *, key=None, target=None, event=None, manifest=None, client=None):
        listing = manifest if manifest is not None else [{"name": n, "size": len(data)} for n, data in files]
        fields = {"event": event or self.event, "manifest": json.dumps(listing, ensure_ascii=False)}
        if target:
            fields["target"] = target
        return (client or self.http).post("/api/intake-batches", data=fields,
                              headers={"Idempotency-Key": key or str(uuid4())},
                              files=[("files", (name, data, "application/octet-stream")) for name, data in files])

    def history(self):
        return self.http.get("/api/intake-batches", params={"event": self.event}).raise_for_status().json()

    def team(self, event, name, rep):
        return self.http.post(f"/api/events/{event}/teams", json={"name": name, "rep": rep}).raise_for_status().json()["id"]

    def decide(self, receipt, item, action, revision, **fields):
        return self.http.put(f"{receipt}/files/{item}/assignment",
                             json={"action": action, "revision": revision, "reason": "원본 목록 대조", **fields})

    def confirm(self, receipt, team, revision, client=None):
        return (client or self.http).put(f"{receipt}/teams/{team}/submission", json={"revision": revision})

    def review_jobs(self, state=None):
        return self.http.get(f"/api/events/{self.event}/review-jobs",
                             params={} if state is None else {"state": state}).raise_for_status().json()

    def worker(self):
        client = httpx.Client(base_url=URL, timeout=30, trust_env=False,
                              headers={"Authorization": "Bearer " + os.environ["AWARDS_REVIEW_WORKER_TOKEN"]})
        self.addCleanup(client.close)
        return client

    def review_fixture(self, *groups):
        teams = [self.team(self.event, group, "") for group in groups]
        files = [(team, source) for team, group in zip(teams, groups) for source in self.sets[group]]
        receipt = self.send([source for _, source in files]).raise_for_status().headers["location"]
        items = self.http.get(receipt).raise_for_status().json()["files"]
        for rev, ((team, _), item) in enumerate(zip(files, items, strict=True)):
            self.decide(receipt, item["item_id"], "assign", rev, team=team).raise_for_status()
        for team in teams:
            self.confirm(receipt, team, len(items)).raise_for_status()
        return receipt, teams

    def race_claims(self):
        gate = Barrier(2)
        workers = [self.worker(), self.worker()]
        def claim(index):
            gate.wait(timeout=10)
            return workers[index].post(WORKER + "/claim", json={"worker_id": f"worker-{index}", "event_id": self.event})
        with ThreadPoolExecutor(max_workers=2) as pool:
            return list(pool.map(claim, (0, 1)))

    def test_all_official_originals_round_trip(self):
        files = [entry for group in sorted(self.sets) for entry in self.sets[group]]
        self.assertEqual((10, 29), (len(self.sets), len(files)))
        response = self.send(files)
        self.assertEqual(202, response.status_code, response.text)
        self.assertEqual(response.json()["status_url"], response.headers["location"])
        detail = self.http.get(response.headers["location"]).raise_for_status().json()
        self.assertEqual("received", detail["batch"]["status"])
        self.assertIsNone(detail["batch"]["target_team_id"])
        self.assertEqual(sum(len(data) for _, data in files), detail["batch"]["total_bytes"])
        self.assertEqual(29, len({f["item_id"] for f in detail["files"]}))
        for pos, ((name, data), item) in enumerate(zip(files, detail["files"], strict=True), 1):
            expected = hashlib.sha256(data).hexdigest()
            self.assertEqual((pos, name, len(data), expected), (item["position"], item["name"], item["size"], item["sha256"]))
            endpoint = response.headers["location"] + "/files/" + item["item_id"] + "/original"
            original = self.http.get(endpoint).raise_for_status()
            self.assertEqual(expected, hashlib.sha256(original.content).hexdigest())
            self.assertIn("filename*=", original.headers["content-disposition"])
        self.assertEqual([response.json()["batch_id"]], [b["batch_id"] for b in self.history()])

    def test_concurrent_replay_preserves_duplicate_originals(self):
        name, data = self.sets["set01"][1]
        other = self.sets["set02"][1][1]
        files = [(name, data), (name, other), (name, data)]
        key = str(uuid4())
        with ThreadPoolExecutor(max_workers=3) as pool:
            results = list(pool.map(lambda _: self.send(files, key=key), range(3)))
        self.assertEqual([202] * 3, [r.status_code for r in results])
        self.assertEqual(1, len({r.json()["batch_id"] for r in results}))
        self.assertEqual(1, len(self.history()))
        details = self.http.get(results[0].headers["location"]).raise_for_status().json()
        self.assertEqual([name] * 3, [f["name"] for f in details["files"]])
        self.assertEqual(3, len({f["item_id"] for f in details["files"]}))
        self.assertEqual([hashlib.sha256(b).hexdigest() for _, b in files], [f["sha256"] for f in details["files"]])
        changed = [(name, other), (name, data), (name, data)]
        self.assertEqual(409, self.send(changed, key=key).status_code)
        self.assertEqual(409, self.send([("이름변경.hwp", data), *files[1:]], key=key).status_code)
        self.assertEqual(409, self.send(files, key=key, target=self.team(self.event, "동명", "가")).status_code)
        self.assertEqual(1, len(self.history()))

    def test_incomplete_or_unsupported_input_creates_no_receipt(self):
        files = self.sets["set04"]
        self.assertEqual(2, len(files))
        listing = [{"name": name, "size": len(data)} for name, data in files]
        self.assertEqual(422, self.send(files[:1], manifest=listing).status_code)
        self.assertEqual(422, self.send(files, manifest=[listing[0], {**listing[1], "size": 1}]).status_code)
        for invalid in ("00_지급내역서.hwp", "지급정보.pdf"):
            self.assertEqual(415, self.send([files[0], (invalid, files[1][1])]).status_code)
        self.assertEqual([], self.history())
        valid = self.send(files)
        self.assertEqual(202, valid.status_code)
        self.assertEqual("received", valid.json()["status"])
        self.assertEqual(2, self.history()[0]["file_count"])

    def test_team_and_original_are_scoped_to_parent(self):
        a = self.team(self.event, "동명", "대표 가")
        self.assertEqual(a, self.team(self.event, "동명", "대표 가"))
        self.assertNotEqual(a, self.team(self.event, "동명", "대표 나"))
        other_event = self.http.post("/api/events", json={"name": uuid4().hex}).raise_for_status().json()["id"]
        files = self.sets["set01"]
        key = str(uuid4())
        result = self.send(files, key=key, target=a)
        self.assertEqual(202, result.status_code)
        self.assertEqual(a, self.history()[0]["target_team_id"])
        self.assertEqual(422, self.send(files, target=a, event=other_event).status_code)
        self.assertEqual(409, self.send(files, key=key, event=other_event).status_code)
        item = self.http.get(result.headers["location"]).json()["files"][0]["item_id"]
        second = self.send(files, event=other_event)
        self.assertEqual(404, self.http.get(second.headers["location"] + "/files/" + item + "/original").status_code)

    def test_full_selection_limit_is_available_through_multipart_parser(self):
        source = min((f for files in self.sets.values() for f in files), key=lambda f: len(f[1]))
        self.assertEqual(422, self.send([source] * 101).status_code)
        self.assertEqual([], self.history())
        self.assertEqual(202, self.send([source] * 100).status_code)
        self.assertEqual(100, self.history()[0]["file_count"])

    def test_manual_assignment_and_reassignment_keep_an_audit(self):
        first = self.team(self.event, "A팀", "대표 가")
        second = self.team(self.event, "B팀", "대표 나")
        receipt = self.send(self.sets["set01"][:2], target=first).raise_for_status().headers["location"]
        detail = self.http.get(receipt).raise_for_status().json()
        item, sibling = detail["files"]
        self.assertEqual((first, 0, None, "unassigned"),
                         (detail["batch"]["target_team_id"], detail["revision"], item["team"], item["state"]))
        url = f"{receipt}/files/{item['item_id']}/assignment"
        self.assertEqual([], self.http.get(url + "/history").raise_for_status().json())
        initial = {"action": "assign", "team": first, "reason": "팀 제출 목록 대조", "revision": 0}
        corrected = {"action": "assign", "team": second, "reason": "대표자 서명 재확인", "revision": 1}
        for body, revision in ((initial, 1), (initial, 1), (corrected, 2), (corrected, 2)):
            response = self.http.put(url, json=body, headers={"X-Staff": os.environ["INTAKE_TEST_LOGIN_B"]})
            self.assertEqual({"saved": True, "revision": revision}, response.raise_for_status().json())
        self.assertEqual(409, self.http.put(url, json=initial).status_code)
        self.assertEqual(2, self.http.put(url, json={**corrected, "revision": 2}).raise_for_status().json()["revision"])
        history = self.http.get(url + "/history").raise_for_status().json()
        self.assertEqual([(None, first, initial["reason"], 1), (first, second, corrected["reason"], 2)],
                         [(h["before_team_id"], h["after_team_id"], h["reason"], h["revision"]) for h in history])
        self.assertEqual({os.environ["INTAKE_TEST_LOGIN_A"]}, {h["actor"] for h in history})
        self.assertEqual({item["item_id"]}, {h["item_id"] for h in history})
        timestamps = [datetime.fromisoformat(h["changed_at"]) for h in history]
        self.assertTrue(all(t.utcoffset() is not None for t in timestamps))
        self.assertLessEqual(timestamps[0], timestamps[1])
        updated = self.http.get(receipt).raise_for_status().json()
        self.assertEqual((2, second, "assigned", corrected["reason"]),
                         (updated["revision"], updated["files"][0]["team"], updated["files"][0]["state"],
                          updated["files"][0]["reason"]))
        self.assertEqual(sibling, updated["files"][1])
        sibling_url = f"{receipt}/files/{sibling['item_id']}/assignment"
        self.assertEqual(409, self.http.put(sibling_url, json=initial).status_code)
        self.assertEqual([], self.http.get(sibling_url + "/history").json())
        self.assertEqual(item["sha256"], hashlib.sha256(self.http.get(
            f"{receipt}/files/{item['item_id']}/original").raise_for_status().content).hexdigest())

    def test_assignment_rejects_foreign_resources_and_invalid_edits(self):
        team = self.team(self.event, "대회 팀", "")
        foreign_event = self.http.post("/api/events", json={"name": uuid4().hex}).raise_for_status().json()["id"]
        foreign_team = self.team(foreign_event, "다른 대회 팀", "")
        inputs = self.sets["set02"][:1]
        receipt = self.send(inputs).raise_for_status().headers["location"]
        other = self.send(inputs, event=foreign_event).raise_for_status().headers["location"]
        item = self.http.get(receipt).json()["files"][0]["item_id"]
        suffix = f"/files/{item}/assignment"
        url = receipt + suffix
        valid = {"action": "assign", "team": team, "reason": "원본 명단 대조", "revision": 0}
        with httpx.Client(base_url=URL, trust_env=False) as anonymous:
            self.assertEqual(401, anonymous.get(url + "/history").status_code)
        for client, path in ((self.peer, url), (self.http, other + suffix)):
            self.assertEqual(404, client.put(path, json=valid).status_code)
            self.assertEqual(404, client.get(path + "/history").status_code)
        for invalid in ({"team": foreign_team}, {"team": None}, {"reason": "  "}, {"reason": "가" * 501},
                        {"revision": None}, {"revision": -1}):
            self.assertEqual(422, self.http.put(url, json={**valid, **invalid}).status_code)
        self.assertEqual(409, self.http.put(url, json={**valid, "revision": 1}).status_code)
        self.assertEqual(0, self.http.get(receipt).json()["revision"])
        self.assertEqual([], self.http.get(url + "/history").json())

    def test_concurrent_assignments_do_not_overwrite_each_other(self):
        teams = [self.team(self.event, name, "") for name in ("동시 배정 A", "동시 배정 B")]
        receipt = self.send(self.sets["set01"][:1]).raise_for_status().headers["location"]
        item = self.http.get(receipt).json()["files"][0]["item_id"]
        url = f"{receipt}/files/{item}/assignment"

        def assign(team):
            return self.http.put(url, json={"action": "assign", "team": team, "revision": 0, "reason": "제출 출처 확인"})

        with ThreadPoolExecutor(max_workers=2) as pool:
            outcomes = list(pool.map(assign, teams))
        self.assertEqual([200, 409], sorted(r.status_code for r in outcomes))
        winner = teams[[r.status_code for r in outcomes].index(200)]
        changes = self.http.get(url + "/history").raise_for_status().json()
        self.assertEqual([(None, winner, 1)], [(c["before_team_id"], c["after_team_id"], c["revision"]) for c in changes])

    def test_exclusion_releases_only_selected_teams_and_outside_releases_the_rest(self):
        a, b = [self.team(self.event, name, "") for name in ("Nextify", "AutoAI")]
        receipt = self.send(self.sets["set01"]).raise_for_status().headers["location"]
        first, second, pending = [f["item_id"] for f in self.http.get(receipt).json()["files"]]
        self.decide(receipt, first, "assign", 0, team=a).raise_for_status()
        self.decide(receipt, second, "assign", 1, team=b).raise_for_status()
        for team in (a, b):
            self.assertEqual(409, self.confirm(receipt, team, 2).status_code)
        self.assertEqual([], self.http.get(receipt).json()["teams"])
        self.assertEqual([], self.review_jobs())
        for _ in range(2):
            self.assertEqual(3, self.decide(receipt, pending, "hold", 2, exclude=[a, a]).raise_for_status().json()["revision"])
        original = self.http.get(receipt).json()["files"][2]
        self.assertEqual(("unassigned", None, [a]), (original["state"], original["team"], original["excluded"]))
        self.assertEqual(409, self.confirm(receipt, b, 3).status_code)
        link_a = self.confirm(receipt, a, 3).raise_for_status().json()
        for _ in range(2):
            self.assertEqual(4, self.decide(receipt, pending, "outside", 3).raise_for_status().json()["revision"])
        link_b = self.confirm(receipt, b, 4).raise_for_status().json()
        self.assertEqual(1, link_b["version"])
        changes = self.http.get(f"{receipt}/files/{pending}/assignment/history").raise_for_status().json()
        self.assertEqual([("unassigned", [a]), ("outside", [])], [(h["state"], h["excluded"]) for h in changes])
        self.assertEqual(link_a, self.confirm(receipt, a, 4).raise_for_status().json())

        self.decide(receipt, pending, "hold", 4, exclude=[b]).raise_for_status()
        links = {s["team"]: s for s in self.http.get(receipt).json()["teams"]}
        self.assertEqual(("blocked", None), (links[a]["state"], links[a]["submission_id"]))
        self.assertEqual(link_b, links[b])
        self.assertEqual("blocked", self.http.get(link_a["status_url"]).json()["state"])
        job_a = link_a["review_job"]["review_job_id"]
        self.assertEqual([job_a], [job["review_job_id"] for job in self.review_jobs("blocked")])
        self.assertEqual([b], [job["team"] for job in self.review_jobs("queued")])
        self.assertEqual(409, self.http.put(link_a["status_url"] + "/review-job").status_code)
        self.decide(receipt, pending, "outside", 5).raise_for_status()
        self.assertEqual(link_a, self.confirm(receipt, a, 6).raise_for_status().json())
        self.decide(receipt, first, "outside", 6).raise_for_status()
        self.assertEqual(409, self.confirm(receipt, a, 7).status_code)
        self.assertEqual("empty", self.http.get(link_a["status_url"]).json()["state"])
        self.assertEqual([job_a], [job["review_job_id"] for job in self.review_jobs("blocked")])
        self.decide(receipt, first, "assign", 7, team=a).raise_for_status()
        self.assertEqual(link_a, self.confirm(receipt, a, 8).raise_for_status().json())
        self.assertEqual({job_a, link_b["review_job"]["review_job_id"]},
                         {job["review_job_id"] for job in self.review_jobs("queued")})
        self.assertEqual(2, len(self.review_jobs()))

    def test_reassignment_revises_only_the_two_changed_snapshots(self):
        teams = [self.team(self.event, name, "") for name in ("Nextify", "AutoAI", "3팀")]
        inputs = self.sets["set01"] + self.sets["set02"] + self.sets["set04"]
        receipt = self.send(inputs).raise_for_status().headers["location"]
        files = self.http.get(receipt).raise_for_status().json()["files"]
        owners = [teams[0]] * 3 + [teams[1]] * 3 + [teams[2]] * 2
        for revision, (item, team) in enumerate(zip(files, owners, strict=True)):
            self.decide(receipt, item["item_id"], "assign", revision, team=team).raise_for_status()
        before = [self.confirm(receipt, team, 8).raise_for_status().json() for team in teams]
        self.assertEqual([1, 1, 1], [link["version"] for link in before])
        initial_jobs = {job["team"]: job for job in self.review_jobs("queued")}
        self.assertEqual(3, len(initial_jobs))
        snapshots = [self.http.get(link["status_url"]).raise_for_status().json() for link in before]
        self.assertEqual([3, 3, 2], [len(sub["files"]) for sub in snapshots])
        for i, team in enumerate(teams):
            self.assertEqual(before[i], self.confirm(receipt, team, 8).raise_for_status().json())
        for _ in range(2):
            self.decide(receipt, files[2]["item_id"], "assign", 8, team=teams[1]).raise_for_status()
        after = {s["team"]: s for s in self.http.get(receipt).raise_for_status().json()["teams"]}
        self.assertEqual([2, 2, 1], [after[t]["version"] for t in teams])
        self.assertEqual(before[2], after[teams[2]])
        queued = self.review_jobs("queued")
        self.assertEqual(3, len(queued))
        self.assertEqual({(teams[0], 2), (teams[1], 2), (teams[2], 1)}, {(j["team"], j["version"]) for j in queued})
        archived = self.review_jobs("superseded")
        self.assertEqual({initial_jobs[t]["review_job_id"] for t in teams[:2]}, {j["review_job_id"] for j in archived})
        self.assertEqual(5, len(self.review_jobs()))
        self.assertIn(initial_jobs[teams[2]], queued)
        for i, positions in enumerate(((0, 1), (2, 3, 4, 5), (6, 7))):
            current = self.http.get(after[teams[i]]["status_url"]).raise_for_status().json()
            task = self.http.get(after[teams[i]]["review_job"]["status_url"]).raise_for_status().json()
            self.assertIn(task, queued)
            self.assertEqual(current["submission_id"], task["submission_id"])
            self.assertEqual([files[j]["item_id"] for j in positions], [f["item_id"] for f in current["files"]])
            old = self.http.get(before[i]["status_url"]).raise_for_status().json()
            self.assertEqual(snapshots[i]["files"], old["files"])
            self.assertEqual("confirmed" if i == 2 else "superseded", old["state"])
            self.assertEqual(after[teams[i]], self.confirm(receipt, teams[i], 9).raise_for_status().json())
        self.assertEqual(409, self.confirm(receipt, teams[0], 8).status_code)

    def test_concurrent_confirmations_reuse_content_across_receipts_and_count_duplicates(self):
        team = self.team(self.event, "Nextify", "")
        a, b = self.sets["set01"][:2]

        def prepare(files):
            receipt = self.send(files).raise_for_status().headers["location"]
            items = self.http.get(receipt).raise_for_status().json()["files"]
            for revision, item in enumerate(items):
                self.decide(receipt, item["item_id"], "assign", revision, team=team).raise_for_status()
            return receipt

        receipts = [prepare([a, b, b]), prepare([("표시명변경.hwp", b[1]), b, a])]
        with ThreadPoolExecutor(max_workers=4) as pool:
            links = list(pool.map(lambda r: self.confirm(r, team, 3).raise_for_status().json(), receipts * 2))
        self.assertEqual({1}, {link["version"] for link in links})
        self.assertEqual(1, len({link["submission_id"] for link in links}))
        self.assertEqual(1, len({link["review_job"]["review_job_id"] for link in links}))
        self.assertEqual(1, len(self.review_jobs()))
        snapshot = self.http.get(links[0]["status_url"]).raise_for_status().json()
        self.assertEqual(sorted(hashlib.sha256(f[1]).hexdigest() for f in (a, b, b)),
                         sorted(f["sha256"] for f in snapshot["files"]))
        self.assertEqual([1, 2, 3], [f["position"] for f in snapshot["files"]])
        for receipt in receipts:
            self.assertEqual(snapshot["submission_id"], self.confirm(receipt, team, 3).raise_for_status().json()["submission_id"])
        reduced = prepare([a, b])
        v2 = self.confirm(reduced, team, 2).raise_for_status().json()
        self.assertEqual(2, v2["version"])
        self.assertNotEqual(snapshot["submission_id"], v2["submission_id"])
        self.assertEqual(409, self.confirm(receipts[0], team, 3).status_code)
        old_item = self.http.get(receipts[0]).json()["files"][0]["item_id"]
        self.assertEqual(409, self.decide(receipts[0], old_item, "outside", 3).status_code)
        self.assertEqual(3, self.http.get(receipts[0]).json()["revision"])
        self.assertEqual(v2, self.confirm(reduced, team, 2).raise_for_status().json())
        changed_bytes = prepare([a, (b[0], self.sets["set02"][1][1])])
        self.assertEqual(3, self.confirm(changed_bytes, team, 2).raise_for_status().json()["version"])

    def test_confirm_racing_reassignment_never_exposes_a_mixed_snapshot(self):
        a, b = [self.team(self.event, name, "") for name in ("Nextify", "AutoAI")]
        receipt = self.send(self.sets["set01"]).raise_for_status().headers["location"]
        items = [f["item_id"] for f in self.http.get(receipt).json()["files"]]
        for rev, team in enumerate((a, a, b)):
            self.decide(receipt, items[rev], "assign", rev, team=team).raise_for_status()
        with ThreadPoolExecutor(max_workers=2) as pool:
            confirming = pool.submit(self.confirm, receipt, a, 3)
            moving = pool.submit(self.decide, receipt, items[1], "assign", 3, team=b)
            first = confirming.result()
            moving.result().raise_for_status()
        self.assertIn(first.status_code, (200, 409))
        current = self.confirm(receipt, a, 4).raise_for_status().json()
        if first.status_code == 200:
            earlier = self.http.get(first.json()["status_url"]).raise_for_status().json()
            self.assertEqual(items[:2], [f["item_id"] for f in earlier["files"]])
            self.assertEqual("superseded", earlier["state"])
        self.assertEqual(2 if first.status_code == 200 else 1, current["version"])
        latest = self.http.get(current["status_url"]).raise_for_status().json()
        self.assertEqual([items[0]], [f["item_id"] for f in latest["files"]])
        self.assertEqual([current["submission_id"]], [job["submission_id"] for job in self.review_jobs("queued")])

    def test_review_job_registration_handoff_and_event_permissions(self):
        team = self.team(self.event, "3팀", "")
        inputs = self.sets["set04"]
        receipt = self.send(inputs).raise_for_status().headers["location"]
        items = self.http.get(receipt).raise_for_status().json()["files"]
        for rev, item in enumerate(items):
            self.decide(receipt, item["item_id"], "assign", rev, team=team).raise_for_status()
        link = self.confirm(receipt, team, len(items)).raise_for_status().json()
        job, = self.review_jobs("queued")
        self.assertEqual((self.event, team, link["submission_id"], 1),
                         (job["event_id"], job["team"], job["submission_id"], job["version"]))
        self.assertIsNotNone(datetime.fromisoformat(job["registered_at"]).utcoffset())
        detail_url = job["status_url"]
        register = link["status_url"] + "/review-job"
        with ThreadPoolExecutor(max_workers=4) as pool:
            for result in pool.map(lambda _: self.http.put(register).raise_for_status().json(), range(4)):
                self.assertEqual(job, result)
        self.assertEqual([job], self.review_jobs())
        self.assertEqual(job, self.http.get(detail_url).raise_for_status().json())
        batch_team, = self.http.get(receipt).raise_for_status().json()["teams"]
        snapshot = self.http.get(job["submission_url"]).raise_for_status().json()
        self.assertEqual(link["review_job"], batch_team["review_job"])
        self.assertEqual({"review_job_id": job["review_job_id"], "state": "queued", "status_url": detail_url},
                         snapshot["review_job"])
        for source, (name, data) in zip(snapshot["files"], inputs, strict=True):
            self.assertEqual(name, source["name"])
            self.assertEqual(data, self.http.get(source["original_url"]).raise_for_status().content)
        listing = f"/api/events/{self.event}/review-jobs"
        self.assertEqual(422, self.http.get(listing, params={"state": "unknown"}).status_code)
        for path in (detail_url, listing, job["submission_url"]):
            self.assertEqual(404, self.peer.get(path).status_code)
        self.assertEqual(404, self.peer.put(register).status_code)
        with httpx.Client(base_url=URL, trust_env=False) as anonymous:
            self.assertEqual(401, anonymous.get(detail_url).status_code)
            self.assertEqual(401, anonymous.get(listing).status_code)

    @requires_worker
    def test_one_worker_claim_and_idempotent_result(self):
        receipt, (team,) = self.review_fixture("set04")
        payload = {"worker_id": "staff", "event_id": self.event}
        self.assertEqual(401, self.http.post(WORKER + "/claim", json=payload).status_code)
        worker = self.worker()
        self.assertEqual(401, worker.post(WORKER + "/claim", json=payload, headers={"Authorization": "Bearer wrong"}).status_code)
        self.assertEqual(422, worker.post(WORKER + "/claim", json={"worker_id": " "}).status_code)
        first, empty = sorted(self.race_claims(), key=lambda r: r.status_code)
        self.assertEqual((200, 204), (first.status_code, empty.status_code))
        claim = first.json()
        task, = self.review_jobs("running")
        self.assertEqual((team, task["review_job_id"], 1), (claim["team"], claim["review_job_id"], claim["attempt"]))
        self.assertNotIn("claim_token", task)
        self.assertEqual("running", self.http.get(receipt).json()["teams"][0]["review_job"]["state"])
        url = WORKER + "/" + claim["review_job_id"]
        token = {"X-Claim-Token": claim["claim_token"]}
        for original, (name, content) in zip(claim["files"], self.sets["set04"], strict=True):
            self.assertEqual(name, original["name"])
            self.assertEqual(content, worker.get(original["original_url"], headers=token).raise_for_status().content)
        self.assertEqual(404, worker.get(url + f"/files/{uuid4()}/original", headers=token).status_code)
        self.assertEqual(401, worker.get(task["status_url"]).status_code)
        studio_id = "test-" + uuid4().hex
        result = {"state": "done", "studio_job_id": studio_id, "verdict": "재제출요청", "reason": "02 동의서 누락",
                  "output": {"documents": ["01", "03"]}}
        self.assertEqual(409, worker.put(url + "/result", json=result, headers={"X-Claim-Token": str(uuid4())}).status_code)
        self.assertEqual(422, worker.put(url + "/result", json={**result, "verdict": "임의 값"}, headers=token).status_code)
        renewed = worker.put(url + "/lease", json={"studio_job_id": studio_id}, headers=token).raise_for_status().json()
        self.assertGreater(datetime.fromisoformat(renewed["lease_until"]), datetime.fromisoformat(claim["lease_until"]))
        self.assertEqual(409, worker.put(url + "/lease", json={"studio_job_id": "changed"}, headers=token).status_code)
        with ThreadPoolExecutor(max_workers=2) as pool:
            codes = list(pool.map(lambda _: worker.put(url + "/result", json=result, headers=token).status_code, range(2)))
        self.assertEqual([204, 204], codes)
        stored = self.http.get(task["status_url"]).raise_for_status().json()
        self.assertEqual(result, stored["result"])
        self.assertEqual(studio_id, stored["studio_job_id"])
        self.assertIsNotNone(datetime.fromisoformat(stored["finished_at"]).utcoffset())
        self.assertEqual(409, worker.put(url + "/result", json={**result, "reason": "수정"}, headers=token).status_code)
        self.assertEqual(409, worker.get(claim["files"][0]["original_url"], headers=token).status_code)
        self.assertEqual(204, worker.post(WORKER + "/claim", json=payload).status_code)
        self.assertEqual(stored, self.http.get(task["status_url"]).json())
        self.assertEqual(404, self.peer.get(task["status_url"]).status_code)
        summary, = self.review_jobs("done")
        self.assertNotIn("result", summary)
        current = self.http.get(receipt).json()["teams"][0]["review_job"]
        self.assertEqual(("done", "재제출요청"), (current["state"], current["verdict"]))

    @requires_worker
    def test_two_workers_take_distinct_teams_and_failure_is_not_a_verdict(self):
        receipt, teams = self.review_fixture("set01", "set02")
        a, b = [r.raise_for_status().json() for r in self.race_claims()]
        self.assertEqual(set(teams), {a["team"], b["team"]})
        self.assertNotEqual(a["review_job_id"], b["review_job_id"])
        worker = self.worker()
        token_a, token_b = [{"X-Claim-Token": c["claim_token"]} for c in (a, b)]
        self.assertEqual(409, worker.get(a["files"][0]["original_url"], headers=token_b).status_code)
        url_a, url_b = [WORKER + "/" + c["review_job_id"] for c in (a, b)]
        self.assertEqual(404, worker.get(url_a + "/files/" + b["files"][0]["item_id"] + "/original", headers=token_a).status_code)
        run = {"studio_job_id": "test-" + uuid4().hex}
        worker.put(url_a + "/lease", json=run, headers=token_a).raise_for_status()
        self.assertEqual(409, worker.put(url_b + "/lease", json=run, headers=token_b).status_code)
        failure = {"state": "failed", "reason": "검토용 변환 실패"}
        worker.put(url_b + "/result", json=failure, headers=token_b).raise_for_status()
        by_team = {t["team"]: t["review_job"] for t in self.http.get(receipt).json()["teams"]}
        self.assertEqual(("running", "failed"), (by_team[a["team"]]["state"], by_team[b["team"]]["state"]))
        self.assertNotIn("verdict", by_team[b["team"]])
        failed, = self.review_jobs("failed")
        self.assertEqual(failure["reason"], self.http.get(failed["status_url"]).json()["result"]["reason"])

    @requires_worker
    def test_hold_restore_and_new_version_fence_old_worker(self):
        receipt, (team,) = self.review_fixture("set04")
        worker = self.worker()
        def claim():
            return worker.post(WORKER + "/claim", json={"worker_id": "worker", "event_id": self.event})
        first = claim().raise_for_status().json()
        url = WORKER + "/" + first["review_job_id"]
        old = {"X-Claim-Token": first["claim_token"]}
        file = first["files"][0]["item_id"]
        self.decide(receipt, file, "hold", 2).raise_for_status()
        self.assertEqual(204, claim().status_code)
        self.assertEqual(409, worker.put(url + "/lease", json={}, headers=old).status_code)
        self.decide(receipt, file, "assign", 3, team=team).raise_for_status()
        again = claim().raise_for_status().json()
        self.assertEqual((first["review_job_id"], 2), (again["review_job_id"], again["attempt"]))
        self.assertNotEqual(first["claim_token"], again["claim_token"])
        failed = {"state": "failed", "reason": "이전 작업 응답"}
        self.assertEqual(409, worker.put(url + "/result", json=failed, headers=old).status_code)
        other = self.team(self.event, "재배정 팀", "")
        self.decide(receipt, file, "assign", 4, team=other).raise_for_status()
        self.assertEqual(409, worker.put(url + "/result", json=failed, headers={"X-Claim-Token": again["claim_token"]}).status_code)
        current, = self.review_jobs("queued")
        self.assertEqual((2, team), (current["version"], current["team"]))
        self.assertEqual([first["review_job_id"]], [j["review_job_id"] for j in self.review_jobs("superseded")])

    @requires_worker
    def test_same_version_from_new_receipt_keeps_active_claim(self):
        previous, (team,) = self.review_fixture("set04")
        worker = self.worker()
        payload = {"worker_id": "worker", "event_id": self.event}
        held = worker.post(WORKER + "/claim", json=payload).raise_for_status().json()
        files = list(reversed(self.sets["set04"]))
        current = self.send(files).raise_for_status().headers["location"]
        for rev, item in enumerate(self.http.get(current).json()["files"]):
            self.decide(current, item["item_id"], "assign", rev, team=team).raise_for_status()
        link = self.confirm(current, team, len(files)).raise_for_status().json()
        self.assertEqual((held["submission_id"], "running"), (link["submission_id"], link["review_job"]["state"]))
        self.assertEqual(204, worker.post(WORKER + "/claim", json=payload).status_code)
        result = {"state": "done", "studio_job_id": "test-" + uuid4().hex, "verdict": "담당자확인", "reason": "원본 대조 필요"}
        worker.put(WORKER + "/" + held["review_job_id"] + "/result", json=result,
                   headers={"X-Claim-Token": held["claim_token"]}).raise_for_status()
        for receipt, state in ((previous, "superseded"), (current, "confirmed")):
            team_link, = self.http.get(receipt).json()["teams"]
            self.assertEqual((state, "done", "담당자확인"), (team_link["state"], team_link["review_job"]["state"],
                                                       team_link["review_job"]["verdict"]))

    @requires_worker
    @unittest.skipUnless(os.getenv("INTAKE_TEST_SHORT_LEASE"), "Run with a 5–20 second test lease.")
    def test_expired_claim_resumes_same_studio_job(self):
        self.review_fixture("set01")
        worker = self.worker()
        def claim(name):
            return worker.post(WORKER + "/claim", json={"worker_id": name, "event_id": self.event})
        first = claim("first").raise_for_status().json()
        url = WORKER + "/" + first["review_job_id"]
        old = {"X-Claim-Token": first["claim_token"]}
        run = {"studio_job_id": "test-" + uuid4().hex}
        worker.put(url + "/lease", headers=old, json=run).raise_for_status()
        deadline = time.monotonic() + 23
        while not self.review_jobs("queued") and time.monotonic() < deadline:
            time.sleep(0.2)
        self.assertEqual(409, worker.put(url + "/lease", headers=old, json={}).status_code)
        second = claim("second").raise_for_status().json()
        self.assertEqual((first["review_job_id"], run["studio_job_id"], 2),
                         (second["review_job_id"], second["studio_job_id"], second["attempt"]))
        result = {"state": "done", "verdict": "성공", "reason": "원본 확인 완료"}
        self.assertEqual(409, worker.put(url + "/result", headers=old, json=result).status_code)
        self.assertEqual(204, worker.put(url + "/result", headers={"X-Claim-Token": second["claim_token"]}, json=result).status_code)
        self.assertEqual(204, claim("third").status_code)

    def test_submission_and_exclusion_enforce_event_scope(self):
        team = self.team(self.event, "접수 팀", "")
        foreign_event = self.http.post("/api/events", json={"name": uuid4().hex}).raise_for_status().json()["id"]
        foreign = self.team(foreign_event, "다른 대회", "")
        receipt = self.send(self.sets["set04"]).raise_for_status().headers["location"]
        first, second = [f["item_id"] for f in self.http.get(receipt).json()["files"]]
        for action, fields in (("hold", {"exclude": [team, foreign]}), ("outside", {"team": team}),
                               ("assign", {"team": team, "exclude": [team]}), ("hold", {"exclude": [None]})):
            self.assertEqual(422, self.decide(receipt, first, action, 0, **fields).status_code)
        self.assertEqual(0, self.http.get(receipt).json()["revision"])
        self.decide(receipt, first, "assign", 0, team=team).raise_for_status()
        self.decide(receipt, second, "assign", 1, team=team).raise_for_status()
        self.assertEqual(422, self.confirm(receipt, foreign, 2).status_code)
        self.assertEqual(404, self.confirm(receipt, team, 2, self.peer).status_code)
        self.assertEqual(422, self.confirm(receipt, team, None).status_code)
        link = self.confirm(receipt, team, 2).raise_for_status().json()
        self.assertEqual(404, self.peer.get(link["status_url"]).status_code)
        with httpx.Client(base_url=URL, trust_env=False) as anonymous:
            self.assertEqual(401, anonymous.get(link["status_url"]).status_code)
        sub = self.http.get(link["status_url"]).raise_for_status().json()
        self.assertEqual((self.event, team, os.environ["INTAKE_TEST_LOGIN_A"]),
                         (sub["event_id"], sub["team"], sub["confirmed_by"]))
        for f in sub["files"]:
            raw = self.http.get(f"/api/intake-batches/{f['batch_id']}/files/{f['item_id']}/original").raise_for_status()
            self.assertEqual(f["sha256"], hashlib.sha256(raw.content).hexdigest())

    def test_two_staff_direct_downloads_and_event_isolation(self):
        event_b = self.peer.post("/api/events", json={"name": "담당 B " + uuid4().hex}).raise_for_status().json()["id"]
        inputs = self.sets["set01"][:1]
        with httpx.Client(base_url=URL, trust_env=False) as anonymous:
            for owner, outsider, event in ((self.http, self.peer, self.event), (self.peer, self.http, event_b)):
                receipt = self.send(inputs, client=owner, event=event).raise_for_status().headers["location"]
                detail = owner.get(receipt).raise_for_status().json()
                url = receipt + "/files/" + detail["files"][0]["item_id"] + "/original"
                original = owner.get(url)
                self.assertEqual(200, original.status_code)
                self.assertEqual(hashlib.sha256(inputs[0][1]).digest(), hashlib.sha256(original.content).digest())
                for method, headers in (("GET", {}), ("HEAD", {}), ("GET", {"Range": "bytes=0-15", "X-Staff": "admin"})):
                    blocked = outsider.request(method, url, headers=headers)
                    self.assertEqual(404, blocked.status_code)
                    self.assertNotIn("content-disposition", blocked.headers)
                    self.assertNotEqual("application/octet-stream", blocked.headers.get("content-type"))
                    self.assertNotEqual(inputs[0][1], blocked.content)
                    self.assertNotIn(inputs[0][0].encode(), blocked.content)
                self.assertEqual(401, anonymous.get(url).status_code)
                self.assertEqual(404, outsider.get(receipt).status_code)
                self.assertEqual(404, outsider.get("/api/intake-batches", params={"event": event}).status_code)
                teams = f"/api/events/{event}/teams"
                self.assertEqual(404, outsider.get(teams).status_code)
                self.assertEqual(404, outsider.post(teams, json={"name": "접근 시험"}).status_code)
                self.assertEqual(404, self.send(inputs, client=outsider, event=event).status_code)
                self.assertEqual(409, outsider.post("/api/events", json={"name": detail["batch"]["event_name"]}).status_code)
                self.assertNotIn(event, {e["id"] for e in outsider.get("/api/events").json()})
                self.assertEqual(404, outsider.get(url).status_code)

    def test_login_rotation_csrf_and_logout(self):
        with httpx.Client(base_url=URL, trust_env=False, headers={"Accept": "application/json"}) as client:
            form = client.get("/login").raise_for_status()
            self.assertIn('name="username"', form.text)
            token = client.get("/api/auth/session").raise_for_status().json()["csrf_token"]
            before = client.cookies["JSESSIONID"]
            invalid = client.post("/login", data={"username": os.environ["INTAKE_TEST_LOGIN_A"], "password": "incorrect"},
                                  headers={"X-CSRF-TOKEN": token})
            self.assertEqual(401, invalid.status_code)
            login(client, os.environ["INTAKE_TEST_LOGIN_A"], os.environ["INTAKE_TEST_PASSWORD_A"])
            authenticated = client.cookies["JSESSIONID"]
            self.assertNotEqual(before, authenticated)
            denied = client.post("/api/events", json={"name": "위조 요청"}, headers={
                "Sec-Fetch-Site": "cross-site", "Origin": "https://untrusted.invalid", "X-CSRF-TOKEN": ""})
            self.assertEqual(403, denied.status_code)
            self.assertEqual(204, client.post("/logout").status_code)
            replay = client.get("/api/events", headers={"Cookie": "JSESSIONID=" + authenticated})
            self.assertEqual(401, replay.status_code)
