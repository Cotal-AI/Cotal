import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {verifyTargetAdmissionEvidence} from './target-admission-evidence.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
function fixture(mode='offline'){
 const output=mkdtempSync(join(tmpdir(),'admission-grade-'));
 const identity={daemon:{pid:10,start:'a'},manager:{pid:11,start:'b',instanceId:'manager'},version:'0.1.0'};
 const receipt={v:1,nonce:'0'.repeat(32),installedEntry:'/prefix/cotal.js',occupied:null,admission:{disposition:'deferred',occupied:null}};
 const call={label:'upgrade under test',argv:['/prefix/cotal.js','update','--self'],exit:0,signal:null,timeout:false,stdout:'machine daemon activation deferred: unknown; software update finished',stderr:''};
 const probe={label:'actual target read-only admission before update',exit:0,stdout:'COTAL_PREINSTALL_RESULT '+JSON.stringify(receipt)+'\n',argv:['checker',JSON.stringify({nonce:receipt.nonce})]};
 const e={mode,before:identity,after:structuredClone(identity),recovery:null,update:call,deferred:true,activationRecords:[{record:{v:1,target:'0.2.0',reason:'unknown'}}],oldSetsAfter:[{path:'old',sha256:'a',observedSha256:'a'}],workBefore:{items:[{name:'admission_original',id:'seat',lifecycleUid:'life'}]},workAfter:{items:[{name:'admission_original',id:'seat',lifecycleUid:'life'}]},lateWork:{items:[{name:'admission_late'}]},dependency:{brokerTraffic:'paused'},targetReceipt:receipt};
 const report={calls:[call,probe],candidateSourceInvocation:{argv:['/prefix/cotal.js','update','--self']},selectedCliVersion:'0.2.0',source:'0.1.0',targetAdmission:e};
 const cell={platform:'linux',targetAdmission:mode,targetVersion:'0.2.0'};
 function seal(){const{artifact,remaining,...data}=e;const b=Buffer.from(JSON.stringify(data));writeFileSync(join(output,'observations.json'),b,{mode:0o600});e.artifact={name:'observations.json',bytes:b.length,sha256:sha(b)}}
 seal();return{output,e,report,cell,seal,run:()=>verifyTargetAdmissionEvidence({report,cell,output}),close:()=>rmSync(output,{recursive:true,force:true})};
}
test('actual-observation verifier accepts deferred control and rejects changed holders, fake zero and lost old bytes',()=>{const f=fixture();try{assert.equal(f.run().passed,true);f.e.after.manager.start='reused';f.seal();assert.throws(f.run,/changed a native holder/);f.e.after.manager.start='b';f.e.targetReceipt.occupied=0;f.report.calls[1].stdout='COTAL_PREINSTALL_RESULT '+JSON.stringify(f.e.targetReceipt)+'\n';f.seal();assert.throws(f.run);f.e.targetReceipt.occupied=null;f.report.calls[1].stdout='COTAL_PREINSTALL_RESULT '+JSON.stringify(f.e.targetReceipt)+'\n';f.e.oldSetsAfter[0].observedSha256=null;f.seal();assert.throws(f.run,/old loaded connector/);}finally{f.close()}});
test('original artifact binding rejects report-only changes and unknown Windows scope',()=>{const f=fixture();try{f.e.recovery={phase:'paused'};assert.throws(f.run,/differs/);f.e.recovery=null;f.cell.platform='win32';assert.throws(f.run,/Windows/);}finally{f.close()}});
