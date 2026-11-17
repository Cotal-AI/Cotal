import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import test from 'node:test';

test('diagnostic preload records actual client and server close calls without payloads',()=>{
 const root=mkdtempSync('/var/tmp/socket-trace-test-'),output=join(root,'trace.ndjson'),socket=join(root,'daemon.sock');
 const program=`import{createServer,createConnection}from'node:net';const server=createServer(s=>{s.resume();s.once('data',()=>s.end('ok'));});await new Promise(r=>server.listen(${JSON.stringify(socket)},r));server._pipeName=${JSON.stringify(join(root,'.bind-test'))};const client=createConnection(${JSON.stringify(socket)});client.on('error',e=>{throw e;});await new Promise(r=>client.once('connect',r));client.write('private-payload');client.resume();await new Promise(r=>client.once('close',r));await new Promise(r=>server.close(r));`;
 const result=spawnSync(process.execPath,['--import',new URL('./daemon-socket-trace.mjs',import.meta.url).pathname,'--input-type=module','-e',program],{env:{...process.env,DARWIN_SOCKET_TRACE_FILE:output},encoding:'utf8',timeout:5000});
 assert.equal(result.status,0,result.stderr);
 const text=readFileSync(output,'utf8'),rows=text.trim().split('\n').map(line=>JSON.parse(line));
 assert(rows.some(row=>row.side==='client'&&row.event==='connect'));
 assert(rows.some(row=>row.side==='server'&&row.event==='call-end'&&row.stack.length));
 assert(rows.some(row=>row.side==='client'&&row.event==='close'));
 assert(!text.includes('private-payload'));
});
