import {mkdirSync,readdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
const output=process.argv[2],scratch=process.env.RUNNER_TEMP;
if(!output||!scratch||process.platform!=='darwin')throw Error('native diagnostics require Mac runner and explicit output');
mkdirSync(output,{recursive:true});
const run=(file,args)=>{const r=spawnSync(file,args,{encoding:'utf8',timeout:15000,maxBuffer:1024*1024});return {file,args,status:r.status,signal:r.signal,stdout:r.stdout,stderr:r.stderr,error:r.error?.message};};
const redact=text=>text.replace(/eyJ[A-Za-z0-9_.-]*/g,'<redacted-jwt>');
const rows=[];
for(const item of readdirSync(scratch,{withFileTypes:true}).filter(d=>d.isDirectory()&&d.name.startsWith('cell-'))){
 const root=join(scratch,item.name),entry=join(root,'prefix/lib/node_modules/cotal-ai/dist/cotal.js');if(!existsSync(entry))continue;
 const daemonHome=join(process.env.HOME,'.cotal/daemon');
 const files={};for(const name of ['daemon.log','service-unit.json','daemon.lock']){const path=join(daemonHome,name);if(existsSync(path)){const bytes=readFileSync(path);files[name]=redact(bytes.subarray(Math.max(0,bytes.length-256*1024)).toString('utf8'));}}
 const processes=run('/bin/ps',['-axo','pid,ppid,command']);processes.stdout=processes.stdout?.split('\n').filter(line=>line.includes(root)||line.includes('/.cotal/')).join('\n');
 rows.push({root,files,status:run(process.execPath,[entry,'daemon','status','--json']),supervisor:run('/bin/launchctl',['print',`gui/${process.getuid()}/ai.cotal.daemon`]),processes});
}
writeFileSync(join(output,'native-final-diagnostics.json'),JSON.stringify({at:new Date().toISOString(),scope:'Read-only owned cell status, standard user daemon logs/source/lifetime, own launchd label and process list; no stop/delete/retry',rows},null,2));
