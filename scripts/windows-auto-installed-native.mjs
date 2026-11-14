// Runs the product's native reader API from the user-installed packed package, never a source mock.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
assert.equal(process.platform,'win32');
const {win32ProcessBinding,windowsCommandLine,windowsEnvironmentBlock}=await import(pathToFileURL(process.argv[2]).href);
const native=win32ProcessBinding(),root=mkdtempSync(join(tmpdir(),'installed-win-update-'));
try{
 const bootId=native.bootId();assert(Number.isInteger(bootId));assert.equal(native.bootId(),bootId);console.log(JSON.stringify({bootId,source:'installed packed workspace binding',clockIdentity:'OS-loader sequence'}));
 const file=join(root,'worker.mjs'),log=join(root,'worker.log');writeFileSync(file,'import {spawn} from "node:child_process";spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});setInterval(()=>{},1000);');writeFileSync(log,'');
 const child=native.launch({application:process.execPath,commandLine:windowsCommandLine(process.execPath,[file]),cwd:root,environment:windowsEnvironmentBlock({},process.env),log});assert.equal(native.inJob(child.pid),true);
 const until=performance.now()+10000;while(native.jobProcesses().length<2&&performance.now()<until)await delay(10);
 assert(native.accounting().active>=2);assert.equal(native.drain(20000),'drained');assert.deepEqual(native.accounting(),{active:0,assigned:0,count:0});assert.deepEqual(native.jobProcesses(),[]);console.log('installed native boot/accounting/drain acceptance passed');
}finally{rmSync(root,{recursive:true,force:true});}
