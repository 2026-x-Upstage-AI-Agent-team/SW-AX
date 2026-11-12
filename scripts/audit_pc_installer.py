"""Inspect the final self-contained installer for accidental credential files/values."""
import json
import marshal
from pathlib import Path
import types

from PyInstaller.archive.readers import CArchiveReader

ROOT=Path(__file__).resolve().parents[1]
EXE=ROOT/'var/pc-connector-build/dist/SWAX-PC-Setup.exe'
values={}
env=ROOT/'.env.local'
if env.exists():
    for line in env.read_text(encoding='utf-8-sig').splitlines():
        key,separator,value=line.partition('=')
        value=value.strip().strip('\"\'')
        if separator and any(term in key.upper() for term in ('KEY','TOKEN','PASSWORD','SECRET')) and len(value)>=16:
            values[key.strip()]=value.encode('utf-8')
for name in ('intake-postgres.key','review-worker.key','output-worker.key'):
    path=ROOT/'var'/name
    if path.exists():values[name]=path.read_text().strip().encode('utf-8')
archive=CArchiveReader(str(EXE))
forbidden=[name for name in archive.toc if any(term in name.lower() for term in ('.env.local','connection.bin','worker.awsconfig','empty-credentials'))]
matches=[]
for name in archive.toc:
    data=archive.extract(name)
    if data:
        for key,value in values.items():
            if value in data:matches.append(key)
pyz=archive.open_embedded_archive(next(name for name in archive.toc if name.endswith('.pyz')))
modules=list(pyz.toc)
for name in modules:
    data=pyz.extract(name)
    if isinstance(data,types.CodeType):data=marshal.dumps(data)
    if isinstance(data,bytes):
        for key,value in values.items():
            if value in data:matches.append(key)
unexpected=[name for name in modules if name.split('.')[0] in ('awscli','boto3','psycopg')]
report={'known_secret_values_checked':len(values),'secret_matches':sorted(set(matches)),
        'forbidden_configuration_files':forbidden,'aws_or_database_sdk_modules':unexpected,
        'standalone_python_runtime':any('python312.dll' in name for name in archive.toc)}
(ROOT/'var/pc-connector-build/dist/credential-audit.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
print(json.dumps(report))
if matches or forbidden or unexpected:raise SystemExit(1)
