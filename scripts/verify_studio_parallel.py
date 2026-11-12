"""Run Studio parallel/recovery contracts on fresh local PostgreSQL/Spring instances."""
import argparse
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import time
from uuid import uuid4

import httpx
import psycopg
from psycopg import sql

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'var/studio-parallel-tests'


def verify(jar, module, port):
    name=module.rsplit('.',1)[-1]
    output=OUT/name
    output.mkdir(parents=True,exist_ok=True)
    with socket.socket() as probe:
        if probe.connect_ex(('127.0.0.1',port))==0:raise RuntimeError('Test port is already occupied')
    database='swax_studio_test_'+uuid4().hex[:12]
    password=(ROOT/'var/intake-postgres.key').read_text().strip()
    master=dict(host='127.0.0.1',port=55432,user='swax',password=password,autocommit=True,connect_timeout=5)
    with psycopg.connect(dbname='postgres',**master) as db:
        db.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(database)))
    env={k:v for k,v in os.environ.items() if not k.startswith(('AWARDS_','UPSTAGE_','AWS_','GMAIL_','SMTP_','INTAKE_TEST_'))}
    env.update(AWARDS_DB_URL='jdbc:postgresql://127.0.0.1:55432/'+database,AWARDS_DB_USER='swax',
        AWARDS_DB_PASSWORD=password,AWARDS_REVIEW_WORKER_TOKEN=secrets.token_hex(32),
        AWARDS_OUTPUT_WORKER_TOKEN=secrets.token_hex(32),AWARD_DATA_DIR=str(output/'data'),
        AWARDS_WORKER_MANAGED='true',AWARDS_REMOTE_PRINTER='true',AWARDS_PARALLEL_TESTS='1',AWARDS_RECOVERY_TESTS='1',
        INTAKE_TEST_URL='http://127.0.0.1:'+str(port),PYTHONIOENCODING='utf-8',
        INTAKE_TEST_LOGIN_A='parallel-fixture-a',INTAKE_TEST_PASSWORD_A=secrets.token_urlsafe(20),
        INTAKE_TEST_LOGIN_B='parallel-fixture-b',INTAKE_TEST_PASSWORD_B=secrets.token_urlsafe(20))
    process=None
    try:
        with (output/'api.log').open('wb') as log:
            process=subprocess.Popen([r'C:\Program Files\Java\jdk-21\bin\java.exe','-Xmx768m','-Dfile.encoding=UTF-8',
                '-jar',str(jar),'--server.port='+str(port)],cwd=ROOT,env=env,stdout=log,stderr=subprocess.STDOUT,
                creationflags=subprocess.CREATE_NO_WINDOW)
        for _ in range(90):
            if process.poll() is not None:raise RuntimeError('Isolated API exited: '+str(output/'api.log'))
            try:
                if httpx.get(env['INTAKE_TEST_URL']+'/actuator/health',timeout=2,trust_env=False).status_code==200:break
            except httpx.HTTPError:pass
            time.sleep(1)
        else:raise TimeoutError('Isolated API did not start')
        with psycopg.connect(dbname=database,**master) as db:
            db.execute('CREATE EXTENSION IF NOT EXISTS pgcrypto')
            for suffix in ('A','B'):
                db.execute("INSERT INTO staff_account(login,password_hash) VALUES(%s,crypt(%s,gen_salt('bf',10)))",
                    (env['INTAKE_TEST_LOGIN_'+suffix],env['INTAKE_TEST_PASSWORD_'+suffix]))
        with (output/'tests.log').open('wb') as log:
            result=subprocess.run([sys.executable,'-m','unittest',module,'-v'],cwd=ROOT,env=env,stdout=log,stderr=subprocess.STDOUT)
        print((output/'tests.log').read_text(encoding='utf-8'),flush=True)
        if result.returncode:raise RuntimeError('Studio contract failed: '+module)
        return dict(suite=module,passed=True,database_isolated=True)
    finally:
        if process is not None:
            process.terminate()
            process.wait(timeout=20)
        with psycopg.connect(dbname='postgres',**master) as db:
            db.execute(sql.SQL('DROP DATABASE {} WITH (FORCE)').format(sql.Identifier(database)))


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--jar',type=Path,required=True)
    args=parser.parse_args()
    results=[verify(args.jar.resolve(),module,18887+i) for i,module in enumerate(
        ('tests.test_studio_parallel','tests.test_operations_recovery'))]
    (OUT/'result.json').write_text(json.dumps(results,indent=2),encoding='utf-8')
