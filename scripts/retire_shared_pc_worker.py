"""Retire only the d1110a shared PC roles after an idle-queue check; preserve the local 18765 service."""
import argparse
import importlib.util
import json
from pathlib import Path
import sys
import tempfile

import psycopg

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'var/aws-integration-d1110a'))
from native_runtime import BASE,DATA,PW7,process_alive,run,save_json,stop_tunnel

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--restore',action='store_true')
    parser.add_argument('--close-tunnel',action='store_true')
    args=parser.parse_args()
    marker=ROOT/'var/pc-connector-deployment/shared-worker-retired.json'
    if args.restore:
        snapshot=json.loads(marker.read_text(encoding='utf-8'))
        if snapshot['was_enabled']:
            result=run([PW7,'-NoProfile','-NonInteractive','-Command','Enable-ScheduledTask -TaskName SWAX-d1110a-PC-Recovery | Out-Null;Start-ScheduledTask -TaskName SWAX-d1110a-PC-Recovery'],timeout=20)
            if result.returncode:raise RuntimeError('Shared PC recovery restore failed')
        print(json.dumps({'restored':True}));return
    if args.close_tunnel:
        snapshot=json.loads(marker.read_text(encoding='utf-8'))
        entry=json.loads((DATA/'tunnel.json').read_text(encoding='utf-8-sig'))
        if process_alive(entry):stop_tunnel(entry)
        snapshot['legacy_tunnel_closed']=True;save_json(marker,snapshot)
        print(json.dumps({'legacy_tunnel_closed':True}));return
    if marker.exists():raise RuntimeError('Shared-worker retirement already recorded; inspect before retrying')
    spec=importlib.util.spec_from_file_location('watch_native',BASE/'watch-native.py')
    watch=importlib.util.module_from_spec(spec);spec.loader.exec_module(watch)
    config=json.loads((BASE/'handoff-verified/deployment-result.json').read_text(encoding='utf-8-sig'))
    credential=watch.load_db_credentials(config)
    with psycopg.connect(host=config['database']['host'],hostaddr='127.0.0.1',port=15434,dbname='swax_intake',user=credential['username'],password=credential['password'],
            sslmode='verify-full',sslrootcert=str(Path(tempfile.gettempdir())/'swax-d1110a-rds-ca.pem'),connect_timeout=4,
            options='-c statement_timeout=5000 -c default_transaction_read_only=on',autocommit=True) as db:
        pending=db.execute("SELECT count(*) FROM intake_preparation WHERE state IN ('pending','ready')").fetchone()[0]
        reviews=db.execute("SELECT count(*) FROM review_job_status WHERE state IN ('queued','running')").fetchone()[0]
        reports=db.execute("SELECT count(*) FROM award_report WHERE state IN ('queued','building','printing','verifying')").fetchone()[0]
    if pending or reviews or reports:raise RuntimeError('Cloud work is in progress; wait before switching shared native workers')
    workers=json.loads((DATA/'native-workers.json').read_text(encoding='utf-8-sig'))
    result=run([PW7,'-NoProfile','-NonInteractive','-Command',"$task=Get-ScheduledTask SWAX-d1110a-PC-Recovery;$was=$task.Settings.Enabled;Stop-ScheduledTask SWAX-d1110a-PC-Recovery;Disable-ScheduledTask SWAX-d1110a-PC-Recovery|Out-Null;[pscustomobject]@{was_enabled=$was}|ConvertTo-Json -Compress"],timeout=20)
    if result.returncode:raise RuntimeError('Cannot retire shared recovery task')
    snapshot={'was_enabled':json.loads(result.stdout)['was_enabled'],'previous_workers':workers,'pending_at_switch':pending,'reviews_at_switch':reviews,'reports_at_switch':reports}
    save_json(marker,snapshot)
    for item in workers['processes']:
        if item['role'] not in ('prepare','printer'):raise RuntimeError('Unexpected legacy role; do not stop')
        if process_alive(item):
            pid=int(item['pid'])
            result=run([PW7,'-NoProfile','-NonInteractive','-Command',f"$w=Get-CimInstance Win32_Process -Filter 'ProcessId={pid}';if($w.Name -notin @('python.exe','pythonw.exe') -or $w.CommandLine -notlike '*operations.*'){{throw 'Worker identity changed'}};Stop-Process -Id {pid} -Force"],timeout=15)
            if result.returncode:raise RuntimeError('Legacy native worker stop failed')
    print(json.dumps({'shared_native_workers_retired':True,'pending_at_switch':pending,'reviews_at_switch':reviews,'reports_at_switch':reports}))

if __name__=='__main__':main()
