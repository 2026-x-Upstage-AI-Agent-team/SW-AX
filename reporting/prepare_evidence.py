"""Restore standalone page numbering and running headers at attachment boundaries."""

import sys
from pathlib import Path
from zipfile import ZipFile

from lxml import etree as ET

from fill_award_form import HP


def empty_running_text(ctrl, kind, side, control_id):
    running = ET.SubElement(ctrl, HP + kind, id=str(control_id), applyPageType=side)
    content = ET.SubElement(running, HP + "subList", id="", textDirection="HORIZONTAL", lineWrap="BREAK",
                            vertAlign="TOP", linkListIDRef="0", linkListNextIDRef="0", textWidth="0",
                            textHeight="0", hasTextRef="0", hasNumRef="0")
    para = ET.SubElement(content, HP + "p", id="2147483648", paraPrIDRef="0", styleIDRef="0",
                         pageBreak="0", columnBreak="0", merged="0")
    ET.SubElement(para, HP + "run", charPrIDRef="0")


def isolate_first_section(source, dest):
    with ZipFile(source) as src, ZipFile(dest, "x") as out:
        for entry in src.infolist():
            data = src.read(entry)
            if entry.filename == "Contents/section0.xml":
                section = ET.fromstring(data)
                first_para = section.find(HP + "p")
                run = first_para.find(HP + "run")
                start = section.find(".//" + HP + "secPr/" + HP + "startNum")
                if start.get("page") == "0":
                    start.set("page", "1")
                # A standalone file has no preceding headers, footers, or automatic
                # page number. InsertFile otherwise inherits them from the report.
                controls = first_para.findall("./" + HP + "run/" + HP + "ctrl")
                if not any(c.find(HP + "pageNum") is not None for c in controls):
                    ctrl = ET.SubElement(run, HP + "ctrl")
                    ET.SubElement(ctrl, HP + "pageNum", pos="NONE", formatType="DIGIT", sideChar="")
                for kind in ("header", "footer"):
                    sides = {e.get("applyPageType") for c in controls for e in c.findall(HP + kind)}
                    if "BOTH" in sides:
                        continue
                    missing = {"BOTH"} if not sides else {"EVEN", "ODD"} - sides
                    next_id = 1 + max((int(e.get("id")) for e in section.iter(HP + kind)), default=0)
                    for side in sorted(missing):
                        empty_running_text(ET.SubElement(run, HP + "ctrl"), kind, side, next_id)
                        next_id += 1
                data = ET.tostring(section, encoding="UTF-8", xml_declaration=True, standalone=True)
            out.writestr(entry, data)


if __name__ == "__main__":
    isolate_first_section(Path(sys.argv[1]), Path(sys.argv[2]))
