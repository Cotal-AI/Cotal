#!/usr/bin/env node
/** Local installed-entry witness for target-owned preinstall refusal. Run only with reviewed packed fixtures. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';
import {existsSync,lstatSync,mkdirSync,readFileSync,readdirSync,readlinkSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {candidatePairRegistry} from './candidate-pair-registry.mjs';

const {values}=parseArgs({options:{candidate:{type:'string'},target:{type:'string'},output:{type:'string'},refusal:{type:'string'}}});
for(const name of ['candidate','target','output','refusal'])assert(values[name],`--${name} required`);
assert(process.platform==='linux','initial cell is Linux only');
const output=resolve(values.output);assert(!existsSync(output),'output must be a new private directory');
mkdirSync(output,{mode:0o700});
const home=join(output,'home'),state=join(output,'state'),config=join(output,'config'),runtime=join(output,'runtime'),prefix=join(output,'prefix'),project=join(output,'project');
for(const dir of [home,state,config,runtime,prefix,project])mkdirSync(dir,{mode:0o700});
const env={...process.env};for(const key of Object.keys(env))if(key.startsWith('COTAL_'))delete env[key];
Object.assign(env,{HOME:home,COTAL_HOME:state,XDG_CONFIG_HOME:config,XDG_RUNTIME_DIR:runtime,DO_NOT_TRACK:'1',COTAL_TELEMETRY:'off',COTAL_SKIP_CONNECTOR_SEED:'1',npm_config_cache:join(output,'npm-cache')});
const calls=[];
async function call(label,file,args){
 const row={label,file,args,status:null,signal:null,stdout:'',stderr:'',timeout:false};calls.push(row);
 await new Promise((done,reject)=>{const child=spawn(file,args,{cwd:project,env,stdio:['ignore','pipe','pipe']});let forced;
 const timer=setTimeout(()=>{row.timeout=true;child.kill('SIGTERM');forced=setTimeout(()=>child.kill('SIGKILL'),5000)},180000);
 child.stdout.on('data',b=>row.stdout+=b);child.stderr.on('data',b=>row.stderr+=b);child.once('error',error=>{clearTimeout(timer);clearTimeout(forced);reject(error)});child.once('close',(status,signal)=>{clearTimeout(timer);clearTimeout(forced);row.status=status;row.signal=signal;done()});});
 assert(!row.timeout&&!row.signal,`${label}: outcome not confirmed`);return row;
}
function inventory(root){if(!existsSync(root))return null;const rows=[];function walk(path,name){const st=lstatSync(path);if(st.isSymbolicLink())rows.push([name,'link',readlinkSync(path)]);else if(st.isDirectory())for(const n of readdirSync(path).sort())walk(join(path,n),name+'/'+n);else rows.push([name,createHash('sha256').update(readFileSync(path)).digest('hex')]);}walk(root,'');return rows;}
let registry;
try{
 registry=await candidatePairRegistry(resolve(values.candidate),resolve(values.target));
 env.npm_config_registry=registry.url;writeFileSync(join(home,'.npmrc'),`registry=${registry.url}\n`,{mode:0o600});
 const installed=join(prefix,'lib/node_modules/cotal-ai'),entry=join(installed,'dist/cotal.js');
 const install=await call('install exact source closure','npm',['install','-g','--prefix',prefix,`cotal-ai@${registry.identity.sourceVersion}`,'--no-audit','--no-fund']);assert.equal(install.status,0,install.stderr);
 const meta=JSON.parse(readFileSync(join(installed,'package.json')));assert.equal(meta.version,registry.identity.sourceVersion);
 const request={v:1,nonce:randomBytes(16).toString('hex'),installedEntry:entry,daemonArgv:[process.execPath,entry,'daemon','serve'],flags:{}};
 const before={installed:inventory(installed),config:inventory(config),state:inventory(state)};
 const floor=await call('source declared preinstall accepts same machine',process.execPath,[join(installed,meta.cotalPreinstall.entry),JSON.stringify(request)]);
 assert.equal(floor.status,0,floor.stderr);const receipts=floor.stdout.split(/\r?\n/).filter(line=>line.startsWith('COTAL_PREINSTALL_RESULT '));assert.equal(receipts.length,1);const receipt=JSON.parse(receipts[0].slice('COTAL_PREINSTALL_RESULT '.length));assert.equal(receipt.nonce,request.nonce);assert.equal(receipt.installedEntry,entry);
 writeFileSync(join(output,'before-inventory.json'),JSON.stringify(before,null,2),{mode:0o600});
 assert.deepEqual({installed:inventory(installed),config:inventory(config),state:inventory(state)},before,'source control must be read-only');
 registry.activateTarget();
 const update=await call('installed public update obeys target refusal',process.execPath,[entry,'update','--self']);
 assert.notEqual(update.status,0,'target-only refusal must prevent publication');
 assert(!(floor.stdout+'\n'+floor.stderr).includes(values.refusal),'refusal is not target-specific');
 assert((update.stdout+'\n'+update.stderr).includes(values.refusal),'target-specific refusal not reached');
 writeFileSync(join(output,'after-inventory.json'),JSON.stringify({installed:inventory(installed),config:inventory(config),state:inventory(state)},null,2),{mode:0o600});
 assert.deepEqual(inventory(installed),before.installed,'canonical source bytes changed despite target refusal');
 assert.deepEqual(inventory(config),before.config,'connector/config bytes changed despite target refusal');
 const version=await call('source remains selected',process.execPath,[entry,'--version']);assert.equal(version.status,0,version.stderr);assert.equal(version.stdout.split(/\r?\n/)[0],`cotal-ai ${registry.identity.sourceVersion}`);
 const recovery=join(state,'update-recovery.json');assert(!existsSync(recovery)||JSON.parse(readFileSync(recovery))===null,'target refusal left recovery authority');
 writeFileSync(join(output,'result.json'),JSON.stringify({passed:true,source:registry.identity.source,identity:registry.identity,refusal:values.refusal,calls},null,2),{mode:0o600});
 console.log('target-owned preinstall: source control accepts, installed updater refuses target-only policy, source/config unchanged');
}catch(error){writeFileSync(join(output,'result.json'),JSON.stringify({passed:false,error:error.message,calls},null,2),{mode:0o600});throw error;}
finally{if(registry){const requests=await registry.close();writeFileSync(join(output,'registry-requests.json'),JSON.stringify(requests,null,2),{mode:0o600});}}
