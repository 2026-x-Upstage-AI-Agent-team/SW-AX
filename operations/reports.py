"""Build editable reports on the server and verify the independently printed evidence."""
import os
import shutil
import subprocess
from pathlib import Path
from tempfile import TemporaryDirectory
from zipfile import BadZipFile, ZipFile
from pypdf.errors import PdfReadError

from lxml import etree
from pypdf import PdfReader

from reporting.fill_award_form import HP, fill_form, text_of
from reporting.merge_hwpx import compile_sections, save
from reporting.verify_evidence import verify
from service.db import DATA, ROOT
from service.documents import source
from .store import cached_file


def build_hwpx(template, snapshot, evidence, directory, cfg):
    java = Path(cfg["JAVA_HOME"]) / "bin" / ("java.exe" if os.name == "nt" else "java") if cfg.get("JAVA_HOME") else shutil.which("java")
    targets, conversion = [], []
    for index, original in enumerate([template, *evidence]):
        if original.suffix.lower() == ".hwpx":
            targets.append(original)
        else:
            target = directory / f"source-{index}.hwpx"
            targets.append(target)
            conversion.extend([str(original), str(target)])
    if conversion:
        libs = ROOT / "backend/build/report-converter"
        subprocess.run([str(java), "-cp", str(libs / "*"), str(ROOT / "reporting/ConvertHwp.java"), *conversion],
                       check=True, capture_output=True, timeout=360)
    cover = directory / "cover.hwpx"
    fill_form(targets[0], snapshot, cover)
    dest = directory / "report.hwpx"
    save(dest, compile_sections(cover, targets[1:], directory))
    return dest.read_bytes()


def verify_pair(hwpx, pdf, snapshot, references):
    with ZipFile(hwpx) as archive:
        section = etree.fromstring(archive.read("Contents/section0.xml"))
    expected = {"시상구분":sum(len(t["members"]) for t in snapshot["teams"])+2, "차인지급액":len(snapshot["teams"])+2}
    for table in section.iter(HP+"tbl"):
        header = table.find(HP+"tr")
        if header is not None:
            for label in list(expected):
                if label in text_of(header) and int(table.get("rowCnt",0)) == expected[label]:
                    del expected[label]
    if expected:
        raise ValueError("지급 표 행 수를 확인하세요.")
    evidence_pages = sum(len(PdfReader(f).pages) for f in references)
    cover_pages = len(PdfReader(pdf).pages) - evidence_pages
    if cover_pages < 1:
        raise ValueError("증빙 쪽수가 부족합니다.")
    verify(pdf,cover_pages,references)


def report_tick(db,cfg):
    report = db.execute("""SELECT id,state,snapshot FROM award_report WHERE state IN ('queued','building','verifying')
        ORDER BY created_at,id LIMIT 1""").fetchone()
    if not report:
        return False
    rid = report["id"]
    files = [fid for t in report["snapshot"]["teams"] for fid in t["file_ids"]]
    root = DATA / "operations" / "reports"
    root.mkdir(parents=True, exist_ok=True)
    try:
        with TemporaryDirectory(dir=root) as work:
            directory = Path(work)
            if report["state"] == "verifying":
                pair = db.execute("SELECT hwpx,pdf FROM award_report WHERE id=%s",(rid,)).fetchone()
                hwpx,pdf = directory/"report.hwpx",directory/"report.pdf"
                hwpx.write_bytes(pair["hwpx"])
                pdf.write_bytes(pair["pdf"])
                refs = []
                for index,fid in enumerate(files):
                    raw = db.execute("SELECT pdf FROM original_analysis WHERE file_id=%s",(fid,)).fetchone()
                    if not raw or not raw["pdf"]:
                        raise ValueError("증빙 미리보기 누락")
                    f = directory/f"evidence-{index}.pdf"
                    f.write_bytes(raw["pdf"])
                    refs.append(f)
                verify_pair(hwpx,pdf,report["snapshot"],refs)
                db.execute("UPDATE award_report SET state='preview',error='' WHERE id=%s AND state='verifying'",(rid,))
            else:
                db.execute("UPDATE award_report SET state='building' WHERE id=%s",(rid,))
                template = Path(cfg["AWARDS_REPORT_TEMPLATE"]) if cfg.get("AWARDS_REPORT_TEMPLATE") else next(ROOT.glob("0_RE*/00*지급내역서*.hwp"),None)
                if not template or not template.is_file():
                    raise FileNotFoundError("00 양식")
                data = build_hwpx(template,report["snapshot"],[source(cached_file(db,f)) for f in files],directory,cfg)
                db.execute("UPDATE award_report SET state='printing',hwpx=%s,error='' WHERE id=%s AND state='building'",(data,rid))
    except (OSError, ValueError, KeyError, IndexError, TypeError, subprocess.SubprocessError, StopIteration, etree.Error, BadZipFile, PdfReadError) as exc:
        db.execute("UPDATE award_report SET state='failed',error=%s WHERE id=%s",
                   (("지급 표·증빙 원본과 출력된 PDF를 대조하세요." if report["state"]=="verifying" else
                     "00 양식·한글 변환 라이브러리와 원본을 확인한 뒤 다시 생성하세요.")+" ("+type(exc).__name__+")",rid))
    return True
