import hashlib
import json

from fastapi import HTTPException

from .db import dump, now, row, rows, uid
from .documents import match_file


def require(db, table, key):
    record = row(db, f"SELECT * FROM {table} WHERE id=?", key)
    if not record:
        raise HTTPException(404, "해당 기록을 찾을 수 없습니다.")
    return record


def audit(db, subject, action, detail, actor="담당자"):
    db.execute("INSERT INTO audit(ts,subject,action,detail,actor) VALUES(?,?,?,?,?)",
               (now(), subject, action, dump(detail), actor))


def event_teams(db, event):
    teams = rows(db, "SELECT * FROM teams WHERE event=? ORDER BY rowid", event)
    for t in teams:
        t["roster"] = json.loads(t["roster"])
    return teams


def identify_batch(db, batch):
    files = rows(db, "SELECT * FROM files WHERE batch=? ORDER BY pos", batch["id"])
    for f in files:
        sig = json.loads(f["signals"])
        for app in sig.get("apps", []):
            if sig.get("mixed"):
                continue
            team = row(db, "SELECT * FROM teams WHERE event=? AND name=? AND rep=?",
                       batch["event"], app["name"], app["rep"])
            target = require(db, "teams", batch["target"]) if batch["target"] else None
            if target and not target["rep"] and target["name"] == app["name"] and not team:
                db.execute("UPDATE teams SET rep=?, roster=? WHERE id=?", (app["rep"], dump(app["roster"]), target["id"]))
            elif not team:
                db.execute("INSERT INTO teams(id,event,name,rep,roster) VALUES(?,?,?,?,?)",
                           (uid(), batch["event"], app["name"], app["rep"], dump(app["roster"])))
            elif not batch["base"] or team["id"] == batch["target"]:
                db.execute("UPDATE teams SET roster=? WHERE id=?", (dump(app["roster"]), team["id"]))
    teams = event_teams(db, batch["event"])
    for f in files:
        if f["state"] != "read":
            continue
        signals = json.loads(f["signals"])
        chosen, candidates, reason = match_file(f, signals, teams, batch["target"])
        state = "outside" if chosen == "outside" else "assigned" if chosen else "unassigned"
        team = chosen if state == "assigned" else None
        signals.pop("body",None)
        signals.pop("identity",None)
        db.execute("UPDATE files SET state=?,team=?,candidates=?,reason=?,signals=? WHERE id=?",
                   (state, team, dump(sorted(candidates)), reason, dump(signals), f["id"]))
        audit(db, f["id"], "판독", {"team": team, "reason": reason}, "서비스")
    db.execute("UPDATE batches SET state='review',revision=revision+1 WHERE id=?", (batch["id"],))
    synchronize(db, batch)


def pending_file(f, team):
    if f["state"] not in {"unassigned", "error"} or team in json.loads(f["excluded"]):
        return False
    candidates = json.loads(f["candidates"])
    return not candidates or team in candidates


def held(db, team):
    entry = require(db, "teams", team)
    if row(db,"SELECT id FROM batches WHERE event=? AND state='preparing' AND (target IS NULL OR target=?) LIMIT 1",
           entry["event"], team):
        return True
    unresolved = rows(db, """SELECT f.* FROM files f JOIN batches b ON f.batch=b.id
        WHERE b.event=? AND f.state IN ('error','unassigned')""", entry["event"])
    return any(pending_file(f, team) for f in unresolved)


def files_for(db, ids):
    return [require(db, "files", key) for key in ids]


