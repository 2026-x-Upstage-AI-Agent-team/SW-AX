"""Current-user installation, protected credentials and a cross-process worker lock."""
import ctypes
from ctypes import wintypes
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import winreg
from uuid import uuid4

VERSION='1.1.0'
SERVER='https://d3nkw8bzgv8pom.cloudfront.net'
APP_HOME=Path(os.environ['LOCALAPPDATA'])/'SWAX/PCConnector'
RESOURCES=Path(getattr(sys,'_MEIPASS',Path(__file__).resolve().parents[1]))
POWERSHELL=Path(os.environ['SystemRoot'])/'System32/WindowsPowerShell/v1.0/powershell.exe'
_probe_time=0
_probe_ready=False

class Blob(ctypes.Structure):
    _fields_=[('size',wintypes.DWORD),('data',ctypes.POINTER(ctypes.c_ubyte))]

def protected(data,encrypt):
    buf=ctypes.create_string_buffer(data)
    source=Blob(len(data),ctypes.cast(buf,ctypes.POINTER(ctypes.c_ubyte)))
    output=Blob()
    function=ctypes.windll.crypt32.CryptProtectData if encrypt else ctypes.windll.crypt32.CryptUnprotectData
    if not function(ctypes.byref(source),None,None,None,None,1,ctypes.byref(output)):
        raise ctypes.WinError()
    try:return ctypes.string_at(output.data,output.size)
    finally:ctypes.windll.kernel32.LocalFree(output.data)

def save_connection(value):
    APP_HOME.mkdir(parents=True,exist_ok=True)
    target=APP_HOME/'connection.bin'
    temp=APP_HOME/'connection.tmp'
    temp.write_bytes(protected(json.dumps(value).encode('utf-8'),True))
    temp.replace(target)

def load_connection():
    target=APP_HOME/'connection.bin'
    if not target.exists():return None
    return json.loads(protected(target.read_bytes(),False))

def notice(message,error=False):
    ctypes.windll.user32.MessageBoxW(None,message,'SW·AX PC 연결',0x10 if error else 0x40)

def confirm_connection(login):
    return ctypes.windll.user32.MessageBoxW(None,
        login+' 계정의 문서를 이 PC의 한글로 처리하도록 연결하시겠습니까?\n\n'
        '웹에서 로그인한 계정과 같은지 확인해 주세요.\n'+SERVER,
        'SW·AX 계정 연결 확인',0x24)==6

def executable():
    return APP_HOME/VERSION/'SWAX-PC.exe'

def start_worker():
    startup=APP_HOME/'startup.json'
    if startup.is_file():
        name=json.loads(startup.read_text(encoding='utf-8'))['task_name']
        if not name.startswith('SWAX-PC-Connector-'):raise RuntimeError('Unexpected startup task')
        subprocess.run(['schtasks.exe','/Run','/TN',name],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,creationflags=subprocess.CREATE_NO_WINDOW,check=True,timeout=20)
        return
    subprocess.Popen([str(executable()),'--background'],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,
                     stderr=subprocess.DEVNULL,creationflags=subprocess.CREATE_NO_WINDOW)

def register():
    binary=str(executable())
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER,r'Software\Classes\swax-pc') as key:
        winreg.SetValueEx(key,'',0,winreg.REG_SZ,'URL:SWAX PC Connector')
        winreg.SetValueEx(key,'URL Protocol',0,winreg.REG_SZ,'')
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER,r'Software\Classes\swax-pc\shell\open\command') as key:
        winreg.SetValueEx(key,'',0,winreg.REG_SZ,'"'+binary+'" "%1"')
    result=subprocess.run([str(POWERSHELL),'-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',
        str(RESOURCES/'pc_connector/install-task.ps1'),'-Executable',binary],stdin=subprocess.DEVNULL,
        capture_output=True,creationflags=subprocess.CREATE_NO_WINDOW,check=True,timeout=30)
    metadata=json.loads(result.stdout.decode('utf-8-sig'))
    (APP_HOME/'startup.json').write_text(json.dumps(metadata),encoding='utf-8')

