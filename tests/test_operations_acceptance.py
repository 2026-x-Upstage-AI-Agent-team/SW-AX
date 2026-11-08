"""Opt-in acceptance test with the official fictional set01, set02 and set04 on a dedicated database."""
import hashlib
import json
import os
import subprocess
import sys
import time
import unittest
from email import policy
from email.parser import BytesParser
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
from zipfile import ZipFile

import httpx
import pypdfium2 as pdfium
from lxml import etree
from pypdf import PdfReader

from tests.test_intake_postgres import login
from operations.delivery import deliver
from operations.preparation import prepare
from operations.printer import worker_api
from operations.reports import report_tick
from operations.store import configuration, connect
from operations.studio_worker import run_studio
from reporting.fill_award_form import HP, cells, text_of, write_lines
from reporting.verify_evidence import image_pixels
from service import studio
from service.db import DATA, ROOT, WAVE


@unittest.skipUnless(os.getenv("AWARDS_LIVE_ACCEPTANCE")=="1","Requires an empty dedicated test DB, official ZIP, Hancom and Studio.")
class OperationalAcceptance(unittest.TestCase):
    def test_official_documents_to_two_staff_reports(self):
        cfg = configuration()
        url = os.environ["INTAKE_TEST_URL"]
        self.assertEqual(httpx.URL(url).host,"127.0.0.1")
        self.assertEqual(httpx.URL(cfg["AWARDS_DB_URL"].removeprefix("jdbc:")).host,"127.0.0.1")
        self.assertEqual(cfg["MAIL_MODE"],"local")
        db = connect(cfg)
        self.addCleanup(db.close)
        rows = db.execute("SELECT id,name FROM award_event").fetchall()
        expected_event = os.getenv("AWARDS_ACCEPTANCE_EVENT")
        if rows:
            self.assertEqual([(str(r["id"]),r["name"]) for r in rows],[(expected_event,WAVE)],
                             "Use an empty isolated DB, or explicitly resume this official fixture by event UUID.")
        staff, peer = [httpx.Client(base_url=url,timeout=60,trust_env=False) for _ in range(2)]
        for client,key in [(staff,"A"),(peer,"B")]:
            self.addCleanup(client.close)
            login(client,os.environ["INTAKE_TEST_LOGIN_"+key],os.environ["INTAKE_TEST_PASSWORD_"+key])
        event = expected_event or staff.post("/api/events",json={"name":WAVE}).raise_for_status().json()["id"]
        db.execute("INSERT INTO event_staff(event_id,login) VALUES(%s,%s) ON CONFLICT DO NOTHING",(event,os.environ["INTAKE_TEST_LOGIN_B"]))
        api = httpx.Client(base_url=url+"/api/worker/",headers={"Authorization":"Bearer "+cfg["AWARDS_REVIEW_WORKER_TOKEN"]})
        self.addCleanup(api.close)
        with ZipFile(ROOT/"test case"/"유잇_미션2_테스트set.zip") as archive:
            groups = {s:sorted([(Path(n).name,archive.read(n)) for n in archive.namelist()
                     if Path(n).parent.name==s and Path(n).suffix.lower() in (".hwp",".hwpx")]) for s in ("set01","set02","set04")}
        self.assertEqual([3,3,2],[len(g) for g in groups.values()])
        def upload(files, label):
            before = time.monotonic()
            response = staff.post("/api/intake-batches",data={"event":event,"manifest":json.dumps([{"name":n,"size":len(b)} for n,b in files])},
                    headers={"Idempotency-Key":"official-"+event+"-"+label},files=[("files",(n,b)) for n,b in files])
            self.assertIn(response.status_code,(200,202),response.text[:300])
            print("접수",response.status_code,round(time.monotonic()-before,3),"초",len(files),"개",flush=True)
            return response.json()["batch_id"]
        # Preserve byte content and source order while removing team/set labels from both consent forms.
        labels = {1:"신청",2:"개인정보",3:"신분증"}
        mixed = [(s,kind,next(entry for entry in groups[s] if labels[kind] in entry[0]))
                 for kind in (2,3,1) for s in ("set01","set02")]
        receipt = upload([("동의서.hwp" if kind==2 else f"서류{kind}{Path(n).suffix}",b) for s,kind,(n,b) in mixed],"mixed")
        second = upload(groups["set04"],"set04")
        self.assertEqual(db.execute("SELECT count(*) AS n FROM intake_batch").fetchone()["n"],2)
        while prepare(db,api):
            pass
        def detail(b):
            return staff.get("/api/operations/batches/"+b).raise_for_status().json()
        b = detail(receipt)
        owners = {s:f["team"] for (s,kind,_),f in zip(mixed,b["files"],strict=True) if kind==1}
        self.assertTrue(all(owners.values()))
        self.assertEqual(2,len(set(owners.values())))
        for i,(s,kind,_) in enumerate(mixed):
            b = detail(receipt)
            f = b["files"][i]
            if kind==2:
                self.assertEqual(owners[s],f["team"])
            if kind==3 and not f["team"]:
                staff.put(f"/api/intake-batches/{receipt}/files/{f['id']}/assignment",json={"action":"assign","team":owners[s],
                    "revision":b["revision"],"reason":"공식 접수 목록과 대표 증빙 원본 대조"}).raise_for_status()
        b = detail(second)
        owner = next(f["team"] for f in b["files"] if f["kind"]=="01")
        owners["set04"] = owner
        for f in b["files"]:
            if not f["team"]:
                staff.put(f"/api/intake-batches/{second}/files/{f['id']}/assignment",json={"action":"assign","team":owner,
                    "revision":detail(second)["revision"],"reason":"공식 원접수와 대표 증빙 대조"}).raise_for_status()
        for s,tid in owners.items():
            staff.put(f"/api/teams/{tid}/email",json={"email":s+"@award.test"}).raise_for_status()
        expected = {t["submission_id"] for b in (receipt,second) for t in detail(b)["teams"]}
        self.assertEqual(3,len(expected))
        known = {s:{hashlib.sha256(x[1]).hexdigest() for x in rows} for s,rows in groups.items()}
        for team,tid in owners.items():
            rows = db.execute("""SELECT f.sha256 FROM team_submission s JOIN team_submission_file sf ON sf.submission_id=s.id
                  JOIN intake_file f ON f.id=sf.file_id WHERE s.team_id=%s""",(tid,)).fetchall()
            self.assertEqual({r["sha256"] for r in rows},known[team])
        with studio.client(cfg) as remote:
            deadline = time.monotonic()+1500
            while True:
                states = db.execute("SELECT submission_id,state FROM review_job_status").fetchall()
                self.assertEqual(expected,{str(s["submission_id"]) for s in states})
                if all(s["state"]=="done" for s in states):
                    break
                bad = db.execute("SELECT phase,error FROM studio_execution WHERE phase IN ('failed','invalid','uncertain','paused','access')").fetchall()
                self.assertFalse(bad,bad)
                self.assertLess(time.monotonic(),deadline)
                if not run_studio(db,api,remote,cfg):
                    time.sleep(1)
        while deliver(db,cfg):
            pass
        dashboard = staff.get("/api/dashboard",params={"event":event}).raise_for_status().json()
        subs = {t["id"]:t["current"] for t in dashboard["teams"]}
        details = {s:staff.get("/api/operations/submissions/"+subs[tid]).raise_for_status().json() for s,tid in owners.items()}
        print("Studio 최종판정",{s:d["verdict"] for s,d in details.items()},flush=True)
        for key in ("set01","set02"):
            self.assertIn(details[key]["verdict"],("성공","담당자확인"))
        self.assertEqual(details["set04"]["verdict"],"재제출요청")
        self.assertIn("consent", details["set04"]["result"]["issues"])
        self.assertEqual(len({s["job"] for s in details.values()}),3)
        for s in ("set01","set02"):
            if not details[s]["decision"]:
                self.assertFalse([m for m in details[s]["mail"] if m["kind"]!="담당자 알림"])
            self.assertEqual(sum(m["kind"]=="담당자 알림" for m in details[s]["mail"]),int(details[s]["verdict"]=="담당자확인"))
        self.assertEqual(len(details["set04"]["mail"]),2)
        leader, = [m for m in details["set04"]["mail"] if m["kind"]=="보완 요청"]
        message = BytesParser(policy=policy.default).parsebytes((DATA/"operations/mail"/(leader["id"]+".eml")).read_bytes())
        self.assertIn("동의서",message.get_body().get_content())
        self.assertIn("보완 요청",str(message["Subject"]))
        self.assertEqual(str(message["To"]),"set04@award.test")
        selection = []
        for s,award in (("set01","대상"),("set02","최우수상")):
            d=details[s]
            self.assertEqual(len(d["fields"]["members"]),3 if s=="set01" else 4)
            body=dict(d["fields"],revision=d["revision"],decision="승인",note="가상 제출 원본과 대조",
                      award_type=award,support_amount="100000",issues=[])
            if d["decision"]!="승인":
                staff.put("/api/submissions/"+d["id"]+"/review",json=body).raise_for_status()
            selection.append(d["id"])
        def order(client):
            return client.post("/api/reports",json={"event":event,"submissions":selection}).raise_for_status().json()["id"]
        first,other=order(staff),order(peer)
        self.assertNotEqual(first,other)
        self.assertEqual(first,order(staff))
        self.assertEqual(peer.get(f"/api/reports/{first}/hwpx").status_code,404)
        output=worker_api(url,cfg["AWARDS_OUTPUT_WORKER_TOKEN"])
        self.addCleanup(output.close)
        def publish():
            while report_tick(db,cfg):
                pass
            if not db.execute("SELECT 1 FROM award_report WHERE state='printing'").fetchone():
                return
            # Exit a real printer process after downloading and hashing its HWPX, before its first PDF upload.
            crash = ("import os; from operations.printer import print_one,worker_api; "
                     "api=worker_api(os.environ['AWARDS_API_URL'],os.environ['AWARDS_OUTPUT_WORKER_TOKEN']); "
                     "print_one(api,'before-restart',renderer=lambda src,dest: os._exit(91))")
            env = dict(os.environ,AWARDS_API_URL=url,AWARDS_OUTPUT_WORKER_TOKEN=cfg["AWARDS_OUTPUT_WORKER_TOKEN"])
            with TemporaryDirectory() as spool:
                stopped=subprocess.run([sys.executable,"-c",crash],cwd=ROOT,env=dict(env,TEMP=spool,TMP=spool),timeout=90)
                self.assertEqual(stopped.returncode,91)
            claim=db.execute("""UPDATE award_report SET print_until=now()-interval '1 second'
                WHERE state='printing' AND printer='before-restart' RETURNING id,print_token""").fetchone()
            self.assertIsNotNone(claim)
            while db.execute("SELECT 1 FROM award_report WHERE state='printing'").fetchone():
                subprocess.run([sys.executable,"-m","operations.printer","--once"],cwd=ROOT,env=env,check=True,timeout=240)
            self.assertEqual(409,output.put(str(claim["id"])+"/lease",headers={"X-Claim-Token":str(claim["print_token"])}).status_code)
            while report_tick(db,cfg):
                pass
        publish()
        for client,rid in [(staff,first),(peer,other)]:
            report=client.get(f"/api/reports/{rid}").raise_for_status().json()
            self.assertIn(report["state"],("preview","confirmed"),report["error"])
            client.post(f"/api/reports/{rid}/confirm").raise_for_status()
            pdf=client.get(f"/api/reports/{rid}/pdf").raise_for_status().content
            self.assertEqual(len(PdfReader(BytesIO(pdf)).pages),11)
        reference = Path(os.getenv("AWARDS_ACCEPTANCE_REFERENCE",ROOT/"output/pdf/유잇_set01-set02_출력검증/시상금_지급내역서.pdf"))
        self.assertTrue(reference.is_file(),"공식 두 팀의 11쪽 편철 기준 PDF를 지정하세요.")
        combined_pages = PdfReader(BytesIO(pdf)).pages
        with pdfium.PdfDocument(pdf) as combined, pdfium.PdfDocument(str(reference)) as golden:
            self.assertEqual(len(combined),len(golden))
            page_index = 2
            for s in ("set01","set02"):
                for kind in ("01","02","03"):
                    file_id=details[s]["result"]["documents"][kind][0]["id"]
                    original=staff.get(f"/api/files/{file_id}/preview").raise_for_status()
                    for page in PdfReader(BytesIO(original.content)).pages:
                        attached = combined_pages[page_index]
                        self.assertEqual((page.mediabox,page.cropbox,page.rotation,page.extract_text(),image_pixels(page)),
                                         (attached.mediabox,attached.cropbox,attached.rotation,attached.extract_text(),image_pixels(attached)))
                        canonical=golden[page_index].render(scale=120/72).to_pil()
                        actual=combined[page_index].render(scale=120/72).to_pil()
                        self.assertEqual((actual.size,hashlib.sha256(actual.tobytes()).hexdigest()),
                                         (canonical.size,hashlib.sha256(canonical.tobytes()).hexdigest()),f"편철 기준 {page_index+1}쪽")
                        page_index+=1
            self.assertEqual(page_index,11)
        raw=staff.get(f"/api/reports/{first}/hwpx").raise_for_status().content
        edit=BytesIO()
        with ZipFile(BytesIO(raw)) as src, ZipFile(edit,"w") as dst:
            for item in src.infolist():
                data=src.read(item)
                if item.filename=="Contents/section0.xml":
                    section=etree.fromstring(data)
                    table,=[t for t in section.iter(HP+"tbl") if t.get("colCnt")=="7" and "시상구분" in text_of(t.find(HP+"tr"))]
                    self.assertEqual(len(table.findall(HP+"tr"))-2,7)
                    write_lines(cells(table.findall(HP+"tr")[1])[5],"편집상")
                    data=etree.tostring(section,encoding="UTF-8",xml_declaration=True,standalone=True)
                dst.writestr(item,data)
        edited=staff.post(f"/api/reports/{first}/edited",files={"file":("편집.hwpx",edit.getvalue())}).raise_for_status().json()["id"]
        publish()
        staff.post(f"/api/reports/{edited}/confirm").raise_for_status()
        self.assertEqual(edit.getvalue(),staff.get(f"/api/reports/{edited}/hwpx").raise_for_status().content)
        pdf=PdfReader(BytesIO(staff.get(f"/api/reports/{edited}/pdf").raise_for_status().content))
        self.assertEqual(len(pdf.pages),11)
        self.assertIn("편집상","".join(pdf.pages[0].extract_text().split()))
        print("공식 3팀 실제 판정, 팀장 메일 1통, 두 담당자 출력 11쪽과 편집 PDF 확인",flush=True)
