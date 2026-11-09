"""Editable working copies of received documents in the single-PC service."""
from datetime import datetime, timezone
import hashlib
from io import BytesIO
from pathlib import Path
from urllib.parse import quote
from zipfile import BadZipFile, ZipFile

from fastapi import APIRouter, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response

from .db import database, row, rows
from .documents import source
from .workflow import require

router = APIRouter(prefix="/api/files/{fid}/versions")
EDITOR = "로컬 담당자"


@router.get("")
def history(fid: str):
    with database() as db:
        original = require(db, "files", fid)
        versions = rows(db, "SELECT version, editor, saved_at FROM document_edit_version WHERE file_id=? ORDER BY version DESC", fid)
        return {"name": original["name"], "versions": versions}


@router.get("/{version}/content")
def content(fid: str, version: int):
    with database() as db:
        original = require(db, "files", fid)
        if version == 0:
            return FileResponse(source(original), filename=original["name"], media_type="application/octet-stream")
        revision = row(db, "SELECT hwpx FROM document_edit_version WHERE file_id=? AND version=?", fid, version)
        if not revision:
            raise HTTPException(404, "문서 버전을 찾을 수 없습니다.")
        name = Path(original["name"]).stem + f"-v{version}.hwpx"
        return Response(revision["hwpx"], media_type="application/octet-stream",
                        headers={"Content-Disposition": "attachment; filename*=UTF-8''" + quote(name)})


@router.post("")
def save(fid: str, document: UploadFile, baseVersion: int = Form(ge=0, le=2147483646)):
    if not document.size or document.size > 40 * 1024**2:
        raise HTTPException(413, "수정본은 1바이트 이상 40 MiB까지 저장할 수 있습니다.")
    data = document.file.read()
    try:
        with ZipFile(BytesIO(data)) as archive:
            entries = archive.infolist()
            required = {"mimetype", "Contents/header.xml", "Contents/content.hpf", "Contents/section0.xml"}
            if (len(entries) > 10000 or sum(e.file_size for e in entries) > 384 * 1024**2
                    or any(e.filename.startswith("/") or ".." in e.filename for e in entries)
                    or not required.issubset(archive.namelist()) or archive.getinfo("mimetype").file_size > 64
                    or archive.read("mimetype") != b"application/hwp+zip" or archive.testzip() is not None):
                raise ValueError()
    except (BadZipFile, ValueError, RuntimeError, OSError, NotImplementedError):
        raise HTTPException(415, "열 수 있는 HWPX 수정본이 필요합니다.")
    digest = hashlib.sha256(data).hexdigest()
    with database(True) as db:
        require(db, "files", fid)
        latest = db.execute("SELECT coalesce(max(version),0) FROM document_edit_version WHERE file_id=?", (fid,)).fetchone()[0]
        version = baseVersion + 1
        if latest != baseVersion:
            replay = row(db, "SELECT version, editor, saved_at FROM document_edit_version WHERE file_id=? AND version=? AND sha256=?", fid, version, digest)
            if replay:
                return replay
            raise HTTPException(409, "그 사이 새 버전이 저장되었습니다. 최신 수정본을 다시 열어 주세요.")
        saved = datetime.now(timezone.utc).isoformat()
        db.execute("INSERT INTO document_edit_version(file_id,version,parent_version,editor,saved_at,sha256,hwpx) VALUES(?,?,?,?,?,?,?)",
                   (fid, version, baseVersion, EDITOR, saved, digest, data))
        return {"version": version, "editor": EDITOR, "saved_at": saved}
