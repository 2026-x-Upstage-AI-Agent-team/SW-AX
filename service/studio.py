import base64
import json
import re
from collections import Counter
from pathlib import Path

import httpx

from .documents import preview

API = "https://api.upstage.ai/v2"
CONFIG = "4"
VERDICTS = ("성공", "담당자확인", "재제출요청", "보완필요")
FINAL_NODES = ("Instruct - 최종판정", "Instruct - 판정_성공", "Instruct - 판정_담당자확인",
               "Instruct - 판정_보완필요", "Instruct - 판정_서류누락")
ISSUES = {"application": "팀의 지급확인서를 확인해 제출해 주세요.",
          "consent": "전체 팀원의 개인정보 동의서와 작성자 명단을 확인해 주세요.",
          "identity": "팀 대표의 신분증·통장 사본을 확인해 주세요.",
          "account": "지급확인서와 통장 사본의 은행·계좌·예금주 표기를 대조해 주세요.",
          "signature": "신청서와 동의서의 동의 표시와 서명을 확인해 주세요.",
          "affiliation": "신청서와 동의서의 소속 표기를 확인해 주세요.",
          "duplicate": "같은 종류로 중복 제출된 서류를 확인해 주세요.",
          "student_id": "지급확인서의 해당 학번 기재란을 확인해 주세요.",
          "representative": "지급확인서의 대표 성명과 신분증의 성명을 대조해 주세요.",
          "other": "제출한 증빙의 기재 내용과 판독 상태를 담당자와 확인해 주세요."}

DOCUMENT_TERMS = re.compile(r"(?<![-A-Za-z0-9])(?P<code>0[123])(?![-A-Za-z0-9])|"
                            r"(?P<app>지급\s*확인서|신청서)|(?P<consent>개인정보\s*동의|동의서)|"
                            r"(?P<identity>신분증|통장)")
EXTRACT_DOCUMENTS = {"지급확인서":"01","개인정보동의":"02","신분증정보":"03"}
FIELD_LABELS = {"representative_name":"대표 성명","representative_student_id":"대표 학번",
                "representative_phone":"대표 전화번호","representative_email":"대표 이메일",
                "representative_signed":"대표 서명","applicant_signed":"신청인 서명","project_name":"과제명",
                "representative_account":"대표 계좌 기재란","account_number":"통장 계좌 기재란","written_date":"작성일"}


def validation_sources(condition):
    if isinstance(condition,list):
        for child in condition:
            yield from validation_sources(child)
    elif isinstance(condition,dict):
        kind = EXTRACT_DOCUMENTS.get(str(condition.get("nodeName","")).removeprefix("Information Extract - "))
        if kind and condition.get("nodeType") == "extract":
            field = condition.get("field")
            yield kind, field if isinstance(field,str) else ""
        for key in ("left","right","conditions","children"):
            if key in condition:
                yield from validation_sources(condition[key])


