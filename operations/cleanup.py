from service.db import DATA


def clear_deleted_cache(db):
    """Drain a committed deletion on the host that owns the working copies."""
    row = db.execute("""SELECT item_id,batch_id FROM intake_cache_cleanup
        WHERE due<=now() ORDER BY due,item_id LIMIT 1""").fetchone()
    if not row:
        return False
    item = str(row["item_id"])
    root = DATA / "operations"
    if row["batch_id"] is None:
        directory = root / "mail"
        paths = [directory / (item + ext) for ext in (".eml", ".part")]
    else:
        directory = root / "originals" / str(row["batch_id"])
        paths = [directory / (item + ext) for ext in (".hwp", ".hwpx", ".pdf", ".working.pdf", ".ocr.png")]
    try:
        for path in paths:
            path.unlink(missing_ok=True)
        if row["batch_id"] is not None:
            for path in directory.glob(item + ".*.part"):
                path.unlink(missing_ok=True)
    except OSError:
        db.execute("UPDATE intake_cache_cleanup SET due=now()+interval '1 minute' WHERE item_id=%s", (item,))
    else:
        db.execute("DELETE FROM intake_cache_cleanup WHERE item_id=%s", (item,))
    return True
