"""Opt-in real Hancom concurrency, PDF fidelity, timeout and parent-exit checks."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import threading
import time
from unittest.mock import patch
from uuid import uuid4
from zipfile import ZipFile

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
import operations.native as native
from service.documents import powershell,read_signals
from tests.official_inputs import official_files,fixture_slot
import pypdfium2 as pdfium
from pypdf import PdfReader


def fingerprint(path):
    reader=PdfReader(path)
    with pdfium.PdfDocument(str(path)) as document:
        pixels=[]
        for page in document:
            bitmap=page.render(scale=1)
            try:pixels.append(hashlib.sha256(bitmap.to_numpy().tobytes()).hexdigest())
            finally:bitmap.close();page.close()
    return dict(pages=len(reader.pages),text_sha256=hashlib.sha256('\n'.join(p.extract_text() for p in reader.pages).encode()).hexdigest(),page_pixels=pixels)


def alive(pid):
    import ctypes
    kernel=ctypes.WinDLL('kernel32',use_last_error=True)
    kernel.OpenProcess.argtypes=[ctypes.c_ulong,ctypes.c_bool,ctypes.c_ulong];kernel.OpenProcess.restype=ctypes.c_void_p
    kernel.GetExitCodeProcess.argtypes=[ctypes.c_void_p,ctypes.POINTER(ctypes.c_ulong)]
    kernel.CloseHandle.argtypes=[ctypes.c_void_p]
    handle=kernel.OpenProcess(0x1000,False,pid)
    if not handle:return False
    try:
        code=ctypes.c_ulong()
        return bool(kernel.GetExitCodeProcess(handle,ctypes.byref(code))) and code.value==259
    finally:kernel.CloseHandle(handle)


def wait_file(path,timeout=20):
    deadline=time.monotonic()+timeout
    while time.monotonic()<deadline:
        if path.is_file():
            try:return json.loads(path.read_text(encoding='utf-8-sig'))
            except (ValueError,OSError):pass
        time.sleep(.1)
    raise TimeoutError('Converter did not reach its private test barrier')


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--guard-dir',type=Path,required=True)
    parser.add_argument('--report',type=Path,default=ROOT/'var/pc-connector-deployment/e2e/report.hwpx')
    args=parser.parse_args()
    home=args.guard_dir.resolve()
    if not (home/'jobs').is_dir():raise RuntimeError('Use the installed private Hancom guard directory')
    os.environ.update(AWARDS_HANCOM_GUARD_DIR=str(home),AWARDS_POWERSHELL=r'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe')
    out=ROOT/'var/pc-parallel-native'/datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
    out.mkdir(parents=True)
    source={}
    for name,data in official_files('set01'):
        kind=fixture_slot(name)
        if kind in ('01','03'):
            source[kind]=out/('source-'+kind+Path(name).suffix.lower());source[kind].write_bytes(data)
    source['report']=args.report.resolve()
    source['report-other']=out/'other-report.hwpx'
    replacements=0
    with ZipFile(source['report']) as original,ZipFile(source['report-other'],'w') as other:
        for entry in original.infolist():
            data=original.read(entry.filename)
            if entry.filename.startswith('Contents/') and entry.filename.endswith('.xml'):
                replacements+=data.count('시연용'.encode())
                data=data.replace('시연용'.encode(),'시연용-B'.encode())
            other.writestr(entry,data)
    assert replacements>0,'Need a distinct report marker to detect crossed output'
    digests={k:hashlib.sha256(p.read_bytes()).hexdigest() for k,p in source.items()}
    result={'approved_input':'fictional set01 and previously verified zero-payment report','rounds':[]}
    thread=threading.local();diagnostics={};data_lock=threading.Lock()
    def record(*a,**kw):
        try:value=powershell(*a,**kw)
        except subprocess.CalledProcessError as error:
            (out/(thread.label+'-error.txt')).write_bytes(error.stderr)
            raise
        with data_lock:
            diagnostics[thread.label]=json.loads(value.stdout.decode('utf-8-sig'))
            (out/(thread.label+'-diagnostics.json')).write_text(json.dumps(diagnostics[thread.label],indent=2))
        return value
    def convert(label,kind,barrier=None):
        thread.label=label
        if barrier:barrier.wait(timeout=5)
        destination=out/(label+'.pdf');native.render(source[kind],destination)
        return destination
    baselines={}
    with patch('operations.native.powershell',side_effect=record):
        for kind in source:baselines[kind]=fingerprint(convert('baseline-'+kind,kind))
        for index,kinds in enumerate((('01','report'),('01','03'),('report','report-other'))):
            barrier=threading.Barrier(2)
            labels=[f'parallel-{index}-{slot}' for slot in (0,1)]
            with ThreadPoolExecutor(max_workers=2) as pool:
                futures=[pool.submit(convert,label,kind,barrier) for label,kind in zip(labels,kinds)]
                paths=[f.result(timeout=200) for f in futures]
            records=[diagnostics[label] for label in labels]
            assert len({r['editor_pid'] for r in records})==2
            starts=[datetime.datetime.fromisoformat(r['editor_started_at']) for r in records]
            ends=[datetime.datetime.fromisoformat(r['completed_at']) for r in records]
            overlap=(min(ends)-max(starts)).total_seconds()
            assert overlap>0,'Hancom editor lifetimes did not overlap'
            for kind,path in zip(kinds,paths):assert fingerprint(path)==baselines[kind],'Parallel output differs from sequential output'
            result['rounds'].append(dict(kinds=kinds,overlap_seconds=overlap,editors=records,pdf_matches_baseline=True))
            print(json.dumps(result['rounds'][-1]),flush=True)
        # Real concurrent OCR exercises the PDFium mutex with two independent documents.
        with ThreadPoolExecutor(max_workers=2) as pool:
            def signals(kind):
                thread.label='signals-'+kind
                return read_signals({'_source':str(source[kind])},renderer=native.render)
            values=list(pool.map(signals,('01','03')))
        assert [v[0] for v in values]==['01','03']
        result['parallel_signal_kinds']=[v[0] for v in values]

    guard=str(ROOT/'reporting/guard_hancom.ps1').replace("'","''")
    sentinel=out/'sentinel.ps1'
    sentinel.write_text("""param([string]$Ready,[string]$Release,[switch]$WaitForOwner)
