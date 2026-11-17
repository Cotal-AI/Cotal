import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,lstatSync} from 'node:fs';
import {join} from 'node:path';

/** Reopen the real second-install observations and bind them to public calls around the updater. */
export function verifyForeignInstallManager({report,cell,output}) {
 assert.equal(cell.scenario,'foreign-install-manager');
 assert.equal(report.source,'0.162.0');assert.equal(report.method,'self');assert.equal(report.layout,'npm');
 const evidence=report.foreignInstallManager;assert(evidence?.before&&evidence?.after);
 const root=lstatSync(output);assert(root.isDirectory()&&!root.isSymbolicLink());
 if(process.getuid){assert.equal(root.uid,process.getuid());assert.equal(root.mode&0o022,0);}
 for(const stage of ['before','after']){
  const receipt=evidence[stage+'Artifact'];assert.match(receipt?.artifact??'',/^[A-Za-z0-9_.-]+\.txt$/);
  const path=join(output,receipt.artifact),stat=lstatSync(path);assert(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1);
  const bytes=readFileSync(path);assert.equal(bytes.length,receipt.bytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),receipt.sha256);
  assert.deepEqual(JSON.parse(bytes),evidence[stage]);
 }
 const {before,after}=evidence;
 assert(Number.isSafeInteger(before.uid)&&before.uid>=0);assert.equal(after.uid,before.uid);
 assert(Number.isSafeInteger(before.identity?.pid)&&before.identity.pid>1);assert(typeof before.identity.token==='string'&&before.identity.token.length>0);
 assert.deepEqual(after.identity,before.identity);assert.equal(after.instanceId,before.instanceId);assert.equal(after.lifecycleUid,before.lifecycleUid);
 assert.match(before.instanceId,/^[a-z0-9]{1,64}$/);assert.match(before.lifecycleUid,/^[a-z0-9]{1,64}$/);
 assert.equal(before.version,'0.162.0');assert.equal(after.version,before.version);assert.equal(after.entry,before.entry);assert.deepEqual(after.inventory,before.inventory);
 for(const hash of Object.values(before.inventory))assert.match(hash,/^[a-f0-9]{64}$/);
 const install=report.calls.filter(c=>c.label==='install second public CLI');assert.equal(install.length,1);assert.equal(install[0].exit,0);assert(install[0].argv.includes('cotal-ai@0.162.0'));
 const update=report.calls.filter(c=>c.label==='upgrade under test');assert.equal(update.length,1);const command=update[0];
 assert.equal(command.exit,0);assert.equal(command.signal,null);assert.equal(command.timeout,false);assert.equal(command.npmBefore,null);
 assert.deepEqual(command.argv.slice(-2),['update','--self']);assert.notEqual(command.argv[0],before.entry,'the updated entry must be a separate installation');
 for(const stage of ['before','after']){
  const matches=report.calls.filter(c=>c.label===`foreign installation Manager ${stage} update`);assert.equal(matches.length,1);
  const call=matches[0],observation=evidence[stage];
  for(const key of ['exit','signal','timeout','stdout','stderr'])assert.equal(call[key],observation.status[key]);
  assert.equal(call.exit,0);assert.equal(call.signal,null);assert.equal(call.timeout,false);
  assert.deepEqual(call.argv,[before.entry,'ps','--on',before.instanceId,'--space',report.participant.space,'--json']);
  const body=JSON.parse(call.stdout);assert.equal(body.outcome,'ok');assert.equal(body.target.managerInstanceId,before.instanceId);
  assert.equal(body.result.managers.length,1);assert.equal(body.result.managers[0].instanceId,before.instanceId);assert.equal(body.result.managers[0].state,'answered');
  if(stage==='before')assert(Date.parse(call.finishedAt)<=Date.parse(command.startedAt));
  else assert(Date.parse(call.startedAt)>=Date.parse(command.finishedAt));
 }
 assert.equal(report.cleanupSafety?.passed,true);assert.equal(report.compositionCleanup,'owned composition stopped before reporting');
 return {passed:true,identity:before.identity,instanceId:before.instanceId,lifecycleUid:before.lifecycleUid,foreignVersion:before.version,updateExit:command.exit};
}
