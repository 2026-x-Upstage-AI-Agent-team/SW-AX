"""Re-run one existing browser regression against the exact previously deployed static files."""
from pathlib import Path
import os
import shutil
import subprocess
from zipfile import ZipFile

ROOT=Path(__file__).resolve().parents[1]
BASE=ROOT/'var/pc-connector-test/deployed-ui-baseline'

def main():
    dist=BASE/'dist';dist.mkdir(parents=True,exist_ok=True)
    with ZipFile(ROOT/'var/aws-integration-d1110a/reason-display-e670d930/swax-intake.jar') as archive:
        prefix='BOOT-INF/classes/static/'
        for name in archive.namelist():
            if not name.startswith(prefix) or name.endswith('/'):continue
            target=(dist/name[len(prefix):]).resolve()
            if not target.is_relative_to(dist.resolve()):raise RuntimeError('Unexpected static path')
            target.parent.mkdir(parents=True,exist_ok=True)
            if target.exists() and target.read_bytes()==archive.read(name):continue
            target.write_bytes(archive.read(name))
    (BASE/'tests').mkdir(exist_ok=True)
    shutil.copyfile(ROOT/'frontend/tests/intake-ux.mjs',BASE/'tests/intake-ux.mjs')
    (BASE/'package.json').write_text('{"type":"module"}',encoding='utf-8')
    modules=BASE/'node_modules'
    if not modules.exists():
        env=os.environ.copy();env.update(PC_TEST_MODULES=str(modules),PC_SOURCE_MODULES=str(ROOT/'frontend/node_modules'))
        subprocess.run(['powershell.exe','-NoProfile','-NonInteractive','-Command',
            "New-Item -ItemType Junction -Path $env:PC_TEST_MODULES -Value $env:PC_SOURCE_MODULES | Out-Null"],env=env,check=True,creationflags=subprocess.CREATE_NO_WINDOW)
    result=subprocess.run(['node.exe','--test','--test-name-pattern=다른 탭에서 저장한 HWPX','tests/intake-ux.mjs'],cwd=BASE)
    raise SystemExit(result.returncode)

if __name__=='__main__':main()
