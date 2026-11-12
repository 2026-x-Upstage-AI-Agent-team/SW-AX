"""Exercise the deployed V7 upgrade and a teammate V9 database lacking the PC migration."""
import argparse,copy,json,os,secrets,socket,subprocess,time
from pathlib import Path
from uuid import uuid4
from zipfile import ZipFile
import httpx,psycopg
from psycopg import sql

ROOT=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--jar',type=Path,required=True)
args=parser.parse_args()
combined=args.jar.resolve()
OUT=ROOT/'var/pc-migration-upgrade'/uuid4().hex[:10]
OUT.mkdir(parents=True)
TREE=ROOT
with socket.socket() as probe:
    if probe.connect_ex(('127.0.0.1',18889))==0:raise RuntimeError('Migration test port is occupied')
v7=OUT/'v7-before-workspaces.jar';v9=OUT/'v9-without-pc7.jar'
with ZipFile(combined) as source:
    for target_path,removed in ((v7,('V8__workspace_categories.sql','V9__category_availability.sql')),(v9,('V7__pc_parallel_slots.sql',))):
        with ZipFile(target_path,'w') as target:
            for item in source.infolist():
                if not any(item.filename.endswith('/'+name) for name in removed):target.writestr(copy.copy(item),source.read(item.filename))
master=dict(host='127.0.0.1',port=55432,user='swax',password=(ROOT/'var/intake-postgres.key').read_text().strip(),autocommit=True,connect_timeout=5)
records=[]

def start(jar,db_name,label,flag=None):
    env={k:v for k,v in os.environ.items() if not k.startswith(('AWARDS_','AWS_','UPSTAGE_','SMTP_','GMAIL_'))}
    env.update(AWARDS_DB_URL='jdbc:postgresql://127.0.0.1:55432/'+db_name,AWARDS_DB_USER='swax',AWARDS_DB_PASSWORD=master['password'],
        AWARDS_REVIEW_WORKER_TOKEN=secrets.token_hex(32),AWARDS_OUTPUT_WORKER_TOKEN=secrets.token_hex(32),AWARDS_PC_ENABLED='true',AWARDS_WORKER_MANAGED='true',AWARD_DATA_DIR=str(OUT/'migration-data'))
    command=[r'C:\Program Files\Java\jdk-21\bin\java.exe','-Xmx512m','-Dfile.encoding=UTF-8','-jar',str(jar),'--server.port=18889']
    if flag is not None:command+=['--spring.flyway.out-of-order='+str(flag).lower()]
    log=OUT/('migration-'+label+'.log')
    with log.open('wb') as stream:process=subprocess.Popen(command,cwd=TREE,env=env,stdout=stream,stderr=subprocess.STDOUT,creationflags=subprocess.CREATE_NO_WINDOW)
    for _ in range(65):
        if process.poll() is not None:return process,False,log
        try:
            if httpx.get('http://127.0.0.1:18889/actuator/health',timeout=1,trust_env=False).status_code==200:return process,True,log
        except httpx.HTTPError:pass
        time.sleep(1)
    process.terminate();process.wait(timeout=15)
    raise TimeoutError('Migration fixture startup timeout')

def stop(process):
    if process.poll() is None:process.terminate();process.wait(timeout=15)

for baseline,label in ((v7,'from-v7'),(v9,'from-v9-missing-v7')):
    name='swax_pc_migration_'+uuid4().hex[:10]
    with psycopg.connect(dbname='postgres',**master) as db:db.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(name)))
    process=None
    try:
        process,ready,_=start(baseline,name,label+'-baseline');assert ready
        stop(process)
        with psycopg.connect(dbname=name,**master) as db:
            event=str(uuid4());batch=str(uuid4());file=str(uuid4());device=str(uuid4())
            db.execute("INSERT INTO staff_account(login,password_hash) VALUES('merge-fixture','!')")
            db.execute("INSERT INTO award_event(id,name) VALUES(%s,'retained migration fixture')",(event,))
            db.execute("INSERT INTO intake_batch(id,event_id,request_key,fingerprint,uploaded_by) VALUES(%s,%s,%s,%s,'merge-fixture')",(batch,event,str(uuid4()),'0'*64))
            db.execute("INSERT INTO intake_file(id,batch_id,position,name,size_bytes,sha256,original) VALUES(%s,%s,1,'fixture.hwp',1,repeat('0',64),%s)",(file,batch,b'x'))
            db.execute("INSERT INTO pc_device(id,login,browser_id,token_hash,name) VALUES(%s,'merge-fixture',%s,%s,'migration fixture')",(device,str(uuid4()),b'z'*32))
            db.execute("INSERT INTO pc_file_conversion(file_id,device_id,lease_until,state) VALUES(%s,%s,now(),'done')",(file,device))
        if label=='from-v9-missing-v7':
            process,ready,log=start(combined,name,label+'-without-fix',False)
            assert not ready,'Expected existing V9 to reject the newly introduced older V7 without explicit ordering support'
            detail=log.read_text(encoding='utf-8',errors='replace')
            assert '7' in detail and ('outOfOrder' in detail or 'out-of-order' in detail or 'not applied' in detail)
            stop(process)
        process,ready,_=start(combined,name,label+'-compatible');assert ready
        with psycopg.connect(dbname=name,**master) as db:
            versions=[r[0] for r in db.execute("SELECT version FROM flyway_schema_history WHERE success AND version IS NOT NULL ORDER BY installed_rank")]
            assert all(v in versions for v in ('7','8','9'))
            assert db.execute('SELECT worker_slot,state FROM pc_file_conversion WHERE file_id=%s',(file,)).fetchone()==(0,'done')
            assert db.execute('SELECT original FROM intake_file WHERE id=%s',(file,)).fetchone()[0]==b'x'
            assert db.execute('SELECT category_id FROM award_event WHERE id=%s',(event,)).fetchone()[0]=='awards'
        records.append(dict(baseline=label,passed=True,applied_versions=versions,data_preserved=True))
        print(json.dumps(records[-1]),flush=True)
    finally:
        if process is not None:stop(process)
        with psycopg.connect(dbname='postgres',**master) as db:db.execute(sql.SQL('DROP DATABASE {} WITH (FORCE)').format(sql.Identifier(name)))
(OUT/'migration-verification.json').write_text(json.dumps(records,indent=2),encoding='utf-8')
