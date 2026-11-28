"""Optional Linux development probe. Requires built seat package and installed systemd/unshare."""
from pathlib import Path
import json,os,socket,subprocess,sys,uuid
os.umask(0o077);script=Path(__file__).resolve();root=Path(sys.argv[1]).resolve();root.mkdir(mode=0o700)
node=script.with_name('service-storage.smoke.mjs');env={'PATH':'/usr/bin:/bin','HOME':str(root)}
for mode in ['missing','timeout']:
 blackhole=None
 try:
  launch=dict(env)
  if mode=='timeout':
   address='cotal-store-timeout-'+uuid.uuid4().hex;blackhole=socket.socket(socket.AF_UNIX,socket.SOCK_DGRAM);blackhole.bind('\0'+address);launch['NOTIFY_SOCKET']='@'+address
  q=subprocess.run(['/usr/bin/node',str(node),str(root),mode],env=launch,capture_output=True,text=True,timeout=20);(root/(mode+'.out')).write_text(q.stdout);(root/(mode+'.err')).write_text(q.stderr);assert q.returncode==0,('non-service probe failed',mode,q.returncode)
 finally:
  if blackhole:blackhole.close()
unit='cotal-store-'+uuid.uuid4().hex+'.service';(root/'unit.json').write_text(json.dumps({'unit':unit})+'\n')
launcher=root/'launch.sh';launcher.write_text('#!/bin/sh\nexec /usr/bin/env -i PATH=/usr/bin:/bin HOME="$1" NOTIFY_SOCKET="${NOTIFY_SOCKET-}" LISTEN_PID="${LISTEN_PID-0}" LISTEN_FDS="${LISTEN_FDS-0}" LISTEN_FDNAMES="${LISTEN_FDNAMES-}" /usr/bin/node "$2" "$1" service "$3"\n')
env.update(XDG_RUNTIME_DIR=f'/run/user/{os.getuid()}',DBUS_SESSION_BUS_ADDRESS=f'unix:path=/run/user/{os.getuid()}/bus')
result={'unit':unit}
try:
 args=['/usr/bin/systemd-run','--user','--wait','--pipe','--collect','--unit',unit,'--property=Type=exec','--property=NotifyAccess=main','--property=Restart=on-failure','--property=RestartSec=100ms','--property=StartLimitBurst=2','--property=StartLimitIntervalSec=60s','--property=RuntimeMaxSec=35s','--property=TimeoutStopSec=5s','--property=FileDescriptorStoreMax=1','--property=FileDescriptorStorePreserve=restart','/bin/sh',str(launcher),str(root),str(node),unit]
 q=subprocess.run(args,env=env,capture_output=True,text=True,timeout=90);(root/'runner.out').write_text(q.stdout);(root/'runner.err').write_text(q.stderr);result['exit']=q.returncode;assert q.returncode==0,('service failed',q.returncode)
 for name in ['missing','timeout','first','second']:result[name]=json.loads((root/(name+'.json')).read_text())
except Exception as e:result['error']=str(e)
finally:
 subprocess.run(['/usr/bin/systemctl','--user','stop',unit],env=env,capture_output=True,text=True,timeout=10)
 q=subprocess.run(['/usr/bin/systemctl','--user','show',unit,'--property=LoadState','--property=ActiveState'],env=env,capture_output=True,text=True,timeout=10);result['unitAfterStop']=q.stdout.strip();(root/'result.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({k:v for k,v in result.items() if k not in ['missing','timeout','first','second']},indent=2));assert 'error' not in result,result.get('error')
assert 'LoadState=not-found' in result['unitAfterStop'] and 'ActiveState=inactive' in result['unitAfterStop']
print('Storage controls:',sum(len(result[k]['checks']) for k in ['missing','timeout','first','second']))
