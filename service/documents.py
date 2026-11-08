import os
import re
import shutil
import subprocess
import sys
from collections import Counter
from pathlib import Path

import pypdfium2 as pdfium
from pypdf import PdfReader

from .db import DATA, ROOT

KINDS = {"01": "지급확인서", "02": "개인정보 동의서", "03": "신분증·통장 사본", "?": "종류 확인"}


def source(f):
    return DATA / "files" / f["batch"] / (f["id"] + f["ext"])


def preview(f):
    return source(f).with_suffix(".pdf")


def powershell(script, *arguments, timeout, legacy=False):
    exe = "powershell.exe" if legacy else "pwsh.exe"
    bundled = Path(sys.base_prefix).parent / "native/powershell/pwsh.exe"
    binary = shutil.which(exe) or str(bundled if bundled.is_file() else Path(os.environ["ProgramFiles"]) / "PowerShell/7/pwsh.exe")
    return subprocess.run([binary, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
                           "-File", str(script), *map(str, arguments)], capture_output=True,
                          creationflags=subprocess.CREATE_NO_WINDOW, timeout=timeout, check=True)


def convert(src, dest):
    powershell(ROOT / "service/convert.ps1", src, dest, timeout=180)


def ocr_page(pdf, index):
    image = pdf.with_suffix(".ocr.png")
    try:
        with pdfium.PdfDocument(str(pdf)) as document:
            page = document[index]
            page.render(scale=2.5).to_pil().save(image)
            page.close()
        result = powershell(ROOT / "service/ocr.ps1", image, timeout=35, legacy=True)
        return result.stdout.decode("utf-8").strip()
    except (OSError, subprocess.SubprocessError, ValueError):
        return ""
    finally:
        image.unlink(missing_ok=True)


def compact(value):
    return re.sub(r"\s+", "", value)


def word(text, target):
    return bool(target and re.search(r"(?<![가-힣A-Za-z0-9])" + re.escape(target) + r"(?![가-힣A-Za-z0-9])", text, re.I))


def read_signals(f):
    pdf = preview(f)
    if not pdf.is_file():
        draft = pdf.with_suffix(".working.pdf")
        try:
            convert(source(f), draft)
            draft.replace(pdf)
        finally:
            draft.unlink(missing_ok=True)
    with pdf.open("rb") as stream:
        pages = [page.extract_text(extraction_mode="layout").replace("\x00", " ") for page in PdfReader(stream).pages]
    if not pages:
        raise ValueError("빈 문서")
    identity = []
    for i, page in enumerate(pages):
        condensed = compact(page)
        if len(condensed) < 30 or ("신분증사본" in condensed and "통장사본" in condensed):
            observed = ocr_page(pdf, i)
            pages[i] += "\n" + observed
            identity.append(observed)
    applications, consent, kinds = [], [], set()
    consent_page = 1
    for p, page in enumerate(pages, 1):
        s = compact(page)
        if "프로그램명" in s and "팀명" in s:
            kinds.add("01")
            team = re.search(r"팀[ \t]*명[ \t]*[:：]?[ \t]+(.+)", page)
            people = list(re.finditer(r"성[ \t]*명[ \t]+([가-힣A-Za-z·]+)[ \t]+성[ \t]*별", page))
            roster = []
            for i, person in enumerate(people):
                segment = page[person.end():people[i+1].start() if i+1 < len(people) else None]
                major = re.search(r"학부\s*\(과\)[ \t]+(.*?)[ \t]+E-?mail", segment, re.I)
                roster.append({"name": person[1], "major": " ".join(major[1].split()) if major else ""})
            if team and roster:
                applications.append({"name": " ".join(team[1].split()), "rep": roster[0]["name"], "roster": roster})
        if "개인정보" in s and ("동의서(수혜인력)" in s or "개인정보및과세정보" in s or "소속부서(학과)" in s):
            kinds.add("02")
        if "수혜인력" in s and "소속부서" in s:
            consent_page = p
            for line in page.splitlines():
                hit = re.search(r"^\s*(.{1,65}?)\s+([가-힣A-Za-z·]{2,20})\s+\d(?:\s*학년)?\s+\d{6}", line)
                if hit:
                    consent.append({"name": hit[2], "major": " ".join(hit[1].split()), "page": p})
        if "신분증사본" in s and "통장사본" in s and "프로그램명" not in s:
            kinds.add("03")
        if "지급대상자상세내역" in s or ("시상금지급내역서" in s and "시상구분" in s):
            kinds.add("00")
    kind = next(iter(kinds)) if len(kinds) == 1 else "?"
    # Keep only the text needed for matching during assignment. Never search for account or identity numbers.
    body = re.sub(r"\d{3,}([- .]?\d+)*", " ", "\n".join(pages))
    id_text = re.sub(r"\d+[-\d]*", " ", "\n".join(identity))
    return kind, len(pages), {"apps": applications, "consent": consent, "mixed": len(kinds) > 1 or len(applications) > 1,
                              "body": body, "identity": id_text, "page": consent_page if kind == "02" else 1}


