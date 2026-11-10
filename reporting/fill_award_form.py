"""Fill the two editable tables in a Hancom-converted WAVE 00 template."""

import argparse
import json
import re
from copy import deepcopy
from pathlib import Path
from zipfile import ZipFile

from lxml import etree as ET


HP = "{http://www.hancom.co.kr/hwpml/2011/paragraph}"
UNKNOWN = "미확인"
MONEY_COLUMNS = ("gross_amount", "tax_amount", "net_amount")


def display(value):
    if value is None or (isinstance(value, str) and not value.strip()):
        return UNKNOWN
    if not isinstance(value, str):
        raise ValueError("학번·계좌 등 문서의 텍스트 값은 문자열이어야 합니다.")
    return value


def won(value):
    if value in (None, "", UNKNOWN):
        return None
    if not re.fullmatch(r"[0-9]+|[0-9]{1,3}(?:,[0-9]{3})+", str(value)):
        raise ValueError(f"원 단위 금액을 확인하세요: {value}")
    return int(str(value).replace(",", ""))


def amount_text(amount):
    return UNKNOWN if amount is None else f"{amount:,}"


def total_text(amounts):
    return amount_text(sum(amounts)) if all(x is not None for x in amounts) else UNKNOWN


def text_of(element):
    return "".join(element.itertext(HP + "t"))


def write_lines(cell, *lines, wrap=None):
    content = cell.find(HP + "subList")
    if wrap:
        content.set("lineWrap", wrap)
    prototype = content.find(HP + "p")
    style = prototype.find(HP + "run").get("charPrIDRef")
    for paragraph in list(content.findall(HP + "p")):
        content.remove(paragraph)
    for line in lines:
        para = ET.SubElement(content, HP + "p", prototype.attrib)
        run = ET.SubElement(para, HP + "run", charPrIDRef=style)
        ET.SubElement(run, HP + "t").text = line


def cells(row):
    return row.findall(HP + "tc")


def replace_rows(table, body):
    old = table.findall(HP + "tr")
    for row in old[1:-1]:
        table.remove(row)
    total = old[-1]
    for row in body:
        total.addprevious(row)
    rows = table.findall(HP + "tr")
    table.set("rowCnt", str(len(rows)))
    for head in cells(rows[0]):
        head.set("header", "1")
    height = 0
    for index, row in enumerate(rows):
        for cell in cells(row):
            cell.find(HP + "cellAddr").set("rowAddr", str(index))
        height += int(cells(row)[0].find(HP + "cellSz").get("height"))
    table.find(HP + "sz").set("height", str(height))
    return cells(total)


