"""Replace only PcTasks.class in the now-deployed connector JAR."""
import copy
import hashlib
import json
from pathlib import Path
from zipfile import ZipFile

ROOT=Path(__file__).resolve().parents[1]
BASE=ROOT/'var/pc-connector-deployment'
OUT=BASE/'retry-fix'
TARGET='BOOT-INF/classes/kr/swax/intake/PcTasks.class'

def main():
    OUT.mkdir(exist_ok=True)
    baseline=BASE/'swax-intake.jar'
    expected=json.loads((BASE/'manifest.json').read_text())['files']['app/swax-intake.jar']['sha256']
    if hashlib.sha256(baseline.read_bytes()).hexdigest()!=expected:raise RuntimeError('Baseline JAR changed')
    stage=json.loads((ROOT/'var/pc-connector-build/backend-stage.json').read_text())
    with ZipFile(stage['jar']) as compiled:replacement=compiled.read(TARGET)
    with ZipFile(baseline) as source,ZipFile(OUT/'swax-intake.jar','w') as result:
        for item in source.infolist():
            result.writestr(copy.copy(item),replacement if item.filename==TARGET else source.read(item.filename))
    with ZipFile(baseline) as source,ZipFile(OUT/'swax-intake.jar') as result:
        changed=[name for name in source.namelist() if source.read(name)!=result.read(name)]
        if changed!=[TARGET]:raise RuntimeError('Unexpected retry patch contents')
    report={'previous_jar_sha256':expected,'jar_sha256':hashlib.sha256((OUT/'swax-intake.jar').read_bytes()).hexdigest(),'changed_entries':changed}
    (OUT/'manifest.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    print(json.dumps(report))

if __name__=='__main__':main()
