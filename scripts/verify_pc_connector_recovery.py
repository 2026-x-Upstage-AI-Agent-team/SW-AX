"""Check idle packaged-worker crash recovery and current public configuration without AWS/DB login."""
import datetime
import getpass
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

import httpx

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from pc_connector.windows import APP_HOME,SERVER,executable,load_connection
from tests.test_intake_postgres import login

OUT=ROOT/'var/pc-connector-deployment/e2e'

def powershell(code):
    env=os.environ.copy()
    env['PC_CONNECTOR_EXE']=str(executable())
    env['PC_CONNECTOR_TASK']=json.loads((APP_HOME/'startup.json').read_text())['task_name']
    response=subprocess.run(['powershell.exe','-NoProfile','-NonInteractive','-Command',
        "[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false);$ErrorActionPreference='Stop';"+code],
        env=env,capture_output=True,timeout=25,creationflags=subprocess.CREATE_NO_WINDOW)
    if response.returncode:raise RuntimeError('Scoped connector process check failed')
    return json.loads(response.stdout.decode('utf-8-sig'))

def main():
    case=json.loads((OUT/'result.json').read_text(encoding='utf-8'))
    if not case.get('completed_at'):raise RuntimeError('Finish the document test first')
    credential=load_connection()
    if credential['device_id']!=case['device_id']:raise RuntimeError('Another PC connection is active')
    expected=json.loads((ROOT/'var/pc-connector-build/dist/manifest.json').read_text())['sha256']
    if hashlib.sha256(executable().read_bytes()).hexdigest()!=expected:raise RuntimeError('Installed artifact changed')
    with httpx.Client(base_url=SERVER,timeout=30,trust_env=False) as api:
        password=getpass.getpass('Demo staff password: ')
        login(api,'staff-a',password);del password
        download=api.get('/api/pc-connections/installer',timeout=120).raise_for_status().content
        if hashlib.sha256(download).hexdigest()!=expected:raise RuntimeError('Public installer changed')
        status=api.get('/api/pc-connections',params={'browser':case['browser_id']}).raise_for_status().json()
        if status['pending'] or not status['device']['online']:raise RuntimeError('Wait until this device is idle and connected')
        if any((APP_HOME/'work').iterdir()) or any((APP_HOME/'hancom/jobs').iterdir()):raise RuntimeError('Conversion is in progress')
        result=powershell("""
$t=Get-ScheduledTask -TaskName $env:PC_CONNECTOR_TASK
if($t.Actions[0].Execute -ne $env:PC_CONNECTOR_EXE -or $t.Actions[0].Arguments -ne '--background'){throw 'Task identity mismatch'}
$all=@(Get-CimInstance Win32_Process -Filter "Name='SWAX-PC.exe'" | Where-Object {$_.ExecutablePath -eq $env:PC_CONNECTOR_EXE})
$ids=@($all.ProcessId)
$child=@($all | Where-Object {$_.ParentProcessId -in $ids})
if($child.Count -ne 1){throw 'Expected one packaged worker child'}
$info=[pscustomobject]@{killed_pid=$child[0].ProcessId;task_name=$t.TaskName;task_enabled=$t.Settings.Enabled;
  logon_trigger=@($t.Triggers | ForEach-Object {$_.CimClass.CimClassName});logon_type=[string]$t.Principal.LogonType;
  restart_count=$t.Settings.RestartCount;restart_interval=$t.Settings.RestartInterval;multiple_instances=[string]$t.Settings.MultipleInstances}
Stop-Process -Id $child[0].ProcessId -Force
$info | ConvertTo-Json -Depth 4
""")
        killed_at=time.time()
        print(json.dumps({'worker_crash_simulated':True,'awaiting_scheduled_restart':True}),flush=True)
        deadline=time.monotonic()+110
        while time.monotonic()<deadline:
            state=json.loads((APP_HOME/'status.json').read_text())
            if state['checked_at']>killed_at and state['state']=='connected':
                status=api.get('/api/pc-connections',params={'browser':case['browser_id']}).raise_for_status().json()
                if status['device']['online'] and status['device']['hancom_ready']:break
            time.sleep(3)
        else:raise TimeoutError('Packaged task did not recover automatically')
        dashboard=api.get('/api/dashboard',params={'event':case['event_id']}).raise_for_status().json()
        if str(dashboard['config'])!='5':raise RuntimeError('Unexpected Studio config')
        health=api.get('/actuator/health').raise_for_status().json()
        result.update(automatic_recovery=True,recovery_seconds=round(time.time()-killed_at,1),
            installer_sha256=expected,public_installer_matches=True,
            device_id_unchanged=load_connection()['device_id']==case['device_id'],
            no_aws_or_db_session_used=True,studio_config=dashboard['config'],api_health=health['status'],
            verified_at=datetime.datetime.now(datetime.timezone.utc).isoformat())
        (OUT/'recovery.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
        print(json.dumps(result),flush=True)

if __name__=='__main__':main()
