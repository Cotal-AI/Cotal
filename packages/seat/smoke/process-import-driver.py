"""Linux development probe: installed systemd user manager, unshare, Python and built seat package."""
from pathlib import Path
import ctypes,json,os,signal,socket,subprocess,sys,uuid
script=Path(__file__).resolve();os.umask(0o077)
def birth(pid):return Path('/proc',str(pid),'stat').read_text().rsplit(')',1)[1].split()[19]
def save(root,name,value):
 with (root/name).open('x') as f:json.dump(value,f,indent=2);f.write('\n');f.flush();os.fsync(f.fileno())
 fd=os.open(root,os.O_DIRECTORY);os.fsync(fd);os.close(fd)
if sys.argv[1]=='gate':
 root=Path(sys.argv[2]);assert os.getpid()==1;s=socket.socket(socket.AF_UNIX);s.settimeout(10);s.connect('\0'+sys.argv[3]);assert s.recv(1)==b'+';s.close();save(root,'admitted.json',{'admitted':True});signal.pause()
elif sys.argv[1]=='owner':
 root=Path(sys.argv[2]);unit=sys.argv[3]
 env={k:os.environ[k] for k in ['NOTIFY_SOCKET','LISTEN_PID','LISTEN_FDS','LISTEN_FDNAMES'] if k in os.environ};env.update(PATH='/usr/bin:/bin',HOME=str(root));os.environ.clear();os.environ.update(env);signal.alarm(25)
 lib=ctypes.CDLL('libsystemd.so.0');lib.sd_pid_notify_with_fds.argtypes=[ctypes.c_int,ctypes.c_int,ctypes.c_char_p,ctypes.POINTER(ctypes.c_int),ctypes.c_uint];lib.sd_notify_barrier.argtypes=[ctypes.c_int,ctypes.c_uint64];lib.sd_notify.argtypes=[ctypes.c_int,ctypes.c_char_p]
 def ready():assert lib.sd_notify(0,b'READY=1')>0;assert lib.sd_notify_barrier(0,5000000)>0
 if (root/'attempt.json').exists():
  assert (root/'first.json').exists(),'refuse repeating incomplete first attempt'
  save(root,'second-owner.json',{'pid':os.getpid(),'birth':birth(os.getpid())});ready()
  os.execve('/usr/bin/node',['/usr/bin/node',str(script.with_name('process-import.smoke.mjs')),str(root),'dead','3'],env)
 save(root,'attempt.json',{'pid':os.getpid(),'birth':birth(os.getpid())});address='cotal-import-'+uuid.uuid4().hex
 server=socket.socket(socket.AF_UNIX);server.settimeout(10);server.bind('\0'+address);server.listen(1)
 child=subprocess.Popen(['/usr/bin/unshare','--user','--map-root-user','--pid','--fork','--kill-child=SIGKILL','--mount-proc','/usr/bin/python3','-I',str(script),'gate',str(root),address],env={'PATH':'/usr/bin:/bin','HOME':str(root)},stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 save(root,'launcher.json',{'pid':child.pid,'birth':birth(child.pid)});fd=None;thread=None
 try:
  peer,_=server.accept();fd=peer.getsockopt(socket.SOL_SOCKET,77)
  info=Path(f'/proc/self/fdinfo/{fd}').read_text();pid=int(next(x.split(':')[1] for x in info.splitlines() if x.startswith('Pid:')))
  status={line.split(':',1)[0]:line.split(':',1)[1].strip() for line in Path('/proc',str(pid),'status').read_text().splitlines() if ':' in line}
  assert int(status['PPid'])==child.pid and status['NSpid'].split()[-1]=='1' and set(map(int,status['Uid'].split()))=={os.getuid()}
  st=os.fstat(fd);kernel={'deviceMajor':os.major(st.st_dev),'deviceMinor':os.minor(st.st_dev),'mode':st.st_mode,'inode':str(st.st_ino)}
  identity={'pid':pid,'uid':os.getuid(),'birth':birth(pid),'boot':Path('/proc/sys/kernel/random/boot_id').read_text().strip(),'namespace':os.readlink(f'/proc/{pid}/ns/pid')}
  assert lib.sd_pid_notify_with_fds(0,0,b'FDSTORE=1\nFDPOLL=0\nFDNAME=namespace',(ctypes.c_int*1)(fd),1)>0;assert lib.sd_notify_barrier(0,5000000)>0
  busenv={'PATH':'/usr/bin:/bin','XDG_RUNTIME_DIR':f'/run/user/{os.getuid()}','DBUS_SESSION_BUS_ADDRESS':f'unix:path=/run/user/{os.getuid()}/bus'}
  def bus(path,interface,method,*args):return json.loads(subprocess.run(['/usr/bin/busctl','--user','--timeout=4','--json=short','call','org.freedesktop.systemd1',path,interface,method,*args],env=busenv,capture_output=True,text=True,check=True,timeout=6).stdout)['data']
  path=bus('/org/freedesktop/systemd1','org.freedesktop.systemd1.Manager','GetUnit','s',unit)[0];rows=bus(path,'org.freedesktop.systemd1.Service','DumpFileDescriptorStore')[0]
  assert len(rows)==1 and rows[0][:5]==['namespace',st.st_mode,os.major(st.st_dev),os.minor(st.st_dev),st.st_ino]
  save(root,'receipt.json',{'identity':identity,'kernel':kernel});save(root,'storage.json',rows);assert not (root/'admitted.json').exists();peer.sendall(b'+');peer.close()
  thread=os.pidfd_open(os.getpid(),os.O_EXCL)
  node=subprocess.run(['/usr/bin/node',str(script.with_name('process-import.smoke.mjs')),str(root),'live',str(fd),str(thread)],env={'PATH':'/usr/bin:/bin','HOME':str(root)},pass_fds=(fd,thread),capture_output=True,text=True,timeout=15)
  (root/'live.out').write_text(node.stdout);(root/'live.err').write_text(node.stderr);assert node.returncode==0,('live import checks failed',node.returncode)
  child.wait(timeout=5);save(root,'first.json',{'owner':{'pid':os.getpid(),'birth':birth(os.getpid())},'childReturn':child.returncode,'liveChecks':json.loads((root/'live-node.json').read_text())});ready();signal.raise_signal(signal.SIGKILL)
 finally:
  if fd is not None:
   try:signal.pidfd_send_signal(fd,signal.SIGKILL)
   except ProcessLookupError:pass
   os.close(fd)
  if thread is not None:os.close(thread)
  server.close()
else:
 assert sys.argv[1]=='run';root=Path(sys.argv[2]).resolve();root.mkdir(mode=0o700);unit='cotal-import-'+uuid.uuid4().hex+'.service';save(root,'unit.json',{'unit':unit})
 env={'PATH':'/usr/bin:/bin','HOME':str(root),'XDG_RUNTIME_DIR':f'/run/user/{os.getuid()}','DBUS_SESSION_BUS_ADDRESS':f'unix:path=/run/user/{os.getuid()}/bus'};result={'unit':unit}
 try:
  args=['/usr/bin/systemd-run','--user','--wait','--pipe','--collect','--unit',unit,'--property=Type=notify','--property=NotifyAccess=main','--property=Restart=on-failure','--property=RestartSec=100ms','--property=StartLimitBurst=2','--property=StartLimitIntervalSec=60s','--property=RuntimeMaxSec=30s','--property=TimeoutStopSec=5s','--property=FileDescriptorStoreMax=1','--property=FileDescriptorStorePreserve=restart','/usr/bin/python3','-I',str(script),'owner',str(root),unit]
  q=subprocess.run(args,env=env,capture_output=True,text=True,timeout=70);(root/'runner.out').write_text(q.stdout);(root/'runner.err').write_text(q.stderr);result['exit']=q.returncode;assert q.returncode==0,('native unit failed',q.returncode)
  result['live']=json.loads((root/'live-node.json').read_text());result['dead']=json.loads((root/'dead-node.json').read_text())
 except Exception as e:result['error']=str(e)
 finally:
  subprocess.run(['/usr/bin/systemctl','--user','stop',unit],env=env,capture_output=True,text=True,timeout=10)
  q=subprocess.run(['/usr/bin/systemctl','--user','show',unit,'--property=LoadState','--property=ActiveState'],env=env,capture_output=True,text=True,timeout=10);result['unitAfterStop']=q.stdout.strip();save(root,'result.json',result)
 print(json.dumps({k:v for k,v in result.items() if k not in ['live','dead']},indent=2));assert 'error' not in result,result.get('error')
 assert 'LoadState=not-found' in result['unitAfterStop'] and 'ActiveState=inactive' in result['unitAfterStop']
 print('Imported-process controls:',len(result['live']['checks'])+len(result['dead']['checks']))
