"""Build a self-contained Windows installer from this checkout; contains no service credentials."""
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import shutil
import ssl
import subprocess
import sys

from pc_connector.windows import VERSION

ROOT=Path(__file__).resolve().parents[1]
BUILD=ROOT/'var/pc-connector-build'
DIST=BUILD/'dist'
ASSETS=BUILD/'assets'

def main():
    ASSETS.mkdir(parents=True,exist_ok=True)
    version=hashlib.sha256((ROOT/'operations/hancom/PathGuard.c').read_bytes()).hexdigest()[:12].upper()
    for bits,arch in ((32,'x86'),(64,'x86_64')):
        target=ASSETS/f'guard-{bits}.dll'
        args=[]
        if bits==32:
            exports=ASSETS/'guard32.def'
            exports.write_text('EXPORTS\nIsAccessiblePath=IsAccessiblePath@16\n',encoding='ascii')
            args.append(str(exports))
        subprocess.run([sys.executable,'-m','ziglang','cc','-target',arch+'-windows-gnu','-shared','-Os','-s',
                        str(ROOT/'operations/hancom/PathGuard.c'),*args,'-o',str(target)],check=True)
    # Keep an existing distribution until the replacement build succeeds.
    args=[sys.executable,'-m','PyInstaller','--noconfirm','--onefile','--windowed','--name','SWAX-PC-Setup',
          '--paths',str(ROOT),'--distpath',str(DIST),'--workpath',str(BUILD/'work'),'--specpath',str(BUILD)]
    for source,destination in [(ROOT/'service/convert.ps1','service'),(ROOT/'service/ocr.ps1','service'),
                               (ROOT/'reporting/guard_hancom.ps1','reporting'),(ROOT/'pc_connector/probe.ps1','pc_connector'),
                               (ROOT/'pc_connector/install-task.ps1','pc_connector'),
                               (ASSETS/'guard-32.dll','pc_connector/assets'),(ASSETS/'guard-64.dll','pc_connector/assets')]:
        args+=['--add-data',str(source)+os.pathsep+destination]
    # This Python distribution loads its CA distrust list while creating an SSLContext.
    # Preserve that policy in a frozen runtime, where the stdlib's __file__ is relocated.
    distrust=Path(ssl.__file__).with_name('codex-rejected-cas.pem')
    if distrust.is_file():args+=['--add-data',str(distrust)+os.pathsep+'.']
    args+=['--hidden-import','pc_connector.agent','--hidden-import','operations.native',
           '--hidden-import','service.documents',str(ROOT/'pc_connector/main.py')]
    subprocess.run(args,check=True,cwd=ROOT)
    binary=DIST/'SWAX-PC-Setup.exe'
    manifest={'version':VERSION,'bytes':binary.stat().st_size,'sha256':hashlib.sha256(binary.read_bytes()).hexdigest(),
              'pyinstaller':importlib.metadata.version('pyinstaller'),'guard_source':version,
              'no_aws_credentials':True,'no_database_credentials':True}
    (DIST/'manifest.json').write_text(json.dumps(manifest,indent=2),encoding='utf-8')
    print(json.dumps(manifest))

if __name__=='__main__':main()
