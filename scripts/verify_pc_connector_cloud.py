"""Approved fictional set01 through the real paired PC, Studio and final HWPX/PDF; no mail/payment execution."""
import argparse
import datetime
import getpass
import hashlib
from io import BytesIO
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
from uuid import uuid4
from zipfile import ZipFile

import httpx
from pypdf import PdfReader

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from pc_connector.agent import connect
from pc_connector.windows import APP_HOME,executable,load_connection
from tests.official_inputs import official_files
from tests.test_intake_postgres import login

BASE='https://d3nkw8bzgv8pom.cloudfront.net'
OUT=ROOT/'var/pc-connector-deployment/e2e'
STATE=OUT/'result.json'
evidence={}

def save():
    STATE.write_text(json.dumps(evidence,ensure_ascii=False,indent=2),encoding='utf-8')

def update_installer(api):
    data=api.get('/api/pc-connections/installer',timeout=120).raise_for_status().content
    expected=json.loads((ROOT/'var/pc-connector-build/dist/manifest.json').read_text())['sha256']
    if hashlib.sha256(data).hexdigest()!=expected:raise RuntimeError('Public installer hash mismatch')
    target=OUT/'SWAX-PC-Setup.exe'
    if target.exists():target.read_bytes()
    target.write_bytes(data)
    installed=executable()
    if not installed.exists() or hashlib.sha256(installed.read_bytes()).hexdigest()!=expected:
        if (APP_HOME/'connection.bin').exists():raise RuntimeError('Do not replace an already-paired test connector during work')
        startup=json.loads((APP_HOME/'startup.json').read_text())
        env=os.environ.copy();env.update(PC_CONNECTOR_TASK=startup['task_name'],PC_CONNECTOR_EXE=str(installed),PC_INSTALLER=str(target))
        code="""$ErrorActionPreference='Stop'
$t=Get-ScheduledTask -TaskName $env:PC_CONNECTOR_TASK
if($t.Actions[0].Execute -ne $env:PC_CONNECTOR_EXE){throw 'Task identity mismatch'}
Disable-ScheduledTask -TaskName $env:PC_CONNECTOR_TASK | Out-Null
Stop-ScheduledTask -TaskName $env:PC_CONNECTOR_TASK
Get-CimInstance Win32_Process -Filter "Name='SWAX-PC.exe'" | Where-Object {$_.ExecutablePath -eq $env:PC_CONNECTOR_EXE} | ForEach-Object {Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue}
$p=Start-Process -FilePath $env:PC_INSTALLER -ArgumentList '--install','--quiet' -WindowStyle Hidden -Wait -PassThru
if($p.ExitCode -ne 0){throw 'Test installation failed'}
"""
        result=subprocess.run(['powershell.exe','-NoProfile','-NonInteractive','-Command',code],env=env,capture_output=True,
            timeout=100,creationflags=subprocess.CREATE_NO_WINDOW)
        if result.returncode:raise RuntimeError('Public installer could not be installed')
    if hashlib.sha256(installed.read_bytes()).hexdigest()!=expected:raise RuntimeError('Installed executable hash mismatch')
    evidence['installer_sha256']=expected

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pair-only',action='store_true')
    args=parser.parse_args()
    OUT.mkdir(parents=True,exist_ok=True)
    if STATE.exists():evidence.update(json.loads(STATE.read_text(encoding='utf-8')))
    else:evidence.update(started_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),browser_id=str(uuid4()),timeline=[])
    save()
    with httpx.Client(base_url=BASE,headers={'Accept':'application/json'},timeout=90,trust_env=False) as api:
        password=getpass.getpass('Demo staff password: ')
        login(api,'staff-a',password);del password
        if args.pair_only:
            update_installer(api)
            previous=load_connection()
            if previous:
                if previous['login']!='staff-a':raise RuntimeError('Do not replace another account connection')
                response=api.delete('/api/pc-agent/connection',headers={'Authorization':'Bearer '+previous['token']})
                if response.status_code not in (204,401):response.raise_for_status()
            pair=api.post('/api/pc-connections/pair',json={'browser_id':evidence['browser_id']}).raise_for_status().json()
            if connect(pair['uri'],approve=lambda account:account=='staff-a')!='staff-a':raise RuntimeError('Unexpected paired account')
            evidence['device_id']=load_connection()['device_id'];save()
            deadline=time.monotonic()+100
            while time.monotonic()<deadline:
                status=api.get('/api/pc-connections',params={'browser':evidence['browser_id']}).raise_for_status().json()
                device=status['device']
                if device.get('online') and device.get('hancom_ready'):
                    evidence.update(device_id=device['id'],paired_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                        packaged_connector_online=True,packaged_hancom_pdf_probe=True)
                    save();print(json.dumps({key:evidence[key] for key in ('device_id','installer_sha256','packaged_connector_online','packaged_hancom_pdf_probe')}),flush=True)
                    return
                time.sleep(3)
            raise TimeoutError('Packaged connector is not ready; inspect its public status file')
        if not evidence.get('packaged_connector_online'):raise RuntimeError('Pair the packaged program first')
        with socket.socket() as check:
            if check.connect_ex(('127.0.0.1',15434))==0:raise RuntimeError('Legacy AWS DB tunnel is still listening')
        evidence['legacy_aws_db_tunnel_closed']=True
        files=official_files('set01')
        if len(files)!=3:raise RuntimeError('Expected three approved originals')
        if not evidence.get('event_id'):
            event=api.post('/api/events',json={'name':'PC 연결 검증 20261112 '+uuid4().hex[:8]}).raise_for_status().json()
            evidence.update(event_id=event['id'],event_name=event['name']);save()
        event=evidence['event_id']
        if not evidence.get('batch_id'):
            history=api.get('/api/intake-batches',params={'event':event}).raise_for_status().json()
            if history:
                if len(history)!=1:raise RuntimeError('Verification event has unexpected receipts')
                evidence['batch_id']=history[0]['batch_id']
            else:
                result=api.post('/api/intake-batches',data={'event':event,'mode':'bundle',
                    'manifest':json.dumps([{'name':name,'size':len(data)} for name,data in files],ensure_ascii=False)},
                    files=[('files',(name,data,'application/octet-stream')) for name,data in files],headers={'Idempotency-Key':str(uuid4())}).raise_for_status().json()
                evidence['batch_id']=result['batch_id']
            evidence.update(files=3,original_bytes=sum(len(data) for _,data in files));save()
        start=time.monotonic();previous=None;submission=None
        while time.monotonic()-start<900:
            dashboard=api.get('/api/dashboard',params={'event':event}).raise_for_status().json()
            submissions=[team['submission'] for team in dashboard['teams'] if team.get('submission')]
            current=[{key:item.get(key) for key in ('id','state','job','verdict','error')} for item in submissions]
            if current!=previous:
                previous=current;evidence['timeline'].append({'seconds':round(time.monotonic()-start,1),'submissions':current});save()
                print(json.dumps({'seconds':round(time.monotonic()-start,1),'submissions':current},ensure_ascii=False),flush=True)
            if submissions and submissions[0]['state']=='done':submission=submissions[0]['id'];break
            if any(item['state'] in ('failed','invalid','paused','access','uncertain','ownership') for item in submissions):
                raise RuntimeError('Studio needs attention; no result was overridden')
            time.sleep(5)
        if not submission:raise TimeoutError('New PC preparation and Studio did not complete')
        evidence['submission_id']=submission
        details=api.get('/api/operations/submissions/'+submission).raise_for_status().json()
        evidence.update(verdict=details['verdict'],studio_job=details['job'])
        if details['verdict']!='성공':raise RuntimeError('Do not approve a non-successful verification result automatically')
        receipt=api.get('/api/intake-batches/'+evidence['batch_id']).raise_for_status().json()
        source_hashes={name:hashlib.sha256(data).hexdigest() for name,data in files}
        checked=0
        for file in receipt['files']:
            raw=api.get('/api/intake-batches/'+evidence['batch_id']+'/files/'+file['item_id']+'/original').raise_for_status().content
            if hashlib.sha256(raw).hexdigest()!=source_hashes[file['name']]:raise RuntimeError('Stored source bytes changed')
            checked+=1
        evidence['original_hashes_verified']=checked
        if details.get('decision')!='승인':
            api.put('/api/submissions/'+submission+'/review',json={'revision':details['revision'],'decision':'승인',
                'note':'가상 set01의 PC 연결·PDF 출력 검증. 실제 지급·메일 발송 없음.',
                'members':details['fields']['members'],'recipient':details['fields']['recipient'],'issues':[]}).raise_for_status()
        details=api.get('/api/operations/submissions/'+submission).raise_for_status().json()
        if not evidence.get('report_id'):
            api.put('/api/submissions/'+submission+'/payment',json={'revision':details['revision'],'award_type':'시연용',
                'support_amount':'0','gross_amount':'0','tax_amount':'0','net_amount':'0'}).raise_for_status()
            report=api.post('/api/reports',json={'event':event,'submissions':[submission]}).raise_for_status().json()
            evidence['report_id']=report['id'];save()
        deadline=time.monotonic()+600;previous=None
        while time.monotonic()<deadline:
            report=api.get('/api/reports/'+evidence['report_id']).raise_for_status().json()
            if report['state']!=previous:
                previous=report['state'];print(json.dumps({'report_state':previous,'error':report.get('error','')},ensure_ascii=False),flush=True)
            if previous in ('preview','confirmed'):break
            if previous=='failed':raise RuntimeError('Report verification failed; inspect its event')
            time.sleep(5)
        else:raise TimeoutError('PC report output did not complete')
        evidence['report_preview_and_evidence_verified']=True
        api.post('/api/reports/'+evidence['report_id']+'/confirm').raise_for_status()
        for kind in ('hwpx','pdf'):
            data=api.get('/api/reports/'+evidence['report_id']+'/'+kind).raise_for_status().content
            (OUT/('report.'+kind)).write_bytes(data)
            evidence[kind]={'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()}
        evidence['pdf']['pages']=len(PdfReader(OUT/'report.pdf').pages)
        with ZipFile(OUT/'report.hwpx') as archive:
            evidence['hwpx']['sections']=len([name for name in archive.namelist() if name.startswith('Contents/section') and name.endswith('.xml')])
        status=api.get('/api/pc-connections',params={'browser':evidence['browser_id']}).raise_for_status().json()
        evidence.update(completed_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),
            connector_online_after_processing=status['device']['online'],actual_mail_sent=False,actual_payment_executed=False)
        save();print(json.dumps(evidence,ensure_ascii=False),flush=True)

if __name__=='__main__':main()