def synchronize(db, batch):
    files = rows(db, "SELECT * FROM files WHERE batch=? ORDER BY pos", batch["id"])
    links = {s["team"]: s["submission"] for s in rows(db, "SELECT * FROM batch_teams WHERE batch=?", batch["id"])}
    affected = set(links) | {f["team"] for f in files if f["team"]}
    # Preserve the originally selected order of first registration.
    for t in sorted(affected, key=lambda k: next((i for i, f in enumerate(files) if f["team"] == k), len(files))):
        previous = links.get(t)
        team = require(db, "teams", t)
        if previous and team["current"] and previous != team["current"]:
            continue
        if any(pending_file(f, t) for f in files):
            continue
        selected = [f for f in files if f["team"] == t]
        if batch["base"] and t == batch["target"]:
            base = require(db, "submissions", batch["base"])
            if team["current"] not in (base["id"], previous):
                continue
            keep = [fid for fid in json.loads(base["files"]) if fid not in json.loads(batch["removed"])]
            selected = files_for(db, keep) + selected
        if not selected:
            if previous and team["current"] == previous:
                db.execute("UPDATE teams SET current=NULL WHERE id=?", (t,))
            db.execute("DELETE FROM batch_teams WHERE batch=? AND team=?", (batch["id"], t))
            continue
        digest = hashlib.sha256(dump(sorted(f["hash"] for f in selected)).encode()).hexdigest()
        current = row(db, "SELECT * FROM submissions WHERE id=?", team["current"])
        if current and current["digest"] == digest:
            sub = current["id"]
        else:
            version = db.execute("SELECT COALESCE(MAX(version),0)+1 FROM submissions WHERE team=?", (t,)).fetchone()[0]
            sub = uid()
            db.execute("""INSERT INTO submissions(id,team,version,files,digest,created,updated)
                       VALUES(?,?,?,?,?,?,?)""", (sub,t,version,dump([f["id"] for f in selected]),digest,now(),now()))
            db.execute("UPDATE teams SET current=? WHERE id=?", (sub,t))
            if current:
                db.execute("UPDATE mail SET state='obsolete' WHERE submission=? AND state IN ('waiting','failed')", (current["id"],))
            audit(db, sub, "제출 버전 생성", {"version": version}, "서비스")
        db.execute("INSERT OR REPLACE INTO batch_teams VALUES(?,?,?)", (batch["id"], t, sub))
    state = "review" if any(f["state"] in ("unassigned","error") for f in files) else "assigned"
    db.execute("UPDATE batches SET state=? WHERE id=?", (state,batch["id"]))


def enqueue_mail(db, sub, kind):
    db.execute("INSERT OR IGNORE INTO mail(id,submission,kind,created) VALUES(?,?,?,?)", (uid(), sub, kind, now()))


def effective_fields(sub):
    result = json.loads(sub["result"] or "{}")
    return json.loads(sub["fields"]) if sub["fields"] else {
        "members": result.get("members", []), "recipient": result.get("recipient", {}), "award_type": "", "support_amount": ""}


def missing_payouts(fields):
    recipient = fields.get("recipient") or {}
    return [label for key,label in (("gross_amount","지급총액"),("tax_amount","세액"),("net_amount","차인지급액"))
            if recipient.get(key) is None or str(recipient[key]).strip() in ("", "미확인")]


def pending_payouts(snapshot):
    return [team["team_name"]+" · "+", ".join(missing) for team in snapshot["teams"]
            if (missing := missing_payouts(team))]


def require_payouts(snapshot):
    missing = pending_payouts(snapshot)
    if missing:
        raise HTTPException(409, "지급 정보 미입력 ("+" / ".join(missing)+").")


def report_snapshot(db, event, selection):
    if not selection or len(set(selection)) != len(selection):
        raise HTTPException(422, "보고서에 포함할 팀을 한 번씩 선택하세요.")
    chosen = []
    for sid in selection:
        s = require(db, "submissions", sid)
        t = require(db, "teams", s["team"])
        if t["event"] != event or t["current"] != sid or s["decision"] != "승인" or held(db, t["id"]):
            raise HTTPException(409, "팀 배정과 현재 제출본 승인을 먼저 완료하세요.")
        fields = effective_fields(s)
        if not fields.get("award_type") or fields.get("support_amount") in (None, ""):
            raise HTTPException(409, "팀별 시상구분과 지원액을 입력하세요.")
        result = json.loads(s["result"])
        groups = result["documents"]
        if any(len(groups[k]) != 1 for k in ("01","02","03")) or groups["?"]:
            raise HTTPException(409, "팀별 01·02·03 원본을 한 부씩 확정하세요. 교체·추가는 보완 접수에서 할 수 있습니다.")
        chosen.append({"team_name": t["name"], **fields, "submission": sid, "revision": s["revision"],
                       "file_ids": [groups[k][0]["id"] for k in ("01","02","03")]})
    return {"event": {"name": require(db, "events", event)["name"]}, "teams": chosen}


def check_report(db, r):
    if dump(report_snapshot(db, r["event"], json.loads(r["selection"]))) != r["snapshot"]:
        raise HTTPException(409, "지급정보 또는 제출본이 변경됐습니다. 새 보고서를 생성하세요.")
