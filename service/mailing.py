import base64
import ctypes
import json
import os
import re
import smtplib
import ssl
import threading
from contextlib import contextmanager
from ctypes import wintypes
from email import policy
from email.errors import HeaderParseError, NonASCIILocalPartDefect
from email.headerregistry import Address
from pathlib import Path
from tempfile import NamedTemporaryFile

from . import db
from .db import smtp_enabled

GMAIL_HOST = "smtp.gmail.com"
ADMIN_NOTICE = "담당자 알림"
_credential_lock = threading.RLock()


def mailbox_address(value):
    """Return a single mailbox suitable for both the To header and SMTP envelope."""
    if any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise ValueError("메일 주소의 줄바꿈을 제거하세요.")
    try:
        header = policy.default.header_factory("To", value.strip())
        if (len(header.addresses) != 1 or any(g.display_name is not None for g in header.groups)
                or any(not isinstance(d, NonASCIILocalPartDefect) for d in header.defects)):
            raise ValueError
        address = header.addresses[0]
        domain = address.domain.encode("idna").decode("ascii").lower()
        if (address.display_name or not address.username or len(address.username.encode()) > 64
                or not all(re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label)
                           for label in domain.split("."))):
            raise ValueError
        normalized = Address(username=address.username, domain=domain).addr_spec
        if len(normalized.encode()) > 254:
            raise ValueError
        return normalized
    except (ValueError, IndexError, HeaderParseError) as exc:
        raise ValueError("수신할 이메일 주소 한 개를 입력하세요.") from exc


class _Blob(ctypes.Structure):
    _fields_ = [("size", wintypes.DWORD), ("data", ctypes.c_void_p)]


def _windows_secret(data, *, protect):
    # DPAPI binds the encrypted value to the Windows user that connected Gmail.
    buffer = ctypes.create_string_buffer(data)
    source = _Blob(len(data), ctypes.addressof(buffer))
    result = _Blob()
    crypt = ctypes.WinDLL("crypt32", use_last_error=True)
    operation = crypt.CryptProtectData if protect else crypt.CryptUnprotectData
    if not operation(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(result)):
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        return ctypes.string_at(result.data, result.size)
    finally:
        ctypes.windll.kernel32.LocalFree(ctypes.c_void_p(result.data))


def protect_secret(text):
    return base64.b64encode(_windows_secret(text.encode("utf-8"), protect=True)).decode("ascii")


def read_secret(encrypted):
    return _windows_secret(base64.b64decode(encrypted, validate=True), protect=False).decode("utf-8")


def save_gmail(address, credential="", *, oauth=""):
    path = db.DATA / "gmail.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False)
    try:
        with temp:
            json.dump({"address": mailbox_address(address), "credential": credential, "oauth": oauth}, temp)
        with _credential_lock:
            os.replace(temp.name, path)
    finally:
        Path(temp.name).unlink(missing_ok=True)


def mail_settings(settings):
    path = db.DATA / "gmail.json"
    mode = settings.get("MAIL_MODE", "").lower()
    if mode in ("local", "smtp") or (not path.exists() and mode != "gmail"):
        return dict(settings, MAIL_READY=not smtp_enabled(settings) or bool(settings.get("SMTP_HOST")))
    try:
        profile = json.loads(path.read_text(encoding="utf-8-sig")) if path.exists() else {}
        address = mailbox_address(settings.get("GMAIL_ADDRESS") or profile["address"])
        if address != profile.get("address"):
            profile = {}
        encrypted, oauth = profile.get("credential", ""), profile.get("oauth", "")
    except (OSError, ValueError, TypeError, KeyError, AttributeError):
        address, encrypted, oauth = "", "", ""
    return dict(settings, MAIL_MODE="smtp", SMTP_HOST=GMAIL_HOST, SMTP_PORT="465", SMTP_USER=address, SMTP_FROM=address,
                ADMIN_EMAIL=address, GMAIL_CREDENTIAL=encrypted, GMAIL_OAUTH=oauth, MAIL_READY=bool(encrypted or oauth))


def mail_recipient(kind, cfg, team_email, team_id):
    if kind == ADMIN_NOTICE:
        return cfg.get("ADMIN_EMAIL")
    return team_email if smtp_enabled(cfg) else team_id + "@award.test"


def discard_revoked_oauth(cfg):
    with _credential_lock:
        current = mail_settings(db.settings())
        if current.get("GMAIL_OAUTH") == cfg["GMAIL_OAUTH"] and current.get("ADMIN_EMAIL") == cfg["ADMIN_EMAIL"]:
            save_gmail(cfg["ADMIN_EMAIL"])


def connect_gmail(address, password):
    password = password.replace(" ", "").strip()
    if not re.fullmatch(r"[A-Za-z0-9]{16}", password):
        raise ValueError("Google에서 발급한 16자리 앱 비밀번호를 입력하세요.")
    with smtplib.SMTP_SSL(GMAIL_HOST, 465, timeout=15, context=ssl.create_default_context()) as server:
        server.login(address, password)
    save_gmail(address, protect_secret(password))


@contextmanager
def smtp_connection(cfg):
    host = cfg["SMTP_HOST"]
    port = int(cfg.get("SMTP_PORT", "587"))
    password = cfg.get("SMTP_PASSWORD", "")
    if "GMAIL_CREDENTIAL" in cfg:
        password = read_secret(cfg["GMAIL_CREDENTIAL"])
    if port == 465:
        client = smtplib.SMTP_SSL(host, port, timeout=15, context=ssl.create_default_context())
    else:
        client = smtplib.SMTP(host, port, timeout=15)
    with client:
        if port != 465 and host not in {"127.0.0.1", "localhost", "::1"}:
            client.starttls(context=ssl.create_default_context())
        if cfg.get("SMTP_USER"):
            client.login(cfg["SMTP_USER"], password)
        yield client
