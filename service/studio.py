import base64
import json
import re
from collections import Counter
from pathlib import Path

import httpx

from .documents import preview

API = "https://api.upstage.ai/v2"
CONFIG = "23"
VERDICTS = ("성공", "담당자확인", "재제출요청")
ISSUES = {"application": "팀의 지급확인서를 확인해 제출해 주세요.",
          "consent": "전체 팀원의 개인정보 동의서와 작성자 명단을 확인해 주세요.",
          "identity": "팀 대표의 신분증·통장 사본을 확인해 주세요.",
          "account": "지급확인서와 통장 사본의 은행·계좌·예금주 표기를 대조해 주세요.",
          "signature": "신청서와 동의서의 동의 표시와 서명을 확인해 주세요.",
          "affiliation": "신청서와 동의서의 소속 표기를 확인해 주세요.",
          "duplicate": "같은 종류로 중복 제출된 서류를 확인해 주세요.",
          "other": "제출한 증빙의 기재 내용과 판독 상태를 담당자와 확인해 주세요."}


def client(cfg):
    return httpx.Client(base_url=API + "/", timeout=httpx.Timeout(connect=5, read=30, write=120, pool=5),
                        headers={"Authorization": "Bearer " + cfg.get("UPSTAGE_API_KEY", "")})


def payload(files, config_id, agent):
    content = []
    used = set()
    for f in files:
        stem = Path(f["name"]).stem
        name, n = stem + ".pdf", 1
        while name.casefold() in used:
            n += 1
            name = f"{stem} ({n}).pdf"
        used.add(name.casefold())
        data = base64.b64encode(preview(f).read_bytes()).decode("ascii")
        content.append({"type": "input_file", "filename": name, "file_data": "data:application/pdf;base64," + data})
    return {"model": agent, "config_id": config_id, "include": ["all"], "background": True,
            "input": [{"role": "user", "content": content}]}


def unpack(value):
    for _ in range(2):
        if not isinstance(value, str):
            break
        try:
            value = json.loads(value)
        except ValueError:
            break
    return value


