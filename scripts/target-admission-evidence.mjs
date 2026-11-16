import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {constants,openSync,closeSync,fstatSync,readFileSync} from 'node:fs';
import {join} from 'node:path';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const modes=new Set(['foreign-preserving','offline','manager-unknown','consent-stop','consent-declined']);
const identity=value=>value&&Number.isSafeInteger(value.pid)&&value.pid>0&&typeof value.start==='string'&&value.start.length>0;
const same=(a,b)=>identity(a)&&identity(b)&&a.pid===b.pid&&a.start===b.start;

/** Reopen native composition observations and grade the actual installed public update/action. */
export function verifyTargetAdmissionEvidence({report,cell,output}) {
 const e=report.targetAdmission;
 assert(e&&modes.has(e.mode),'target admission mode missing');
 assert.equal(cell.targetAdmission,e.mode);
 assert(['linux','darwin'].includes(cell.platform),'Windows does not use staged admission');
 assert.match(e.artifact?.name??'',/^[A-Za-z0-9_.-]+\.json$/);
 const fd=openSync(join(output,e.artifact.name),constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const st=fstatSync(fd);assert(st.isFile()&&st.nlink===1&&st.size===e.artifact.bytes&&st.size<8*1024**2);const bytes=readFileSync(fd);assert.equal(hash(bytes),e.artifact.sha256);const saved=JSON.parse(bytes);const{artifact,remaining,...comparison}=e;assert.deepEqual(saved,comparison,'archived composition observation differs from report');}finally{closeSync(fd)}
 const calls=report.calls.filter(c=>c.label==='upgrade under test');assert.equal(calls.length,1);
 const call=calls[0];for(const key of ['exit','signal','timeout','stdout','stderr'])assert.equal(call[key],e.update?.[key],`public update ${key} differs`);
 assert.equal(call.exit,0);assert.equal(call.signal,null);assert.equal(call.timeout,false);
 const invocation=report.candidateSourceInvocation;const argv=call.argv??call.args;assert(argv.includes(invocation.argv[0])||call.file===invocation.argv[0]);assert(argv.includes('update')&&argv.includes('--self'));
 assert(identity(e.before?.daemon)&&identity(e.before?.manager)&&identity(e.after?.daemon)&&identity(e.after?.manager));
 assert.equal(e.recovery,null);
 const probe=report.calls.filter(row=>row.label==='actual target read-only admission before update');assert.equal(probe.length,1);assert.equal(probe[0].exit,0);const receiptLines=probe[0].stdout.split('\n').filter(line=>line.startsWith('COTAL_PREINSTALL_RESULT '));assert.equal(receiptLines.length,1);assert.deepEqual(JSON.parse(receiptLines[0].slice('COTAL_PREINSTALL_RESULT '.length)),e.targetReceipt);const request=JSON.parse(probe[0].argv.at(-1));assert.equal(e.targetReceipt.nonce,request.nonce);assert.equal(e.targetReceipt.installedEntry,invocation.argv[0]);
 if(['foreign-preserving','offline','manager-unknown'].includes(e.mode)){assert.equal(e.targetReceipt.occupied,null);assert.equal(e.targetReceipt.admission.disposition,'deferred');}
 if(e.mode.startsWith('consent-')){assert.equal(e.targetReceipt.admission.disposition,'consent-stop');assert.equal(e.targetReceipt.occupied,1);assert.equal(e.targetReceipt.admission.inventory.length,1);}
 const deferred=e.mode!=='consent-stop';assert.equal(e.deferred,deferred);
 const assertions={publicUpdate:true,sourceIdentity:true,targetVersion:report.selectedCliVersion===cell.targetVersion,noRecovery:true,nativeAction:false,retainedSet:false,retainedWork:false,lateRead:false};
 if(deferred){
  assert(same(e.before.daemon,e.after.daemon)&&same(e.before.manager,e.after.manager),'deferred action changed a native holder');
  assert.equal(e.before.manager.instanceId,e.after.manager.instanceId);
  assert.match(call.stdout,/activation deferred:.*software update finished/);
  assert(e.activationRecords?.some(({record})=>record.v===1&&record.target===cell.targetVersion&&typeof record.reason==='string'&&record.reason.length>0),'persistent target-specific deferral missing');
  assert(e.oldSetsAfter?.length>0&&e.oldSetsAfter.every(row=>row.observedSha256===row.sha256),'old loaded connector bytes changed');
  assertions.nativeAction=true;assertions.retainedSet=true;
 }else{assert.equal(e.after.version,cell.targetVersion);assert.equal(e.before.version,report.source);assert(!e.workAfter?.items?.some(row=>row.name==='admission_original'));assert(call.argv?.includes('--stop-agents'),'explicit stop consent missing');assertions.nativeAction=true;assertions.retainedSet=true;}
 if(e.mode==='foreign-preserving'){
  assert.equal(e.fenceProducer.signal,'SIGKILL');assert.equal(e.fenceProducer.exit,null);assert.match(e.fenceProducer.stdout,/Saving update recovery snapshot/);assert(e.preparedFence?.prepared&&e.preparedFence.managers.every(row=>row.fenced&&row.seats===0));assert.equal(e.foreignSource?.source,cell.legacySourceSHA);assert(e.foreignSource.entry!==invocation.argv[0]);assert.equal(e.lateConsole?.status,200);assert.match(e.lateConsole.sha256,/^[a-f0-9]{64}$/);assertions.retainedWork=true;assertions.lateRead=true;
 }else{
  assert.equal(e.workBefore?.items?.length,1);assert.equal(e.workBefore.items[0].name,'admission_original');
  const original=e.workBefore.items[0];const after=e.workAfter?.items?.find(row=>row.name===original.name);
  if(deferred){assert(after,'original work disappeared without consent');assert.equal(after.id,original.id);assert.equal(after.lifecycleUid,original.lifecycleUid);}
  assert(identity(e.lateReady)&&e.lateReady.name==='admission_late'&&e.lateReady.managerInstance===e.after.manager.instanceId,'late seat native authenticated readiness missing');
  assert(e.lateWork?.items?.some(row=>row.name==='admission_late'&&row.lifecycleUid===e.lateReady.lifecycleUid&&typeof row.id==='string'&&row.id),'late real seat did not start');assertions.retainedWork=true;assertions.lateRead=true;
  if(e.mode==='offline')assert.equal(e.dependency?.brokerTraffic,'paused');
  if(e.mode==='manager-unknown'){assert.equal(e.dependency?.manager,'SIGSTOP');assert(same(e.dependency.identity,e.before.manager));}
 }
 return{passed:Object.values(assertions).every(Boolean),assertions};
}
