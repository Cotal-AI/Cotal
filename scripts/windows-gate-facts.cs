// Harness only. Compile with the built-in Framework64 csc.exe, not a product dependency.
// Lock semantics: https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-lockfileex
// Inheritance: https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessw
using System;
using System.IO;
using System.Text;
using System.Diagnostics;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Threading;
using System.Web.Script.Serialization;
using System.Collections.Generic;

public static class WindowsGateFacts {
    const uint LockOffset = 1073741824; // Same one-byte range as seat/native/peercred_win32.c.
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    [StructLayout(LayoutKind.Sequential)] struct SA { public int length; public IntPtr descriptor; [MarshalAs(UnmanagedType.Bool)] public bool inherit; }
    [StructLayout(LayoutKind.Sequential)] struct OV { public UIntPtr internalLow, internalHigh; public uint offset, offsetHigh; public IntPtr evt; }
    [StructLayout(LayoutKind.Sequential)] struct FT { public uint low, high; public long Value { get { return ((long)high << 32) | low; } } }
    [StructLayout(LayoutKind.Sequential)] struct INFO { public uint attributes; public FT created, accessed, written; public uint volume, sizeHigh, sizeLow, links, indexHigh, indexLow; }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct SI {
        public int cb; public string reserved, desktop, title; public uint x,y,xSize,ySize,xChars,yChars,fill,flags; public ushort show,reservedSize; public IntPtr reservedBytes,input,output,error;
    }
    [StructLayout(LayoutKind.Sequential)] struct SIX { public SI startup; public IntPtr attributes; }
    [StructLayout(LayoutKind.Sequential)] struct PI { public IntPtr process, thread; public uint pid, tid; }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFileW(string path,uint access,uint share,ref SA sa,uint creation,uint flags,IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool LockFileEx(IntPtr h,uint flags,uint reserved,uint low,uint high,ref OV ov);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetHandleInformation(IntPtr h,out uint flags);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(IntPtr h,out INFO info);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool ReadFile(IntPtr h,byte[] buffer,uint size,out uint read,IntPtr ov);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcessW(string app,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref SIX si,out PI pi);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,uint flags,ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr h,out FT birth,out FT exit,out FT kernel,out FT user);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr h,uint exitCode);

    static void Check(bool ok,string api) { if(!ok) throw new Win32Exception(Marshal.GetLastWin32Error(),api); }
    static string Exe { get { return System.Reflection.Assembly.GetExecutingAssembly().Location; } }
    static string Q(string s) { if(s.Contains("\"") || s.EndsWith("\\")) throw new Exception("Unsafe argument"); return "\""+s+"\""; }
    static void Save(string dir,string name,object value) {
        string path=Path.Combine(dir,name); File.WriteAllText(path+".tmp",Json.Serialize(value),new UTF8Encoding(false)); File.Move(path+".tmp",path);
    }
    static Dictionary<string,object> Load(string dir,string name) { return Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(Path.Combine(dir,name))); }
    static object Identity() {
        using(Process p=Process.GetCurrentProcess()) { return new { pid=p.Id,birthTicks=p.StartTime.ToUniversalTime().Ticks.ToString(),sid=WindowsIdentity.GetCurrent().User.Value,executable=Exe,command=Environment.CommandLine }; }
    }
    static string FileId(INFO i) { return i.volume+":"+i.indexHigh+":"+i.indexLow; }
    static IntPtr Open(string path,bool inherit) {
        SA sa=new SA {length=Marshal.SizeOf(typeof(SA)),inherit=inherit};
        IntPtr h=CreateFileW(path,0xC0000000,3,ref sa,3,0,IntPtr.Zero);
        if(h==new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error(),"CreateFileW"); return h;
    }
    static object Attempt(string dir) {
        IntPtr h=Open(Path.Combine(dir,"lock.bin"),false);
        try { OV ov=new OV {offset=LockOffset}; bool acquired=LockFileEx(h,3,0,1,0,ref ov); int error=acquired?0:Marshal.GetLastWin32Error();
            return new { identity=Identity(),utc=DateTime.UtcNow.ToString("o"),acquired=acquired,lastError=error,outcome=acquired?"granted":(error==33?"refused":"unexpected-error"),offset=LockOffset,length=1,flags=3 };
        } finally { CloseHandle(h); }
    }
    static void Runner(string dir) {
        IntPtr h=Open(Path.Combine(dir,"lock.bin"),true);
        try {
            OV ov=new OV {offset=LockOffset}; Check(LockFileEx(h,3,0,1,0,ref ov),"runner LockFileEx");
            uint flags; INFO info; Check(GetHandleInformation(h,out flags),"runner GetHandleInformation"); Check(GetFileInformationByHandle(h,out info),"runner GetFileInformationByHandle");
            Save(dir,"runner.json",new {identity=Identity(),handle=h.ToInt64().ToString(),handleFlags=flags,fileId=FileId(info),lockOffset=LockOffset,lockLength=1});
            PI pi;
            string command=Q(Exe)+" child "+Q(dir)+" "+h.ToInt64().ToString();
            IntPtr size=IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref size);
            if(size==IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(),"attribute list size");
            IntPtr list=Marshal.AllocHGlobal(size), handles=Marshal.AllocHGlobal(IntPtr.Size);
            bool initialized=false;
            try {
                Check(InitializeProcThreadAttributeList(list,1,0,ref size),"InitializeProcThreadAttributeList"); initialized=true;
                Marshal.WriteIntPtr(handles,h);
                // PROC_THREAD_ATTRIBUTE_HANDLE_LIST: no arbitrary controller/stdio handles.
                Check(UpdateProcThreadAttribute(list,0,new IntPtr(0x20002),handles,new IntPtr(IntPtr.Size),IntPtr.Zero,IntPtr.Zero),"UpdateProcThreadAttribute HANDLE_LIST");
                SIX si=new SIX {startup=new SI {cb=Marshal.SizeOf(typeof(SIX))},attributes=list};
                Check(CreateProcessW(Exe,new StringBuilder(command),IntPtr.Zero,IntPtr.Zero,true,0x80000,IntPtr.Zero,dir,ref si,out pi),"CreateProcessW");
            } finally {
                if(initialized) DeleteProcThreadAttributeList(list);
                Marshal.FreeHGlobal(handles); Marshal.FreeHGlobal(list);
            }
            try {
                FT birth,exit,kernel,user; Check(GetProcessTimes(pi.process,out birth,out exit,out kernel,out user),"GetProcessTimes");
                Save(dir,"child-owner.json",new {pid=pi.pid,birthTicks=DateTime.FromFileTimeUtc(birth.Value).Ticks.ToString(),executable=Exe,command=command});
            } catch { TerminateProcess(pi.process,1); throw; }
            finally { CloseHandle(pi.thread); CloseHandle(pi.process); }
            Thread.Sleep(90000); // Bounded orphan lifetime even if the observer is interrupted.
        } finally { CloseHandle(h); }
    }
    static void Child(string dir,string numeric) {
        // No CreateFileW here. Every native proof uses ONLY the passed inherited HANDLE.
        IntPtr h=new IntPtr(Int64.Parse(numeric));
        try {
            uint flags,read; INFO info; byte[] b=new byte[1];
            Check(GetHandleInformation(h,out flags),"child GetHandleInformation");
            Check(GetFileInformationByHandle(h,out info),"child GetFileInformationByHandle");
            Check(ReadFile(h,b,1,out read,IntPtr.Zero),"child ReadFile");
            if(read!=1 || b[0]!=71 || (flags&1)==0) throw new Exception("Inherited native handle proof failed");
            Save(dir,"child-ready.json",new {identity=Identity(),handle=numeric,handleFlags=flags,fileId=FileId(info),nativeReadBytes=read,nativeReadByte=b[0]});
            Stopwatch clock=Stopwatch.StartNew();
            while(!File.Exists(Path.Combine(dir,"release")) && clock.ElapsedMilliseconds<90000) Thread.Sleep(25);
        } finally { CloseHandle(h); }
    }
    static void WaitFile(string dir,string name) {
        Stopwatch clock=Stopwatch.StartNew(); while(!File.Exists(Path.Combine(dir,name))) {
            if(clock.ElapsedMilliseconds>20000) throw new TimeoutException(name); Thread.Sleep(25);
        }
    }
    static Process Owned(Dictionary<string,object> identity) {
        Process p=Process.GetProcessById(Convert.ToInt32(identity["pid"]));
        try {
            IntPtr pinned=p.Handle;
            if(p.HasExited || p.StartTime.ToUniversalTime().Ticks.ToString()!=(string)identity["birthTicks"] || !String.Equals(p.MainModule.FileName,(string)identity["executable"],StringComparison.OrdinalIgnoreCase)) throw new Exception("Owned PID/birth/path mismatch");
            return p;
        } catch { p.Dispose(); throw; }
    }
    static void Stop(Process p) { if(p!=null && !p.HasExited) { p.Kill(); if(!p.WaitForExit(10000)) throw new Exception("Owned process failed to exit"); } }
    static Dictionary<string,object> Probe(string dir,string name) {
        ProcessStartInfo si=new ProcessStartInfo(Exe,"probe "+Q(dir)+" "+name) {UseShellExecute=false,CreateNoWindow=true};
        using(Process p=Process.Start(si)) {
            IntPtr pinned=p.Handle;
            try { if(!p.WaitForExit(10000)) throw new TimeoutException("probe"); if(p.ExitCode!=0) throw new Exception("probe failed: "+p.ExitCode); return Load(dir,name); }
            finally { Stop(p); }
        }
    }
    static void Observe(string dir) {
        Process runner=null,child=null; var report=new Dictionary<string,object>();
        report["schema"]=1; report["observer"]=Identity(); report["os"]=Environment.OSVersion.VersionString;
        report["acceptance"]="Measurement only. Granted while child lives is a valid factual negative, not proof of an inherited gate.";
        report["range"]=new {offset=LockOffset,length=1,flags=3};
        try {
            File.WriteAllBytes(Path.Combine(dir,"lock.bin"),new byte[]{71});
            runner=Process.Start(new ProcessStartInfo(Exe,"runner "+Q(dir)) {UseShellExecute=false,CreateNoWindow=true}); IntPtr pinned=runner.Handle;
            WaitFile(dir,"child-owner.json"); child=Owned(Load(dir,"child-owner.json"));
            WaitFile(dir,"child-ready.json");
            var parentProof=Load(dir,"runner.json"); var childProof=Load(dir,"child-ready.json");
            if((string)parentProof["handle"]!=(string)childProof["handle"] || (string)parentProof["fileId"]!=(string)childProof["fileId"]) throw new Exception("Inherited handle/file identity mismatch");
            report["runner"]=parentProof; report["child"]=childProof;
            var before=Probe(dir,"before.json"); report["beforeRunnerDeath"]=before;
            if((string)before["outcome"]!="refused") throw new Exception("Baseline runner-held lock did not refuse with ERROR_LOCK_VIOLATION");
            if(child.HasExited) throw new Exception("Child exited before runner kill");
            Stop(runner); report["runnerExitObservedUtc"]=DateTime.UtcNow.ToString("o");
            bool aliveBefore=!child.HasExited;
            var during=Probe(dir,"during.json"); report["whileChildLives"]=during;
            bool aliveAfter=!child.HasExited;
            report["childAliveBeforeProbe"]=aliveBefore; report["childAliveAfterProbe"]=aliveAfter;
            if(!aliveBefore || !aliveAfter) throw new Exception("Child lifetime did not bracket probe");
            if((string)during["outcome"]=="unexpected-error") throw new Exception("Unexpected native error while child lives");
            File.WriteAllText(Path.Combine(dir,"release"),"release");
            if(!child.WaitForExit(10000) || child.ExitCode!=0) throw new Exception("Child did not exit cleanly");
            report["childExitObservedUtc"]=DateTime.UtcNow.ToString("o");
            var after=Probe(dir,"after.json"); report["afterChildExit"]=after;
            if(!(bool)after["acquired"]) throw new Exception("Lock not granted after child exit, inspect native error");
            report["measurementComplete"]=true;
        } catch(Exception e) { report["measurementComplete"]=false; report["error"]=e.ToString(); Environment.ExitCode=1; }
        finally {
            var errors=new List<string>();
            try { Stop(runner); } catch(Exception e) { errors.Add("runner: "+e.Message); }
            // Runner is now stopped, so no new child can appear after the ownership check.
            try { if(child==null && File.Exists(Path.Combine(dir,"child-owner.json"))) child=Owned(Load(dir,"child-owner.json")); Stop(child); } catch(Exception e) { errors.Add("child: "+e.Message); }
            if(child!=null) child.Dispose(); if(runner!=null) runner.Dispose();
            report["cleanupErrors"]=errors; if(errors.Count!=0) Environment.ExitCode=1;
            Save(dir,"report.json",report); Console.WriteLine(Json.Serialize(report));
        }
    }
    public static int Main(string[] args) {
        try {
            if(args.Length<2) throw new Exception("mode and private directory required");
            switch(args[0]) {
                case "observe": Observe(args[1]); break;
                case "runner": Runner(args[1]); break;
                case "child": Child(args[1],args[2]); break;
                case "probe": Save(args[1],args[2],Attempt(args[1])); break;
                default: throw new Exception("Unknown mode");
            }
            return Environment.ExitCode;
        } catch(Exception e) { Console.Error.WriteLine(e); return 1; }
    }
}
