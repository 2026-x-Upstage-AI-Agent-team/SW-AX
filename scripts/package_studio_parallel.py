"""Patch only the Studio concurrency migration in the current verified AWS JAR."""
import argparse
import hashlib
import json
from pathlib import Path
from zipfile import ZipFile

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'var/studio-parallel-deployment'
RESOURCE='BOOT-INF/classes/db/migration/R__workflow_operations.sql'


def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--previous-worker-sha256',required=True,help='SHA-256 read from the current AWS Studio worker')
    args=parser.parse_args()
    previous=args.previous_worker_sha256.lower()
    if len(previous)!=64 or any(c not in '0123456789abcdef' for c in previous):
        parser.error('A 64-character SHA-256 is required')
    baseline=json.loads((ROOT/'var/pc-connector-deployment/final-manifest.json').read_text(encoding='utf-8'))
    original=ROOT/baseline['api_jar_local']
    if digest(original)!=baseline['api_jar_sha256']:raise RuntimeError('Verified baseline changed')
    OUT.mkdir(exist_ok=True)
    target=OUT/'swax-intake.jar'
    if original.resolve()==target.resolve():raise RuntimeError('Do not overwrite the verified baseline JAR')
    with ZipFile(original) as source:
        text=source.read(RESOURCE).decode('utf-8')
        index='CREATE UNIQUE INDEX IF NOT EXISTS studio_one_remote ON studio_execution (occupies_slot) WHERE occupies_slot;'
        if text.count(index)!=1:raise RuntimeError('Inspect the currently deployed migration before updating')
        text=text.replace(index,'ALTER TABLE studio_execution ADD COLUMN IF NOT EXISTS last_http_status smallint;\nDROP INDEX IF EXISTS studio_one_remote;')
        with ZipFile(target,'w') as result:
            for entry in source.infolist():result.writestr(entry,text.encode('utf-8') if entry.filename==RESOURCE else source.read(entry.filename))
    with ZipFile(original) as source,ZipFile(target) as result:
        changed=[n for n in source.namelist() if source.read(n)!=result.read(n)]
        if changed!=[RESOURCE] or source.namelist()!=result.namelist():raise RuntimeError('Unexpected JAR entries changed')
    worker=ROOT/'operations/studio_worker.py'
    manifest=dict(base_jar_sha256=digest(original),jar_sha256=digest(target),worker_sha256=digest(worker),
                  previous_worker_sha256=previous,jar_changed_entries=changed)
    (OUT/'manifest.json').write_text(json.dumps(manifest,indent=2),encoding='utf-8')
    bundle=OUT/'bundle.zip'
    with ZipFile(bundle,'w') as archive:
        archive.write(target,'swax-intake.jar')
        archive.write(worker,'studio_worker.py')
        archive.write(OUT/'manifest.json','manifest.json')
    print(json.dumps(dict(manifest,bundle_sha256=digest(bundle))))


if __name__=='__main__':main()
