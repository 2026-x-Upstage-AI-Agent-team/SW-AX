import base64
import hashlib
import hmac
import json
import secrets
import threading
import time
from dataclasses import dataclass
from email import policy
from urllib.parse import urlencode

import httpx

from .mailing import protect_secret, read_secret, save_gmail

SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send"
AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN = "https://oauth2.googleapis.com/token"
USERINFO = "https://openidconnect.googleapis.com/v1/userinfo"
SEND = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send"
COOKIE = "award_gmail_state"
CALLBACK = "/api/settings/gmail/callback"
TTL = 600


class SetupError(ValueError):
    """A setup instruction that can be displayed in the browser."""


@dataclass
class Attempt:
    address: str
    client_id: str
    client_secret: str
    redirect: str
    verifier: str
    expires: float


_attempts = {}
_lock = threading.Lock()


def begin(address, redirect, client_json):
    try:
        client = json.loads(client_json)["web"]
        client_id, secret = client["client_id"], client["client_secret"]
        if not (isinstance(client_id, str) and client_id.endswith(".apps.googleusercontent.com")
                and isinstance(secret, str) and secret):
            raise ValueError
    except (ValueError, KeyError, TypeError):
        raise SetupError("Google Cloud에서 내려받은 웹 애플리케이션 클라이언트 JSON을 선택하세요.") from None
    redirects = client.get("redirect_uris")
    if not isinstance(redirects, list) or redirect not in redirects:
        raise SetupError(f"Google Cloud에 승인된 리디렉션 URI {redirect} 를 추가하고 JSON을 다시 내려받으세요.")
    state, verifier = secrets.token_urlsafe(32), secrets.token_urlsafe(64)
    now = time.monotonic()
    with _lock:
        for key in [k for k, v in _attempts.items() if v.expires <= now or v.address == address]:
            del _attempts[key]
        _attempts[state] = Attempt(address, client_id, secret, redirect, verifier, now + TTL)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode("ascii")).digest()).rstrip(b"=")
    query = urlencode({"client_id": client_id, "redirect_uri": redirect, "response_type": "code",
                       "scope": f"openid email {SEND_SCOPE}", "access_type": "offline", "prompt": "consent",
                       "login_hint": address, "state": state, "code_challenge": challenge, "code_challenge_method": "S256"})
    return state, AUTHORIZE + "?" + query


def finish(address, state, cookie, code, error):
    if not state or not cookie or not hmac.compare_digest(state.encode(), cookie.encode()):
        raise SetupError("연결을 시작한 브라우저에서 Gmail 연결을 다시 열어 주세요.")
    with _lock:
        attempt = _attempts.pop(state, None)
    if not attempt or attempt.expires <= time.monotonic() or attempt.address != address:
        raise SetupError("연결 요청이 만료됐습니다. 이메일 발송 화면에서 Google 연결을 다시 시작하세요.")
    if error or not code:
        raise SetupError("Google 사용 승인이 완료되지 않았습니다.")
    with httpx.Client(timeout=15) as client:
        response = client.post(TOKEN, data={"grant_type": "authorization_code", "code": code,
                               "client_id": attempt.client_id, "client_secret": attempt.client_secret,
                               "code_verifier": attempt.verifier, "redirect_uri": attempt.redirect})
        response.raise_for_status()
        token = response.json()
        if not token.get("refresh_token") or SEND_SCOPE not in token.get("scope", "").split():
            raise SetupError("지속적인 메일 발송을 위해 Google 동의 화면에서 이메일 보내기를 허용하세요.")
        identity = client.get(USERINFO, headers={"Authorization": "Bearer " + token["access_token"]})
        identity.raise_for_status()
        info = identity.json()
    if info.get("email_verified") is not True or info.get("email", "").casefold() != address.casefold():
        raise SetupError("선택한 Google 계정이 등록된 담당자 주소와 다릅니다. 담당자 계정으로 다시 연결하세요.")
    token_data = {"client_id": attempt.client_id, "client_secret": attempt.client_secret,
                  "refresh_token": token["refresh_token"]}
    save_gmail(address, oauth=protect_secret(json.dumps(token_data)))


class ReconnectRequired(Exception):
    pass


class _GmailWirePolicy(policy.EmailPolicy):
    def fold_binary(self, name, value):
        # Gmail needs an RFC 2047 subject even when a mailbox local part uses UTF-8.
        if name.lower() == "subject":
            return policy.SMTP.fold_binary(name, value)
        return super().fold_binary(name, value)


_GMAIL_WIRE = _GmailWirePolicy(utf8=True, linesep="\r\n")


def access_token(client, cfg):
    credentials = json.loads(read_secret(cfg["GMAIL_OAUTH"]))
    response = client.post(TOKEN, data=dict(credentials, grant_type="refresh_token"))
    if response.status_code == 400 and response.json().get("error") == "invalid_grant":
        raise ReconnectRequired
    response.raise_for_status()
    return response.json()["access_token"]


def send_message(client, token, message):
    raw = base64.urlsafe_b64encode(message.as_bytes(policy=_GMAIL_WIRE)).decode("ascii")
    response = client.post(SEND, headers={"Authorization": "Bearer " + token}, json={"raw": raw})
    response.raise_for_status()