def match_file(f, sig, teams, target):
    ids = {t["id"] for t in teams}
    if sig.get("mixed"):
        return None, ids, "서로 다른 양식 또는 신청서가 한 파일에 있습니다. 팀별 원본을 대조하세요."
    if f["kind"] == "00":
        return "outside", set(), "00 지급내역서는 출력 양식입니다."
    named = {t["id"] for t in teams if word(f["name"], t["name"]) or word(sig["body"], t["name"])}
    matched, possible = set(), set(named)
    reason = "한 팀으로 확정할 소속 근거가 부족합니다."
    if f["kind"] == "01" and sig["apps"]:
        app = sig["apps"][0]
        matched = {t["id"] for t in teams if (t["name"], t["rep"]) == (app["name"], app["rep"])}
        reason = "신청서 1쪽의 팀명과 대표가 일치합니다."
    elif f["kind"] == "02":
        people = sig["consent"]
        names = Counter(p["name"] for p in people)
        counts = Counter(m["name"] for t in teams for m in t["roster"])
        for team in teams:
            roster = team["roster"]
            in_team = {p["name"] for p in roster}
            if names.keys() & in_team:
                possible.add(team["id"])
            complete = len(names) >= 2 and names == Counter(m["name"] for m in roster) and all(counts[n] == 1 for n in names)
            pairs = {(m["name"], compact(m["major"])) for m in roster}
            partial = len(names) >= 2 and all((m["name"], compact(m["major"])) in pairs for m in people)
            single = len(people) == 1 and names.keys() <= in_team and team["id"] in named
            if complete or partial or single:
                matched.add(team["id"])
        reason = f"동의서 {sig['page']}쪽 작성자 {sum(names.values())}명의 성명·명단을 대조했습니다."
    elif f["kind"] == "03":
        # Look before bank evidence so that the account holder alone cannot identify the ID holder.
        id_region = re.split(r"계\s*좌\s*번\s*호|예\s*금\s*주|통\s*장\s*사\s*본", sig["identity"])[0]
        identified = {t["id"] for t in teams if word(id_region, t["rep"])}
        possible |= identified
        matched = identified & named
        reason = "팀명과 신분증의 대표 성명을 대조했습니다."
    possible |= matched
    if target:
        if (possible - {target}) or (f["kind"] == "01" and not matched):
            return None, possible | {target}, "지정한 팀과 서류의 소속 근거를 함께 확인하세요."
        return target, {target}, "담당자가 원접수에서 제출 팀을 지정했습니다."
    if len(matched) == 1 and not (named - matched):
        return next(iter(matched)), matched, reason
    return None, possible or ids, "팀 표기와 명단을 함께 확인하세요." if len(possible) > 1 else "소속 근거가 부족합니다. 원접수와 대조하세요."
