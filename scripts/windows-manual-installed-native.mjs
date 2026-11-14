import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
const entry=process.argv[2];assert(entry);assert.equal(process.platform,'win32');
const {win32ProcessBinding}=await import(pathToFileURL(entry).href);
const {liveWindowsUpdateClosureOwner}=await import(pathToFileURL(join(dirname(entry),'update-closure-win32.js')).href);
const {acquireLock}=await import(pathToFileURL(join(dirname(entry),'advisory-lock.js')).href);
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});
const pin=win32ProcessBinding().pinProcess(child.pid);let passed=0;
try{assert.equal(pin.exited(),false);passed++;assert.equal(pin.token,win32ProcessBinding().creationToken(child.pid));passed++;
 const closed=new Promise(r=>child.once('close',r));child.kill();await closed;assert.equal(pin.exited(),true);passed++;
 pin.close();pin.close();assert.throws(()=>pin.exited(),/closed/);passed++;
}finally{pin.close();child.kill();}
const path=join(mkdtempSync(join(tmpdir(),'installed-owner-pin-')),'closure.lock'),held=acquireLock(path);
try{const original=readFileSync(path,'utf8');const record={v:1,previous:'A',target:'B',installed:'A',phase:'replacing',reason:'native smoke',recordedAt:new Date().toISOString(),owner:{pid:process.pid,start:'',nonce:held.nonce}};
 assert.equal(liveWindowsUpdateClosureOwner(record,path),true);passed++;
 assert.equal(liveWindowsUpdateClosureOwner({...record,owner:{...record.owner,nonce:'foreign'}},path),false);passed++;
 assert.equal(liveWindowsUpdateClosureOwner({...record,owner:{...record.owner,start:'1'}},path),false);passed++;
 assert.equal(liveWindowsUpdateClosureOwner({...record,recordedAt:'1970-01-01T00:00:00.000Z'},path),false);passed++;
 writeFileSync(path,JSON.stringify({...JSON.parse(original),nonce:'replaced'}));assert.equal(liveWindowsUpdateClosureOwner(record,path),false);passed++;writeFileSync(path,original);
}finally{held.release();}
console.log(JSON.stringify({passed,installedWorkspace:entry,native:true}));