$ErrorActionPreference='Stop'
if([Console]::ReadLine() -cne 'SWAX-OWNED'){throw 'Missing owner'}
$doc=$null;$owned=$false
try {
 $doc=New-Object -ComObject HWPFrame.HwpObject
 . '"""+guard+"""'
 Protect-ConverterEditor $doc;$owned=$true
 $doc.XHwpWindows.Item(0).Visible=$false
 $null=$doc.SetMessageBoxMode(0x00020000)
 $a=$doc.CreateAction('InsertText');$s=$a.CreateSet();$s.SetItem('Text','SWAX preservation sentinel');$null=$a.Execute($s)
 $before=$doc.GetTextFile('TEXT','')
 [IO.File]::WriteAllText($Ready,('{"editor_pid":'+[AwardEditorLifetime]::EditorId+'}'))
 while(!(Test-Path -LiteralPath $Release)){Start-Sleep -Milliseconds 100}
 [pscustomobject]@{unchanged=($before -ceq $doc.GetTextFile('TEXT',''));editor_pid=[AwardEditorLifetime]::EditorId} | ConvertTo-Json -Compress
} finally {if($doc -and $owned){$doc.Clear(1);$doc.Quit()}}
""",encoding='utf-8-sig')
    # Use the production converter, adding a test-only barrier immediately before SaveAs.
    held=out/'held.ps1'
    body=(ROOT/'service/convert.ps1').read_text(encoding='utf-8')
    body=body.replace(". (Join-Path $PSScriptRoot '../reporting/guard_hancom.ps1')",". '"+guard+"'")
    anchor="    if (!$doc.SaveAs"
    assert body.count(anchor)==1
    body=body.replace(anchor,"""    [IO.File]::WriteAllText(($Destination+'.ready.json'),('{"editor_pid":'+[AwardEditorLifetime]::EditorId+'}'))
    while(!(Test-Path -LiteralPath ($Destination+'.release'))){Start-Sleep -Milliseconds 100}
