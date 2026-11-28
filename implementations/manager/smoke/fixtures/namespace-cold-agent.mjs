import {createConnection} from 'node:net';
import {spawn} from 'node:child_process';
import {existsSync,writeFileSync} from 'node:fs';
const e=process.env, role=process.argv[2]==='tool'?'tool':'main';
const socket=createConnection('\0'+e.COTAL_NAMESPACE_OBSERVER);
await new Promise((resolve,reject)=>{socket.once('error',reject);socket.once('connect',()=>socket.write(JSON.stringify({role,generation:e.COTAL_NAMESPACE_GENERATION,nonce:e.COTAL_NAMESPACE_NONCE})+'\n'));socket.once('data',()=>{socket.destroy();resolve();});});
if(role==='tool'){
 process.on('SIGTERM',()=>{});
 process.send?.('ready');
 const timer=setInterval(()=>{if(existsSync(e.COTAL_NAMESPACE_CRASH)){clearInterval(timer);setTimeout(()=>writeFileSync(e.COTAL_NAMESPACE_EFFECT,'old tool survived'),700);}},10);
 setTimeout(()=>process.exit(0),180000);
}else{
 const tool=spawn(process.execPath,[import.meta.filename,'tool'],{detached:true,stdio:['ignore','ignore','ignore','ipc'],env:e});
 await new Promise((resolve,reject)=>{tool.once('message',resolve);tool.once('error',reject);tool.once('exit',()=>reject(new Error('tool exited before admission')));});
 await import('../e2e-stub.mjs');
}
