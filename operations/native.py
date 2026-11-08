"""Use a per-installation Hancom allowlist and a fresh, private directory for every conversion."""
import hashlib
import os
import shutil
from pathlib import Path
from uuid import uuid4

from service.db import DATA, ROOT
from service.documents import powershell


def render(src, dest):
    home = Path(os.environ.get("AWARDS_HANCOM_GUARD_DIR") or DATA / "hancom").resolve()
    module = "SWAX-Reports-" + hashlib.sha256(str(home).upper().encode("utf-8")).hexdigest()[:24].upper()
    jobs = home / "jobs"
    if not jobs.is_dir():
        raise FileNotFoundError("한글 워커 경로 확인 모듈을 설치하세요.")
    work = jobs / uuid4().hex
    work.mkdir()
    source = work / ("input"+src.suffix.lower())
    pdf = work / "output.pdf"
    try:
        shutil.copyfile(src,source)
        powershell(ROOT/"service/convert.ps1",source,pdf,"-Guard",module,timeout=180)
        shutil.copyfile(pdf,dest)
    finally:
        for path in (source,pdf):
            path.unlink(missing_ok=True)
        work.rmdir()
