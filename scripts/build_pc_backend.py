"""Run the Windows Gradle test worker from an isolated ASCII path."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'var/pc-connector-build'

def main():
    stage=Path(tempfile.mkdtemp(prefix='swax-pc-build-'))
    shutil.copytree(ROOT/'backend',stage/'backend',ignore=shutil.ignore_patterns('build','.gradle'))
    shutil.copytree(ROOT/'frontend/dist',stage/'frontend/dist')
    env=os.environ.copy();env['JAVA_HOME']=r'C:\Program Files\Java\jdk-21'
    OUT.mkdir(parents=True,exist_ok=True)
    with (OUT/'backend-build.log').open('wb') as log:
        result=subprocess.run(['cmd.exe','/d','/c',str(stage/'backend/gradlew.bat'),'bootJar','test',
            '-x','buildFrontend','-x','installFrontend','--console=plain','--no-daemon'],cwd=stage/'backend',env=env,stdout=log,stderr=subprocess.STDOUT)
    if result.returncode:
        print((OUT/'backend-build.log').read_text(encoding='utf-8',errors='replace')[-7000:])
        raise SystemExit(result.returncode)
    jar=stage/'backend/build/libs/swax-intake-0.1.0.jar'
    state={'stage':str(stage),'jar':str(jar),'jar_sha256':hashlib.sha256(jar.read_bytes()).hexdigest(),'tests_passed':True}
    (OUT/'backend-stage.json').write_text(json.dumps(state,indent=2),encoding='utf-8')
    print(json.dumps(state))

if __name__=='__main__':main()
