"""Deletion through the staff API. Run on an isolated local intake_delete_test database."""
import json
import os
import subprocess
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from uuid import uuid4

import httpx

from operations.cleanup import clear_deleted_cache
from operations.store import cached_file, configuration, connect
from service.db import DATA
from tests.official_inputs import official_files
from tests.test_intake_postgres import login, mark_batch_read


@unittest.skipUnless(os.getenv("AWARDS_DELETION_TESTS") == "1", "Requires an isolated deletion test database.")
class IntakeDeletionTest(unittest.TestCase):
    def setUp(self):
        cfg = configuration()
        url = os.environ["INTAKE_TEST_URL"]
        self.assertEqual(httpx.URL(url).host, "127.0.0.1")
        self.assertNotEqual(httpx.URL(url).port, 18765)
        self.db = self.enterContext(connect(cfg))
        self.assertEqual(self.db.execute("SELECT current_database() AS db").fetchone()["db"], "intake_delete_test")
        self.staff, self.peer = [self.enterContext(httpx.Client(base_url=url, trust_env=False, timeout=30)) for _ in range(2)]
        for client, suffix in ((self.staff, "A"), (self.peer, "B")):
            login(client, os.environ["INTAKE_TEST_LOGIN_" + suffix], os.environ["INTAKE_TEST_PASSWORD_" + suffix])
        self.worker = self.enterContext(httpx.Client(base_url=url + "/api/worker/", trust_env=False,
            headers={"Authorization": "Bearer " + cfg["AWARDS_REVIEW_WORKER_TOKEN"]}))
        self.event = self.staff.post("/api/events", json={"name": "삭제 검증 " + uuid4().hex}).raise_for_status().json()["id"]
        directory = Path(__file__).resolve().parents[1] / "test case" / "upstage_data"
        self.a, self.b = (sorted(official_files(case, directory)) for case in ("set01", "set02"))
        self.team_count = 0

    def upload(self, files, key=None, **options):
        fields = {"event": self.event, "mode": "existing", "manifest": json.dumps([{"name": n, "size": len(b)} for n,b in files]), **options}
        return self.staff.post("/api/intake-batches", data=fields, files=[("files", pair) for pair in files],
                               headers={"Idempotency-Key": key or str(uuid4())})

    def get(self, path):
        return self.staff.get(path).raise_for_status().json()

    def receive_team(self, files, key=None, target=None, **options):
        if target is None:
            self.team_count += 1
            target = self.staff.post(f"/api/events/{self.event}/teams",
                json={"name": f"검증 {self.team_count}팀"}).raise_for_status().json()["id"]
        batch = self.upload(files, key, target=target, **options).raise_for_status().headers["location"]
        detail = self.get(batch)
        for revision, item in enumerate(detail["files"], detail["revision"]):
            self.staff.put(batch + "/files/" + item["item_id"] + "/assignment",
                json={"action": "assign", "team": target, "reason": "시험 묶음 확인", "revision": revision}).raise_for_status()
        return batch

    def confirm(self, batch, team):
        return self.staff.put(batch + "/teams/" + team + "/submission",
                              json={"revision": self.get(batch)["revision"]}).raise_for_status().json()

    def approved(self, link):
        sid, jid = link["submission_id"], link["review_job"]["review_job_id"]
        claim = self.worker.post("review-jobs/claim", json={"worker_id": "delete-test", "review_job_id": jid}).raise_for_status().json()
        docs = {kind: [{"id": file["item_id"], "page": 1}] for kind, file in zip(("01","02","03"), claim["files"], strict=True)}
        self.worker.put(f"review-jobs/{jid}/result", headers={"X-Claim-Token": claim["claim_token"]},
                        json={"state": "done", "studio_job_id": "test-" + jid, "verdict": "담당자확인",
                              "reason": "시험 판정", "output": {"documents": docs}}).raise_for_status()
        self.staff.put(f"/api/submissions/{sid}/review", json={"revision": 0, "decision": "승인", "note": "원본 대조",
            "members": [{"role": "대표", "name": "시험 대표"}], "recipient": {}, "issues": []}).raise_for_status()
        self.staff.put(f"/api/submissions/{sid}/payment",json={"revision":1,"award_type":"대상","support_amount":"100",
            "gross_amount":"100","tax_amount":"0","net_amount":"100"}).raise_for_status()
        return sid

    def report(self, *submissions):
        rid = self.staff.post("/api/reports", json={"event": self.event, "submissions": submissions}).raise_for_status().json()["id"]
        # Stand in for the print worker. Exercise the real approval and download checks.
        self.db.execute("UPDATE award_report SET state='preview',pdf=%s,hwpx=%s WHERE id=%s", (b"test PDF",b"test HWPX",rid))
        self.staff.post(f"/api/reports/{rid}/confirm").raise_for_status()
        return f"/api/reports/{rid}"

    @unittest.skipUnless(os.getenv("AWARDS_DELETION_BROWSER") == "1", "Set AWARDS_DELETION_BROWSER=1 for Chrome.")
    def test_staff_deletes_from_all_three_screens(self):
        batches, reports = [], []
        for files in (self.a, self.b):
            batch = self.receive_team(files)
            team = self.get(batch)["batch"]["target_team_id"]
            # Exercise the preview of an existing numbered team as well as manually registered teams.
            self.db.execute("""WITH n AS (UPDATE award_event SET last_intake_number=last_intake_number+1
                WHERE id=%s RETURNING last_intake_number)
                UPDATE award_team SET intake_number=n.last_intake_number FROM n WHERE id=%s""", (self.event, team))
            mark_batch_read(batch)
            confirmed = self.confirm(batch, team)
            reports.append(self.report(self.approved(confirmed)))
            batches.append(batch)
        single = self.receive_team(self.a[:1])
        fixture = {"event": self.event, "batches": batches, "reports": reports, "single": single}
        subprocess.run(["node", "--test", "tests/intake-deletion.mjs"], check=True, timeout=120,
                       cwd=Path(__file__).resolve().parents[1] / "frontend",
                       env=os.environ | {"DELETION_FIXTURE": json.dumps(fixture)})
        for path in (*batches, single, *(r + "/pdf" for r in reports), f"/api/events/{self.event}/teams"):
            self.assertEqual(self.staff.get(path).status_code, 404, path)

    def test_file_removes_dependent_reviews_and_reports_only(self):
        key = str(uuid4())
        mixed = self.upload(self.a + self.b, key, mode="existing").raise_for_status().headers["location"]
        items = self.get(mixed)["files"]
        teams = [self.staff.post(f"/api/events/{self.event}/teams", json={"name": name}).raise_for_status().json()["id"]
                 for name in ("첫팀","둘째팀")]
        for i, item in enumerate(items):
            self.staff.put(mixed + "/files/" + item["item_id"] + "/assignment",
                json={"revision": i, "action":"assign", "team":teams[i // 3], "reason":"팀별 원본 확인"}).raise_for_status()
        mark_batch_read(mixed)
        first, other = [self.confirm(mixed, team) for team in teams]
        sid, other_sid = self.approved(first), self.approved(other)
        combined, kept = self.report(sid,other_sid), self.report(other_sid)
        fid = items[0]["item_id"]
        target = mixed + "/files/" + fid
        preview_url = target + "/deletion-preview"
        before = self.get(preview_url)
        self.assertEqual((before["team_count"], before["batch_count"], before["file_count"]), (0, 0, 1))
        self.assertEqual([(r["id"], r["team_name"], r["version"], r["verdict"], r["decision"]) for r in before["reviews"]],
                         [(sid, "첫팀", 1, "담당자확인", "승인")])
        self.assertEqual([(r["id"], r["state"], r["edited"]) for r in before["reports"]],
                         [(combined.split("/")[-1], "confirmed", False)])
        edited = self.staff.post(combined + "/edited", files={"file": self.a[2]}).raise_for_status().json()["id"]
        self.assertEqual(self.staff.delete(target, headers={"If-Match": '"' + before["token"] + '"'}).status_code, 412)
        self.assertEqual(self.staff.get(target + "/original").raise_for_status().content, self.a[0][1])
        after = self.get(preview_url)
        self.assertEqual([(r["id"], r["version"], r["edited"]) for r in after["reports"]],
                         [(combined.split("/")[-1], 1, False), (edited, 3, True)])
        self.assertNotEqual(after["token"], before["token"])
        self.assertEqual(self.get(preview_url), after)
        self.db.execute("""INSERT INTO document_edit_version(file_id,version,parent_version,editor,sha256,hwpx)
            VALUES(%s,1,0,%s,encode(sha256(%s),'hex'),%s)""",
            (fid, os.environ["INTAKE_TEST_LOGIN_A"], self.a[2][1], self.a[2][1]))
        self.db.execute("INSERT INTO original_analysis(file_id,pdf) VALUES(%s,%s)", (fid,b"test preview"))
        self.db.execute("INSERT INTO file_preparation_log(file_id,stage,display_name) VALUES(%s,'판독 완료','파일01')", (fid,))
        source = Path(cached_file(self.db, fid)["_source"])
        source.with_suffix(".pdf").write_bytes(b"preview")
        other_cache = Path(cached_file(self.db, items[3]["item_id"])["_source"])
        mail = self.db.execute("SELECT id FROM review_mail WHERE submission_id=%s LIMIT 1", (sid,)).fetchone()["id"]
        envelope = DATA / "operations" / "mail" / (str(mail) + ".eml")
        envelope.parent.mkdir(parents=True, exist_ok=True)
        envelope.write_bytes(b"test mail")

        self.assertEqual(self.peer.delete(target).status_code, 404)
        self.assertEqual(self.staff.delete(target, headers={"If-Match": '"' + after["token"] + '"'}).status_code, 204)
        self.assertEqual(self.staff.get(preview_url).status_code, 404)
        self.assertFalse(self.db.execute("SELECT 1 FROM document_edit_version WHERE file_id=%s", (fid,)).fetchone())
        for path in (target+"/original",f"/api/files/{fid}/preview",first["status_url"],
                     first["review_job"]["status_url"],combined+"/pdf",f"/api/reports/{edited}"):
            self.assertEqual(self.staff.get(path).status_code, 404, path)
        self.assertEqual(self.get(other["status_url"])["submission_id"], other_sid)
        self.assertEqual(self.staff.get(kept+"/pdf").raise_for_status().content, b"test PDF")
        self.assertEqual(len(self.get(mixed)["files"]), 5)
        self.assertEqual(self.staff.delete(target).status_code, 404)
        self.assertEqual(self.upload(self.a+self.b, key, mode="existing").status_code, 409)
        self.assertEqual(self.confirm(mixed, teams[0])["version"], 2)
        for table in ("workflow_audit", "review_mail", "review_resolution"):
            self.assertFalse(self.db.execute(f"SELECT 1 FROM {table} WHERE submission_id=%s", (sid,)).fetchone())
        while clear_deleted_cache(self.db):
            pass
        self.assertFalse(any(p.exists() for p in (source,source.with_suffix(".pdf"),envelope)))
        self.assertTrue(other_cache.is_file())

    def test_batch_event_permissions_busy_worker_and_replay(self):
        other_event = self.peer.post("/api/events", json={"name":"유지할 대회 " + uuid4().hex}).raise_for_status().json()["id"]
        key = str(uuid4())
        batch = self.receive_team(self.a,key)
        another = self.receive_team(self.b[:1])
        detail = self.get(batch)
        target = batch + "/files/" + detail["files"][0]["item_id"]
        event = "/api/events/" + self.event
        for path in (event,batch,target):
            self.assertEqual(self.peer.get(path + "/deletion-preview").status_code, 404)
            self.assertEqual(self.peer.delete(path).status_code, 404)
        self.assertEqual(self.staff.get(another+"/files/"+detail["files"][0]["item_id"]+"/deletion-preview").status_code,404)
        for path, counts in ((event,(2,2,4)), (batch,(0,1,3)), (target,(0,0,1))):
            impact = self.get(path + "/deletion-preview")
            self.assertEqual((impact["team_count"],impact["batch_count"],impact["file_count"]), counts)
            self.assertEqual((impact["reviews"],impact["reports"]), ([],[]))
        self.assertEqual(self.staff.delete(another+"/files/"+detail["files"][0]["item_id"]).status_code,404)
        mark_batch_read(batch)
        link = self.confirm(batch, detail["batch"]["target_team_id"])
        jid = link["review_job"]["review_job_id"]
        claim = self.worker.post("review-jobs/claim", json={"worker_id":"busy", "review_job_id":jid}).raise_for_status().json()
        for path in (event,batch,target):
            impact = self.get(path + "/deletion-preview")
            self.assertEqual(impact["reviews"][0]["state"], "running")
            self.assertEqual(self.staff.delete(path, headers={"If-Match": '"' + impact["token"] + '"'}).status_code,409)
        self.assertEqual(self.staff.get(target+"/original").raise_for_status().content,self.a[0][1])
        self.worker.put(f"review-jobs/{jid}/lease",headers={"X-Claim-Token":claim["claim_token"]},
                        json={"studio_job_id":"remote-" + jid}).raise_for_status()
        self.db.execute("UPDATE review_job SET lease_until=now()-interval '1 second' WHERE id=%s", (jid,))
        self.assertEqual(self.staff.delete(target).status_code,409)
        claim = self.worker.post("review-jobs/claim", json={"worker_id":"resumed","review_job_id":jid}).raise_for_status().json()
        self.worker.put(f"review-jobs/{jid}/result",headers={"X-Claim-Token":claim["claim_token"]},
                        json={"state":"failed","reason":"시험 작업 종료"}).raise_for_status()
        self.assertEqual(self.staff.delete(batch).status_code,204)
        self.assertEqual(self.upload(self.a,key,target=detail["batch"]["target_team_id"]).status_code,409)
        self.assertEqual(self.staff.get(batch).status_code,404)
        self.assertEqual(len(self.get(event+"/teams")),2)
        last = another + "/files/" + self.get(another)["files"][0]["item_id"]
        self.assertEqual(self.get(last + "/deletion-preview")["batch_count"], 1)
        with ThreadPoolExecutor(max_workers=2) as pool:
            codes = list(pool.map(lambda _: self.staff.delete(last).status_code, range(2)))
        self.assertIn(204,codes)
        self.assertTrue(set(codes)<={204,404,409})
        self.assertEqual(self.staff.get(another).status_code,404)
        final = self.receive_team(self.b)
        mark_batch_read(final)
        finished = self.confirm(final,self.get(final)["batch"]["target_team_id"])
        report = self.report(self.approved(finished))
        impact = self.get(event + "/deletion-preview")
        self.assertEqual([r["id"] for r in impact["reports"]], [report.rsplit("/",1)[-1]])
        self.assertEqual(self.staff.delete(event, headers={"If-Match": '"' + impact["token"] + '"'}).status_code,204)
        for path in (event+"/teams",final,report+"/hwpx",finished["status_url"]):
            self.assertEqual(self.staff.get(path).status_code,404)
        self.assertEqual(self.staff.delete(event).status_code,404)
        self.assertEqual(self.peer.get(f"/api/events/{other_event}/teams").status_code,200)
        self.assertNotIn(self.event,[e["id"] for e in self.get("/api/events")])

    def test_replacement_that_no_longer_uses_deleted_original_survives(self):
        base = self.receive_team(self.a)
        detail = self.get(base)
        team = detail["batch"]["target_team_id"]
        fids = [f["item_id"] for f in detail["files"]]
        mark_batch_read(base)
        v1 = self.confirm(base,team)
        correction = {"mode":"existing","target":team,"base":v1["submission_id"],"removed":json.dumps(fids[:1])}
        fixed = self.receive_team(self.b[:1], **correction)
        pending = self.receive_team(self.b[:1], **correction)
        mark_batch_read(fixed)
        v2 = self.confirm(fixed,team)
        self.assertEqual(self.staff.delete(base+"/files/"+fids[0]).status_code,204)
        self.assertEqual(self.staff.get(v1["status_url"]).status_code,404)
        self.assertEqual(self.confirm(fixed,team)["submission_id"],v2["submission_id"])
        self.assertEqual([f["item_id"] for f in self.get(v2["status_url"])["files"]], fids[1:] + [self.get(fixed)["files"][0]["item_id"]])
        self.assertEqual(self.get(pending)["batch"]["status"],"conflict")
        self.assertEqual(self.staff.put(pending+"/teams/"+team+"/submission",json={"revision":self.get(pending)["revision"]}).status_code,409)

    def test_deleting_superseded_duplicate_preserves_current_receipt(self):
        team = self.staff.post(f"/api/events/{self.event}/teams", json={"name":"중복 접수 검증"}).raise_for_status().json()["id"]
        batches, versions = [], []
        for _ in range(3):
            batch = self.upload(self.a[:1], mode="existing", target=team).raise_for_status().headers["location"]
            item = self.get(batch)["files"][0]["item_id"]
            self.staff.put(batch+"/files/"+item+"/assignment", json={"action":"assign","team":team,"reason":"원본 확인","revision":0}).raise_for_status()
            mark_batch_read(batch)
            versions.append(self.confirm(batch,team)["submission_id"])
            batches.append(batch)
        self.assertEqual(len(set(versions)),1)
        self.assertEqual(self.staff.delete(batches[1]).status_code,204)
        self.assertEqual(self.get(batches[2])["teams"][0]["submission_id"],versions[0])
        self.assertEqual(self.get(f"/api/submissions/{versions[0]}")["files"][0]["batch_id"],batches[0].rsplit("/",1)[1])

    def test_removing_only_blocker_releases_the_existing_version(self):
        team = self.staff.post(f"/api/events/{self.event}/teams", json={"name":"보류 해제"}).raise_for_status().json()["id"]
        batch = self.upload(self.a[:2], mode="existing").raise_for_status().headers["location"]
        kept, blocker = [batch+"/files/"+f["item_id"] for f in self.get(batch)["files"]]
        self.staff.put(kept+"/assignment",json={"action":"assign","team":team,"reason":"팀 확인","revision":0}).raise_for_status()
        self.staff.put(blocker+"/assignment",json={"action":"outside","reason":"예비 자료","revision":1}).raise_for_status()
        mark_batch_read(batch)
        original = self.confirm(batch,team)
        self.staff.put(blocker+"/assignment",json={"action":"hold","reason":"소속 확인","revision":2}).raise_for_status()
        self.assertEqual(self.get(batch)["teams"][0]["state"],"blocked")
        self.assertEqual(self.staff.delete(blocker).status_code,204)
        self.assertEqual(self.get(batch)["teams"],[original])