def agent_evidence(text, docs, page_counts, sources=()):
    """Resolve explicit document and position references in one Studio statement."""
    sections = []
    for match in DOCUMENT_TERMS.finditer(text):
        kind = match["code"] or {"app":"01","consent":"02","identity":"03"}[match.lastgroup]
        if not sections or sections[-1][0] != kind:
            sections.append((kind,match.start()))
    if sources:
        kinds = list(dict.fromkeys(kind for kind,_ in sources))
        sections = [(kind,start) for kind,start in sections if kind in kinds]
        referenced = {kind for kind,_ in sections}
        sections.extend((kind,len(text) if referenced else 0) for kind in kinds if kind not in referenced)
    if "학번" in text:
        issue = "student_id"
    elif "계좌" in text or "예금주" in text:
        issue = "account"
    elif "성명" in text and "대표" in text and "신분증" in text:
        issue = "representative"
    elif "서명" in text or "동의 표시" in text:
        issue = "signature"
    elif "동의서" in text or "작성자" in text:
        issue = "consent"
    elif len(sections) == 1:
        issue = {"01":"application","02":"consent","03":"identity"}[sections[0][0]]
    else:
        issue = "other"
    implicit = not sections
    if not sections:
        defaults = {"student_id":("01",),"account":("01","03"),"signature":("01","02"),"consent":("02",)}
        sections = [(kind,0) for kind in defaults.get(issue,())]
    refs = []
    for i,(kind,start) in enumerate(sections):
        part = "" if implicit and len(sections)>1 else text[start:sections[i+1][1] if i+1 < len(sections) else None]
        pages = set(re.findall(r"(?<!\d)([1-9]\d{0,2})\s*(?:쪽|페이지)",part))
        rows = set(re.findall(r"(?<!\d)([1-9]\d{0,2})\s*행",part))
        for ordinal,number in (("첫",1),("둘",2),("셋",3),("넷",4)):
            if re.search(ordinal+r"\s*(?:째|번째)?\s*행",part):
                rows.add(str(number))
        for ref in docs[kind]:
            located = dict(ref)
            if len(docs[kind]) == 1:
                page = int(next(iter(pages))) if len(pages)==1 else ref["page"]
                limit = page_counts.get(ref["id"])
                if (not limit or page <= limit) and len(pages) <= 1:
                    located["page"] = page
                    if len(rows)==1:
                        located["row"] = int(next(iter(rows)))
            if located not in refs:
                refs.append(located)
    return issue, refs


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


def is_masked_rrn(value):
    return bool(re.fullmatch(r"\s*\d{6}\s*[-‐‑–—]\s*\d?[\s*＊xX●•#■_]+", value)
                and re.search(r"[*＊xX●•#■_]", value))


