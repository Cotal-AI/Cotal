// Harness observation only. Never opens or retains the product Job Object.
using System;
using System.IO;
using System.Text;
using System.Diagnostics;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Threading;
using System.Collections.Generic;
using System.Security.Principal;
using System.Management;
using System.Web.Script.Serialization;
public static class WindowsJobFacts {
 static JavaScriptSerializer J = new JavaScriptSerializer { MaxJsonLength = Int32.MaxValue };
 [StructLayout(LayoutKind.Sequential)] struct FT { public uint lo,hi; public string Token { get { return (((ulong)hi<<32)|lo).ToString(); } } }
 [StructLayout(LayoutKind.Sequential)] struct OV { public UIntPtr low,high; public uint offset,offsetHigh; public IntPtr evt; }
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct SI { public int cb; public string reserved,desktop,title; public uint x,y,xs,ys,xc,yc,fill,flags; public ushort show,rs; public IntPtr rb,input,output,error; }
 [StructLayout(LayoutKind.Sequential)] struct PI { public IntPtr process,thread; public uint pid,tid; }
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool QueryFullProcessImageNameW(IntPtr h,uint flags,StringBuilder path,ref uint size);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr h,uint access,out IntPtr token);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr h,out FT birth,out FT exit,out FT kernel,out FT user);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr h,out uint code);
 [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr h,uint ms);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr h,uint code);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsProcessInJob(IntPtr p,IntPtr job,out bool inside);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int cls,IntPtr data,uint size,out uint returned);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool LockFileEx(IntPtr h,uint flags,uint reserved,uint low,uint high,ref OV ov);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool UnlockFileEx(IntPtr h,uint reserved,uint low,uint high,ref OV ov);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcessW(string app,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref SI si,out PI pi);
 static void Check(bool ok,string api) { if(!ok) throw new Win32Exception(Marshal.GetLastWin32Error(),api); }
 static long Tick() { return Stopwatch.GetTimestamp(); }
 static string Q(string s) { if(s.Contains("\"") || s.EndsWith("\\")) throw new Exception("Unsafe argument"); return "\""+s+"\""; }
 static void Save(string dir,string name,object value) { string p=Path.Combine(dir,name); File.WriteAllText(p+".tmp",J.Serialize(value),new UTF8Encoding(false)); File.Move(p+".tmp",p); }
 static Dictionary<string,object> Load(string d,string n) {
  // Node publishes a closed temp file by rename. Permit its transient delete/write access,
  // rather than failing setup when a rename-associated handle overlaps this read.
  using(var stream=new FileStream(Path.Combine(d,n),FileMode.Open,FileAccess.Read,FileShare.ReadWrite|FileShare.Delete))
  using(var reader=new StreamReader(stream,Encoding.UTF8,true)) return J.Deserialize<Dictionary<string,object>>(reader.ReadToEnd());
 }
 static void LoadControl(string dir) {
  string name="load-sharing-control.json";
  using(var writer=new FileStream(Path.Combine(dir,name),FileMode.CreateNew,FileAccess.ReadWrite,FileShare.ReadWrite|FileShare.Delete)) {
   byte[] bytes=Encoding.UTF8.GetBytes("{\"control\":true}"); writer.Write(bytes,0,bytes.Length); writer.Flush();
   var result=Load(dir,name); if(!(bool)result["control"])throw new Exception("Native shared-handle read control failed");
   Save(dir,"load-sharing-result.json",new {pass=true,writerHeldDuringRead=true,retry=false});
  }
 }
 static IntPtr Pin(Dictionary<string,object> id,bool kill) {
  IntPtr h=OpenProcess(0x100000|0x1000|(kill?1u:0u),false,Convert.ToInt32(id["pid"]));
  if(h==IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(),"OpenProcess exact identity");
  FT b,e,k,u; try { Check(GetProcessTimes(h,out b,out e,out k,out u),"GetProcessTimes"); if(b.Token!=(string)id["token"]) throw new Exception("Pinned birth mismatch");
   var path=new StringBuilder(32768); uint size=32768; Check(QueryFullProcessImageNameW(h,0,path,ref size),"QueryFullProcessImageName"); if(!String.Equals(path.ToString(),(string)id["executable"],StringComparison.OrdinalIgnoreCase)) throw new Exception("Pinned executable mismatch");
   IntPtr token; Check(OpenProcessToken(h,8,out token),"OpenProcessToken"); try { using(var wi=new WindowsIdentity(token)) { if(wi.User.Value!=(string)id["sid"]) throw new Exception("Pinned SID mismatch"); } } finally { CloseHandle(token); }
   if(!Alive(h)) throw new Exception("Identity already exited"); return h; } catch { CloseHandle(h); throw; }
 }
 static uint ExitCode(IntPtr h) { uint code; Check(GetExitCodeProcess(h,out code),"GetExitCodeProcess"); return code; }
 static bool Alive(IntPtr h) { uint s=WaitForSingleObject(h,0); if(s==258) return true; if(s==0) return false; throw new Win32Exception(Marshal.GetLastWin32Error(),"WaitForSingleObject"); }
 static bool Gate(IntPtr h,out int error) { OV ov=new OV {offset=1073741824}; bool yes=LockFileEx(h,3,0,1,0,ref ov); error=yes?0:Marshal.GetLastWin32Error(); if(!yes && error!=33) throw new Win32Exception(error,"LockFileEx"); return yes; }
 static void Unlock(IntPtr h) { OV ov=new OV {offset=1073741824}; Check(UnlockFileEx(h,0,1,0,ref ov),"UnlockFileEx"); }
 static string[] ContextGroups() { using(var wi=WindowsIdentity.GetCurrent()) { var groups=new List<string>(); foreach(IdentityReference group in wi.Groups)groups.Add(group.Value); return groups.ToArray(); } }
 static void Context(string dir,int runnerPid) {
  IntPtr runner=OpenProcess(0x1000,false,runnerPid); if(runner==IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
  try {
   bool actionJob,helperJob; Check(IsProcessInJob(runner,IntPtr.Zero,out actionJob),"action IsProcessInJob");
   Check(IsProcessInJob(Process.GetCurrentProcess().Handle,IntPtr.Zero,out helperJob),"helper IsProcessInJob");
   byte[] limits=null,ui=null; uint flags=0,uiFlags=0;
   if(actionJob) {
    if(!helperJob) throw new Exception("Context helper not in inherited scheduler job");
    IntPtr p=Marshal.AllocHGlobal(144); try { uint n; Check(QueryInformationJobObject(IntPtr.Zero,9,p,144,out n),"QueryInformationJobObject NULL ExtendedLimit"); limits=new byte[144]; Marshal.Copy(p,limits,0,144); flags=BitConverter.ToUInt32(limits,16);
     Check(QueryInformationJobObject(IntPtr.Zero,4,p,4,out n),"QueryInformationJobObject NULL UI"); ui=new byte[4]; Marshal.Copy(p,ui,0,4); uiFlags=BitConverter.ToUInt32(ui,0);
    } finally { Marshal.FreeHGlobal(p); }
   }
   Save(dir,"scheduler-job.json",new {tokenGroups=ContextGroups(),helperIdentity=Identity(Process.GetCurrentProcess().Handle,Process.GetCurrentProcess().Id,runnerPid,"context-helper"),ephemeral=true,actionPid=runnerPid,actionInJob=actionJob,helperInJob=helperJob,limitFlags=flags,perProcessUserTime100ns=limits==null?null:BitConverter.ToInt64(limits,0).ToString(),perJobUserTime100ns=limits==null?null:BitConverter.ToInt64(limits,8).ToString(),uiFlags=uiFlags,extendedLimitRaw=limits,uiRaw=ui,scope="HELPER immediate job only. Main action inAnyJob recorded separately, helper flags MUST NOT be attributed to Node action. Separate direct-task control retained. No job handle opened.",utc=DateTime.UtcNow.ToString("o")});
  } finally { CloseHandle(runner); }
 }
 static object Identity(IntPtr h,int pid,int parent,string role) {
  FT b,e,k,u; Check(GetProcessTimes(h,out b,out e,out k,out u),"identity GetProcessTimes");
  var path=new StringBuilder(32768); uint size=32768; Check(QueryFullProcessImageNameW(h,0,path,ref size),"identity executable");
  IntPtr token; Check(OpenProcessToken(h,8,out token),"identity SID"); string sid;
  try { using(var wi=new WindowsIdentity(token)) sid=wi.User.Value; } finally { CloseHandle(token); }
  return new {pid=pid,parent=parent,role=role,token=b.Token,executable=path.ToString(),sid=sid};
 }
 static void Breakaway(string[] a) {
  var root=Load(a[1],"child.json"); var grand=Load(a[1],"grandchild.json");
  IntPtr rootHandle=Pin(root,false),grandHandle=IntPtr.Zero,createdHandle=IntPtr.Zero;
  var self=Process.GetCurrentProcess(); IntPtr selfHandle=self.Handle;
  try {
  grandHandle=Pin(grand,false);
  Save(a[1],"helper-ready.json",Identity(selfHandle,self.Id,Convert.ToInt32(root["pid"]),"breakaway-helper"));
  Stopwatch lifetime=Stopwatch.StartNew();
  while(!File.Exists(Path.Combine(a[1],"breakaway-request"))) { if(lifetime.ElapsedMilliseconds>20000) throw new TimeoutException("breakaway request"); Thread.Yield(); }
  SI si=new SI {cb=Marshal.SizeOf(typeof(SI))}; PI pi;
  string cmd=Q(a[2])+" "+Q(a[3])+" escape "+Q(a[1])+" "+Q(a[4])+" "+Q(a[5]);
  bool ok=CreateProcessW(a[2],new StringBuilder(cmd),IntPtr.Zero,IntPtr.Zero,false,0x01000000,IntPtr.Zero,a[1],ref si,out pi); int error=ok?0:Marshal.GetLastWin32Error();
  object identity=null;
  if(ok) { createdHandle=pi.process; CloseHandle(pi.thread); identity=Identity(createdHandle,(int)pi.pid,Process.GetCurrentProcess().Id,"breakaway-created"); }
  Save(a[1],"breakaway.json",new {created=ok,lastError=error,flags="CREATE_BREAKAWAY_FROM_JOB",identity=identity});
  if(!ok && error!=5) throw new Win32Exception(error,"Unexpected breakaway refusal");
  // Setup barrier only. Stay alive and hold process handles, never a job handle.
  while(!File.Exists(Path.Combine(a[1],"quiesce")) && lifetime.ElapsedMilliseconds<120000) Thread.Yield();
  } finally { if(createdHandle!=IntPtr.Zero)CloseHandle(createdHandle); if(grandHandle!=IntPtr.Zero)CloseHandle(grandHandle); CloseHandle(rootHandle); self.Dispose(); }
 }
 // Pins every PID supplied by the exact workspace job list. Queries no host-wide argv.
 static void Census(string dir) {
  var handles=new List<IntPtr>(); var identities=new Dictionary<int,Dictionary<string,object>>();
  try {
   foreach(string stage in new string[]{"before-request-census","armed-census"}) {
    var facts=new Dictionary<string,object>(); var captured=new List<object>(); facts["census"]=captured;
    try {
     var deadline=Stopwatch.StartNew(); string request=stage+"-request.json";
     while(!File.Exists(Path.Combine(dir,request))) { if(deadline.ElapsedMilliseconds>30000)throw new TimeoutException(request); Thread.Yield(); }
     var input=Load(dir,request); var known=new Dictionary<int,Dictionary<string,object>>();
     foreach(object value in (System.Collections.IEnumerable)input["known"]) { var id=(Dictionary<string,object>)value; known.Add(Convert.ToInt32(id["pid"]),id); }
     foreach(object value in (System.Collections.IEnumerable)input["members"]) {
      int pid=Convert.ToInt32(value); Dictionary<string,object> id;
      if(!identities.TryGetValue(pid,out id)) {
       IntPtr h=OpenProcess(0x100000|0x1000,false,pid); if(h==IntPtr.Zero)throw new Win32Exception(Marshal.GetLastWin32Error(),"OpenProcess job-derived census PID "+pid);
       handles.Add(h);
       // Handle is retained BEFORE any identity or targeted parent query.
       id=new Dictionary<string,object>(); id["pid"]=pid; id["role"]=known.ContainsKey(pid)?(string)known[pid]["role"]:"job-derived-member";
       captured.Add(id); identities.Add(pid,id);
       FT firstBirth,firstExit,firstKernel,firstUser; Check(GetProcessTimes(h,out firstBirth,out firstExit,out firstKernel,out firstUser),"census birth"); id["token"]=firstBirth.Token;
       var image=new StringBuilder(32768); uint imageSize=32768; Check(QueryFullProcessImageNameW(h,0,image,ref imageSize),"census full image"); id["executable"]=image.ToString();
       IntPtr processToken; Check(OpenProcessToken(h,8,out processToken),"census token SID");
       try { using(var wi=new WindowsIdentity(processToken))id["sid"]=wi.User.Value; } finally { CloseHandle(processToken); }
       using(var query=new ManagementObjectSearcher("SELECT ProcessId, ParentProcessId, Name FROM Win32_Process WHERE ProcessId = "+pid)) {
        using(var rows=query.Get()) {
         if(rows.Count!=1)throw new Exception("Unknown job-derived parent/image observation "+pid);
         foreach(ManagementObject row in rows) { id["parent"]=Convert.ToInt32(row["ParentProcessId"]); id["imageName"]=(string)row["Name"]; }
        }
       }
       FT b,e,k,u; Check(GetProcessTimes(h,out b,out e,out k,out u),"census recheck birth");
       if(b.Token!=(string)id["token"] || !Alive(h))throw new Exception("Census identity changed/exited "+pid);
       id["parentScope"]="Observed parent PID only, not proof current parent PID still identifies original parent";
       id["pinnedBeforeIdentity"]=true;
      } else {
       IntPtr check=Pin(id,false); CloseHandle(check); captured.Add(id);
      }
      Dictionary<string,object> expected;
      if(known.TryGetValue(pid,out expected) && ((string)expected["token"]!=(string)id["token"] || (string)expected["sid"]!=(string)id["sid"] || !String.Equals((string)expected["executable"],(string)id["executable"],StringComparison.OrdinalIgnoreCase)))throw new Exception("Known identity differs from job-derived native identity");
     }
     facts["complete"]=true;
    } catch(Exception error) { facts["error"]=error.ToString(); facts["complete"]=false; Save(dir,stage+"-pinned.json",facts); throw; }
    Save(dir,stage+"-pinned.json",facts);
   }
   // Retain all identity handles through intervention. No job handle is opened.
   var hold=Stopwatch.StartNew();
   while(!File.Exists(Path.Combine(dir,"census-agent-stop")) && hold.ElapsedMilliseconds<120000)Thread.Yield();
  } catch(Exception error) { Save(dir,"census-agent-failure.json",new {error=error.ToString()}); Environment.ExitCode=1; }
  finally { foreach(IntPtr h in handles)CloseHandle(h); }
 }
 static bool[] States(List<IntPtr> pinned) { bool[] states=new bool[pinned.Count]; for(int i=0;i<pinned.Count;i++)states[i]=Alive(pinned[i]); return states; }
 static void Observe(string dir,string mode) {
  IntPtr runner=IntPtr.Zero;
  var pinned=new List<IntPtr>(); var identities=new List<Dictionary<string,object>>();
  var samples=new List<object>(); var report=new Dictionary<string,object>(); bool failed=false;
  report["mode"]=mode;report["frequency"]=Stopwatch.Frequency;report["samples"]=samples;
  try {
   runner=Pin(Load(dir,"runner.json"),true); var ready=Load(dir,"ready.json");
   foreach(object value in (System.Collections.IEnumerable)ready["census"]) {
    var id=(Dictionary<string,object>)value; pinned.Add(Pin(id,false)); identities.Add(id);
   }
   if(pinned.Count<3) throw new Exception("Incomplete census");
   report["census"]=identities;
   using(var gate=new FileStream(Path.Combine(dir,"gate.bin"),FileMode.Open,FileAccess.ReadWrite,FileShare.ReadWrite)) {
    IntPtr h=gate.SafeFileHandle.DangerousGetHandle(); int err;
    long baselineBefore=Tick(); bool[] baselineLiveBefore=States(pinned); bool baselineGrant=Gate(h,out err); long baselineAcquired=Tick(); bool[] baselineLiveAfter=States(pinned); long baselineAfter=Tick();
    Save(dir,"baseline-gate.json",new {before=baselineBefore,acquired=baselineAcquired,after=baselineAfter,granted=baselineGrant,error=err,liveBefore=baselineLiveBefore,liveAfter=baselineLiveAfter});
    if(baselineGrant) { Unlock(h); throw new Exception("Baseline gate granted"); }
    Save(dir,"contender-ready.json",new {tick=Tick(),census=identities,alive=States(pinned)});
    // Controller waits for this file, then signals go. Contender exists and has pinned all identities BEFORE kill.
    Stopwatch deadline=Stopwatch.StartNew(); while(!File.Exists(Path.Combine(dir,"go"))) { if(deadline.ElapsedMilliseconds>20000) throw new TimeoutException("go"); Thread.Yield(); }
    if(Array.Exists(States(pinned),state=>!state)) throw new Exception("Full census not alive at intervention");
    bool granted=false;
    using(var stream=new StreamWriter(Path.Combine(dir,"samples.ndjson"),false,new UTF8Encoding(false))) {
    report["interventionBefore"]=Tick();
    if(mode=="kill") Check(TerminateProcess(runner,197),"TerminateProcess exact Node runner");
    else File.WriteAllText(Path.Combine(dir,"normal"),"");
    report["interventionAfter"]=Tick();
    deadline.Restart();
     while(deadline.ElapsedMilliseconds<20000) {
      long before=Tick(); bool[] liveBefore=States(pinned); bool got=Gate(h,out err); long acquired=Tick(); bool[] liveAfter=States(pinned); long after=Tick();
      var sample=new {before=before,acquired=acquired,after=after,granted=got,error=err,liveBefore=liveBefore,liveAfter=liveAfter};
      stream.WriteLine(J.Serialize(sample));
      if(got) {
       samples.Add(sample); Unlock(h); granted=true;
       if(Array.Exists(liveBefore,state=>state)||Array.Exists(liveAfter,state=>state)) { failed=true; report["orderingVerdict"]=Array.Exists(liveAfter,state=>state)?"FAIL: grant bracket ends with live descendant":"UNKNOWN/FAIL: death transition overlaps grant bracket"; }
       if(!report.ContainsKey("firstGrantTick")) report["firstGrantTick"]=acquired;
       if(!Array.Exists(liveAfter,state=>state)) break;
      }
      // No sleep or post-death grace period masks a grant/death ordering race.
     }
    }
    if(!granted || Array.Exists(States(pinned),state=>state)) throw new Exception("No final grant/full census quiescence within bound");
    if(mode=="normal" && !File.Exists(Path.Combine(dir,"quiesced.json"))) throw new Exception("Normal control missing zero-members/release proof");
   }
   report["finalObservationTick"]=Tick(); var exits=new List<object>();
   for(int i=0;i<pinned.Count;i++) exits.Add(new {identity=identities[i],exitCode=ExitCode(pinned[i]),alive=Alive(pinned[i])});
   report["exits"]=exits; report["runnerExitCodeAtObservation"]=ExitCode(runner);
   report["measurementComplete"]=true; report["pass"]=!failed;
  } catch(Exception e) { report["measurementComplete"]=false; report["pass"]=false; report["error"]=e.ToString(); failed=true; }
  finally { if(runner!=IntPtr.Zero)CloseHandle(runner);foreach(IntPtr handle in pinned)CloseHandle(handle); report["custody"]="No failure cleanup kills. Retained ambiguous or live custody belongs to disposable-host teardown."; Save(dir,"observation.json",report); }
  if(failed) Environment.ExitCode=1;
 }
 public static int Main(string[] a) { try { if(a[0]=="load-control")LoadControl(a[1]); else if(a[0]=="context")Context(a[1],Int32.Parse(a[2])); else if(a[0]=="breakaway")Breakaway(a); else if(a[0]=="census")Census(a[1]); else if(a[0]=="observe")Observe(a[1],a[2]); else throw new Exception("mode"); return Environment.ExitCode; } catch(Exception e) { Console.Error.WriteLine(e); return 1; } }
}
