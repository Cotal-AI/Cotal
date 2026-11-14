// Diagnostic fixture only. No shipped binding changes, no duplicate job custodian.
using System;
using System.IO;
using System.Text;
using System.Diagnostics;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Collections.Generic;
using System.Security.Principal;
using System.Security.AccessControl;
using System.Management;
using System.Web.Script.Serialization;
using System.Threading;
public static class NamedJobFacts {
 static JavaScriptSerializer J=new JavaScriptSerializer {MaxJsonLength=Int32.MaxValue};
 [StructLayout(LayoutKind.Sequential)] struct FT {public uint lo,hi;public string Token {get{return (((ulong)hi<<32)|lo).ToString();}}}
 [StructLayout(LayoutKind.Sequential)] struct SA {public int length;public IntPtr descriptor;[MarshalAs(UnmanagedType.Bool)]public bool inherit;}
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct SI {public int cb;public string reserved,desktop,title;public int x,y,xs,ys,xc,yc,fill,flags;public short show,rs;public IntPtr rb,input,output,error;}
 [StructLayout(LayoutKind.Sequential)] struct PI {public IntPtr process,thread;public int pid,tid;}
 [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObjectW(ref SA attributes,string name);
 [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern IntPtr OpenJobObjectW(uint access,bool inherit,string name);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr h,int cls,IntPtr data,uint size);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr h,int cls,IntPtr data,uint size,out uint returned);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool member);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
 [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
 [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr h,uint ms);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr h,out FT birth,out FT exit,out FT kernel,out FT user);
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
 [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool QueryFullProcessImageNameW(IntPtr process,uint flags,StringBuilder image,ref uint length);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
 [DllImport("advapi32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string sddl,uint revision,out IntPtr descriptor,out uint size);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetKernelObjectSecurity(IntPtr h,uint information,byte[] descriptor,uint length,out uint needed);
 [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr h);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
 [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool CreateProcessW(string app,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref SI startup,out PI info);
 static void Check(bool ok,string api){if(!ok)throw new Win32Exception(Marshal.GetLastWin32Error(),api);}
 static long Tick(){return Stopwatch.GetTimestamp();}
 static string Q(string s){if(s.Contains("\"")||s.EndsWith("\\"))throw new Exception("Unsafe fixture argument");return "\""+s+"\"";}
 static void Save(string d,string n,object value){string p=Path.Combine(d,n);File.WriteAllText(p+".tmp",J.Serialize(value),new UTF8Encoding(false));File.Move(p+".tmp",p);}
 static Dictionary<string,object> Load(string d,string n){using(var f=new FileStream(Path.Combine(d,n),FileMode.Open,FileAccess.Read,FileShare.ReadWrite|FileShare.Delete))using(var r=new StreamReader(f))return J.Deserialize<Dictionary<string,object>>(r.ReadToEnd());}
 static bool Alive(IntPtr h){uint r=WaitForSingleObject(h,0);if(r==258)return true;if(r==0)return false;throw new Win32Exception(Marshal.GetLastWin32Error(),"Wait process");}
 static Dictionary<string,object> Identity(IntPtr h,int pid,int parent,string role){
  FT b,e,k,u;Check(GetProcessTimes(h,out b,out e,out k,out u),"birth");
  var image=new StringBuilder(32768);uint length=32768;Check(QueryFullProcessImageNameW(h,0,image,ref length),"full image");
  IntPtr token;Check(OpenProcessToken(h,8,out token),"token SID");string sid;
  try{using(var wi=new WindowsIdentity(token))sid=wi.User.Value;}finally{CloseHandle(token);}
  return new Dictionary<string,object>{{"pid",pid},{"parent",parent},{"role",role},{"token",b.Token},{"executable",image.ToString()},{"sid",sid}};
 }
 static IntPtr Pin(Dictionary<string,object> id,bool terminate){
  IntPtr h=OpenProcess(0x100000|0x1000|(terminate?1u:0u),false,Convert.ToInt32(id["pid"]));
  if(h==IntPtr.Zero)throw new Win32Exception(Marshal.GetLastWin32Error(),"pin exact fixture");
  try{var observed=Identity(h,Convert.ToInt32(id["pid"]),0,"pin");foreach(string key in new string[]{"token","executable","sid"})if(!String.Equals((string)observed[key],(string)id[key],StringComparison.OrdinalIgnoreCase))throw new Exception("Pinned identity mismatch "+key);return h;}catch{CloseHandle(h);throw;}
 }
 static PI Spawn(string dir,string mode,IntPtr job){
  string exe=Process.GetCurrentProcess().MainModule.FileName;var si=new SI{cb=Marshal.SizeOf(typeof(SI))};PI p;
  Check(CreateProcessW(exe,new StringBuilder(Q(exe)+" "+mode+" "+Q(dir)),IntPtr.Zero,IntPtr.Zero,false,4,IntPtr.Zero,dir,ref si,out p),"CreateProcess suspended fixture");
  try{if(job!=IntPtr.Zero){Check(AssignProcessToJobObject(job,p.process),"AssignProcess exact job");bool member;Check(IsProcessInJob(p.process,job,out member),"exact membership");if(!member)throw new Exception("Assignment membership false");}if(ResumeThread(p.thread)==0xffffffff)throw new Win32Exception(Marshal.GetLastWin32Error(),"ResumeThread");}
  catch{TerminateProcess(p.process,198);CloseHandle(p.process);throw;}finally{CloseHandle(p.thread);}
  return p;
 }
 static object Accounting(IntPtr job,out bool empty){
  IntPtr basic=Marshal.AllocHGlobal(48);uint returned;uint active;
  try{Check(QueryInformationJobObject(job,1,basic,48,out returned),"accounting");active=(uint)Marshal.ReadInt32(basic,40);}finally{Marshal.FreeHGlobal(basic);}
  for(int cap=64;cap<=16384;cap*=2){uint bytes=(uint)(8+cap*IntPtr.Size);IntPtr list=Marshal.AllocHGlobal((int)bytes);
   try{bool ok=QueryInformationJobObject(job,3,list,bytes,out returned);int error=ok?0:Marshal.GetLastWin32Error();if(!ok&&error!=234)throw new Win32Exception(error,"complete job PID list");int assigned=Marshal.ReadInt32(list,0),count=Marshal.ReadInt32(list,4);if((!ok&&error==234)||count<assigned)continue;Check(ok,"complete job PID list");var pids=new List<int>();for(int i=0;i<count;i++)pids.Add((int)Marshal.ReadIntPtr(list,8+i*IntPtr.Size));empty=active==0&&assigned==0&&count==0;return new {tick=Tick(),active=active,assigned=assigned,count=count,pids=pids,empty=empty};}finally{Marshal.FreeHGlobal(list);}
  }throw new Exception("Job list exceeded bounded complete census");
 }
 static void Drain(IntPtr job,string dir,string prefix){
  long before=Tick();Check(TerminateJobObject(job,199),"TerminateJobObject successor");long after=Tick();
  var clock=Stopwatch.StartNew();bool empty=false;
  using(var log=new StreamWriter(Path.Combine(dir,prefix+"-accounting.ndjson"),false,new UTF8Encoding(false))){
   while(clock.ElapsedMilliseconds<20000){var sample=Accounting(job,out empty);log.WriteLine(J.Serialize(sample));if(empty)break;Thread.Yield();}
  }
  Save(dir,prefix+"-drain.json",new {terminateBefore=before,terminateAfter=after,drained=empty,deadlineMs=20000});
  if(!empty)throw new TimeoutException("Exact named job did not drain; authority refused");
 }
 static void Owner(string dir){
  string sid=WindowsIdentity.GetCurrent().User.Value;string name="Global\\cotal-update-facts-"+Guid.NewGuid().ToString("N");
  string sddl="O:"+sid+"D:P(A;;GA;;;"+sid+")";IntPtr descriptor;uint size;
  Check(ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl,1,out descriptor,out size),"user-only job DACL");
  IntPtr job=IntPtr.Zero;
  try{var sa=new SA{length=Marshal.SizeOf(typeof(SA)),descriptor=descriptor,inherit=false};job=CreateJobObjectW(ref sa,name);int error=Marshal.GetLastWin32Error();if(job==IntPtr.Zero)throw new Win32Exception(error,"Create named job");if(error==183)throw new Exception("Attempt job collision");}
  finally{LocalFree(descriptor);}
  try{
   IntPtr limits=Marshal.AllocHGlobal(144);try{for(int i=0;i<144;i++)Marshal.WriteByte(limits,i,0);Marshal.WriteInt32(limits,16,0x2000);Check(SetInformationJobObject(job,9,limits,144),"KILL_ON_CLOSE no breakaway");uint n;Check(QueryInformationJobObject(job,9,limits,144,out n),"verify exact job flags");if((Marshal.ReadInt32(limits,16)&0x3800)!=0x2000)throw new Exception("Wrong job flags");}finally{Marshal.FreeHGlobal(limits);}
   uint needed;GetKernelObjectSecurity(job,5,null,0,out needed);if(needed==0)throw new Win32Exception(Marshal.GetLastWin32Error(),"job DACL size");var security=new byte[needed];Check(GetKernelObjectSecurity(job,5,security,needed,out needed),"read exact job owner and DACL");var actual=new RawSecurityDescriptor(security,0);
   if(actual.Owner.Value!=sid || actual.DiscretionaryAcl==null || actual.DiscretionaryAcl.Count!=1)throw new Exception("Wrong named job owner/DACL shape");
   var ace=actual.DiscretionaryAcl[0] as CommonAce;if(ace==null || ace.AceQualifier!=AceQualifier.AccessAllowed || ace.SecurityIdentifier.Value!=sid || (ace.AccessMask&0x1f001f)!=0x1f001f && (ace.AccessMask&0x10000000)==0 || (actual.ControlFlags&ControlFlags.DiscretionaryAclProtected)==0)throw new Exception("Named job user-only protection verification failed");
   var self=Process.GetCurrentProcess();Save(dir,"attempt.json",new {name=name,sddl=sddl,actualSddl=actual.GetSddlForm(AccessControlSections.Owner|AccessControlSections.Access),owner=Identity(self.Handle,self.Id,self.Id,"owner"),killOnClose=true,breakaway=false,frequency=Stopwatch.Frequency,jobHandleInherited=false});
   PI root=Spawn(dir,"tree",job);Save(dir,"root.json",Identity(root.process,root.pid,self.Id,"root"));CloseHandle(root.process);
   var setup=Stopwatch.StartNew();while(Directory.GetFiles(dir,"member-*.json").Length<2){if(setup.ElapsedMilliseconds>20000)throw new TimeoutException("spawning descendants readiness");Thread.Yield();}
   bool unused;var snapshot=J.Deserialize<Dictionary<string,object>>(J.Serialize(Accounting(job,out unused)));var members=new List<object>();
   foreach(object value in (System.Collections.IEnumerable)snapshot["pids"]){int pid=Convert.ToInt32(value);IntPtr process=OpenProcess(0x100000|0x1000,false,pid);if(process==IntPtr.Zero)throw new Win32Exception(Marshal.GetLastWin32Error(),"snapshot member pin");
    try{int parent=0;using(var query=new ManagementObjectSearcher("SELECT ParentProcessId FROM Win32_Process WHERE ProcessId = "+pid))using(var rows=query.Get()){if(rows.Count!=1)throw new Exception("unknown snapshot parent");foreach(ManagementObject row in rows)parent=Convert.ToInt32(row["ParentProcessId"]);}
     bool inside;Check(IsProcessInJob(process,job,out inside),"snapshot exact membership");if(!inside)throw new Exception("snapshot member outside exact job");members.Add(Identity(process,pid,parent,"job-snapshot-member"));
    }finally{CloseHandle(process);}
   }
   Save(dir,"job-members.json",new {members=members,snapshot=snapshot,scope="Pinned identity snapshot; births continue, not a complete future census"});
   Save(dir,"owner-ready.json",new {ready=true,name=name});
   var clock=Stopwatch.StartNew();while(clock.ElapsedMilliseconds<60000&&!File.Exists(Path.Combine(dir,"owner-stop")))Thread.Yield();
  }finally{CloseHandle(job);}
 }
 static void Tree(string dir){
  var self=Process.GetCurrentProcess();var clock=Stopwatch.StartNew();int count=0;
  while(clock.ElapsedMilliseconds<30000&&count<32){
   if(count==2){while(!File.Exists(Path.Combine(dir,"spawn-go"))&&clock.ElapsedMilliseconds<30000)Thread.Yield();Save(dir,"spawning-active.json",new {tick=Tick(),next=count});}
   PI p=Spawn(dir,"leaf",IntPtr.Zero);Save(dir,"member-"+p.pid+".json",Identity(p.process,p.pid,self.Id,"spawning-leaf"));CloseHandle(p.process);count++;
  }
  Save(dir,"spawning-finished.json",new {count=count,tick=Tick()});while(clock.ElapsedMilliseconds<30000)Thread.Yield();
 }
 static void Leaf(){var clock=Stopwatch.StartNew();while(clock.ElapsedMilliseconds<30000)Thread.Yield();}
 static bool[] States(List<IntPtr> pins){var states=new bool[pins.Count];for(int i=0;i<pins.Count;i++)states[i]=Alive(pins[i]);return states;}
 static void Observe(string dir,string mode){
  var report=new Dictionary<string,object>{{"mode",mode},{"frequency",Stopwatch.Frequency},{"pass",false},{"setupComplete",false}};
  var pins=new List<IntPtr>();var ids=new List<Dictionary<string,object>>();IntPtr owner=IntPtr.Zero,job=IntPtr.Zero;StreamWriter log=null;
  try{
   var attempt=Load(dir,"attempt.json");string name=(string)attempt["name"];owner=Pin((Dictionary<string,object>)attempt["owner"],true);
   var snapshot=Load(dir,"job-members.json");var known=new HashSet<int>();
   foreach(object value in (System.Collections.IEnumerable)snapshot["members"]){var id=(Dictionary<string,object>)value;int pid=Convert.ToInt32(id["pid"]);pins.Add(Pin(id,false));ids.Add(id);known.Add(pid);}
   foreach(string file in Directory.GetFiles(dir,"member-*.json")){var id=Load(dir,Path.GetFileName(file));if(known.Add(Convert.ToInt32(id["pid"]))){pins.Add(Pin(id,false));ids.Add(id);}}
   if(pins.Count<3)throw new Exception("Need root and at least two live spawning descendants");
   report["pinned"]=ids;report["beforeAlive"]=States(pins);report["name"]=name;
   if(Array.Exists(States(pins),v=>!v))throw new Exception("Pinned member already exited before intervention");
   if(File.Exists(Path.Combine(dir,"spawning-finished.json")))throw new Exception("Spawning ended before intervention");
   var samples=new List<object>();report["samples"]=samples;bool unsafeAbsence=false;var clock=new Stopwatch();
   log=new StreamWriter(Path.Combine(dir,"name-observations.ndjson"),false,new UTF8Encoding(false));
   // Warm native open and serialization before intervention, without opening the real job.
   IntPtr missing=OpenJobObjectW(0x000c,false,name+"-prewarm-missing");int missingError=Marshal.GetLastWin32Error();
   if(missing!=IntPtr.Zero){CloseHandle(missing);throw new Exception("Unexpected prewarm name collision");}if(missingError!=2)throw new Win32Exception(missingError,"prewarm absent-name open");
   J.Serialize(new {before=Tick(),opened=Tick(),after=Tick(),error=2,success=false,ownerBefore=true,ownerAfter=true,liveBefore=States(pins),liveAfter=States(pins)});
   File.WriteAllText(Path.Combine(dir,"spawn-go"),"");var spawning=Stopwatch.StartNew();
   while(!File.Exists(Path.Combine(dir,"spawning-active.json"))||Directory.GetFiles(dir,"member-*.json").Length<3){if(spawning.ElapsedMilliseconds>10000)throw new TimeoutException("Active spawning/late-child barrier");Thread.Yield();}
   report["spawningActive"]=Load(dir,"spawning-active.json");
   // Pin births observed after the original snapshot while further births continue.
   foreach(string file in Directory.GetFiles(dir,"member-*.json")){var id=Load(dir,Path.GetFileName(file));if(known.Add(Convert.ToInt32(id["pid"]))){pins.Add(Pin(id,false));ids.Add(id);}}
   report["observedBirthFilesAtKill"]=Directory.GetFiles(dir,"member-*.json").Length;
   report["beforeAlive"]=States(pins);
   if(Array.Exists(States(pins),v=>!v))throw new Exception("Late-born pinned process exited before kill");
   if(File.Exists(Path.Combine(dir,"spawning-finished.json")))throw new Exception("Spawning finished before kill after late-child pinning");
   report["setupComplete"]=true;
   if(mode=="open-control"){
    job=OpenJobObjectW(0x000c,false,name);if(job==IntPtr.Zero)throw new Win32Exception(Marshal.GetLastWin32Error(),"owner-alive open control");
    report["ownerAliveAtOpen"]=Alive(owner);report["controlScope"]="Open while owner alive; deliberately NOT last-close absence measurement";
   }
   // All allocations/file opens required by the measurement precede owner termination.
   report["killBefore"]=Tick();Check(TerminateProcess(owner,197),"kill exact owner");report["killAfter"]=Tick();
   if(mode=="after-owner-exit"&&WaitForSingleObject(owner,10000)!=0)throw new Exception("Owner did not signal before successor opens");
   clock.Start();
   if(job==IntPtr.Zero){
    while(clock.ElapsedMilliseconds<20000){long before=Tick();bool[] liveBefore=States(pins);bool ownerBefore=Alive(owner);job=OpenJobObjectW(0x000c,false,name);int error=job==IntPtr.Zero?Marshal.GetLastWin32Error():0;long opened=Tick();bool[] liveAfter=States(pins);bool ownerAfter=Alive(owner);long after=Tick();var s=new {before=before,opened=opened,after=after,error=error,success=job!=IntPtr.Zero,ownerBefore=ownerBefore,ownerAfter=ownerAfter,liveBefore=liveBefore,liveAfter=liveAfter};log.WriteLine(J.Serialize(s));samples.Add(s);
     if(job!=IntPtr.Zero)break;
     if(error!=2)throw new Win32Exception(error,"Exact-name open unknown, not absence");
     if(Array.Exists(liveAfter,v=>v))unsafeAbsence=true;
     else if(Array.Exists(liveBefore,v=>v)){unsafeAbsence=true;report["absenceTransitionAmbiguous"]=true;}
     if(!Array.Exists(liveAfter,v=>v))break;
    }
   }
   report["absenceWithLiveMember"]=unsafeAbsence;report["opened"]=job!=IntPtr.Zero;
   if(job==IntPtr.Zero&&Array.Exists(States(pins),v=>v))throw new TimeoutException("Named absence observation ended before known members signaled");
   // Process references are measurement pins only; release before accounting-zero demand.
   foreach(IntPtr pin in pins)CloseHandle(pin);pins.Clear();
   if(job!=IntPtr.Zero){Drain(job,dir,"successor");report["pass"]=true;}
   else{report["pass"]=!unsafeAbsence;report["absenceScope"]="Pinned subset with continuing births, not universal all-member death proof";}
   report["measurementComplete"]=true;
  }catch(Exception error){report["error"]=error.ToString();report["pass"]=false;}
  finally{if(log!=null)log.Dispose();if(owner!=IntPtr.Zero)CloseHandle(owner);foreach(IntPtr pin in pins)CloseHandle(pin);if(job!=IntPtr.Zero)CloseHandle(job);Save(dir,"named-observation.json",report);}
  if(!(bool)report["pass"])Environment.ExitCode=1;
 }
 public static int Main(string[] a){try{if(a[0]=="owner")Owner(a[1]);else if(a[0]=="tree")Tree(a[1]);else if(a[0]=="leaf")Leaf();else if(a[0]=="observe")Observe(a[1],a[2]);else throw new Exception("Unknown fixture mode");return Environment.ExitCode;}catch(Exception e){if(a.Length>1)Save(a[1],a[0]+"-failure-"+Process.GetCurrentProcess().Id+".json",new {error=e.ToString()});Console.Error.WriteLine(e);return 1;}}
}
