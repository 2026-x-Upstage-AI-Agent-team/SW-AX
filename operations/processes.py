"""Keep a gated Windows converter inside a job owned by its Python parent."""
import ctypes
from ctypes import wintypes
import subprocess


def run_owned(command, *, timeout):
    class Basic(ctypes.Structure):
        _fields_=[('process_time',ctypes.c_int64),('job_time',ctypes.c_int64),('flags',wintypes.DWORD),
                  ('min_working_set',ctypes.c_size_t),('max_working_set',ctypes.c_size_t),
                  ('active_processes',wintypes.DWORD),('affinity',ctypes.c_size_t),
                  ('priority',wintypes.DWORD),('scheduling',wintypes.DWORD)]
    class Limits(ctypes.Structure):
        _fields_=[('basic',Basic),('io',ctypes.c_uint64*6),('process_memory',ctypes.c_size_t),
                  ('job_memory',ctypes.c_size_t),('peak_process',ctypes.c_size_t),('peak_job',ctypes.c_size_t)]
    kernel=ctypes.WinDLL('kernel32',use_last_error=True)
    kernel.CreateJobObjectW.argtypes=[ctypes.c_void_p,wintypes.LPCWSTR]
    kernel.CreateJobObjectW.restype=wintypes.HANDLE
    kernel.SetInformationJobObject.argtypes=[wintypes.HANDLE,ctypes.c_int,ctypes.c_void_p,wintypes.DWORD]
    kernel.SetInformationJobObject.restype=wintypes.BOOL
    kernel.AssignProcessToJobObject.argtypes=[wintypes.HANDLE,wintypes.HANDLE]
    kernel.AssignProcessToJobObject.restype=wintypes.BOOL
    kernel.CloseHandle.argtypes=[wintypes.HANDLE]
    kernel.CloseHandle.restype=wintypes.BOOL
    job=kernel.CreateJobObjectW(None,None)
    if not job:raise ctypes.WinError(ctypes.get_last_error())
    process=None
    try:
        # Track the converter itself; shared Hancom/PDF helper children have their own lifetime.
        limits=Limits();limits.basic.flags=0x3000  # KILL_ON_JOB_CLOSE | SILENT_BREAKAWAY_OK
        if not kernel.SetInformationJobObject(job,9,ctypes.byref(limits),ctypes.sizeof(limits)):
            raise ctypes.WinError(ctypes.get_last_error())
        process=subprocess.Popen(command,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
                                 creationflags=subprocess.CREATE_NO_WINDOW)
        # The converter cannot create Hancom until its parent has attached this process.
        if not kernel.AssignProcessToJobObject(job,int(process._handle)):
            raise ctypes.WinError(ctypes.get_last_error())
        stdout,stderr=process.communicate(b'SWAX-OWNED\n',timeout=timeout)
        if process.returncode:raise subprocess.CalledProcessError(process.returncode,command,stdout,stderr)
        return subprocess.CompletedProcess(command,process.returncode,stdout,stderr)
    finally:
        kernel.CloseHandle(job)
        if process is not None and process.poll() is None:
            process.kill()
            process.communicate()