def install(quiet=False):
    if not quiet:
        answer=ctypes.windll.user32.MessageBoxW(None,
            '이 Windows 계정에 SW·AX PC 연결 프로그램을 설치합니다.\n\n'
            '웹에서 연결한 담당자의 문서만 이 PC의 한글로 변환합니다.\n'
            'Windows 로그인 시 자동 실행하며 AWS 로그인은 필요하지 않습니다.\n\n설치하시겠습니까?',
            'SW·AX PC 연결 프로그램 설치',0x24)
        if answer!=6:return False
    target=executable()
    target.parent.mkdir(parents=True,exist_ok=True)
    source=Path(sys.executable)
    if source.resolve()!=target.resolve():
        digest=lambda path:hashlib.sha256(path.read_bytes()).digest()
        if not target.exists() or digest(target)!=digest(source):
            temp=target.with_suffix('.new.exe');shutil.copyfile(source,temp)
            if digest(temp)!=digest(source):raise RuntimeError('Installer copy failed')
            temp.replace(target)
    home=APP_HOME/'hancom';(home/'jobs').mkdir(parents=True,exist_ok=True)
    tag=hashlib.sha256(str(home).upper().encode('utf-8')).hexdigest()[:24].upper()
    for bits,view in ((32,winreg.KEY_WOW64_32KEY),(64,winreg.KEY_WOW64_64KEY)):
        source=RESOURCES/'pc_connector/assets'/f'guard-{bits}.dll'
        digest=hashlib.sha256(source.read_bytes()).hexdigest()
        destination=home/f'guard-{digest[:12]}-{bits}.dll'
        if destination.exists():
            if hashlib.sha256(destination.read_bytes()).hexdigest()!=digest:raise RuntimeError('Guard file mismatch')
        else:shutil.copyfile(source,destination)
        with winreg.CreateKeyEx(winreg.HKEY_CURRENT_USER,r'Software\HNC\HwpAutomation\Modules',0,winreg.KEY_WRITE|view) as key:
            winreg.SetValueEx(key,f'SWAX-Reports-{tag}-{bits}',0,winreg.REG_SZ,str(destination))
    register()
    start_worker()
    if not quiet:
        notice('설치가 완료됐습니다.\n웹의 PC 연결 화면에서 「이 PC 연결」을 눌러 주세요.')
        import webbrowser
        webbrowser.open(SERVER+'/#/pc-connect')
    return True

def worker_lock():
    import msvcrt
    APP_HOME.mkdir(parents=True,exist_ok=True)
    handle=(APP_HOME/'worker.lock').open('a+b')
    handle.seek(0);handle.write(b'0');handle.flush();handle.seek(0)
    try:msvcrt.locking(handle.fileno(),msvcrt.LK_NBLCK,1)
    except OSError:handle.close();return None
    return handle

def has_hancom():
    global _probe_time,_probe_ready
    if time.monotonic()-_probe_time<300:return _probe_ready
    _probe_time=time.monotonic()
    _probe_ready=False
    for view in (winreg.KEY_WOW64_64KEY,winreg.KEY_WOW64_32KEY):
        try:
            with winreg.OpenKey(winreg.HKEY_CLASSES_ROOT,r'HWPFrame.HwpObject\CLSID',0,winreg.KEY_READ|view):
                home=APP_HOME/'hancom'
                if not (home/'jobs').is_dir():return False
                work=home/'jobs'/uuid4().hex;work.mkdir()
                output=work/'output.pdf'
                tag=hashlib.sha256(str(home).upper().encode('utf-8')).hexdigest()[:24].upper()
                try:
                    from operations.processes import run_owned
                    result=run_owned([str(POWERSHELL),'-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass',
                        '-File',str(RESOURCES/'pc_connector/probe.ps1'),'-Destination',str(output),'-Guard','SWAX-Reports-'+tag,
                        '-WaitForOwner'],timeout=45)
                    if result.returncode==0 and output.is_file():
                        from pypdf import PdfReader
                        _probe_ready=bool(len(PdfReader(output).pages))
                finally:
                    output.unlink(missing_ok=True);work.rmdir()
                return _probe_ready
        except FileNotFoundError:pass
        except subprocess.SubprocessError:return False
    return False
