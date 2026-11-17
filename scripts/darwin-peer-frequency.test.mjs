import assert from 'node:assert/strict';
import {test} from 'node:test';
import {incompleteDaemonTrace,measureDaemonRequests} from './darwin-peer-frequency.mjs';

test('bounded read-only sample preserves successes and exact peer-read errors without retries',async()=>{
 let clock=0,calls=0;
 const result=await measureDaemonRequests({stage:'after-ready',count:3,now:()=>clock,request:async(label,timeout)=>{
  assert(label.startsWith('after-ready read-only daemon request'));assert.equal(timeout,5000);calls++;clock+=10;
  return {exit:calls===2?3:0,signal:null,timeout:false,stdout:calls===2?"could not read the daemon's peer credentials: Socket is not connected":'ready',stderr:''};
 }});
 assert.equal(calls,3);assert.equal(result.completed,3);assert.equal(result.enotconn,1);assert.equal(result.failures,1);assert.equal(result.rows[1].exit,3);
});
test('daemon-only incomplete marker is read from hash-bound archive, not metadata',async()=>{
 const {mkdtempSync,writeFileSync}=await import('node:fs');const {createHash}=await import('node:crypto');
 const root=mkdtempSync('/var/tmp/daemon-trace-marker-'),name='cell-daemon.log.txt',bytes=Buffer.from('daemon ready\nDARWIN_SOCKET_TRACE_INCOMPLETE pid=123 code=EACCES\n');
 writeFileSync(root+'/'+name,bytes);
 const report={calls:[{stdout:'',stderr:''}],daemonDiagnostics:{'after-update':{observations:[{artifact:name,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}]}}};
 assert.equal(JSON.stringify(report.daemonDiagnostics).includes('DARWIN_SOCKET_TRACE_INCOMPLETE'),false);
 assert.equal(incompleteDaemonTrace(report,root),true);
 writeFileSync(root+'/'+name,'changed');assert.throws(()=>incompleteDaemonTrace(report,root));
});

test('total deadline ends measurement without manufacturing samples',async()=>{
 let clock=0;
 const result=await measureDaemonRequests({stage:'after-update',count:50,deadlineMs:100,now:()=>clock,request:async()=>{clock+=60;return {exit:0,stdout:'ready',stderr:''};}});
 assert.equal(result.completed,2);assert.equal(result.requested,50);assert.equal(result.enotconn,0);
 await assert.rejects(measureDaemonRequests({stage:'bad',request:async()=>({})}));
 await assert.rejects(measureDaemonRequests({stage:'after-ready',count:51,request:async()=>({})}));
});
