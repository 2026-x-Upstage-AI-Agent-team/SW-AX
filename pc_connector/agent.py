"""One sequential conversion worker, authenticated only to its paired staff account."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import threading
import time
from tempfile import TemporaryDirectory
from urllib.parse import parse_qs,urlsplit

import httpx
from pypdf import PdfReader
from pypdf.errors import PdfReadError

from .windows import APP_HOME,POWERSHELL,RESOURCES,SERVER,VERSION,confirm_connection,has_hancom,load_connection,save_connection,worker_lock

def connection_code(uri):
    parsed=urlsplit(uri)
    values=parse_qs(parsed.query,strict_parsing=True)
    if parsed.scheme!='swax-pc' or parsed.netloc!='connect' or parsed.path not in ('','/') or parsed.fragment:
        raise ValueError('Invalid PC connection URI')
    if set(values)!={'code'} or len(values['code'])!=1 or not re.fullmatch('[a-f0-9]{64}',values['code'][0]):
        raise ValueError('Invalid one-use code')
    return values['code'][0]

def connect(uri,approve=confirm_connection):
    import socket
    code=connection_code(uri)
    with httpx.Client(base_url=SERVER,timeout=25,trust_env=False,follow_redirects=False) as api:
        response=api.post('/api/pc-agent/exchange',json={'code':code,'name':socket.gethostname()[:80],'version':VERSION})
        response.raise_for_status()
        value=response.json()
        if not approve(value['login']):
            api.delete('/api/pc-agent/connection',headers={'Authorization':'Bearer '+value['token']}).raise_for_status()
            return None
    save_connection(value)
    return value['login']

def event(state,**fields):
    # Do not include document names, content, URLs, tokens or exception text.
    target=APP_HOME/'status.json'
    temp=APP_HOME/'status.tmp'
    temp.write_text(json.dumps({'checked_at':time.time(),'state':state,**fields}),encoding='utf-8')
    temp.replace(target)

def render(source,destination):
    from operations.native import render as native_render
    native_render(source,destination)

def process(api,task,renderer=render):
    if task.get('kind') not in ('file','report') or task.get('extension') not in ('.hwp','.hwpx'):
        raise ValueError('Unsupported conversion input')
    route='/api/pc-agent/'+task['kind']+'/'+task['id']
    headers={'X-Claim-Token':task['claim_token']}
    stop=threading.Event()
    lost=threading.Event()
    def heartbeat():
        while not stop.wait(10):
            try:
                response=api.put(route+'/lease',headers=headers,timeout=10)
                if response.status_code in (401,404,409):lost.set();return
                response.raise_for_status()
                if stop.is_set():return
                api.put('/api/pc-agent/heartbeat',json={'hancom_ready':True,'version':VERSION},timeout=10).raise_for_status()
            except (httpx.HTTPError,RuntimeError):pass
    thread=threading.Thread(target=heartbeat,daemon=True);thread.start()
    try:
        with TemporaryDirectory(prefix='document-',dir=APP_HOME/'work') as folder:
            source=Path(folder)/('input'+task['extension'])
            pdf=Path(folder)/'input.pdf'
            with source.open('wb') as file,api.stream('GET',route+'/input',headers=headers) as response:
                response.raise_for_status()
                size=0
                for block in response.iter_bytes():
                    size+=len(block)
                    if size>200*1024*1024:raise ValueError('Input limit exceeded')
                    file.write(block)
            if hashlib.sha256(source.read_bytes()).hexdigest()!=task['sha256']:
                raise ValueError('Source hash mismatch')
            try:
                if task['kind']=='file':
                    from service.documents import read_signals
                    kind,pages,signals=read_signals({'_source':str(source)},renderer=renderer)
                    metadata={'kind':kind,'pages':pages,'signals':signals}
                else:renderer(source,pdf)
                if not pdf.is_file() or pdf.stat().st_size>120*1024*1024 or not len(PdfReader(pdf).pages):
                    raise ValueError('Invalid rendered PDF')
            except (OSError,ValueError,RuntimeError,subprocess.SubprocessError,PdfReadError):
                if not lost.is_set():api.put(route+'/failure',headers=headers).raise_for_status()
                event('conversion_failed',kind=task['kind'])
                return
            if lost.is_set():return
            if task['kind']=='file':api.put(route+'/metadata',json=metadata,headers=headers).raise_for_status()
            with pdf.open('rb') as stream:
                api.put(route+'/pdf',content=stream,headers={**headers,'Content-Type':'application/pdf','X-Source-Sha256':task['sha256']}).raise_for_status()
            event('completed',kind=task['kind'])
    finally:
        stop.set();thread.join(timeout=12)

def clear_interrupted_files():
    # Only our own generated filenames are removed; preserve unexpected user files and links.
    for directory,pattern in ((APP_HOME/'work',r'document-[a-zA-Z0-9_-]{8}'),(APP_HOME/'hancom/jobs',r'[a-f0-9]{32}')):
        if not directory.is_dir():continue
        root=directory.resolve()
        for folder in directory.iterdir():
            if not re.fullmatch(pattern,folder.name) or folder.is_symlink() or folder.is_junction() or not folder.is_dir():continue
            if folder.resolve().parent!=root:continue
            for name in ('input.hwp','input.hwpx','input.pdf','output.pdf','input.working.pdf','input.ocr.png'):
                file=folder/name
                if file.is_file() or file.is_symlink():file.unlink(missing_ok=True)
            try:folder.rmdir()
            except OSError:pass

def run():
    lock=worker_lock()
    if lock is None:return
    os.environ['AWARD_DATA_DIR']=str(APP_HOME/'data')
    os.environ['AWARDS_HANCOM_GUARD_DIR']=str(APP_HOME/'hancom')
    os.environ['AWARDS_POWERSHELL']=str(POWERSHELL)
    (APP_HOME/'work').mkdir(exist_ok=True)
    clear_interrupted_files()
    # The worker owns only its guarded conversion children; the renderer closes its own editor.
    wait=3
    previous=None
    while True:
        try:
            stage='credential'
            credential=load_connection()
            if not credential:
                if previous!='unpaired':event('unpaired');previous='unpaired'
                time.sleep(3);continue
            stage='hancom'
            ready=has_hancom()
            stage='https'
            with httpx.Client(base_url=SERVER,timeout=httpx.Timeout(connect=8,read=45,write=90,pool=8),trust_env=False,follow_redirects=False,
                              headers={'Authorization':'Bearer '+credential['token']}) as api:
                stage='heartbeat'
                api.put('/api/pc-agent/heartbeat',json={'hancom_ready':ready,'version':VERSION}).raise_for_status()
                event('connected' if ready else 'hancom_required',login=credential['login'])
                previous='connected'
                if ready:
                    stage='claim'
                    response=api.post('/api/pc-agent/claim');response.raise_for_status()
                    if response.status_code==200:
                        stage='conversion'
                        process(api,response.json());wait=1
                    else:wait=8
                else:wait=15
            time.sleep(wait)
        except httpx.HTTPStatusError as error:
            event('reconnect_required' if error.response.status_code==401 else 'retrying')
            time.sleep(15)
        except Exception as error:
            import traceback
            event('retrying',error=type(error).__name__,stage=stage,
                  frames=[Path(frame.filename).name+':'+frame.name+':'+str(frame.lineno)
                          for frame in traceback.extract_tb(error.__traceback__)])
            time.sleep(15)
