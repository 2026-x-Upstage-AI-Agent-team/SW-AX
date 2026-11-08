import subprocess

from psycopg.types.json import Jsonb
from pypdf.errors import PdfReadError

from service.documents import match_file, preview, read_signals
from .native import render
from .store import cached_file


def prepare(db, api):
    db.execute("""INSERT INTO intake_preparation(batch_id)
        SELECT DISTINCT f.batch_id FROM review_job_status j JOIN team_submission_file sf ON sf.submission_id=j.submission_id
        JOIN intake_file f ON f.id=sf.file_id JOIN intake_batch b ON b.id=f.batch_id
        WHERE b.uploaded_by IS NULL AND j.state IN ('queued','running')
        AND NOT EXISTS(SELECT FROM original_analysis WHERE file_id=f.id) ON CONFLICT DO NOTHING""")
    batch = db.execute("""SELECT b.id,b.event_id,b.target_team_id,b.base_submission,b.uploaded_by,p.state FROM intake_preparation p
        JOIN intake_batch b ON b.id=p.batch_id WHERE p.state IN ('pending','ready') ORDER BY p.created_at,b.id LIMIT 1""").fetchone()
    if not batch:
        return False
    bid = batch["id"]
    if batch["state"] == "ready":
        api.put(f"review-jobs/preparations/{bid}/confirm").raise_for_status()
        return True
    items = db.execute("SELECT id,position,name FROM intake_file WHERE batch_id=%s ORDER BY position", (bid,)).fetchall()
    for item in items:
        fid = item["id"]
        if db.execute("SELECT 1 FROM original_analysis WHERE file_id=%s", (fid,)).fetchone():
            continue
        file = cached_file(db, fid)
        display = "파일%02d.%s" % (item["position"],item["name"].rsplit(".",1)[-1].lower())
        db.execute("INSERT INTO file_preparation_log(file_id,stage,display_name) VALUES(%s,'검토 PDF 준비',%s)",(fid,display))
        try:
            kind, pages, signals = read_signals(file, renderer=render)
            db.execute("""INSERT INTO original_analysis(file_id,kind,pages,signals,pdf) VALUES(%s,%s,%s,%s,%s)
                       ON CONFLICT DO NOTHING""", (fid, kind, pages, Jsonb(signals), preview(file).read_bytes()))
            stage = "판독 완료"
        except (ValueError, OSError, RuntimeError, subprocess.SubprocessError, PdfReadError):
            stage = "판독 실패"
            db.execute("""INSERT INTO original_analysis(file_id,failed,reason) VALUES(%s,true,
                '원본을 열 수 없습니다. 손상·암호와 한글 파일 접근 권한을 확인하세요.') ON CONFLICT DO NOTHING""", (fid,))
        db.execute("INSERT INTO file_preparation_log(file_id,stage,display_name) VALUES(%s,%s,%s)",(fid,stage,display))
        return True
    if not batch["uploaded_by"]:
        db.execute("UPDATE intake_preparation SET state='prepared' WHERE batch_id=%s",(bid,))
        return True
    with db.transaction():
        db.execute("SELECT id FROM intake_batch WHERE id=%s FOR UPDATE", (bid,))
        db.execute("SELECT id FROM award_event WHERE id=%s FOR NO KEY UPDATE", (batch["event_id"],))
        files = db.execute("""SELECT f.id,f.name,a.kind,a.signals,a.failed FROM intake_file f JOIN original_analysis a ON a.file_id=f.id
                           WHERE f.batch_id=%s ORDER BY f.position""", (bid,)).fetchall()
        for file in files:
            sig = file["signals"]
            if sig.get("mixed") or file["failed"]:
                continue
            for app in sig.get("apps", []):
                if not app["name"] or len(app["name"])>160 or len(app["rep"])>80:
                    continue
                target = batch["target_team_id"]
                if target:
                    db.execute("""UPDATE award_team t SET representative=%s,roster=%s WHERE id=%s AND name=%s
                      AND representative='' AND NOT EXISTS(SELECT FROM award_team x WHERE x.event_id=t.event_id
                          AND x.name=t.name AND x.representative=%s AND x.id<>t.id)""",
                               (app["rep"],Jsonb(app["roster"]),target,app["name"],app["rep"]))
                db.execute("""INSERT INTO award_team(id,event_id,name,representative,roster) VALUES(gen_random_uuid(),%s,%s,%s,%s)
                    ON CONFLICT(event_id,name,representative) DO UPDATE SET roster=EXCLUDED.roster""",
                           (batch["event_id"],app["name"],app["rep"],Jsonb(app["roster"])))
        teams = db.execute("SELECT id,name,representative AS rep,roster FROM award_team WHERE event_id=%s", (batch["event_id"],)).fetchall()
        for file in files:
            signals = file["signals"]
            if not file["failed"]:
                chosen, candidates, reason = match_file(file, signals, teams, batch["target_team_id"])
            if file["failed"] or signals.get("mixed"):
                old = db.execute("SELECT team_id FROM intake_file_state WHERE id=%s", (file["id"],)).fetchone()
                if old["team_id"]:
                    rev = db.execute("UPDATE intake_batch SET assignment_revision=assignment_revision+1 WHERE id=%s RETURNING assignment_revision",
                                     (bid,)).fetchone()["assignment_revision"]
                    db.execute("""INSERT INTO intake_file_assignment(file_id,revision,before_team_id,actor,reason,state)
                        VALUES(%s,%s,%s,'@workflow','혼합 또는 열 수 없는 원본을 분리·교체하세요.','unassigned')""",
                               (file["id"],rev,old["team_id"]))
                if file["failed"]:
                    continue
            db.execute("UPDATE original_analysis SET candidates=%s,reason=%s,signals=%s WHERE file_id=%s",
                       (list(candidates),reason,Jsonb(signals),file["id"]))
            if not chosen or db.execute("SELECT 1 FROM intake_file_assignment WHERE file_id=%s LIMIT 1",(file["id"],)).fetchone():
                continue
            rev = db.execute("UPDATE intake_batch SET assignment_revision=assignment_revision+1 WHERE id=%s RETURNING assignment_revision",
                             (bid,)).fetchone()["assignment_revision"]
            db.execute("""INSERT INTO intake_file_assignment(file_id,revision,after_team_id,actor,reason,state)
                VALUES(%s,%s,%s,'@workflow',%s,%s)""", (file["id"],rev,None if chosen=="outside" else chosen,reason,
                                                      "outside" if chosen=="outside" else "assigned"))
        db.execute("UPDATE intake_preparation SET state='ready' WHERE batch_id=%s", (bid,))
    return True
