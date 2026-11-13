"""Verify staff Gmail isolation, a V9 upgrade and delivery routing without sending mail."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import time
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit
from uuid import uuid4

import httpx
import psycopg
from psycopg import sql
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT/'var/gmail-staff-20261113'/('integration-'+uuid4().hex[:8])
OUT.mkdir(parents=True)
os.environ['AWARD_DATA_DIR'] = str(OUT/'data')
sys.path.insert(0, str(ROOT))
from operations.delivery import deliver
from service.mailing import protect_secret, read_secret
from tests.test_intake_postgres import login

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--jar', type=Path, required=True)
parser.add_argument('--baseline', type=Path, required=True)
args = parser.parse_args()
checks = []

def check(value, label):
    if not value: raise AssertionError(label)
    checks.append(label)

with socket.socket() as probe:
    probe.bind(('127.0.0.1', 0))
    port = probe.getsockname()[1]
URL = 'http://127.0.0.1:'+str(port)
name = 'swax_staff_gmail_'+uuid4().hex[:12]
master = dict(host='127.0.0.1', port=55432, user='swax', password=(ROOT/'var/intake-postgres.key').read_text().strip(), autocommit=True)
environment = {k:v for k,v in os.environ.items() if not k.startswith(('AWS_', 'AWARDS_', 'UPSTAGE_', 'GMAIL_', 'SMTP_'))}
client_file = OUT/'client.json'
client_file.write_text(json.dumps({'web': {'client_id': 'fixture.apps.googleusercontent.com', 'client_secret': 'fixture-secret'}}), encoding='utf-8')
environment.update(AWARDS_DB_URL='jdbc:postgresql://127.0.0.1:55432/'+name, AWARDS_DB_USER='swax',
    AWARDS_DB_PASSWORD=master['password'], AWARDS_REVIEW_WORKER_TOKEN=secrets.token_hex(32), MAIL_MODE='gmail',
    GMAIL_ADDRESS='legacy@example.test', AWARDS_GMAIL_CLIENT_FILE=str(client_file),
    AWARDS_GMAIL_REDIRECT_URI=URL+'/api/settings/gmail/callback')
data = OUT/'data'
data.mkdir()
legacy = data/'gmail.json'
legacy.write_text(json.dumps({'address': 'legacy@example.test', 'credential': protect_secret('legacy-fixture-password'), 'oauth': ''}), encoding='utf-8')
legacy_hash = hashlib.sha256(legacy.read_bytes()).hexdigest()
process = None
db = None

def stop():
    global process
    if process and process.poll() is None:
        process.terminate(); process.wait(timeout=20)

def start(jar, label):
    global process
    with (OUT/(label+'.out')).open('wb') as out, (OUT/(label+'.err')).open('wb') as err:
        process = subprocess.Popen([r'C:\Program Files\Java\jdk-21\bin\java.exe', '-Xmx512m', '-Dfile.encoding=UTF-8',
            '-jar', str(jar.resolve()), '--server.port='+str(port)], cwd=ROOT, env=environment,
            stdout=out, stderr=err, creationflags=subprocess.CREATE_NO_WINDOW)
    for _ in range(80):
        if process.poll() is not None: raise RuntimeError('Isolated API exited: '+label)
        try:
            if httpx.get(URL+'/actuator/health', timeout=2, trust_env=False).status_code == 200: return
        except httpx.HTTPError: pass
        time.sleep(1)
    raise TimeoutError('Isolated API did not start: '+label)

def profile(who, address, connected=True):
    credential = protect_secret(who+'-fixture-password') if connected else ''
    db.execute('''INSERT INTO staff_gmail(login,address,credential) VALUES(%s,%s,%s)
        ON CONFLICT(login) DO UPDATE SET address=excluded.address,credential=excluded.credential,oauth='',generation=staff_gmail.generation+1''',
        (who,address,credential))

def notice():
    team,batch,sid = [uuid4() for _ in range(3)]
    team_name = 'fixture-'+str(team)[:8]
    db.execute('INSERT INTO award_team(id,event_id,name,email) VALUES(%s,%s,%s,%s)', (team,event,team_name,'leader@example.test'))
    db.execute('INSERT INTO intake_batch(id,event_id,request_key,fingerprint) VALUES(%s,%s,%s,%s)', (batch,event,str(uuid4()),'0'*64))
    db.execute("INSERT INTO team_submission(id,team_id,version,digest,confirmed_by) VALUES(%s,%s,1,%s,'gmail-a')", (sid,team,'0'*64))
    db.execute("INSERT INTO intake_team_confirmation VALUES(%s,%s,%s,'confirmed')", (batch,team,sid))
    db.execute('UPDATE award_team SET email_confirmed_submission=%s WHERE id=%s', (sid,team))
    db.execute("UPDATE review_job SET work_state='done',finished_at=now(),result=%s WHERE submission_id=%s",
        (Jsonb({'verdict':'보완필요','output':{'team_name':team_name}}),sid))
    return str(db.execute('SELECT id FROM review_mail WHERE submission_id=%s',(sid,)).fetchone()['id'])

def draft(web, mid):
    return web.get('/api/mail/'+mid).raise_for_status().json()

def approve(web, mid, form=None):
    body = form or draft(web,mid)
    return web.post('/api/mail/'+mid+'/approve',json={key:body.get(key) for key in ('revision','subject','body','recipient','sender_address')}
                    | {'subject':'보완 안내','body':'신청서의 학번을 확인하고 다시 제출해 주세요.'})

cfg = {'MAIL_MODE':'gmail', 'GMAIL_ADDRESS':'must-never-be-used@example.test'}
sent = []
def capture(message, settings, path):
    check(str(message['From']) == settings['SMTP_USER'], 'sender header and authentication account match')
    sent.append(settings['SMTP_USER'])
    return 'sent'

with psycopg.connect(dbname='postgres', **master) as admin:
    admin.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(name)))
try:
    start(args.baseline, 'before-upgrade')
    db = psycopg.connect(dbname=name, **master, row_factory=dict_row)
    db.execute('CREATE EXTENSION IF NOT EXISTS pgcrypto')
    for who in ('gmail-a','gmail-b'):
        db.execute("INSERT INTO staff_account(login,password_hash) VALUES(%s,crypt('fixture-password',gen_salt('bf',10)))",(who,))
    event = uuid4()
    db.execute('INSERT INTO award_event(id,name) VALUES(%s,%s)',(event,'Gmail isolated fixture'))
    for who in ('gmail-a','gmail-b'): db.execute('INSERT INTO event_staff VALUES(%s,%s)',(event,who))
    stop(); start(args.jar,'after-upgrade')
    check(db.execute("SELECT count(*) AS n FROM staff_account WHERE login IN ('gmail-a','gmail-b')").fetchone()['n']==2, 'upgrade preserves existing staff')
    with httpx.Client(base_url=URL,timeout=30,trust_env=False) as a, httpx.Client(base_url=URL,timeout=30,trust_env=False) as b:
        login(a,'gmail-a','fixture-password'); login(b,'gmail-b','fixture-password')
        for web in (a,b):
            state=web.get('/api/settings/gmail').raise_for_status().json()
            check(not state['gmail_account'] and not state['mail_ready'], 'legacy global credentials are not assigned to staff')
        with httpx.Client(base_url=URL,trust_env=False) as anonymous:
            check(anonymous.get('/api/settings/gmail').status_code==401, 'anonymous status rejected')
            check(anonymous.post('/api/settings/gmail/oauth/start').status_code in (401,403), 'anonymous start rejected')
        with httpx.Client(base_url=URL,cookies=a.cookies,trust_env=False) as no_csrf:
            check(no_csrf.post('/api/settings/gmail/disconnect').status_code==403, 'disconnect requires CSRF protection')
        disconnected_notice=notice()
        check(not draft(a,disconnected_notice)['can_approve'] and approve(a,disconnected_notice).status_code==409,
              'mail approval requires the approving staff to connect Gmail')
        profile('gmail-a','a@example.test'); profile('gmail-b','b@example.test')
        b_before=dict(db.execute("SELECT * FROM staff_gmail WHERE login='gmail-b'").fetchone())
        authorization=a.post('/api/settings/gmail/oauth/start',json={'login':'gmail-b'}).raise_for_status().json()['url']
        query=parse_qs(urlsplit(authorization).query)
        check(query['prompt']==['select_account consent'] and query['redirect_uri']==[URL+'/api/settings/gmail/callback'], 'OAuth account picker and callback configured')
        check(query['login_hint']==['a@example.test'], 'request cannot select another staff owner')
        result=b.get('/api/settings/gmail/callback',params={'state':query['state'][0],'error':'access_denied'})
        check(result.headers['location'].endswith('result=expired'), 'another staff session cannot consume callback')
        result=a.get('/api/settings/gmail/callback',params={'state':query['state'][0],'error':'access_denied'})
        check(result.headers['location'].endswith('result=cancelled'), 'cancelled account change preserves connection')
        check(dict(db.execute("SELECT * FROM staff_gmail WHERE login='gmail-b'").fetchone())==b_before, 'other staff token unchanged')
        check(a.post('/api/settings/gmail/connect',json={'address':'bad\r\naddress','app_password':'abcdefghijklmnop'}).status_code==422, 'invalid sender rejected before authentication')
        mail_a,mail_b=notice(),notice()
        check(approve(a,mail_a).status_code==200, 'staff A can approve with own connected sender')
        check(approve(b,mail_b).status_code==200, 'staff B can approve with own connected sender')
        check(a.post('/api/settings/gmail/disconnect').raise_for_status().json()['mail_ready'] is False, 'app password disconnect supported')
        db.execute("INSERT INTO workflow_health(role,configured,mail_mode) VALUES('mail',true,'gmail')")
        check(a.get('/api/dashboard',params={'event':str(event)}).json()['mail_ready'] is False, 'global heartbeat cannot mark disconnected staff ready')
        check(b.get('/api/dashboard',params={'event':str(event)}).json()['gmail_account']=='b@example.test', 'dashboard shows only current staff sender')
        with patch('operations.delivery.send',side_effect=capture):
            check(deliver(db,cfg), 'connected staff is not blocked by another staff waiting mail')
            check(sent==['b@example.test'], 'mail approved by B uses only B credentials')
            check(not deliver(db,cfg), 'disconnected staff mail does not send')
            profile('gmail-a','a@example.test')
            check(deliver(db,cfg) and sent[-1]=='a@example.test', 'same sender reconnection resumes only its approved mail')
            pending=notice()
            old_form=draft(a,pending)
            check(approve(a,pending).status_code==200, 'pending mail records the reviewed sender')
            profile('gmail-a','changed@example.test')
            check(not deliver(db,cfg) and draft(a,pending)['state']=='draft', 'sender change returns pending approval to draft')
            check(approve(a,pending,old_form).status_code==409, 'stale sender approval rejected')
            check(approve(a,pending).status_code==200 and deliver(db,cfg) and sent[-1]=='changed@example.test', 'reapproval sends from the new account')
        check(hashlib.sha256(legacy.read_bytes()).hexdigest()==legacy_hash, 'legacy global profile remains untouched')
        expired=notice(); check(approve(a,expired).status_code==200, 'reconnection fixture approved')
        with patch('operations.delivery.send',return_value='waiting'):
            check(deliver(db,cfg), 'expired token pauses its approved message')
        check(a.get('/api/settings/gmail').json()['mail_ready'] is False and b.get('/api/settings/gmail').json()['mail_ready'] is True,
              'expired credential clears only its owner')
        b_secret=db.execute("SELECT credential FROM staff_gmail WHERE login='gmail-b'").fetchone()['credential']
        check('fixture-password' not in b_secret and read_secret(b_secret)=='gmail-b-fixture-password', 'stored secret is DPAPI encrypted and worker-readable')
        stop(); start(args.jar,'restarted')
        login(a,'gmail-a','fixture-password'); login(b,'gmail-b','fixture-password')
        check(b.get('/api/settings/gmail').json()['mail_ready'] is True, 'staff connection survives API restart')
        check(a.get('/api/settings/gmail').json()['gmail_account']=='changed@example.test', 'changed account persists independently')
    result={'passed':True,'checks':checks,'mail_sent':False,'legacy_global_preserved':True,'database_isolated':True}
    (OUT/'result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({'passed':True,'checks':len(checks),'result':str(OUT/'result.json'),'mail_sent':False}))
finally:
    stop()
    if db: db.close()
    with psycopg.connect(dbname='postgres', **master) as admin:
        if not name.startswith('swax_staff_gmail_'): raise RuntimeError('Unexpected test database')
        admin.execute(sql.SQL('DROP DATABASE {} WITH (FORCE)').format(sql.Identifier(name)))
