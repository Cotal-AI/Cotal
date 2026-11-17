import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdirSync,writeFileSync,readFileSync,readdirSync,readlinkSync,statfsSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {candidateRegistry} from './automatic-update-platform-baseline.mjs';

function birth(pid) { const fields=readFileSync(`/proc/${pid}/stat`,'utf8').split(') ').slice(1).join(') ').split(' ');assert.notEqual(fields[0],'Z');return fields[19]; }

/** Two real installed copies share a home. An update must leave the old Manager able to launch its own connector generation. */
export async function retainedLaunchCell({root, candidate, nextCandidate}) {
assert.equal(process.platform,'linux','native birth and launch-path acceptance is Linux only');
root=resolve(root);
for(const n of ['', 'home','cotal','config','runtime','tmp','cache','project','tools','fixture','evidence'])mkdirSync(join(root,n),{recursive:true,mode:0o700});
const disk=statfsSync(root);assert(disk.bavail*disk.bsize>=30*1024**3,'30GiB free space required');
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('COTAL_')&&!/^npm_config_(registry|before)$/i.test(k)));
Object.assign(env,{HOME:join(root,'home'),COTAL_HOME:join(root,'cotal'),XDG_CONFIG_HOME:join(root,'config'),XDG_RUNTIME_DIR:join(root,'runtime'),TMPDIR:join(root,'tmp'),npm_config_cache:join(root,'cache'),npm_config_audit:'false',npm_config_fund:'false',DO_NOT_TRACK:'1',COTAL_TELEMETRY:'off',SHELL:'/bin/bash',COTAL_JCODE_TUI:'0'});
const fake=resolve(import.meta.dirname,'../extensions/connector-jcode/smoke/fake-jcode.mjs');
const shim=join(root,'tools/jcode.mjs'),launchLog=join(root,'evidence/harness-launches.jsonl');
writeFileSync(shim,`import{appendFileSync}from'node:fs';if(process.argv[2]==='--version'){console.log('jcode 0.99.0');process.exit(0)}appendFileSync(${JSON.stringify(launchLog)},JSON.stringify({pid:process.ppid})+'\\n');process.argv=[process.argv[0],${JSON.stringify(fake)},...process.argv.slice(2)];await import(${JSON.stringify(pathToFileURL(fake).href)});`);
writeFileSync(join(root,'tools/jcode'),`#!/bin/sh\nexec '${process.execPath}' '${shim}' "$@"\n`,{mode:0o700});env.PATH=`${root}/tools:${env.PATH}`;
const report={v:1,calls:[],root};
const run=async(label,file,args,over={})=>{const p=spawn(file,args,{cwd:join(root,'project'),env:{...env,...over},stdio:['ignore','pipe','pipe']});let stdout='',stderr='';p.stdout.on('data',b=>stdout+=b);p.stderr.on('data',b=>stderr+=b);const timer=setTimeout(()=>p.kill('SIGTERM'),420000);try{const code=await new Promise((d,j)=>{p.once('error',j);p.once('close',d)});const c={label,code,stdout,stderr};report.calls.push(c);writeFileSync(join(root,`evidence/${label}.json`),JSON.stringify(c,null,2));return c}finally{clearTimeout(timer)}};
const ok=c=>{assert.equal(c.code,0,c.stdout+c.stderr);return c};
const a=join(root,'main/lib/node_modules/cotal-ai/dist/cotal.js'),b=join(root,'manager/lib/node_modules/cotal-ai/dist/cotal.js');
const cli=(label,entry,args)=>run(label,process.execPath,[entry,...args]);
const status=async(label,entry,instanceId)=>{
 const modules=join(dirname(dirname(entry)),'node_modules');
 const script=`const{resolveControlTarget}=await import(${JSON.stringify(pathToFileURL(join(modules,'@cotal-ai/workspace/dist/index.js')).href)});const{askManager}=await import(${JSON.stringify(pathToFileURL(join(modules,'@cotal-ai/workspace/dist/control/index.js')).href)});const t=await resolveControlTarget({space:'separate-proof'},'control-caller-admin',${JSON.stringify(instanceId)},{readOnly:true,onRefusal:'throw'});const s=await askManager({versionSkew:()=>{},roster:async()=>[]},t.space,t.server,'managerStatus',undefined,t.auth,'owner',3000,{instanceId:${JSON.stringify(instanceId)}});if(!s.ok)throw new Error(s.error);console.log(JSON.stringify(s.data));`;
 return JSON.parse(ok(await run(label,process.execPath,['--input-type=module','-e',script])).stdout);
};
let reg,next,started=false;
try{
 reg=await candidateRegistry(resolve(candidate),'B','https://registry.npmjs.org/');env.npm_config_registry=reg.url;report.candidate=reg.identity;
 for(const [name,prefix]of[['a','main'],['b','manager']])ok(await run(`install-${name}`,'npm',['install','-g','--prefix',join(root,prefix),`cotal-ai@${reg.identity.version}`]));
 const core=pathToFileURL(join(root,'manager/lib/node_modules/cotal-ai/node_modules/@cotal-ai/core/dist/index.js')).href;
 const seat=join(root,'fixture/seat.mjs');writeFileSync(join(root,'fixture/package.json'),JSON.stringify({name:'cotal-retain-separate-fixture',version:'1.0.0',type:'module',main:'index.js',peerDependencies:{'@cotal-ai/core':'*'}}));
 writeFileSync(seat,`import{CotalEndpoint}from${JSON.stringify(core)};import{readFileSync,writeFileSync}from'node:fs';import{createServer}from'node:http';const e=process.env;const p=new CotalEndpoint({space:e.COTAL_SPACE,servers:e.COTAL_SERVERS,creds:readFileSync(e.COTAL_CREDS,'utf8'),card:{id:e.COTAL_ID,name:e.COTAL_NAME,role:'worker',kind:'agent'},lifecycleUid:e.COTAL_LIFECYCLE_UID,channels:[],consume:false,registerPresence:true});p.on('error',console.error);await p.start();const h=createServer((q,r)=>r.end(q.url));await new Promise(d=>h.listen(0,'127.0.0.1',d));writeFileSync(${JSON.stringify(join(root,'ready.json'))},JSON.stringify({pid:process.pid,port:h.address().port}));for(const s of['SIGINT','SIGTERM'])process.on(s,()=>{h.close();p.stop().finally(()=>process.exit(0))});`);
 writeFileSync(join(root,'fixture/index.js'),`import{registry}from'@cotal-ai/core';registry.register({kind:'connector',name:'retain-separate',requires:['node'],buildLaunch:o=>({command:process.execPath,args:[${JSON.stringify(seat)}],env:{...process.env,COTAL_SPACE:o.space,COTAL_SERVERS:String(o.servers),COTAL_CREDS:String(o.creds),COTAL_ID:String(o.id),COTAL_NAME:o.name,COTAL_LIFECYCLE_UID:String(o.lifecycleUid)}})});`);
 ok(await cli('add-fixture',b,['ext','add',join(root,'fixture')]));
 ok(await cli('setup',b,['setup','--destination','local','--harness','retain-separate','--project',join(root,'project'),'--space','separate-proof','--no-input','--configure-only']));
 const server=createServer();await new Promise(d=>server.listen(0,'127.0.0.1',d));const port=server.address().port;await new Promise(d=>server.close(d));
 ok(await cli('up',b,['up','--space','separate-proof','--server',`nats://127.0.0.1:${port}`]));started=true;
 ok(await cli('spawn-existing',b,['spawn','--agent','retain-separate','--name','existing_worker','--detach','--no-events','--space','separate-proof']));
 report.before=JSON.parse(ok(await cli('ps-before',b,['ps','--space','separate-proof','--json'])).stdout).result;const manager=report.before.items[0].instanceId;
 report.seatBirth=birth(report.before.items[0].pid);
 report.managerBefore=await status('manager-before',b,manager);assert.equal(report.managerBefore.version,reg.identity.version);
 next=await candidateRegistry(resolve(nextCandidate),'B','https://registry.npmjs.org/');env.npm_config_registry=next.url;report.next=next.identity;
 ok(await cli('update-main',a,['update','--self']));
 report.after=JSON.parse(ok(await cli('ps-after',a,['ps','--space','separate-proof','--on',manager,'--json'])).stdout).result;
 assert.equal(report.after.items[0].pid,report.before.items[0].pid);assert.equal(report.after.items[0].presenceIdentityVerified,true);
 assert.equal(birth(report.before.items[0].pid),report.seatBirth);
 const ready=JSON.parse(readFileSync(join(root,'ready.json'),'utf8'));report.challenge=`live-${Date.now()}`;assert.equal(await(await fetch(`http://127.0.0.1:${ready.port}/${report.challenge}`)).text(),`/${report.challenge}`);
 report.launch=await cli('old-manager-firstparty-launch',a,['spawn','--agent','jcode','--name','kept_jcode','--detach','--no-events','--space','separate-proof','--on',manager]);
 assert.equal(report.launch.code,0,report.launch.stdout+report.launch.stderr);
 report.managerAfter=await status('manager-after-launch',b,manager);assert.equal(report.managerAfter.version,reg.identity.version);
 report.oldLaunch=JSON.parse(readFileSync(launchLog,'utf8').trim().split('\n').at(-1));
 report.oldConnector=JSON.parse(readFileSync(join(root,'config/cotal/extensions/node_modules/@cotal-ai/connector-jcode/package.json'),'utf8')).version;assert.equal(report.oldConnector,reg.identity.version);
 report.twoSeats=JSON.parse(ok(await cli('two-seats',a,['ps','--space','separate-proof','--on',manager,'--json'])).stdout).result;assert.equal(report.twoSeats.items.length,2);assert(report.twoSeats.items.every(s=>s.presenceIdentityVerified===true));
 const kept=report.twoSeats.items.find(s=>s.id===report.before.items[0].id);assert(kept);assert.equal(kept.pid,report.before.items[0].pid);assert.equal(kept.lifecycleUid,report.before.items[0].lifecycleUid);assert.equal(birth(kept.pid),report.seatBirth);
 assert.equal(await(await fetch(`http://127.0.0.1:${ready.port}/${report.challenge}-after-launch`)).text(),`/${report.challenge}-after-launch`);
 ok(await cli('restart-down',a,['down','--with-agents','--yes']));started=false;
 ok(await cli('restart-up',a,['up','--space','separate-proof']));started=true;
 ok(await cli('new-generation-launch',a,['spawn','--agent','jcode','--name','new_jcode','--detach','--no-events','--space','separate-proof']));
 report.newSeats=JSON.parse(ok(await cli('new-seats',a,['ps','--space','separate-proof','--json'])).stdout).result;assert.equal(report.newSeats.items.length,1);assert.equal(report.newSeats.items[0].presenceIdentityVerified,true);
 report.managerRestarted=await status('manager-restarted',a,report.newSeats.items[0].instanceId);assert.equal(report.managerRestarted.version,next.identity.version);
 report.newLaunch=JSON.parse(readFileSync(launchLog,'utf8').trim().split('\n').at(-1));assert.notEqual(report.newLaunch.pid,report.oldLaunch.pid);
 report.passed=true;
}finally{
 if(started)report.cleanup=await cli('cleanup-down',a,['down','--with-agents','--yes']);
 if(reg)await reg.close();if(next)await next.close();
 report.finalNative=readdirSync('/proc').filter(n=>/^\d+$/.test(n)&&+n!==process.pid).flatMap(n=>{try{return readlinkSync(`/proc/${n}/cwd`).startsWith(root)?[+n]:[]}catch{return[]}});
 writeFileSync(join(root,'evidence/result.json'),JSON.stringify(report,null,2));
}
assert.equal(report.cleanup.code,0);assert.deepEqual(report.finalNative,[]);
return report;
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){const[root,candidate,nextCandidate]=process.argv.slice(2);assert(root&&candidate&&nextCandidate,'usage: automatic-update-retained-launch.mjs <root> <candidate> <next>');console.log(JSON.stringify(await retainedLaunchCell({root,candidate,nextCandidate})));}