"""+anchor)
    held.write_text(body,encoding='utf-8-sig')
    module='SWAX-Reports-'+hashlib.sha256(str(home).upper().encode()).hexdigest()[:24].upper()
    private=[]
    def job(kind):
        folder=home/'jobs'/uuid4().hex;folder.mkdir();private.append(folder)
        original=folder/('input'+source[kind].suffix);shutil.copyfile(source[kind],original)
        return original,folder/'output.pdf'
    ready=out/'sentinel-ready.json';release=out/'sentinel-release'
    with ThreadPoolExecutor(max_workers=3) as pool:
        sentinel_future=pool.submit(powershell,sentinel,'-Ready',ready,'-Release',release,timeout=120,isolated=True)
        sentinel_pid=wait_file(ready)['editor_pid']
        try:
            first,first_pdf=job('01');second,second_pdf=job('report')
            failing=pool.submit(powershell,held,first,first_pdf,'-Guard',module,timeout=18,isolated=True)
            working=pool.submit(powershell,held,second,second_pdf,'-Guard',module,timeout=60,isolated=True)
            failed_pid=wait_file(Path(str(first_pdf)+'.ready.json'))['editor_pid']
            working_pid=wait_file(Path(str(second_pdf)+'.ready.json'))['editor_pid']
            try:failing.result(timeout=25)
            except subprocess.TimeoutExpired:pass
            else:raise AssertionError('The fault fixture did not time out')
            deadline=time.monotonic()+5
            while alive(failed_pid) and time.monotonic()<deadline:time.sleep(.1)
            assert not alive(failed_pid) and alive(working_pid) and alive(sentinel_pid)
            Path(str(second_pdf)+'.release').touch()
            working.result(timeout=30)
            assert fingerprint(second_pdf)==baselines['report']
            result['timeout_isolated']=True
            # Killing the Python owner must also remove its converter and Hancom child.
            third,third_pdf=job('01')
            child=out/'parent-exit.py'
            child.write_text('import sys\nsys.path.insert(0,'+repr(str(ROOT))+')\nfrom service.documents import powershell\npowershell('+repr(str(held))+','+repr(str(third))+','+repr(str(third_pdf))+',"-Guard",'+repr(module)+',timeout=90,isolated=True)\n',encoding='utf-8')
            owner=subprocess.Popen([sys.executable,str(child)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,creationflags=subprocess.CREATE_NO_WINDOW)
            try:
                orphan=wait_file(Path(str(third_pdf)+'.ready.json'))['editor_pid']
                owner.kill();owner.wait(timeout=10)
                deadline=time.monotonic()+5
                while alive(orphan) and time.monotonic()<deadline:time.sleep(.1)
                assert not alive(orphan) and alive(sentinel_pid)
                result['parent_exit_cleans_owned_editor']=True
            finally:
                if owner.poll() is None:owner.kill();owner.wait(timeout=10)
        finally:
            release.touch()
            response=sentinel_future.result(timeout=20)
            result['preexisting_document_preserved']=json.loads(response.stdout.decode('utf-8-sig'))['unchanged']
            assert result['preexisting_document_preserved']
            for folder in private:
                assert folder.resolve().parent==home/'jobs'
                for name in ('input.hwp','input.hwpx','output.pdf','output.pdf.ready.json','output.pdf.release'):
                    (folder/name).unlink(missing_ok=True)
                folder.rmdir()
    assert all(hashlib.sha256(p.read_bytes()).hexdigest()==digests[k] for k,p in source.items())
    result['source_hashes_unchanged']=True
    result['passed']=True
    (out/'result.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
    print(json.dumps({'passed':True,'result':str(out/'result.json')}),flush=True)


if __name__=='__main__':main()
