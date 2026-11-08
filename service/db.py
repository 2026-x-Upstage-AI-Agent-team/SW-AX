import json
import os
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]
DATA = Path(os.environ.get("AWARD_DATA_DIR") or ROOT / "var").resolve()
WAVE = "WAVE 2026 대학생 AI/SW 아이디어 피칭대회"


def settings():
    values = {}
    path = ROOT / ".env.local"
    if path.exists():
        for line in path.read_text(encoding="utf-8-sig").splitlines():
            key, sep, value = line.strip().partition("=")
            if sep and key and not key.startswith("#"):
                values[key.strip()] = value.strip().strip("\"'")
    return values | os.environ


def uid():
    return uuid4().hex


def smtp_enabled(cfg):
    return cfg.get("MAIL_MODE","local").lower() == "smtp"


def dump(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def now():
    return int(time.time())


@contextmanager
def database(write=False):
    db = sqlite3.connect(DATA / "award.sqlite3", timeout=15, isolation_level=None)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys=ON")
    try:
        db.execute("BEGIN IMMEDIATE" if write else "BEGIN")
        yield db
        db.commit()
    except BaseException:
        db.rollback()
        raise
    finally:
        db.close()


def initialize():
    DATA.mkdir(parents=True, exist_ok=True)
    with database() as db:
        db.commit()
        db.execute("PRAGMA journal_mode=WAL")
        db.executescript((Path(__file__).with_name("schema.sql")).read_text(encoding="utf-8"))
        columns = {r[1] for r in db.execute("PRAGMA table_info(submissions)")}
        for name in ("agent_id","config_version","config_id"):
            if name not in columns:
                db.execute(f"ALTER TABLE submissions ADD COLUMN {name} TEXT")
        db.execute("INSERT OR IGNORE INTO events(id,name) VALUES('wave',?)", (WAVE,))


def row(db, sql, *args):
    value = db.execute(sql, args).fetchone()
    return dict(value) if value is not None else None


def rows(db, sql, *args):
    return [dict(value) for value in db.execute(sql, args)]