def parse_result(job, files):
    nodes = {}
    for node in job.get("output", []):
        nodes.setdefault(node.get("model", ""), []).extend(node.get("content", []))

    extracted = {name: [unpack(item.get("text", {})) for item in content]
                 for name, content in nodes.items() if name.startswith("Information Extract - ")}
    extraction_sources = {name: [unpack(item.get("additional_values", {})) for item in nodes[name]] for name in extracted}
    warnings = []

    def text(value):
        return "" if value is None else str(value)

    def present(value):
        return value is not None and (bool(value.strip()) if isinstance(value, str) else value is not False)

    def extract(name):
        records = extracted.get(name, [])
        for record in records:
            if not isinstance(record, dict):
                raise ValueError("추출 노드의 JSON 객체를 확인하세요.")
        if len(records) > 1:
            warnings.append(name.removeprefix("Information Extract - ")
                            + " 추출 결과가 여러 건입니다. 초안에는 첫 응답을 표시합니다. 추출 원본값과 제출 서류를 대조해 유효본을 확인해 주세요.")
        return records[0] if records else {}

    def first(name):
        return next(iter(nodes.get(name, [])), {})

    def field(name):
        return unpack(first(name).get("text", {}))

    finals = [(name, unpack(record.get("text", {}))) for name in FINAL_NODES for record in nodes.get(name, [])]
    if len(finals) != 1:
        raise ValueError("최종판정 응답이 한 건인지 확인하세요.")
    final_name, raw_final = finals[0]
    agent_decision = None
    if final_name == "Instruct - 최종판정":
        final = raw_final
    else:
        if not isinstance(raw_final, dict) or any(not isinstance(raw_final.get(key), list) for key in ("확정오류", "확인필요")):
            raise ValueError("판정 분기의 최종판정·판정근거·오류 목록을 확인하세요.")
        agent_decision = raw_final
        final = {"enum": raw_final.get("최종판정"), "reason": raw_final.get("판정근거")}
    if not isinstance(final, dict) or final.get("enum") not in VERDICTS or not isinstance(final.get("reason"), str) or not final["reason"].strip():
        raise ValueError("최종판정 노드의 enum·reason을 확인하세요.")
    app = extract("Information Extract - 지급확인서")
    consent = extract("Information Extract - 개인정보동의").get("beneficiaries") or []
    identity = extract("Information Extract - 신분증정보")
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
    page_counts = {}
    emails = set()
    member_locations = {"01": {}, "02": {}}
    for f in files:
        k = classes.get(f["id"], "?")
        signals = json.loads(f["signals"])
        ref = {"id": f["id"], "page": signals.get("page", 1)}
        if "pages" in f.keys():
            page_counts[f["id"]] = f["pages"]
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

    for node in nodes.get("Information Extract - 지급확인서", []):
        form = unpack(node.get("text"))
        if isinstance(form, dict):
            if "participants" in form:
                people = form.get("participants") or []
                email = people[0].get("email") if isinstance(people, list) and people and isinstance(people[0], dict) else None
            else:
                email = form.get("representative_email")
            if isinstance(email, str):
                emails.add(email.strip())

    def member_refs(kind, name, row):
        located = member_locations[kind].get(name)
        if located:
            return located
        # Older analyses may have only the Studio row and the document's default evidence page.
        return [dict(docs[kind][0], row=row)] if len(docs[kind]) == 1 else docs[kind]

    elements = (unpack(parse.get("text", {})) or {}).get("elements", [])
    id_lines = [e.get("content", {}).get("text", "") for e in elements if e.get("page") in id_pages]
    rrns = set(re.findall(r"(?<!\d)\d{6}\s*-\s*(?:\d\*{6}|\*{7})(?![\d*])", "\n".join(id_lines)))
    # Config 23 has no id_number_display. Keep its Parse fallback for older jobs;
    # an explicit Extract value, including an empty value, takes precedence.
    rrn = identity.get("id_number_display")
    if "id_number_display" not in identity:
        rrn = re.sub(r"\s+", "", rrns.pop()) if len(rrns) == 1 else ""
    if rrn and not is_masked_rrn(str(rrn)):
        warnings.append("신분증의 번호 표기가 마스킹되어 있는지 원본을 확인해 주세요.")
        rrn = ""
    recipient = {"rrn_display": text(rrn), "bank_name": text(identity.get("bank_name")),
                 "account_number": text(identity.get("account_number")), "account_holder": text(identity.get("account_holder"))}
    members = []
    if "participants" in app:
        people = app.get("participants")
        if not isinstance(people, list) or any(not isinstance(person, dict) for person in people):
            raise ValueError("지급확인서 participants 배열을 확인하세요.")
        members.extend(dict(role="대표" if index == 0 else "팀원", name=text(person.get("name")),
                            school=text(person.get("affiliation")), student_id=text(person.get("student_id")),
                            major=text(person.get("department"))) for index, person in enumerate(people))
    elif any(present(value) and not isinstance(value, bool)
             for key, value in app.items() if key.startswith("representative_")):
        members.append(dict(role="대표", name=text(app.get("representative_name")), school=text(app.get("representative_affiliation")),
                            student_id=text(app.get("representative_student_id")), major=text(app.get("representative_department"))))
    if "participants" not in app:
        members.extend(dict(role="팀원", name=text(m.get("name")), school=text(m.get("affiliation")), student_id=text(m.get("student_id")),
                            major=text(m.get("department"))) for m in (app.get("members") or []))
    for index, member in enumerate(members, 1):
        if not member["name"].strip():
            warnings.append(f"명단 {index}행의 성명이 비어 있습니다. 학번·전공과 원본을 대조해 주세요.")
    checks, issues = [], []

    def check(label, passed, kinds, issue=None):
        checks.append({"label": label, "passed": passed, "refs": [ref for k in kinds for ref in docs[k]]})
        if passed is False and issue and issue not in issues:
            issues.append(issue)

    if agent_decision is None:
        for k, title, key in (("01", "지급확인서", "application"), ("02", "동의서", "consent"), ("03", "신분증·통장", "identity")):
            check(f"{title} {len(docs[k])}부 접수", len(docs[k]) == 1, [k], "duplicate" if len(docs[k]) > 1 else key)
        if members and docs["02"]:
            check("신청 명단과 동의서 작성자 일치", Counter(m["name"] for m in members) == Counter(m.get("name") for m in consent), ["01","02"], "consent")
            majors = {b.get("name"): b.get("department") for b in consent}
            check("신청서·동의서 소속 표기 일치", all(m["major"] == majors.get(m["name"]) for m in members), ["01","02"], "affiliation")
            for i, member in enumerate(members, 1):
                name = member["name"]
                if not name.strip():
                    continue
                found = [(j,b) for j,b in enumerate(consent,1) if b.get("name") == name]
                refs = member_refs("01", name, i)
                if not found:
                    checks.append({"label":name+" · 동의서 명단에 없음", "passed":False, "refs":refs+docs["02"]})
                for j, b in found:
                    located = refs + member_refs("02", name, j)
                    if member["major"] != b.get("department"):
                        checks.append({"label":name+" · 소속 표기 대조","passed":False,"refs":located})
                    if any(b.get(k) is not True for k in ("collection_consent","identifier_consent","third_party_consent","signed")):
                        checks.append({"label":name+" · 동의 표시 또는 서명 확인","passed":False,"refs":located,"issue":"signature"})
                        if "signature" not in issues:
                            issues.append("signature")
        if app and identity:
            account = lambda value: re.sub(r"[^0-9]", "", str(value or ""))
            left, right = account(app.get("representative_account")), account(identity.get("account_number"))
            check("대표 계좌·예금주 일치", bool(left and left == right and app.get("representative_name") == identity.get("account_holder")), ["01","03"], "account")
    def agent_check(label, passed, sources=()):
        issue, refs = agent_evidence(label, docs, page_counts, sources)
        entry = {"label":label, "passed":passed, "refs":refs}
        if passed is False:
            entry["issue"] = issue
            entry["fields"] = list(dict.fromkeys(field for _,field in sources if field in FIELD_LABELS))
        checks.append(entry)
        if passed is False and issue not in issues:
            issues.append(issue)

    if agent_decision is not None:
        for key, passed in (("확정오류", False), ("확인필요", None)):
            for finding in agent_decision[key]:
                if not isinstance(finding, dict) or any(not isinstance(finding.get(k), str) for k in ("문서유형", "대상자", "검사항목", "문제유형", "근거")):
                    raise ValueError("판정 분기의 오류·확인사항 항목을 확인하세요.")
                label = " · ".join(finding[k] for k in ("문서유형", "대상자", "검사항목", "문제유형") if finding[k])
                agent_check(label + ": " + finding["근거"], passed)
    else:
        for c in unpack(first("Validate - 증빙검증").get("additional_values", {})).get("checks", []):
            agent_check(str(c.get("name", "검사")), c.get("passed"), list(validation_sources(c.get("conditions"))))
        if final["enum"] != "성공":
            for statement in re.split(r"(?<!\d[.])(?<=[.!?])\s+|[\r\n]+",final["reason"].strip()):
                if statement.strip():
                    # A reason can also describe a field that passed. Only explicit problems become student notices.
                    problem = re.sub(r"(?:이상|문제|누락|오류|불일치|중복)[이가은는]?\s*없[가-힣]*", "", statement)
                    failed = final["enum"] in ("재제출요청", "보완필요") and re.search(
                        r"누락|미제출|미기재|미작성|미서명|불일치|중복|없[습음어다]|빠[졌진져]|비어|다릅|다르|상이|되지 않",
                        problem)
                    agent_check(statement.strip(), False if failed else None)
    result = {"verdict": final["enum"], "reason": final["reason"], "program": app.get("program_name") or "",
            "representative_emails": sorted(emails - {""}),
            "team_name": app.get("team_name") or "", "rep": app.get("representative_name") or "",
            "members": members, "recipient": recipient, "documents": docs, "checks": checks, "issues": issues or ["other"],
            "extracted": extracted, "extraction_sources": extraction_sources, "extraction_warnings": warnings,
            "consent_names": [b.get("name") for b in consent],
            "staff_report": field("Instruct - 검토보고서") or field("Instruct - 검사기록") or ""}
    if agent_decision is not None:
        result["agent_decision"] = agent_decision
    return result
