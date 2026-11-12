"""Real HTTP/SQL contract checks on a newly created, isolated localhost database."""
import hashlib
import argparse
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import time
from unittest.mock import patch
from uuid import uuid4

import httpx
import psycopg
from psycopg import sql
from psycopg.rows import dict_row
from pypdf import PdfWriter

ROOT=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--jar',type=Path)
parser.add_argument('--port',type=int,default=18885)
parser.add_argument('--keep-server',action='store_true')
args=parser.parse_args()
if args.port<1024 or args.port>65535:raise ValueError('Use a local unprivileged port')
OUT=ROOT/'var/pc-connector-test'/('port-'+str(args.port))
os.environ['AWARD_DATA_DIR']=str(OUT/'data')
sys.path.insert(0,str(ROOT))
from operations.preparation import prepare
from tests.test_intake_postgres import login

URL='http://127.0.0.1:'+str(args.port)
checks=[]

def check(value,label):
    if not value:raise AssertionError(label)
    checks.append(label)

def run():
    OUT.mkdir(parents=True,exist_ok=True)
    with socket.socket() as probe:
        if probe.connect_ex(('127.0.0.1',args.port))==0:raise RuntimeError('Test port is already in use')
    password=(ROOT/'var/intake-postgres.key').read_text().strip()
    database='swax_pc_connector_'+uuid4().hex[:12]
    master={'host':'127.0.0.1','port':55432,'user':'swax','password':password,'autocommit':True}
    with psycopg.connect(dbname='postgres',**master) as db:
        db.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(database)))
    internal=secrets.token_hex(32)
    legacy=secrets.token_hex(32)
    environment={key:value for key,value in os.environ.items() if not key.startswith(('AWS_','AWARDS_','UPSTAGE_','GMAIL_','SMTP_'))}
    environment.update(AWARDS_DB_URL='jdbc:postgresql://127.0.0.1:55432/'+database,AWARDS_DB_USER='swax',
        AWARDS_DB_PASSWORD=password,AWARDS_REVIEW_WORKER_TOKEN=internal,AWARDS_OUTPUT_WORKER_TOKEN=legacy,
        AWARDS_PC_ENABLED='true',AWARDS_WORKER_MANAGED='true',AWARDS_REMOTE_PRINTER='true',
        AWARDS_PC_INSTALLER=str(ROOT/'var/pc-connector-build/dist/SWAX-PC-Setup.exe'),AWARD_DATA_DIR=str(OUT/'data'))
    jar=args.jar or Path(json.loads((ROOT/'var/pc-connector-build/backend-stage.json').read_text(encoding='utf-8'))['jar'])
    with (OUT/'api.out').open('wb') as out,(OUT/'api.err').open('wb') as err:
        api_process=subprocess.Popen([r'C:\Program Files\Java\jdk-21\bin\java.exe','-Xmx768m','-Dfile.encoding=UTF-8',
            '-jar',str(jar),'--server.port='+str(args.port)],cwd=ROOT,env=environment,stdout=out,stderr=err,creationflags=subprocess.CREATE_NO_WINDOW)
    state={'url':URL,'database':database,'pid':api_process.pid,'fixture_accounts':['pc-fixture-a','pc-fixture-b']}
    (OUT/'server.json').write_text(json.dumps(state,indent=2),encoding='utf-8')
    db=psycopg.connect(dbname=database,**master,row_factory=dict_row)
    try:
        for _ in range(80):
            if api_process.poll() is not None:raise RuntimeError('Isolated API exited; inspect its local log')
            try:
                if httpx.get(URL+'/actuator/health',timeout=2,trust_env=False).status_code==200:break
            except httpx.HTTPError:pass
            time.sleep(1)
        else:raise TimeoutError('Isolated API did not start')
        db.execute('CREATE EXTENSION IF NOT EXISTS pgcrypto')
        for who in state['fixture_accounts']:
            db.execute("INSERT INTO staff_account(login,password_hash) VALUES(%s,crypt('9999',gen_salt('bf',10)))",(who,))
        with httpx.Client(base_url=URL,timeout=30,trust_env=False) as a,httpx.Client(base_url=URL,timeout=30,trust_env=False) as b:
            login(a,'pc-fixture-a','9999');login(b,'pc-fixture-b','9999')
            browser_a,browser_b=str(uuid4()),str(uuid4())
            check(a.get('/api/pc-connections',params={'browser':browser_a}).json()['device']=={},'new browser has no installed-device assertion')
            with httpx.Client(base_url=URL,trust_env=False) as anonymous:
                check(anonymous.get('/api/pc-connections',params={'browser':browser_a}).status_code==401,'status requires a web session')
                check(anonymous.post('/api/pc-agent/claim').status_code==401,'claim requires device authentication')
            no_csrf=httpx.Client(base_url=URL,trust_env=False,cookies=a.cookies)
            check(no_csrf.post('/api/pc-connections/pair',json={'browser_id':browser_a}).status_code==403,'pairing requires CSRF protection')
            no_csrf.close()
            def pair(web,browser):
                code=web.post('/api/pc-connections/pair',json={'browser_id':browser}).raise_for_status().json()['code']
                result=httpx.post(URL+'/api/pc-agent/exchange',json={'code':code,'name':'Fixture PC','version':'1.0.0'},trust_env=False)
                result.raise_for_status()
                check(httpx.post(URL+'/api/pc-agent/exchange',json={'code':code,'name':'Replay','version':'1.0.0'},trust_env=False).status_code==401,'pairing code is single-use')
                record=result.json()
                client=httpx.Client(base_url=URL,headers={'Authorization':'Bearer '+record['token']},timeout=30,trust_env=False)
                client.put('/api/pc-agent/heartbeat',json={'hancom_ready':True,'version':'1.0.0'}).raise_for_status()
                return client,record
            pc_a,cred_a=pair(a,browser_a);pc_b,cred_b=pair(b,browser_b)
            expired=a.post('/api/pc-connections/pair',json={'browser_id':str(uuid4())}).raise_for_status().json()['code']
            db.execute("UPDATE pc_pairing SET expires_at=clock_timestamp()-interval '1 second' WHERE code_hash=%s",(hashlib.sha256(expired.encode()).digest(),))
            check(httpx.post(URL+'/api/pc-agent/exchange',json={'code':expired,'name':'Expired','version':'1.0.0'},trust_env=False).status_code==401,'expired pairing code cannot register a device')
            check(db.execute('SELECT token_hash FROM pc_device WHERE id=%s',(cred_a['device_id'],)).fetchone()['token_hash']==hashlib.sha256(cred_a['token'].encode()).digest(),'device credentials are stored only as hashes')
            check(pc_a.get('/api/events').status_code==401,'device credential cannot become a web session')
            check(pc_a.post('/api/worker/output/claim',json={'worker_id':'untrusted'}).status_code==401,'device credential cannot use the global printer API')
            check(a.post('/api/pc-agent/claim').status_code==401,'web session cannot impersonate a PC bearer')
            check(httpx.post(URL+'/api/worker/output/claim',json={'worker_id':'legacy'},headers={'Authorization':'Bearer '+legacy},trust_env=False).status_code==401,'global output credential is disabled in per-user mode')
            event=a.post('/api/events',json={'name':'PC contract '+uuid4().hex[:8]}).raise_for_status().json()['id']
            db.execute('INSERT INTO event_staff(event_id,login) VALUES(%s,%s)',(event,'pc-fixture-b'))
            def upload(web,name):
                raw=('synthetic '+name).encode()
                response=web.post('/api/intake-batches',data={'event':event,'mode':'bundle','manifest':json.dumps([{'name':name,'size':len(raw)}])},
                    files=[('files',(name,raw))],headers={'Idempotency-Key':str(uuid4())}).raise_for_status().json()
                details=web.get(response['status_url']).raise_for_status().json()
                return response['batch_id'],details['files'][0]['item_id']
            batch_b,file_b=upload(b,'peer.hwp')
            batch_a,file_a=upload(a,'mine.hwp')
            task=pc_a.post('/api/pc-agent/claim').raise_for_status().json()
            check(task['id']==file_a,'A receives its own file even when B has an older file in the same accessible event')
            route='/api/pc-agent/file/'+file_a
            headers={'X-Claim-Token':task['claim_token']}
            for method,suffix,body in [('GET','input',None),('PUT','lease',None),('PUT','failure',None),('PUT','metadata',{})]:
                check(pc_b.request(method,route+'/'+suffix,headers=headers,json=body).status_code==404,'B cannot access A '+suffix)
            check(pc_b.put(route+'/pdf',content=b'%PDF-invalid',headers={**headers,'X-Source-Sha256':task['sha256'],'Content-Type':'application/pdf'}).status_code==404,'B cannot submit A output')
            check(pc_a.get(route+'/input',headers=headers).raise_for_status().content==b'synthetic mine.hwp','claimed input is byte-identical')
            check(pc_a.put(route+'/metadata',json={},headers=headers).status_code==422,'invalid analysis metadata is rejected')
            pc_a.put(route+'/lease',headers=headers).raise_for_status()
            db.execute("UPDATE pc_file_conversion SET lease_until=clock_timestamp()-interval '1 second' WHERE file_id=%s",(file_a,))
            pc_a2,cred_a2=pair(a,str(uuid4()))
            renewed=pc_a2.post('/api/pc-agent/claim').raise_for_status().json()
            check(renewed['id']==file_a and renewed['claim_token']!=task['claim_token'],'expired work can be recovered by another PC of the same account')
            check(pc_a.get(route+'/input',headers=headers).status_code==404,'stale device and lease cannot download input')
            headers={'X-Claim-Token':renewed['claim_token']}
            metadata={'kind':'?','pages':1,'signals':{'apps':[],'consent':[],'body':'','identity':'','mixed':False,'page':1}}
            pc_a2.put(route+'/metadata',json=metadata,headers=headers).raise_for_status()
            document=BytesIO();writer=PdfWriter();writer.add_blank_page(width=595,height=842);writer.write(document);pdf=document.getvalue()
            complete_headers={**headers,'Content-Type':'application/pdf','X-Source-Sha256':renewed['sha256']}
            check(pc_a2.put(route+'/pdf',content=pdf,headers={**complete_headers,'X-Source-Sha256':'wrong'}).status_code==409,'output must match the immutable source digest')
            pc_a2.put(route+'/pdf',content=pdf,headers=complete_headers).raise_for_status()
            check(pc_a2.put(route+'/pdf',content=pdf,headers=complete_headers).status_code==204,'completion replay is idempotent')
            check(pc_a2.post('/api/pc-agent/claim').status_code==204,'A does not claim B work even with access to the same event')
            with patch.dict(os.environ,{'AWARDS_PC_ENABLED':'true'}),httpx.Client(base_url=URL+'/api/worker/',headers={'Authorization':'Bearer '+internal},trust_env=False) as worker:
                for _ in range(5):
                    if not prepare(db,worker):break
            state_a=db.execute('SELECT state FROM intake_preparation WHERE batch_id=%s',(batch_a,)).fetchone()['state']
            state_b=db.execute('SELECT state FROM intake_preparation WHERE batch_id=%s',(batch_b,)).fetchone()['state']
            check(state_a=='prepared' and state_b=='pending','offline B does not block server preparation and confirmation for A')
            report=db.execute("INSERT INTO award_report(event_id,version,created_by,selection,snapshot,state,hwpx) VALUES(%s,1,'pc-fixture-b','{}','{}','printing',%s) RETURNING id",(event,b'fixture report')).fetchone()['id']
            check(pc_a2.post('/api/pc-agent/claim').status_code==204,'A cannot claim B report')
            b_task=pc_b.post('/api/pc-agent/claim').raise_for_status().json()
            check(b_task['id']==file_b,'B claims its own pending file')
            pc_b.put('/api/pc-agent/file/'+file_b+'/failure',headers={'X-Claim-Token':b_task['claim_token']}).raise_for_status()
            b.post('/api/intake-batches/'+batch_b+'/files/'+file_b+'/retry').raise_for_status()
            retried=pc_b.post('/api/pc-agent/claim').raise_for_status().json()
            check(retried['kind']=='file' and retried['id']==file_b and retried['claim_token']!=b_task['claim_token'],
                  'manual retry after a failed conversion receives a fresh PC claim')
            retried_route='/api/pc-agent/file/'+file_b
            retried_headers={'X-Claim-Token':retried['claim_token']}
            pc_b.put(retried_route+'/metadata',json=metadata,headers=retried_headers).raise_for_status()
            pc_b.put(retried_route+'/pdf',content=pdf,headers={**retried_headers,'Content-Type':'application/pdf','X-Source-Sha256':retried['sha256']}).raise_for_status()
            b_report=pc_b.post('/api/pc-agent/claim').raise_for_status().json()
            check(b_report['kind']=='report' and b_report['id']==str(report),'B claims its own report after its files')
            report_route='/api/pc-agent/report/'+str(report)
            report_headers={'X-Claim-Token':b_report['claim_token']}
            check(pc_a2.get(report_route+'/input',headers=report_headers).status_code==404,'A cannot download B report even with a leaked claim token')
            check(pc_b.get(report_route+'/input',headers=report_headers).raise_for_status().content==b'fixture report','report download is scoped and byte-identical')
            pc_b.put(report_route+'/pdf',content=pdf,headers={**report_headers,'Content-Type':'application/pdf','X-Source-Sha256':b_report['sha256']}).raise_for_status()
            check(db.execute('SELECT state FROM award_report WHERE id=%s',(report,)).fetchone()['state']=='verifying','report PDF enters the existing evidence-verification queue')
            def finish_file(task,pc=pc_a2):
                route='/api/pc-agent/file/'+task['id'];headers={'X-Claim-Token':task['claim_token']}
                pc.put(route+'/metadata',json=metadata,headers=headers).raise_for_status()
                pc.put(route+'/pdf',content=pdf,headers={**headers,'Content-Type':'application/pdf','X-Source-Sha256':task['sha256']}).raise_for_status()
            def claim_file(pc):
                for _ in range(100):
                    response=pc.post('/api/pc-agent/claim').raise_for_status()
                    if response.status_code==200:return response.json()
                    check(response.status_code==204,'a contested claim returns no work')
                    time.sleep(0.02)
                raise TimeoutError('A PC did not receive its independent pending file')
            for attempt in range(20):
                upload(a,'parallel-one-'+str(attempt)+'.hwp');upload(a,'parallel-two-'+str(attempt)+'.hwp')
                for pc in (pc_a,pc_a2):pc.put('/api/pc-agent/heartbeat',json={'hancom_ready':True,'version':'1.1.0'}).raise_for_status()
                with ThreadPoolExecutor(max_workers=2) as pool:
                    concurrent=list(pool.map(claim_file,(pc_a,pc_a2)))
                check(len({task['id'] for task in concurrent})==2,'two PCs receive different files concurrently: '+str(attempt))
                for pc,task in zip((pc_a,pc_a2),concurrent):finish_file(task,pc)
            for slot in (-1,2):
                check(pc_a2.post('/api/pc-agent/claim',json={'slot':slot}).status_code==422,'slot outside the two-worker limit is rejected: '+str(slot))
            upload(a,'slot-zero.hwp');upload(a,'slot-one.hwp')
            with ThreadPoolExecutor(max_workers=2) as pool:
                slots=list(pool.map(lambda slot:pc_a2.post('/api/pc-agent/claim',json={'slot':slot}).raise_for_status().json(),(0,1)))
            check(len({t['id'] for t in slots})==2,'same PC receives different files in two concurrent slots')
            check({r['worker_slot'] for r in db.execute('SELECT worker_slot FROM pc_file_conversion WHERE file_id=ANY(%s::uuid[])',([t['id'] for t in slots],))}=={0,1},'slot ownership is durable in PostgreSQL')
            for slot,task in enumerate(slots):
                resumed=pc_a2.post('/api/pc-agent/claim',json={'slot':slot}).raise_for_status().json()
                check(resumed==task,'a repeated slot claim resumes exactly its own file: '+str(slot))
            check(pc_a2.post('/api/pc-agent/claim').json()==slots[0],'old clients without a slot still resume slot zero')
            finish_file(slots[0])
            report_zero=db.execute("INSERT INTO award_report(event_id,version,created_by,selection,snapshot,state,hwpx) VALUES(%s,2,'pc-fixture-a','{}','{}','printing',%s) RETURNING id",(event,b'first parallel report')).fetchone()['id']
            first_report=pc_a2.post('/api/pc-agent/claim',json={'slot':0}).raise_for_status().json()
            check(first_report['kind']=='report' and first_report['id']==str(report_zero),'report printing can start while the other slot converts a file')
            check(pc_a2.post('/api/pc-agent/claim',json={'slot':1}).json()==slots[1],'report printing does not replace the other slot file')
            old=slots[1]
            db.execute("UPDATE pc_file_conversion SET lease_until=clock_timestamp()-interval '1 second' WHERE file_id=%s",(old['id'],))
            slots[1]=pc_a2.post('/api/pc-agent/claim',json={'slot':1}).raise_for_status().json()
            check(slots[1]['id']==old['id'] and slots[1]['claim_token']!=old['claim_token'],'expired slot is reclaimed with a fresh token')
            check(pc_a2.get('/api/pc-agent/file/'+old['id']+'/input',headers={'X-Claim-Token':old['claim_token']}).status_code==404,'expired parallel claim is rejected')
            finish_file(slots[1])
            report_one=db.execute("INSERT INTO award_report(event_id,version,created_by,selection,snapshot,state,hwpx) VALUES(%s,3,'pc-fixture-a','{}','{}','printing',%s) RETURNING id",(event,b'second parallel report')).fetchone()['id']
            second_report=pc_a2.post('/api/pc-agent/claim',json={'slot':1}).raise_for_status().json()
            check(second_report['kind']=='report' and second_report['id']==str(report_one),'same PC can print two independent reports')
            check(pc_a2.post('/api/pc-agent/claim',json={'slot':1}).json()==second_report,'slot-one report resumes without a second output job')
            report_route='/api/pc-agent/report/'+second_report['id'];report_headers={'X-Claim-Token':second_report['claim_token']}
            check(pc_b.get(report_route+'/input',headers=report_headers).status_code==404,'another account cannot access a parallel report')
            check(pc_a2.get(report_route+'/input',headers={'X-Claim-Token':first_report['claim_token']}).status_code==404,'parallel report tokens cannot be swapped')
            pc_a2.put('/api/pc-agent/report/'+first_report['id']+'/failure',headers={'X-Claim-Token':first_report['claim_token']}).raise_for_status()
            check(pc_a2.get(report_route+'/input',headers=report_headers).raise_for_status().content==b'second parallel report','failure in one slot does not invalidate the other report')
            pc_a2.put(report_route+'/pdf',content=pdf,headers={**report_headers,'Content-Type':'application/pdf','X-Source-Sha256':second_report['sha256']}).raise_for_status()
            check(db.execute('SELECT state FROM award_report WHERE id=%s',(report_one,)).fetchone()['state']=='verifying','slot-one PDF reaches server evidence verification')
            if (ROOT/'var/pc-connector-build/dist/SWAX-PC-Setup.exe').is_file():
                response=a.get('/api/pc-connections/installer').raise_for_status()
                check(hashlib.sha256(response.content).digest()==hashlib.sha256((ROOT/'var/pc-connector-build/dist/SWAX-PC-Setup.exe').read_bytes()).digest(),'downloaded installer matches the built artifact')
            db.execute("UPDATE pc_device SET seen_at=clock_timestamp()-interval '1 minute' WHERE id=%s",(cred_a['device_id'],))
            offline=a.get('/api/pc-connections',params={'browser':browser_a}).raise_for_status().json()['device']
            check(offline['registered'] and not offline['online'],'offline installed PC keeps its registration')
            check(a.get('/api/pc-connections',params={'browser':browser_b}).json()['device']=={},'device registration is scoped to account and browser')
            check(b.delete('/api/pc-connections/'+cred_a['device_id']).status_code==404,'another account cannot revoke a PC')
            a.delete('/api/pc-connections/'+cred_a['device_id']).raise_for_status()
            check(pc_a.post('/api/pc-agent/claim').status_code==401,'revocation invalidates the device immediately')
            for client in (pc_a,pc_a2,pc_b):client.close()
        result={'checks':len(checks),'passed':checks,'server':state,'production_data_changed':False}
        (OUT/'result.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
        print(json.dumps(result))
    finally:
        db.close()
        if not args.keep_server:
            api_process.terminate();api_process.wait(timeout=15)
            with psycopg.connect(dbname='postgres',**master) as admin:
                if not database.startswith('swax_pc_connector_'):raise RuntimeError('Unexpected test database')
                admin.execute(sql.SQL('DROP DATABASE {}').format(sql.Identifier(database)))

if __name__=='__main__':run()
