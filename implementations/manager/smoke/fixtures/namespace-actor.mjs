import { createConnection } from 'node:net';
import { spawn } from 'node:child_process';
import { existsSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [role,root]=process.argv.slice(2);
const socket=createConnection(join(root,'actors.sock'));
const deadline=setTimeout(()=>process.exit(2),12_000);
socket.on('error',()=>process.exit(3));
socket.once('connect',()=>socket.write(role+'\n'));
socket.once('data',()=>{
 socket.destroy();
 if(role==='main'){
  const child=spawn(process.execPath,[import.meta.filename,'tool',root],{detached:true,stdio:'ignore',env:{PATH:'/usr/bin:/bin'}});
  let childDone=false;child.once('exit',()=>childDone=true);
  process.on('SIGINT',()=>{console.log('INT');process.exit(0);});
  process.stdout.on('resize',()=>console.log(`SIZE=${process.stdout.columns}x${process.stdout.rows}`));
  process.stdin.on('data',b=>console.log('ACK='+b.toString().trim()));
  console.log('READY');
  const timer=setInterval(()=>{if(existsSync(join(root,'finish'))&&childDone){writeFileSync(join(root,'main.effect'),'finished');clearInterval(timer);clearTimeout(deadline);process.exit(0);}},10);
 }else{
  process.on('SIGTERM',()=>{});
  const timer=setInterval(()=>{if(existsSync(join(root,'finish'))){writeFileSync(join(root,'tool.effect'),'finished');clearInterval(timer);clearTimeout(deadline);process.exit(0);}},10);
 }
});
