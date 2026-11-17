import {appendFileSync} from 'node:fs';
import {Socket,Server} from 'node:net';
const output=process.env.DARWIN_SOCKET_TRACE_FILE;
const tracked=new WeakMap();let sequence=0;
let incomplete=false;
function record(socket,event,details={}){
 const identity=tracked.get(socket);if(!identity||!output)return;
 try {
  appendFileSync(output,JSON.stringify({at:new Date().toISOString(),monoNs:process.hrtime.bigint().toString(),pid:process.pid,role:process.argv.includes('serve')?'daemon':process.argv.includes('status')?'status-client':'other',...identity,event,fd:socket._handle?.fd??null,destroyed:socket.destroyed,readable:socket.readable,writable:socket.writable,...details})+'\n',{mode:0o600});
 }catch(error){
  if(!incomplete){incomplete=true;try{process.stderr.write(`DARWIN_SOCKET_TRACE_INCOMPLETE pid=${process.pid} code=${error.code??'unknown'}\n`);}catch{}}
 }
}
function track(socket,side,path){
 if(tracked.has(socket))return;
 tracked.set(socket,{connection:++sequence,side,path});
 record(socket,'observed');
}
const socketEmit=Socket.prototype.emit;
Socket.prototype.emit=function(event,...args){
 if(['connect','end','close','timeout','error'].includes(event))record(this,event,event==='error'?{code:args[0]?.code,message:args[0]?.message}:event==='close'?{hadError:args[0]}:{});
 return Reflect.apply(socketEmit,this,[event,...args]);
};
const connect=Socket.prototype.connect;
Socket.prototype.connect=function(...args){
 const first=Array.isArray(args[0])?args[0][0]:args[0],path=typeof first==='string'?first:typeof first?.path==='string'?first.path:undefined;
 if(path?.endsWith('/daemon.sock'))track(this,'client',path);
 return Reflect.apply(connect,this,args);
};
const emit=Server.prototype.emit;
Server.prototype.emit=function(event,...args){
 if(event==='connection'&&this._pipeName?.includes('/.bind-'))track(args[0],'server',this._pipeName);
 return Reflect.apply(emit,this,[event,...args]);
};
for(const name of ['end','destroy','destroySoon']){
 const original=Socket.prototype[name];
 Socket.prototype[name]=function(...args){
  record(this,'call-'+name,{stack:new Error().stack?.split('\n').slice(2,8),code:args[0]?.code});
  return Reflect.apply(original,this,args);
 };
}
