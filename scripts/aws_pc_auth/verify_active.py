"""Confirm the certificate profile, live workers and DB; migrate an idle legacy tunnel when requested."""
import argparse
import datetime
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import time

import httpx
import psycopg

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'var/aws-integration-d1110a'))
from native_runtime import BASE,DATA,DEVICE_STATE,PW7,aws_settings,listener,process_alive,run,save_json

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--reconnect-if-idle',action='store_true')
    args=parser.parse_args()
    profile,_=aws_settings()
    if profile!='swax-pc-worker-d1110a':raise RuntimeError('Device profile is not active')
    spec=importlib.util.spec_from_file_location('watch_native',BASE/'watch-native.py')
    watch=importlib.util.module_from_spec(spec);spec.loader.exec_module(watch)
    config=json.loads((BASE/'handoff-verified/deployment-result.json').read_text(encoding='utf-8-sig'))
    workers=json.loads((DATA/'native-workers.json').read_text(encoding='utf-8-sig'))
    credentials=watch.load_db_credentials(config)
    with psycopg.connect(host=config['database']['host'],hostaddr='127.0.0.1',port=15434,dbname='swax_intake',user=credentials['username'],password=credentials['password'],sslmode='verify-full',sslrootcert=str(Path(tempfile.gettempdir())/'swax-d1110a-rds-ca.pem'),connect_timeout=4,options='-c statement_timeout=3000',autocommit=True) as db:
        pending=db.execute("SELECT count(*) FROM intake_preparation WHERE state IN ('pending','ready')").fetchone()[0]
    before=json.loads((DATA/'tunnel.json').read_text(encoding='utf-8-sig'))
    migrated=False
    if args.reconnect_if_idle and pending==0 and before.get('aws_profile')!=profile:
        stopped=run([PW7,'-NoProfile','-NonInteractive','-Command',"Stop-ScheduledTask -TaskName SWAX-d1110a-PC-Recovery; $limit=(Get-Date).AddSeconds(15);while((Get-ScheduledTask -TaskName SWAX-d1110a-PC-Recovery).State -eq 'Running'){if((Get-Date)-gt $limit){throw 'Task stop timeout'};Start-Sleep -Milliseconds 200}"],timeout=20)
        if stopped.returncode:raise RuntimeError('Cannot coordinate tunnel migration')
        try:
            watch.reconnect()
            if not watch.database_alive(config,credentials):raise RuntimeError('Migrated DB tunnel probe failed')
            migrated=True
        finally:
            restarted=run([PW7,'-NoProfile','-NonInteractive','-Command','Start-ScheduledTask -TaskName SWAX-d1110a-PC-Recovery'],timeout=15)
            if restarted.returncode:raise RuntimeError('Recovery task restart needs attention')
    deadline=time.monotonic()+45
    status={}
    while time.monotonic()<deadline:
        status=json.loads((DATA/'watchdog-status.json').read_text(encoding='utf-8'))
        age=(datetime.datetime.now(datetime.timezone.utc)-datetime.datetime.fromisoformat(status['checked_at'])).total_seconds()
        if status['state']=='healthy' and age<20:break
        time.sleep(2)
    else:raise RuntimeError('Recovery watchdog is not healthy')
    state=json.loads((DATA/'tunnel.json').read_text(encoding='utf-8-sig'))
    alive=[{'role':item['role'],'pid':item['pid'],'alive':process_alive(item)} for item in workers['processes']]
    if not all(item['alive'] for item in alive):raise RuntimeError('A native worker exited')
    response=httpx.get('https://d3nkw8bzgv8pom.cloudfront.net/actuator/health',timeout=15,trust_env=False)
    if response.status_code!=200 or response.json().get('status')!='UP':raise RuntimeError('Public API health is not UP')
    if listener(15435) is not None:raise RuntimeError('Disposable tunnel was not cleaned up')
    result={'checked_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'active_profile':profile,'human_login_cache_used':False,'event_scope':workers.get('event_scope'),'pending_batches':pending,'production_tunnel_migrated':migrated,'production_tunnel_profile':state.get('aws_profile','legacy-human-session'),'tunnel_pid':state['pid'],'workers':alive,'watchdog':status,'public_api_status':response.status_code,'public_api_health':'UP','test_tunnel_cleaned_up':True,'certificate_not_after':json.loads((DEVICE_STATE/'certificate.json').read_text(encoding='utf-8-sig'))['not_after']}
    save_json(DEVICE_STATE/'activation-verification.json',result)
    print(json.dumps(result))

if __name__=='__main__':main()
