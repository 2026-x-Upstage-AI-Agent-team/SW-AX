import base64
import hashlib
import json
import smtplib
import tempfile
import unittest
from contextlib import ExitStack
from email import policy
from email.message import EmailMessage
from email.parser import BytesParser
from pathlib import Path
from unittest.mock import Mock, patch
from urllib.parse import parse_qs, urlsplit

import httpx
from fastapi.testclient import TestClient

from service import app as web
from service import db, gmail_oauth, mailing, studio, worker


class GmailNotifications(unittest.TestCase):
    account = "staff@example.org"
    password = "abcdefghijklmnop"

    def setUp(self):
        scope = self.enterContext(ExitStack())
        folder = Path(scope.enter_context(tempfile.TemporaryDirectory()))
        for module in (db, web, worker):
            scope.enter_context(patch.object(module, "DATA", folder))
        for module in (web, worker):
            scope.enter_context(patch.object(module, "settings", return_value={"MAIL_MODE": "gmail"}))
        smtp = scope.enter_context(patch.object(mailing.smtplib, "SMTP_SSL"))
        self.smtp = smtp.return_value
        self.smtp.__enter__.return_value = self.smtp
        self.api = TestClient(web.app, base_url="http://127.0.0.1", headers={"X-Award-Client": "staff"})
        scope.callback(self.api.close)
        mailing.save_gmail(self.account)
        db.initialize()
        with db.database(True) as con:
            con.execute("INSERT INTO teams(id,event,name,current) VALUES('team','wave','시험팀','sub')")
            con.execute("""INSERT INTO submissions(id,team,version,files,digest,state,job,created,updated)
                           VALUES('sub','team',1,'[]','digest','polling','job_offline',0,0)""")

    def connect(self):
        return self.api.post("/api/settings/gmail/connect", json={"app_password": self.password})

    def verdict(self, label):
        def reply(request):
            return httpx.Response(200, json={"id":"job_offline","status":"completed"})
        result = {"verdict":label, "rep":"", "team_name":"시험팀", "issues":["account"], "members":[]}
        with db.database() as con:
            submission = db.row(con, "SELECT * FROM submissions")
        with patch.object(studio, "client", return_value=httpx.Client(
                base_url="https://studio.invalid", transport=httpx.MockTransport(reply))), \
                patch.object(studio, "parse_result", return_value=result):
            worker.run_studio(submission)

    def test_connect_only_after_google_auth_and_never_send_during_setup(self):
        self.smtp.login.side_effect = smtplib.SMTPAuthenticationError(535, b"rejected")
        self.assertEqual(422, self.connect().status_code)
        self.assertFalse(self.api.get("/api/dashboard").json()["mail_ready"])
        self.smtp.login.side_effect = None
        self.assertEqual(200, self.connect().status_code)
        dashboard = self.api.get("/api/dashboard").json()
        self.assertTrue(dashboard["mail_ready"])
        self.assertEqual(self.account, dashboard["gmail_account"])
        self.assertNotIn(self.password, (db.DATA / "gmail.json").read_text())
        self.assertNotIn("credential", json.dumps(dashboard))
        self.smtp.send_message.assert_not_called()

    def test_missing_team_address_does_not_hold_admin_or_duplicate_either_message(self):
        self.verdict("재제출요청")
        self.verdict("재제출요청")
        loop = worker.Worker()
        self.assertFalse(loop.step())
        self.assertEqual(200, self.connect().status_code)
        self.assertTrue(loop.step())
        self.assertEqual([self.account], self.smtp.send_message.call_args.kwargs["to_addrs"])
        self.assertFalse(loop.step())
        leader = "leader+award@naver.com"
        self.assertEqual(200, self.api.put("/api/teams/team/email", json={"email":leader}).status_code)
        self.assertTrue(loop.step())
        msg = self.smtp.send_message.call_args.args[0]
        self.assertEqual(self.account, str(msg["From"]))
        self.assertEqual(leader, str(msg["To"]))
        self.assertIsNone(msg["Cc"])
        self.assertIn(studio.ISSUES["account"], msg.get_content())
        self.assertFalse(loop.step())
        self.assertEqual(2, self.smtp.send_message.call_count)
        self.smtp.login.assert_called_with(self.account, self.password)

    def test_uncertain_result_waits_for_human_and_uses_selected_item(self):
        self.assertEqual(200, self.connect().status_code)
        self.assertEqual(200, self.api.put("/api/teams/team/email", json={"email":"rep@dept.school.ac.kr"}).status_code)
        self.verdict("담당자확인")
        loop = worker.Worker()
        self.assertTrue(loop.step())
        self.assertFalse(loop.step())
        self.assertEqual([self.account], self.smtp.send_message.call_args.kwargs["to_addrs"])
        body = {"revision":0,"decision":"보완 필요","note":"원본 대조","members":[],"recipient":{},"issues":["identity"]}
        self.assertEqual(200, self.api.put("/api/submissions/sub/review", json=body).status_code)
        self.assertTrue(loop.step())
        msg = self.smtp.send_message.call_args.args[0]
        self.assertEqual("rep@dept.school.ac.kr", str(msg["To"]))
        self.assertIn(studio.ISSUES["identity"], msg.get_content())
        self.assertNotIn(studio.ISSUES["account"], msg.get_content())

    def test_accepts_one_mailbox_independently_of_provider(self):
        for address in ("a+team@daum.net", "o'hara@school.edu", "팀장@한글.한국"):
            with self.subTest(address=address):
                self.assertEqual(200, self.api.put("/api/teams/team/email", json={"email":address}).status_code)
        for invalid in ("no-at-sign", "a@b.com, c@d.com", "a@b.com\r\nBcc:other@b.com", "student@@school.kr"):
            with self.subTest(invalid=invalid):
                self.assertEqual(422, self.api.put("/api/teams/team/email", json={"email":invalid}).status_code)

    def test_gmail_wire_format_for_korean_subject_and_international_address(self):
        subject = "[시상금 서류 보완 요청] 메일 수신 테스트팀"
        body = "전체 팀원의 개인정보 동의서를 확인해 주세요."
        for address in ("leader@example.org", mailing.mailbox_address("팀장@한글.한국")):
            with self.subTest(address=address):
                msg = EmailMessage()
                msg["From"], msg["To"], msg["Subject"] = self.account, address, subject
                msg.set_content(body)
                client = Mock()
                gmail_oauth.send_message(client, "mock-token", msg)
                wire = base64.urlsafe_b64decode(client.post.call_args.kwargs["json"]["raw"])
                received = BytesParser(policy=policy.default).parsebytes(wire)
                raw_subject = dict(received.raw_items())["Subject"]
                self.assertTrue(raw_subject.isascii())
                self.assertIn("=?utf-8?", raw_subject.lower())
                self.assertEqual(subject, str(received["Subject"]))
                self.assertIn(b"To: " + address.encode("utf-8") + b"\r\n", wire)
                self.assertEqual(body, received.get_content().strip())

    def start_oauth(self):
        client = {"web":{"client_id":"unit.apps.googleusercontent.com", "client_secret":"mock-client-secret",
                         "redirect_uris":["http://127.0.0.1" + gmail_oauth.CALLBACK]}}
        response = self.api.post("/api/settings/gmail/oauth/start", json={"client_json":json.dumps(client)})
        self.assertEqual(200, response.status_code)
        url = urlsplit(response.json()["url"])
        self.assertEqual("accounts.google.com", url.hostname)
        return {k:v[0] for k,v in parse_qs(url.query).items()}

    def test_oauth_account_binding_offline_send_and_revocation(self):
        self.verdict("재제출요청")
        before = self.start_oauth()
        self.assertEqual({"openid","email",gmail_oauth.SEND_SCOPE}, set(before["scope"].split()))
        verified_account = "wrong@example.org"
        revoked = False
        sent = []

        def google(req):
            if str(req.url) == gmail_oauth.TOKEN:
                form = parse_qs(req.content.decode())
                if form["grant_type"] == ["authorization_code"]:
                    challenge = base64.urlsafe_b64encode(hashlib.sha256(form["code_verifier"][0].encode()).digest())
                    self.assertEqual(before["code_challenge"], challenge.rstrip(b"=").decode())
                    return httpx.Response(200, json={"refresh_token":"mock-refresh-token", "access_token":"initial",
                                                    "scope":gmail_oauth.SEND_SCOPE})
                self.assertEqual(["mock-refresh-token"], form["refresh_token"])
                if revoked:
                    return httpx.Response(400, json={"error":"invalid_grant"})
                return httpx.Response(200, json={"access_token":"new-access"})
            if str(req.url) == gmail_oauth.USERINFO:
                self.assertEqual("Bearer initial", req.headers["Authorization"])
                return httpx.Response(200, json={"email":verified_account,"email_verified":True})
            self.assertEqual(gmail_oauth.SEND, str(req.url))
            self.assertEqual("Bearer new-access", req.headers["Authorization"])
            sent.append(BytesParser(policy=policy.default).parsebytes(base64.urlsafe_b64decode(json.loads(req.content)["raw"])))
            return httpx.Response(200, json={"id":"mock-message"})

        real_client = httpx.Client
        with patch.object(httpx, "Client", side_effect=lambda **kw: real_client(transport=httpx.MockTransport(google), **kw)):
            def callback():
                return self.api.get(gmail_oauth.CALLBACK, params={"code":"offline","state":before["state"]}, follow_redirects=False)
            self.assertEqual(400, callback().status_code)
            self.assertFalse(self.api.get("/api/dashboard").json()["mail_ready"])
            before = self.start_oauth()
            verified_account = self.account
            self.assertEqual(303, callback().status_code)
            self.assertEqual(400, callback().status_code)
            self.assertNotIn("mock-refresh-token", (db.DATA / "gmail.json").read_text())
            self.assertNotIn("mock-client-secret", (db.DATA / "gmail.json").read_text())
            self.assertEqual([], sent)
            loop = worker.Worker()
            self.assertTrue(loop.step())
            self.assertEqual([self.account], [str(msg["To"]) for msg in sent])
            self.assertEqual(200, self.api.put("/api/teams/team/email",json={"email":"leader@naver.com"}).status_code)
            revoked = True
            self.assertTrue(loop.step())
            self.assertFalse(self.api.get("/api/dashboard").json()["mail_ready"])
            self.assertFalse(loop.step())
            self.assertEqual(1, len(sent))
            self.smtp.send_message.assert_not_called()

    def test_oauth_requires_the_initiating_browser(self):
        attempt = self.start_oauth()
        self.api.cookies.clear()
        with patch.object(httpx, "Client", side_effect=AssertionError("unexpected Google call")):
            response = self.api.get(gmail_oauth.CALLBACK, params={"state":attempt["state"],"code":"fake"})
        self.assertEqual(400, response.status_code)
        self.assertFalse(self.api.get("/api/dashboard").json()["mail_ready"])
