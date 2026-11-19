import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { saveIdpSession } from '@cotal-ai/auth';
import { serveDaemon } from '../../bin/daemon/server.js';
import { daemonPathsFor } from '../../bin/daemon/endpoint.js';
import { queryDaemon } from '../../bin/daemon/client.js';
import { exchangeDesktopRequest } from '../../bin/daemon/desktop.js';
const root = mkdtempSync(join(tmpdir(), 'row-'));
const home = join(root, 'home'); mkdirSync(home, {mode:0o700});
Object.assign(process.env,{HOME:home,COTAL_HOME:home,XDG_CONFIG_HOME:join(root,'config')});
const runtime=join(root,'rt'); mkdirSync(runtime,{mode:0o700});
mkdirSync(join(home,'daemon'),{mode:0o700});
writeFileSync(join(home,'daemon','account-spaces.json'),JSON.stringify({v:1,spaces:{'foreign-space':{owner:'retained-other-account',id:'foreign-id',revision:1,removedAt:1}}}),{mode:0o600});
let idp='', issuer='';
const server=createServer((req,res)=>{res.setHeader('content-type','application/json'); const id=req.url?.match(/machines\/([^/]+)/)?.[1]; res.end(JSON.stringify(req.method==='PUT'?{v:1,machine:{id,lastSeenAt:new Date().toISOString(),revision:1}}:{v:1,machineId:id,revision:1,bindingRevisions:{'foreign-id':1},account:{idpUrl:idp,issuer,sub:'new-owner'},spaces:[{id:'foreign-id',slug:'foreign-space',name:'Foreign space',kind:'team',role:'member',unavailable:'offline'}]}));});
await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
issuer=`http://127.0.0.1:${(server.address() as {port:number}).port}`; idp=`${issuer}/api/auth`;
saveIdpSession(home,idp,{token:'fixture-only',sub:'new-owner',expiresAt:Date.now()/1000+3600});
const paths=daemonPathsFor(home,{XDG_RUNTIME_DIR:runtime});
const daemon=await serveDaemon({paths,sessionDir:home,version:'0.168.0'});
try {
 const end=Date.now()+15000;
 while(!JSON.stringify(daemon.status()).includes('another account owns')&&Date.now()<end) await new Promise(r=>setTimeout(r,50));
 console.log('BEFORE',JSON.stringify(daemon.status().account));
 assert.match(JSON.stringify(daemon.status()),/another account owns/);
 for(const request of [{op:'space-intent',space:'foreign-space',enabled:true},{op:'status'}] as const){const start=performance.now();const result=request.op === 'status' ? await queryDaemon({paths}) : await exchangeDesktopRequest({paths},request);console.log('TIMING',request.op,Math.round(performance.now()-start),'ms',JSON.stringify(result));}
} finally {await daemon.close(); server.closeAllConnections(); await new Promise<void>(r=>server.close(()=>r()));}
