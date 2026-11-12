"""Patch only PC-connector classes/resources into the verified deployed JAR."""
import hashlib
import copy
import json
from pathlib import Path
from zipfile import ZipFile,ZIP_DEFLATED

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'var/pc-connector-deployment'
BASE=ROOT/'var/aws-integration-d1110a/reason-display-e670d930/swax-intake.jar'
EXPECTED='b3c063eccaecb496709d0ea73948fc122726dc881914ba0c2d8f6714342c518b'
PREFIX='BOOT-INF/classes/'

def digest(value):return hashlib.sha256(value).hexdigest()

def main():
    OUT.mkdir(parents=True,exist_ok=True)
    if digest(BASE.read_bytes())!=EXPECTED:raise RuntimeError('Verified deployed JAR changed')
    stage=json.loads((ROOT/'var/pc-connector-build/backend-stage.json').read_text(encoding='utf-8'))
    source=Path(stage['jar'])
    if digest(source.read_bytes())!=stage['jar_sha256'] or not stage['tests_passed']:raise RuntimeError('Tested build changed')
    replacements={}
    with ZipFile(source) as compiled:
        for name in compiled.namelist():
            if not name.startswith(PREFIX+'kr/swax/intake/'):continue
            filename=Path(name).name
            if filename.startswith(('PcDevices','PcConnectionController','PcTasks','PcAgent')) or filename.split('$')[0] in ('OutputJobs.class','ReviewWorkerAccess.class','WorkerStatus.class'):
                replacements[name]=compiled.read(name)
        migration=PREFIX+'db/migration/V6__pc_connectors.sql'
        replacements[migration]=compiled.read(migration)
        if replacements[migration]!=(ROOT/'backend/src/main/resources/db/migration/V6__pc_connectors.sql').read_bytes():
            raise RuntimeError('Migration differs from tested build')
    with ZipFile(BASE) as deployed:
        properties=PREFIX+'application.properties'
        content=deployed.read(properties).decode('utf-8')
        if 'awards.pc.enabled=' in content:raise RuntimeError('PC configuration already exists; review the new baseline')
        replacements[properties]=(content+'\nawards.pc.enabled=${AWARDS_PC_ENABLED:false}\nawards.pc.installer=${AWARDS_PC_INSTALLER:}\n').encode('utf-8')
        for file in (ROOT/'frontend/dist').rglob('*'):
            if file.is_file():replacements[PREFIX+'static/'+file.relative_to(ROOT/'frontend/dist').as_posix()]=file.read_bytes()
        changed=[];added=[]
        patched=OUT/'swax-intake.jar'
        with ZipFile(patched,'w') as result:
            for entry in deployed.infolist():
                original=deployed.read(entry.filename)
                value=replacements.pop(entry.filename,original)
                if value!=original:changed.append(entry.filename)
                result.writestr(copy.copy(entry),value)
            for name,value in replacements.items():
                result.writestr(name,value,compress_type=ZIP_DEFLATED);added.append(name)
        # All backend code outside this feature stays byte-for-byte equal to the deployed server.
        with ZipFile(patched) as result:
            for entry in deployed.namelist():
                if entry not in changed and result.read(entry)!=deployed.read(entry):raise RuntimeError('Unrelated deployed entry changed')
    base_release=ROOT/'var/aws-integration-d1110a/r20261110-final5-161200/swax-release.zip'
    with ZipFile(base_release) as archive:
        old_aux=archive.read('bin/run-auxiliary.ps1')
        old_prepare=archive.read('worker/operations/preparation.py')
        aux=old_aux.decode('utf-8-sig')
    aux=aux.replace("[ValidateSet('studio','report')]","[ValidateSet('studio','report','prepare')]")
    aux=aux.replace("$env:AWARDS_API_URL='http://127.0.0.1:18765';","$env:AWARDS_PC_ENABLED='true'; $env:AWARDS_API_URL='http://127.0.0.1:18765';")
    files={'app/swax-intake.jar':patched.read_bytes(),
           'worker/preparation.py':(ROOT/'operations/preparation.py').read_bytes(),
           'bin/run-auxiliary.ps1':aux.encode('utf-8'),
           'pc/SWAX-PC-Setup.exe':(ROOT/'var/pc-connector-build/dist/SWAX-PC-Setup.exe').read_bytes()}
    manifest={'deployment_id':'d1110a','instance_type':'t3.medium','base_jar_sha256':EXPECTED,
              'previous_aux_sha256':digest(old_aux),'previous_preparation_sha256':digest(old_prepare),
              'changed_jar_entries':changed,'added_jar_entries':added,
              'files':{name:{'sha256':digest(value),'bytes':len(value)} for name,value in files.items()}}
    (OUT/'manifest.json').write_text(json.dumps(manifest,indent=2),encoding='utf-8')
    bundle=OUT/'pc-connector.zip'
    with ZipFile(bundle,'w',compression=ZIP_DEFLATED) as archive:
        for name,value in files.items():archive.writestr(name,value)
        archive.writestr('manifest.json',json.dumps(manifest))
    print(json.dumps({'zip':str(bundle),'zip_sha256':digest(bundle.read_bytes()),'zip_bytes':bundle.stat().st_size,
                      'backend_entries_preserved':True,'changed_entries':len(changed),'added_entries':len(added)}))

if __name__=='__main__':main()
