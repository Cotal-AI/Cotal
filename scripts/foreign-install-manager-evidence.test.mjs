import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,writeFileSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {verifyForeignInstallManager} from './foreign-install-manager-evidence.mjs';
import {boundedCells} from './upgrade-matrix-plan.mjs';

function evidence(change=()=>{}) {
 const output=mkdtempSync(join(tmpdir(),'foreign-install-evidence-'));chmodSync(output,0o700);
 const reply=label=>({label,argv:['/B/dist/cotal.js','ps','--on','manager','--space','hosted','--json'],exit:0,signal:null,timeout:false,stdout:JSON.stringify({outcome:'ok',target:{managerInstanceId:'manager'},result:{managers:[{instanceId:'manager',state:'answered'}],items:[]}}),stderr:'',startedAt:label.includes('before')?'2026-11-17T01:00:00Z':'2026-11-17T01:00:03Z',finishedAt:label.includes('before')?'2026-11-17T01:00:01Z':'2026-11-17T01:00:04Z'});
 const beforeStatus=reply('foreign installation Manager before update'),afterStatus=reply('foreign installation Manager after update');
 const before={identity:{pid:1234,token:'native-birth'},uid:1000,instanceId:'manager',lifecycleUid:'lifecycle',entry:'/B/dist/cotal.js',version:'0.162.0',inventory:{entrySha256:'a'.repeat(64),packageSha256:'b'.repeat(64),remoteRecordSha256:'c'.repeat(64)},status:beforeStatus};
 const after={...structuredClone(before),status:afterStatus};
 const report={source:'0.162.0',layout:'npm',method:'self',participant:{space:'hosted'},calls:[{label:'install second public CLI',argv:['install','cotal-ai@0.162.0'],exit:0},beforeStatus,{label:'upgrade under test',argv:['/A/dist/cotal.js','update','--self'],exit:0,signal:null,timeout:false,npmBefore:null,startedAt:'2026-11-17T01:00:01Z',finishedAt:'2026-11-17T01:00:02Z'},afterStatus],foreignInstallManager:{before,after},cleanupSafety:{passed:true},compositionCleanup:'owned composition stopped before reporting'};
 change(report);
 for(const stage of ['before','after']){const bytes=Buffer.from(JSON.stringify(report.foreignInstallManager[stage])),artifact=stage+'.txt';writeFileSync(join(output,artifact),bytes,{mode:0o600});report.foreignInstallManager[stage+'Artifact']={artifact,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};}
 return{report,cell:{scenario:'foreign-install-manager'},output};
}

test('permanent POSIX cell pins legacy source and requires foreign Manager preservation in both phases',()=>{
 for(const phase of ['candidate','published']){
  const cells=boundedCells({status:'planned',phase,sourceSHA:'a'.repeat(40),sourceVersion:'0.165.2',targetVersion:'0.165.3',targetSource:phase==='candidate'?'packed-target':'npm-exact'});
  const foreign=cells.filter(c=>c.scenario==='foreign-install-manager');
  assert.deepEqual(foreign.map(c=>c.platform),['linux','darwin']);
  for(const cell of foreign){assert.equal(cell.sourceVersion,'0.162.0');assert.equal(cell.channel,'npm');assert.equal(cell.required,true);assert(cell.requiredAssertions.includes('foreign-install-manager-preserved'));}
 }
});

test('independent evidence requires answering unchanged foreign native identity after actual updater exit',()=>{
 assert.equal(verifyForeignInstallManager(evidence()).passed,true);
 for(const change of [
  r=>r.foreignInstallManager.after.identity.pid++,r=>r.foreignInstallManager.after.identity.token='reused',
  r=>r.foreignInstallManager.after.lifecycleUid='new',r=>r.foreignInstallManager.after.instanceId='new',
  r=>r.foreignInstallManager.after.uid++,r=>r.foreignInstallManager.after.inventory.entrySha256='d'.repeat(64),
  r=>r.calls[2].exit=1,r=>r.calls[2].timeout=true,r=>r.calls[2].npmBefore='date',
  r=>r.calls[2].argv[0]='/B/dist/cotal.js',r=>r.calls[3].startedAt='2026-11-17T01:00:00Z',
  r=>r.calls[3].stdout='{}',r=>r.cleanupSafety.passed=false,
 ])assert.throws(()=>verifyForeignInstallManager(evidence(change)));
 const bad=evidence();writeFileSync(join(bad.output,'after.txt'),'changed');assert.throws(()=>verifyForeignInstallManager(bad));
});
