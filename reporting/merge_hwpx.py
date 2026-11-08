"""Append editable HWPX sections, rebasing their style, font, field and binary references."""
from collections import defaultdict
from copy import deepcopy
from pathlib import Path
import re
from zipfile import ZipFile, ZIP_DEFLATED, ZIP_STORED

from lxml import etree as ET

from .fill_award_form import HP
from .prepare_evidence import isolate_first_section

HH = "{http://www.hancom.co.kr/hwpml/2011/head}"
GROUPS = {"borderFillIDRef":"borderFills", "charPrIDRef":"charProperties",
          "tabPrIDRef":"tabProperties", "paraPrIDRef":"paraProperties",
          "styleIDRef":"styles", "nextStyleIDRef":"styles",
          "outlineShapeIDRef":"numberings", "memoShapeIDRef":"memoProperties"}
def xml(x):
    return ET.tostring(x, encoding="UTF-8", xml_declaration=True, standalone=True)

def compile_sections(cover, attachments, directory):
    with ZipFile(cover) as z:
        base = {k:z.read(k) for k in z.namelist()}
    h = ET.fromstring(base["Contents/header.xml"])
    ref = h.find(HH + "refList")
    pkg = ET.fromstring(base["Contents/content.hpf"])
    man, = pkg.xpath("//*[local-name()='manifest']")
    spine, = pkg.xpath("//*[local-name()='spine']")
    opf = "{"+ET.QName(man).namespace+"}"
    paths = {item.get("id") for item in man}
    image_num = max([0] + [int(m[1]) for name in paths if (m := re.fullmatch(r"image(\d+)", name or ""))])
    master_num = max([-1] + [int(m[1]) for name in paths if (m := re.fullmatch(r"masterpage(\d+)", name or ""))]) + 1
    section_count = int(h.get("secCnt"))
    cover_sections = [ET.fromstring(data) for name, data in base.items() if re.fullmatch(r"Contents/section\d+\.xml", name)]
    next_field = max([1_000_000] + [int(field.get("id"))+1 for sec in cover_sections for field in sec.iter(HP+"fieldBegin")])
    for index, attachment in enumerate(attachments):
        isolated = Path(directory) / f"isolated-{index}.hwpx"
        isolate_first_section(attachment, isolated)
        with ZipFile(isolated) as z:
            sh = ET.fromstring(z.read("Contents/header.xml"))
            sr = sh.find(HH + "refList")

            manifest = ET.fromstring(z.read("Contents/content.hpf"))
            by_id = {item.get("id"): item.get("href") for item in manifest.xpath("//*[local-name()='manifest']/*")}
            sections = [ET.fromstring(z.read(href)) for item in manifest.xpath("//*[local-name()='spine']/*")
                        if (href := by_id.get(item.get("idref"), "")) and re.fullmatch(r"Contents/section\d+\.xml", href)]
            if len(sections) != int(sh.get("secCnt")):
                raise ValueError("원본 HWPX 구역 목록을 확인하세요.")
            maps = defaultdict(dict)
            resources = []
            masters = {}
            for group in sr:
                gn = ET.QName(group).localname
                dest = ref.find(group.tag)
                if dest is None:
                    dest = ET.SubElement(ref, group.tag, itemCnt="0")
                if gn == "fontfaces":
                    for lang in group:
                        target = next((x for x in dest if x.get("lang") == lang.get("lang")), None)
                        if target is None:
                            target = ET.SubElement(dest,lang.tag,dict(lang.attrib))
                            dest.set("itemCnt",str(len(dest)))
                        known = {tuple(sorted((k,v) for k,v in x.attrib.items() if k!="id")) + (xml(x[0]) if len(x) else b"",):x.get("id") for x in target}
                        for font in lang:
                            old = font.get("id")
                            key = tuple(sorted((k,v) for k,v in font.attrib.items() if k!="id")) + (xml(font[0]) if len(font) else b"",)
                            new = known.get(key)
                            if new is None:
                                new = str(max((int(x.get("id")) for x in target),default=-1)+1)
                                font.set("id",new)
                                target.append(deepcopy(font))
                                known[key] = new
                            maps["font."+lang.get("lang").lower()][old] = new
                        target.set("fontCnt",str(len(target)))
                    continue
                start = max((int(x.get("id")) for x in dest), default=(0 if gn in ("memoProperties","borderFills","numberings") else -1))+1
                for offset, child in enumerate(group):
                    item = deepcopy(child)
                    new = str(start+offset)
                    maps[gn][item.get("id")] = new
                    item.set("id",new)
                    dest.append(item)
                    resources.append(item)
                dest.set("itemCnt",str(len(dest)))
            for item in manifest.xpath("//*[local-name()='item']"):
                href = item.get("href")
                if href.startswith("Contents/masterpage"):
                    name = f"masterpage{master_num}"
                    master_num += 1
                    dest = f"Contents/{name}.xml"
                    maps["master"][item.get("id")] = name
                    master = ET.fromstring(z.read(href))
                    master.set("id",name)
                    masters[dest] = master
                    entry = deepcopy(item)
                    entry.set("id",name)
                    entry.set("href",dest)
                    man.append(entry)
                    continue
                if not href.startswith("BinData/"):
                    continue
                image_num += 1
                name = f"image{image_num}"
                dest = f"BinData/{name}.{href.rsplit('.',1)[1]}"
                maps["image"][item.get("id")] = name
                base[dest] = z.read(href)
                entry = deepcopy(item)
                entry.set("id",name)
                entry.set("href",dest)
                man.append(entry)
            for begin in (field for sec in sections for field in sec.iter(HP+"fieldBegin")):
                maps["field"][begin.get("id")] = str(next_field)
                begin.set("id",str(next_field))
                next_field += 1
            for tree in [*resources,*masters.values(),*sections]:
                for e in tree.iter():
                    for k,v in list(e.attrib.items()):
                        group = GROUPS.get(k)
                        if e.tag == HH+"fontRef":
                            group = "font."+k
                        elif k == "binaryItemIDRef":
                            group = "image"
                        elif k == "beginIDRef":
                            group = "field"
                        elif ET.QName(e).localname == "masterPage" and k=="idRef":
                            group = "master"
                        elif e.tag == HH+"heading" and k=="idRef":
                            group = {"NUMBER":"numberings","OUTLINE":"numberings","BULLET":"bullets"}.get(e.get("type"))
                        if group and v in maps[group]:
                            e.set(k,maps[group][v])
                        elif group=="image":
                            raise ValueError(f"Unresolved binary {v}")
            for dest,master in masters.items():
                base[dest] = xml(master)
            for sec in sections:
                name = f"section{section_count}"
                path = f"Contents/{name}.xml"
                base[path] = xml(sec)
                ET.SubElement(man,opf+"item",id=name,href=path,attrib={"media-type":"application/xml"})
                ET.SubElement(spine,opf+"itemref",idref=name,linear="yes")
                section_count += 1
    h.set("secCnt",str(section_count))
    base["Contents/header.xml"] = xml(h)
    base["Contents/content.hpf"] = xml(pkg)
    return base

def save(path, base):
    with ZipFile(path,"w",compression=ZIP_DEFLATED) as z:
        z.writestr("mimetype",base["mimetype"],compress_type=ZIP_STORED)
        for k,v in base.items():
            if k!="mimetype":
                z.writestr(k,v)
