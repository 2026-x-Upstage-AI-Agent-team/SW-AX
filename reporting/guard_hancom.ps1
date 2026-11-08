# Tie only a newly created automation editor to the lifetime of its converter.
# A pre-existing interactive Hangul process must never be attached to this job.
function Protect-ConverterEditor($Editor) {
    Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class AwardEditorLifetime {
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out int id);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attrs, string name);
    [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int level, IntPtr info, uint size);
    [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
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
        if (window == IntPtr.Zero || GetWindowThreadProcessId(window, out id) == 0) return;
        using (var process = Process.GetProcessById(id))
        using (var self = Process.GetCurrentProcess()) {
            if (!process.ProcessName.Equals("Hwp", StringComparison.OrdinalIgnoreCase)
                || process.StartTime < self.StartTime) return;
            var job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) return;
            var limits = new Limits();
            limits.basic.flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            int size = Marshal.SizeOf(limits);
            var ptr = Marshal.AllocHGlobal(size);
            try {
                Marshal.StructureToPtr(limits, ptr, false);
                if (!SetInformationJobObject(job, 9, ptr, (uint)size) ||
                    !AssignProcessToJobObject(job, process.Handle)) CloseHandle(job);
                // On success the OS releases the only job handle when this converter exits.
            } finally { Marshal.FreeHGlobal(ptr); }
        }
    }
}
'@
    [AwardEditorLifetime]::Bind([IntPtr]::new([long]$Editor.XHwpWindows.Item(0).WindowHandle))
}
