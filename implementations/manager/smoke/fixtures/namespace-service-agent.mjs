import {createConnection} from 'node:net';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
import {existsSync,writeFileSync,readFileSync,readlinkSync} from 'node:fs';
import {CotalEndpoint} from '@cotal-ai/core';
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
 const ep=new CotalEndpoint({space:e.COTAL_SPACE,servers:e.COTAL_SERVERS,creds:readFileSync(e.COTAL_CREDS,'utf8'),card:{id:e.COTAL_ID,name:e.COTAL_NAME,role:'worker',kind:'agent'},lifecycleUid:e.COTAL_LIFECYCLE_UID,acceptedToken:e.COTAL_ACCEPTED_TOKEN,channels:[],consume:false,registerPresence:true});
 await ep.start();
 const bye=()=>{void ep.stop().finally(()=>process.exit(0));};process.on('SIGTERM',bye);process.on('SIGINT',bye);
 if(e.COTAL_NAMESPACE_GENERATION.startsWith('2.')){
  const pulled=await ep.invokeService('manager','turn-pending',undefined,{target:{mode:'self'},deadlineMs:10000});
  assert.equal(pulled.reply.ok,true);const turns=pulled.reply.data.turns;
  assert.equal(turns.length,1);assert.equal(turns[0].goalId,'service-turn'.padEnd(43,'t'));assert.equal(turns[0].payload,'service-cold-payload');
  const yielded=await ep.invokeService('manager','turn-yield',{goalId:turns[0].goalId,status:'done',note:'actual replacement completed inert turn'},{target:{mode:'self'},deadlineMs:10000});
  assert.equal(yielded.reply.ok,true);assert.equal(yielded.reply.data.state,'succeeded');
  writeFileSync(e.COTAL_SERVICE_TURN_PROOF,JSON.stringify({actor:e.COTAL_ID,uid:e.COTAL_LIFECYCLE_UID,namespace:readlinkSync('/proc/self/ns/pid'),goalId:turns[0].goalId,payload:turns[0].payload,yieldState:yielded.reply.data.state}),{flag:'wx',mode:0o600});
 }
}
