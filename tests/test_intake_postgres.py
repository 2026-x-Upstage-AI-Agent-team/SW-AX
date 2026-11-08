"""Run against a separate Spring Boot instance backed by a real test PostgreSQL database."""
import hashlib
import json
import os
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urlparse
from uuid import uuid4
from zipfile import ZipFile

import httpx


ROOT = Path(__file__).resolve().parents[1]
URL = os.getenv("INTAKE_TEST_URL")

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
