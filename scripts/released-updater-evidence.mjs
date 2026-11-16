import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {constants,openSync,closeSync,fstatSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const modes=new Set(['no-service','empty-owned-service','owned-agent-consent','foreground-foreign-prefix']);
const projection=row=>({daemon:row.daemon,hostedSpaces:row.hostedSpaces,occupied:row.occupied});
const identity=row=>row&&Number.isSafeInteger(row.pid)&&row.pid>0&&typeof row.start==='string'&&row.start.length>0;

/** Verify archived observations against the public released command and its installed reader. */
export function verifyReleasedUpdaterEvidence({report,cell,output}) {
 const e=report.releasedUpdater;
 assert(e&&modes.has(e.mode)); assert.equal(e.mode,cell.releasedUpdater);
 assert(['linux','darwin'].includes(cell.platform));
 assert.match(e.artifact?.name??'',/^[A-Za-z0-9_.-]+\.json$/);
 const fd=openSync(join(output,e.artifact.name),constants.O_RDONLY|constants.O_NOFOLLOW);
 try {const st=fstatSync(fd);assert(st.isFile()&&st.nlink===1&&st.size===e.artifact.bytes&&st.size<8*1024**2);const bytes=readFileSync(fd);assert.equal(hash(bytes),e.artifact.sha256);const {artifact,...saved}=e;assert.deepEqual(JSON.parse(bytes),JSON.parse(JSON.stringify(saved)));}finally{closeSync(fd)}
 assert.equal(report.source,'0.164.18');assert.equal(e.sourceVersion,report.source);
 assert.match(e.sourcePackageSha256,/^[a-f0-9]{64}$/);
 assert.match(e.officialDist?.integrity??'',/^sha512-/);assert.match(e.officialDist.tarball,/^https:\/\/registry\.npmjs\.org\//);
 const dist=report.calls.filter(row=>row.label==='released source public dist');assert.equal(dist.length,1);assert.equal(dist[0].exit,0);assert.deepEqual(JSON.parse(dist[0].stdout),e.officialDist);
 const updates=report.calls.filter(row=>row.label==='upgrade under test');assert.equal(updates.length,1);
 const update=updates[0],argv=update.argv??update.args;
 assert(argv.includes(e.sourceEntry)||update.file===e.sourceEntry);assert(argv.includes('update')&&argv.includes('--self'));
 for(const key of ['exit','signal','timeout','stdout','stderr'])assert.equal(update[key],e.update[key]);
 assert.equal(update.exit,0);assert.equal(update.signal,null);assert.equal(update.timeout,false);
 assert.equal(e.selectedVersion,cell.targetVersion);assert.equal(report.selectedCliVersion,cell.targetVersion);assert.equal(e.recovery,null);
 const probes=report.calls.filter(row=>row.label==='released reader probe before update');assert.equal(probes.length,1);assert.equal(probes[0].exit,0);
 for(const key of ['exit','stdout','stderr'])assert.equal(probes[0][key],e.readerProbeCall[key]);
 const lines=probes[0].stdout.split('\n').filter(line=>line.startsWith('RELEASED_READER_RESULT '));assert.equal(lines.length,1);assert.deepEqual(JSON.parse(lines[0].slice('RELEASED_READER_RESULT '.length)),e.readerProbe);
 assert.equal(e.readerProbe.accepted,true);assert.equal(e.readerProbe.receipt.installedEntry,e.sourceEntry);
 assert.deepEqual(projection(e.readerProbe.receipt),projection(e.readerProbe.legacy));
 assert(Number.isSafeInteger(e.readerProbe.receipt.occupied)&&e.readerProbe.receipt.occupied>=0);
 if(e.mode==='no-service'){assert.equal(e.noServiceAfter?.exit,2);const statuses=report.calls.filter(row=>row.label==='released no-service custody after');assert.equal(statuses.length,1);assert.equal(statuses[0].exit,2);assert.equal(e.before,null);assert.equal(e.after,null);assert.deepEqual(e.readerProbe.legacy,{hostedSpaces:[],occupied:0});}
 else {
  assert(identity(e.before?.daemon)&&identity(e.after?.daemon));assert.equal(e.before.version,'0.164.18');
  assert(e.before.managers.length>0&&e.before.managers.every(row=>identity(row)&&typeof row.instanceId==='string'));
  if(e.mode==='foreground-foreign-prefix'){
   assert.equal(e.foreignSource.version,'0.164.18');assert.notEqual(e.foreignSource.entry,e.sourceEntry);
   assert.deepEqual(e.after.daemon,e.before.daemon);assert.deepEqual(e.after.managers,e.before.managers);assert.deepEqual(e.after.update?.restartEvidence,e.before.update?.restartEvidence);
  }else{assert.equal(e.after.version,cell.targetVersion);assert(e.after.managers.length>0&&e.after.managers.every(row=>identity(row)&&row.state==='answering'));}
  if(e.mode==='owned-agent-consent'){assert(argv.includes('--stop-agents'));assert(identity(e.seat));assert.equal(e.seatStopped,true);assert.equal(e.workBefore.items.length,1);assert.equal(e.readerProbe.legacy.occupied,1);}
 }
 const assertions={'released-updater-source':true,'released-updater-self':true,'released-reader-probe':true,'custody-preserved':true};
 return {passed:true,assertions};
}
