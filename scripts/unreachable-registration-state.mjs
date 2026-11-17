import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createConnection,createServer} from 'node:net';
import {mkdirSync,readFileSync,readdirSync,renameSync,existsSync,realpathSync} from 'node:fs';
import {inspectInstalledUpdateRoute} from './daemon-cell-diagnostics.mjs';
import {join} from 'node:path';

const hash=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
async function unusedPort(){
 const server=createServer();
 await new Promise((done,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',done);});
 const port=server.address().port;
 await new Promise(done=>server.close(done));
 return port;
}
async function unreachable(port){
 return new Promise((done,reject)=>{
  const socket=createConnection({host:'127.0.0.1',port});
  socket.setTimeout(2000,()=>{socket.destroy();reject(new Error('loopback probe timed out'));});
  socket.once('connect',()=>{socket.destroy();reject(new Error('fixture broker port unexpectedly answers'));});
  socket.once('error',error=>{socket.destroy();if(error.code==='ECONNREFUSED')done({host:'127.0.0.1',port,code:error.code,observedAt:new Date().toISOString()});else reject(error);});
 });
}

/** Prepare a stopped real stack and an unrelated offline registration through the installed CLI. */
export async function prepareUnreachableRegistration(context){
 assert(['linux','darwin'].includes(process.platform),'staged unreachable-registration proof is POSIX only');
 const {root,project,pkg,cotal,call,check,report}=context;
 const local='update-stopped',gone='update-gone',localRoot=join(root,'local-project'),goneRoot=join(root,'gone-project');
 mkdirSync(localRoot,{mode:0o700});mkdirSync(goneRoot,{mode:0o700});
 const localPort=await unusedPort();let gonePort=await unusedPort();
 while(gonePort===localPort)gonePort=await unusedPort();
 const ok=async(label,args)=>{const result=await cotal(label,args);assert.equal(result.exit,0,result.stdout+result.stderr);return result;};
 const down=()=>call('stop owned local broker before update','bash',['-c','cd "$1" && exec "$2" "$3" down --yes','owned-stack-down',localRoot,process.execPath,join(pkg,'dist/cotal.js')]);
 let mayRun=false;
 try{
  await ok('prepare stopped local space',['space','create',local,'--root',localRoot]);
  mayRun=true;
  await ok('start real local broker without Manager',['up','--root',localRoot,'--space',local,'--open','--no-manager','--server',`nats://127.0.0.1:${localPort}`,'--detach']);
  const stopped=await down();assert.equal(stopped.exit,0,stopped.stdout+stopped.stderr);mayRun=false;
  const probesBefore=[await unreachable(localPort),await unreachable(gonePort)];
  await ok('register unreachable broker through public CLI',['space','add',gone,'--server',`nats://127.0.0.1:${gonePort}`,'--root',goneRoot,'--mode','open','--force','--yes']);
  assert.deepEqual(readdirSync(join(project,'.cotal')),[],'only the empty harness marker may move out of the command root');
  renameSync(join(project,'.cotal'),join(root,'empty-harness-marker'));
  await ok('clear selection for install-wide continuity',['use','--clear']);
  const selection=await ok('selection before unreachable update',['use','--json']);
  assert.equal(JSON.parse(selection.stdout).result.current,null);
  const registry=await ok('registry before unreachable update',['meshes','--json']);
  const records=registry.stdout.trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(records.length,1);assert.equal(records[0].space,gone);assert.equal(records[0].offline,true);
  const journal=join(localRoot,'.cotal/stack-controller.json');
  const before={registry:registry.stdout,journalSha256:hash(journal)};
  const routeBefore=inspectInstalledUpdateRoute(pkg);
  const commandContext={cwd:realpathSync(project),projectMarker:existsSync(join(project,'.cotal')),selected:JSON.parse(selection.stdout).result.current,observedAt:new Date().toISOString()};
  report.unreachableRegistration={local,gone,localRoot,goneRoot,commandRoot:project,localPort,gonePort,before,probesBefore,commandContext,routeBefore,harnessSha256:hash(import.meta.filename)};
  check('stopped local stack and unreachable registration prepared through public CLI',true,before);
  return async()=>{
   report.unreachableRegistration.probesAfter=[await unreachable(localPort),await unreachable(gonePort)];
   report.unreachableRegistration.routeAfter=inspectInstalledUpdateRoute(pkg);
   const after=await ok('registry after unreachable update',['meshes','--json']);
   assert.equal(after.stdout,before.registry,'update must retain the unrelated offline registration');
   assert.equal(hash(journal),before.journalSha256,'update must leave the stopped stack journal untouched');
   report.unreachableRegistration.after={registry:after.stdout,journalSha256:hash(journal)};
   check('offline registration and stopped stack remain unchanged',true,report.unreachableRegistration.after);
  };
 }catch(error){
  if(mayRun){const stopped=await down();assert.equal(stopped.exit,0,'owned fixture cleanup failed: '+stopped.stdout+stopped.stderr);}
  throw error;
 }
}