def parse_result(job, files):
    nodes = {n.get("model", ""): n.get("content", []) for n in job.get("output", [])}

    def first(name):
        return next(iter(nodes.get(name, [])), {})

    def field(name):
        return unpack(first(name).get("text", {}))

    final = field("Instruct - 최종판정")
    if not isinstance(final, dict) or final.get("enum") not in VERDICTS or not isinstance(final.get("reason"), str) or not final["reason"].strip():
        raise ValueError("최종판정 노드의 enum·reason을 확인하세요.")
    app = field("Information Extract - 지급확인서") or {}
    consent = (field("Information Extract - 개인정보동의") or {}).get("beneficiaries") or []
    identity = field("Information Extract - 신분증정보") or {}
    parse = first("step_1_parse")
    boundaries = unpack(parse.get("additional_values", {})).get("source_file_boundaries", [])
    source_ids = {b["file_id"]: files[b["file_index"]]["id"] for b in boundaries
                  if isinstance(b.get("file_index"), int) and 0 <= b["file_index"] < len(files)}
    classes, id_pages = {}, set()
    for c in nodes.get("step_2_classify", []):
        label = str(unpack(c.get("text", "")))
        kind = "02" if "동의" in label else "03" if "신분증" in label or "통장" in label else "01" if "지급" in label else "?"
        av = unpack(c.get("additional_values", {}))
        for source in av.get("source_files", []):
            fid = source_ids.get(source.get("file_id"))
            if fid:
                classes[fid] = kind if fid not in classes or classes[fid] == kind else "?"
        if kind == "03":
            for start, end in av.get("page_ranges", []):
                id_pages.update(range(start, end + 1))
    docs = {k: [] for k in ("01", "02", "03", "?")}
    member_locations = {"01": {}, "02": {}}
    for f in files:
        k = classes.get(f["id"], f["kind"])
        signals = json.loads(f["signals"])
        ref = {"id": f["id"], "page": signals.get("page", 1)}
        docs[k if k in docs else "?"].append(ref)
        if k == "01":
            for form in signals.get("apps", []):
                for row, person in enumerate(form.get("roster", []), 1):
                    member_locations[k].setdefault(person["name"], []).append(dict(ref, page=form.get("page", ref["page"]), row=row))
        if k == "02":
            rows = Counter()
            for person in signals.get("consent", []):
                page = person.get("page", ref["page"])
                rows[page] += 1
                member_locations[k].setdefault(person["name"], []).append(dict(ref, page=page, row=rows[page]))

    def member_refs(kind, name, row):
        located = member_locations[kind].get(name)
        if located:
            return located
        # Older analyses may have only the Studio row and the document's default evidence page.
        return [dict(docs[kind][0], row=row)] if len(docs[kind]) == 1 else docs[kind]

    elements = (unpack(parse.get("text", {})) or {}).get("elements", [])
    id_lines = [e.get("content", {}).get("text", "") for e in elements if e.get("page") in id_pages]
    rrns = set(re.findall(r"(?<!\d)\d{6}\s*-\s*(?:\d\*{6}|\*{7})(?![\d*])", "\n".join(id_lines)))
    bank_lines = {m[1] for s in id_lines if (m := re.search(r"(?:^|[\s|])((?:[A-Z]{2,3}[ \t]*)?[가-힣]{1,8}은행)[\s|]*$", s))}
    recipient = {"rrn_display": re.sub(r"\s+", "", rrns.pop()) if len(rrns) == 1 else "",
                 "bank_name": bank_lines.pop() if len(bank_lines) == 1 else "",
                 "account_number": str(identity.get("account_number") or ""), "account_holder": identity.get("account_holder") or ""}
    members = []
    if app.get("representative_name"):
        members.append(dict(role="대표", name=app["representative_name"], school=app.get("representative_affiliation") or "",
                            student_id=str(app.get("representative_student_id") or ""), major=app.get("representative_department") or ""))
    members.extend(dict(role="팀원", name=m["name"], school=m.get("affiliation") or "", student_id=str(m.get("student_id") or ""),
                        major=m.get("department") or "") for m in (app.get("members") or []) if m.get("name"))
    checks, issues = [], []

    def check(label, passed, kinds, issue=None):
        checks.append({"label": label, "passed": passed, "refs": [ref for k in kinds for ref in docs[k]]})
        if passed is False and issue and issue not in issues:
            issues.append(issue)

    for k, title, key in (("01", "지급확인서", "application"), ("02", "동의서", "consent"), ("03", "신분증·통장", "identity")):
        check(f"{title} {len(docs[k])}부 접수", len(docs[k]) == 1, [k], "duplicate" if len(docs[k]) > 1 else key)
    if members and docs["02"]:
        check("신청 명단과 동의서 작성자 일치", Counter(m["name"] for m in members) == Counter(m.get("name") for m in consent), ["01","02"], "consent")
        majors = {b.get("name"): b.get("department") for b in consent}
        check("신청서·동의서 소속 표기 일치", all(m["major"] == majors.get(m["name"]) for m in members), ["01","02"], "affiliation")
        for i, member in enumerate(members, 1):
            name = member["name"]
            found = [(j,b) for j,b in enumerate(consent,1) if b.get("name") == name]
            refs = member_refs("01", name, i)
            if not found:
                checks.append({"label":name+" · 동의서 명단에 없음", "passed":False, "refs":refs+docs["02"]})
            for j, b in found:
                located = refs + member_refs("02", name, j)
                if member["major"] != b.get("department"):
                    checks.append({"label":name+" · 소속 표기 대조","passed":False,"refs":located})
                if any(b.get(k) is not True for k in ("collection_consent","identifier_consent","third_party_consent","signed")):
                    checks.append({"label":name+" · 동의 표시 또는 서명 확인","passed":False,"refs":located})
                    if "signature" not in issues:
                        issues.append("signature")
    if app and identity:
        account = lambda value: re.sub(r"[^0-9]", "", str(value or ""))
        left, right = account(app.get("representative_account")), account(identity.get("account_number"))
        check("대표 계좌·예금주 일치", bool(left and left == right and app.get("representative_name") == identity.get("account_holder")), ["01","03"], "account")
    for c in unpack(first("Validate - 증빙검증").get("additional_values", {})).get("checks", []):
        label = str(c.get("name", "검사"))
        k = "03" if "통장" in label else "02" if "과제" in label else "01"
        check(label, c.get("passed"), [k], "signature" if "서명" in label else "other")
    return {"verdict": final["enum"], "reason": final["reason"], "program": app.get("program_name") or "",
            "team_name": app.get("team_name") or "", "rep": app.get("representative_name") or "",
            "members": members, "recipient": recipient, "documents": docs, "checks": checks, "issues": issues or ["other"],
            "consent_names": [b.get("name") for b in consent], "staff_report": field("Instruct - 검토보고서") or ""}