def fill_tables(student_table, recipient_table, teams):
    # The original student table has mixed vertical merges. Clone a full
    # one-person row, then rebuild the three team-wide cells for each team.
    student_proto = next(row for row in student_table.findall(HP + "tr")[1:-1]
                         if len(cells(row)) == 7 and
                         all(c.find(HP + "cellSpan").get("rowSpan") == "1" for c in cells(row)))
    recipient_proto = recipient_table.findall(HP + "tr")[1]
    student_rows, recipient_rows = [], []
    support_amounts = []
    payout_amounts = {key: [] for key in MONEY_COLUMNS}
    for team_number, team in enumerate(teams, start=1):
        members = team["members"]
        reps = [person for person in members if person["role"] == "대표"]
        if len(reps) != 1:
            raise ValueError(f"{team['team_name']}의 대표 한 명을 확인하세요.")
        rep = reps[0]
        amount = won(team.get("support_amount"))
        support_amounts.append(amount)
        for offset, person in enumerate([rep] + [p for p in members if p is not rep]):
            row = deepcopy(student_proto)
            row_cells = cells(row)
            for cell in row_cells:
                cell.find(HP + "cellSz").set("height", "2900")
            write_lines(row_cells[0], str(len(student_rows) + 1))
            write_lines(row_cells[1], display(person.get("name")))
            write_lines(row_cells[2], display(person.get("student_id")), "(" + display(person.get("school")) + ")")
            write_lines(row_cells[3], display(person.get("major")), wrap="BREAK")
            for cell, value in zip(row_cells[4:], [display(team["team_name"]),
                    display(team.get("award_type")), amount_text(amount)]):
                if offset == 0:
                    cell.find(HP + "cellSpan").set("rowSpan", str(len(members)))
                    cell.find(HP + "cellSz").set("height", str(2900 * len(members)))
                    write_lines(cell, value)
                else:
                    row.remove(cell)
            student_rows.append(row)

        recipient = team["recipient"]
        row = deepcopy(recipient_proto)
        values = [str(team_number)] + [display(rep.get(k)) for k in ("name", "student_id", "major")]
        values.extend(display(recipient.get(k)) for k in ("rrn_display", "bank_name", "account_number", "account_holder"))
        for key in MONEY_COLUMNS:
            value = won(recipient.get(key))
            payout_amounts[key].append(value)
            values.append(amount_text(value))
        for column, (cell, value) in enumerate(zip(cells(row), values, strict=True)):
            if column == 5 and value.endswith("은행") and len(value) > 4:
                write_lines(cell, value[:-2], "은행", wrap="SQUEEZE" if len(value[:-2]) <= 4 else "BREAK")
            else:
                write_lines(cell, value, wrap="BREAK" if column in (3, 5) else "SQUEEZE")
        recipient_rows.append(row)

    write_lines(replace_rows(student_table, student_rows)[-1], total_text(support_amounts))
    totals = replace_rows(recipient_table, recipient_rows)
    for cell, key in zip(totals[1:], MONEY_COLUMNS, strict=True):
        write_lines(cell, total_text(payout_amounts[key]))
    return len(student_rows)


def fill_form(template, data, target):
    teams = data["teams"]
    if not teams:
        raise ValueError("보고서에 포함할 팀을 선택하세요.")
    with ZipFile(template) as src:
        section_path = "Contents/section0.xml"
        section = ET.fromstring(src.read(section_path))
        tables = list(section.iter(HP + "tbl"))
        first, = (t for t in tables if t.get("colCnt") == "7" and "시상구분" in text_of(t.find(HP + "tr")))
        second, = (t for t in tables if t.get("colCnt") == "11" and "차인지급액" in text_of(t.find(HP + "tr")))
        count = fill_tables(first, second, teams)
        event = data["event"]
        name = display(event.get("name"))
        title, = (t for t in tables if t.get("colCnt") == "1" and "시상금 지급내역서" in text_of(t))
        write_lines(cells(title.find(HP + "tr"))[0], name + " 시상금 지급내역서")
        overview = {"행사명": name, "일시": display(event.get("date")), "장소": display(event.get("place")),
                    "참여인원": f"{len(teams)}개 팀 {count}명 참여(지급대상 {len(teams)}명)"}
        for para in section.findall(HP + "p"):
            for node in para.findall("./" + HP + "run/" + HP + "t"):
                label, sep, _ = (node.text or "").partition(":")
                field = label.replace("○", "").strip()
                if sep and field in overview:
                    node.text = label + ": " + overview.pop(field)
        if overview:
            raise ValueError("00 개요 양식의 항목을 찾을 수 없습니다: " + ", ".join(overview))
        # Hancom recalculates line positions and table pagination on open.
        for cached in section.iterfind(".//" + HP + "linesegarray"):
            cached.getparent().remove(cached)
        xml = ET.tostring(section, encoding="UTF-8", xml_declaration=True, standalone=True)
        with ZipFile(target, "x") as dst:
            for entry in src.infolist():
                dst.writestr(entry, xml if entry.filename == section_path else src.read(entry))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("template", type=Path)
    parser.add_argument("data", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    fill_form(args.template, json.loads(args.data.read_text(encoding="utf-8-sig")), args.output)
