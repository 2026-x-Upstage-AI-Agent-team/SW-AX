# Tie only a newly created automation editor to the lifetime of its converter.
# A pre-existing interactive Hangul process must never be attached to this job.
function Protect-ConverterEditor($Editor) {
    Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.ComponentModel;
using System.Threading;
public static class AwardEditorLifetime {
    static Mutex editorOwnership;
    public static int EditorId { get; private set; }
    public static DateTime EditorStartedAt { get; private set; }
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out int id);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attrs, string name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int level, IntPtr info, uint size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [StructLayout(LayoutKind.Sequential)] struct Basic {
        public long perProcessTime, perJobTime;
        public uint flags;
        public UIntPtr minWorkingSet, maxWorkingSet;
        public uint activeProcesses;
        public UIntPtr affinity;
        public uint priority, scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct Limits {
        public Basic basic;
        public ulong readOps, writeOps, otherOps, readBytes, writeBytes, otherBytes;
        public UIntPtr processMemory, jobMemory, peakProcess, peakJob;
    }
    public static void Bind(IntPtr window) {
        int id;
        if (window == IntPtr.Zero || GetWindowThreadProcessId(window, out id) == 0)
            throw new InvalidOperationException("Cannot identify the automation editor");
        using (var process = Process.GetProcessById(id))
        using (var self = Process.GetCurrentProcess()) {
            if (!process.ProcessName.Equals("Hwp", StringComparison.OrdinalIgnoreCase)
                || process.StartTime < self.StartTime)
                throw new InvalidOperationException("Refusing a pre-existing editor");
            bool created;
            editorOwnership = new Mutex(true, "Local\\SWAX-Hancom-"+id+"-"+process.StartTime.ToUniversalTime().Ticks, out created);
            if (!created) {
                editorOwnership.Dispose(); editorOwnership=null;
                throw new InvalidOperationException("The editor belongs to another conversion");
            }
            var job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) {
                int error=Marshal.GetLastWin32Error(); process.Kill();
                throw new Win32Exception(error);
            }
            var limits = new Limits();
            // Shared PDF helpers must not be terminated when just this editor exits.
            limits.basic.flags = 0x3000; // KILL_ON_JOB_CLOSE | SILENT_BREAKAWAY_OK
            int size = Marshal.SizeOf(limits);
            var ptr = Marshal.AllocHGlobal(size);
            try {
                Marshal.StructureToPtr(limits, ptr, false);
                if (!SetInformationJobObject(job, 9, ptr, (uint)size) ||
                    !AssignProcessToJobObject(job, process.Handle)) {
                    int error=Marshal.GetLastWin32Error(); CloseHandle(job); process.Kill();
                    throw new Win32Exception(error);
                }
                EditorId=id;
                EditorStartedAt=process.StartTime.ToUniversalTime();
                // On success the OS releases the only job handle when this converter exits.
            } finally { Marshal.FreeHGlobal(ptr); }
        }
    }
}
'@
    [AwardEditorLifetime]::Bind([IntPtr]::new([long]$Editor.XHwpWindows.Item(0).WindowHandle))
}
