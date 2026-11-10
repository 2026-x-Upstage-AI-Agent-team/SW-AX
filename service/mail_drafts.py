"""Read the local service's existing notice template or the staff-edited draft."""
import json

from .db import row
from .mailing import mail_recipient
from .studio import ISSUES
from .workflow import held, require


def detail(db, mail, cfg):
    sub = require(db, "submissions", mail["submission"])
    team = require(db, "teams", sub["team"])
    result = json.loads(sub["result"] or "{}")
    kind = mail["kind"]
    recipient = mail_recipient(kind, cfg, team["email"], team["id"]) or ""
    editable = mail["state"] == "draft"
    subject, body = mail["subject"], mail["body"]
    if editable and (subject is None or body is None):
        name = " ".join((result.get("team_name") or "").splitlines()).strip() or "미확인"
        lines = [f"{name} 팀장님, 제출 {sub['version']}차 서류의 검토 결과입니다.", ""]
        if kind == "보완 요청":
            last = row(db, "SELECT detail FROM audit WHERE subject=? AND action='검토 저장' ORDER BY id DESC LIMIT 1", sub["id"])
            review = json.loads(last["detail"]) if last else {}
            issues = review.get("issues", []) if review.get("decision") == "보완 필요" else result.get("issues", [])
            lines.extend(ISSUES[key] for key in issues if key in ISSUES)
            lines.append("보완한 서류는 기존 제출 경로로 담당자에게 보내 주세요.")
        else:
            lines.append("제출한 서류의 검토를 완료했습니다.")
        subject = subject if subject is not None else f"[시상금 서류 {kind}] {name}"
        body = body if body is not None else "\n".join(lines)
    return dict(mail, subject=subject, body=body, recipient=recipient if editable else mail["sent_to"],
                can_approve=bool(editable and recipient and kind in ("보완 요청","검토 완료")
                                 and team["current"] == sub["id"] and sub["state"] == "done" and not held(db,team["id"])))
