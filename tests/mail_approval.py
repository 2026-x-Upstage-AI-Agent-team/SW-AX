def approve_ready_notices(staff, submission):
    notices = staff.get("/api/operations/submissions/" + submission).raise_for_status().json()["mail"]
    for notice in notices:
        if notice["state"] == "draft":
            url = "/api/mail/" + notice["id"]
            draft = staff.get(url).raise_for_status().json()
            if draft["can_approve"]:
                staff.post(url + "/approve", json={k:draft[k] for k in ("revision","subject","body","recipient")}).raise_for_status()
