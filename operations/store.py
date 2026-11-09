"""Server-side worker connection and immutable document cache."""
import hashlib
from pathlib import Path

import psycopg
from psycopg.rows import dict_row

from service.db import DATA, settings


def connect(cfg):
    url = cfg.get("AWARDS_DB_URL", "jdbc:postgresql://127.0.0.1:55432/swax_intake").removeprefix("jdbc:")
    return psycopg.connect(url, user=cfg.get("AWARDS_DB_USER", "swax"), password=cfg["AWARDS_DB_PASSWORD"],
                           autocommit=True, row_factory=dict_row)


def configuration():
    cfg = settings()
    if not cfg.get("AWARDS_DB_PASSWORD"):
        cfg["AWARDS_DB_PASSWORD"] = (DATA / "intake-postgres.key").read_text().strip()
    if not cfg.get("AWARDS_REVIEW_WORKER_TOKEN"):
        cfg["AWARDS_REVIEW_WORKER_TOKEN"] = (DATA / "review-worker.key").read_text().strip()
    return cfg


def cached_file(db, fid):
    row = db.execute("""SELECT f.id,f.batch_id AS batch,f.name,f.sha256,coalesce(a.kind,'?') AS kind,
        coalesce(a.signals,'{}')::text AS signals,coalesce(a.pages,0) AS pages FROM intake_file f LEFT JOIN original_analysis a ON a.file_id=f.id
        WHERE f.id=%s""", (fid,)).fetchone()
    path = DATA / "operations" / "originals" / str(row["batch"]) / (str(fid) + Path(row["name"]).suffix.lower())
    if not path.exists() or hashlib.sha256(path.read_bytes()).hexdigest() != row["sha256"]:
        path.parent.mkdir(parents=True, exist_ok=True)
        data = db.execute("SELECT original FROM intake_file WHERE id=%s", (fid,)).fetchone()["original"]
        if hashlib.sha256(data).hexdigest() != row["sha256"]:
            raise ValueError("원본 해시 불일치")
        from tempfile import NamedTemporaryFile
        with NamedTemporaryFile(dir=path.parent, prefix=str(fid) + ".", suffix=".part", delete=False) as temp:
            temp.write(data)
        Path(temp.name).replace(path)
    return dict(row, id=str(fid), batch=str(row["batch"]), _source=str(path))
