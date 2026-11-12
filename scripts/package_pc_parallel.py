"""Build the bounded-PC-parallelism patch and a migration-compatible rollback JAR."""
import copy
import hashlib
import json
from pathlib import Path
from zipfile import ZipFile,ZIP_DEFLATED

from PyInstaller.archive.readers import CArchiveReader

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'var/pc-parallel-deployment'
PREFIX='BOOT-INF/classes/'
MIGRATION=PREFIX+'db/migration/V7__pc_parallel_slots.sql'

def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()

def main():
    baseline=json.loads((ROOT/'var/pc-connector-deployment/final-manifest.json').read_text(encoding='utf-8'))
    original=ROOT/baseline['api_jar_local']
    if digest(original)!=baseline['api_jar_sha256']:raise RuntimeError('Verified baseline JAR changed')
    stage=json.loads((ROOT/'var/pc-connector-build/backend-stage.json').read_text(encoding='utf-8'))
    compiled=Path(stage['jar'])
    if not stage['tests_passed'] or digest(compiled)!=stage['jar_sha256']:raise RuntimeError('Tested build changed')
    installer=ROOT/'var/pc-connector-build/dist/SWAX-PC-Setup.exe'
    installer_manifest=json.loads(installer.with_name('manifest.json').read_text())
    if installer_manifest['version']!='1.1.0' or digest(installer)!=installer_manifest['sha256']:raise RuntimeError('Installer build mismatch')
    archive=CArchiveReader(str(installer))
    for source in ('service/convert.ps1','reporting/guard_hancom.ps1','pc_connector/probe.ps1'):
        entry=next(n for n in archive.toc if n.replace('\\','/')==source)
        if archive.extract(entry)!=(ROOT/source).read_bytes():raise RuntimeError('Installer contains stale converter code')
    replacements={}
    with ZipFile(compiled) as jar:
        for name in ('PcTasks.class','PcAgentController.class','PcAgentController$Claim.class'):
            path=PREFIX+'kr/swax/intake/'+name;replacements[path]=jar.read(path)
        replacements[MIGRATION]=jar.read(MIGRATION)
    OUT.mkdir(exist_ok=True)
    target=OUT/'swax-intake.jar';rollback=OUT/'rollback.jar'
    if original.resolve() in (target.resolve(),rollback.resolve()):raise RuntimeError('Do not overwrite the verified baseline')
    with ZipFile(original) as source:
        if MIGRATION in source.namelist():raise RuntimeError('PC slot migration already exists; inspect current deployment')
        with ZipFile(target,'w') as jar,ZipFile(rollback,'w') as old:
            existing=set(source.namelist())
            for entry in source.infolist():
                data=source.read(entry.filename)
                jar.writestr(copy.copy(entry),replacements.get(entry.filename,data))
                old.writestr(copy.copy(entry),data)
            for name,data in replacements.items():
                if name not in existing:jar.writestr(name,data,compress_type=ZIP_DEFLATED)
            old.writestr(MIGRATION,replacements[MIGRATION],compress_type=ZIP_DEFLATED)
        with ZipFile(target) as jar:
            changed=[n for n in source.namelist() if source.read(n)!=jar.read(n)]
            added=[n for n in jar.namelist() if n not in existing]
            if set(changed)!={PREFIX+'kr/swax/intake/PcTasks.class',PREFIX+'kr/swax/intake/PcAgentController.class'}:
                raise RuntimeError('Unexpected deployed classes changed')
    manifest=dict(deployment_id='d1110a',instance_type='t3.medium',base_jar_sha256=digest(original),
        previous_installer_sha256=baseline['installer_sha256'],installer_version='1.1.0',
        files={name:dict(sha256=digest(path),bytes=path.stat().st_size) for name,path in
               (('swax-intake.jar',target),('rollback.jar',rollback),('SWAX-PC-Setup.exe',installer))},
        changed_jar_entries=changed,added_jar_entries=added,concurrency=2)
    (OUT/'manifest.json').write_text(json.dumps(manifest,indent=2),encoding='utf-8')
    with ZipFile(OUT/'bundle.zip','w',compression=ZIP_DEFLATED) as bundle:
        for name,path in (('swax-intake.jar',target),('rollback.jar',rollback),('SWAX-PC-Setup.exe',installer),('manifest.json',OUT/'manifest.json')):
            bundle.write(path,name)
    print(json.dumps(dict(bundle_sha256=digest(OUT/'bundle.zip'),**manifest)))

if __name__=='__main__':main()
