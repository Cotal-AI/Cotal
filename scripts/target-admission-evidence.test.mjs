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
 const e={mode,before:identity,after:structuredClone(identity),recovery:null,update:call,deferred:true,activationRecords:[{record:{v:1,target:'0.2.0',reason:'unknown'}}],oldSetsAfter:[{path:'old',sha256:'a',observedSha256:'a'}],workBefore:{items:[{name:'admission_original',id:'seat',lifecycleUid:'life'}]},workAfter:{items:[{name:'admission_original',id:'seat',lifecycleUid:'life'}]},lateWork:{items:[{name:'admission_late',id:'late-seat',lifecycleUid:'late-life'}]},lateReady:{name:'admission_late',pid:12,start:'c',managerInstance:'manager',lifecycleUid:'late-life'},dependency:{brokerTraffic:'paused'},targetReceipt:receipt};
 const report={calls:[call,probe],candidateSourceInvocation:{argv:['/prefix/cotal.js','update','--self']},selectedCliVersion:'0.2.0',source:'0.1.0',targetAdmission:e};
 const cell={platform:'linux',targetAdmission:mode,targetVersion:'0.2.0'};
 function seal(){const{artifact,remaining,...data}=e;const b=Buffer.from(JSON.stringify(data));writeFileSync(join(output,'observations.json'),b,{mode:0o600});e.artifact={name:'observations.json',bytes:b.length,sha256:sha(b)}}
 seal();return{output,e,report,cell,seal,run:()=>verifyTargetAdmissionEvidence({report,cell,output}),close:()=>rmSync(output,{recursive:true,force:true})};
}
test('actual-observation verifier accepts deferred control and rejects changed holders, fake zero and lost old bytes',()=>{const f=fixture();try{assert.equal(f.run().passed,true);f.e.after.manager.start='reused';f.seal();assert.throws(f.run,/changed a native holder/);f.e.after.manager.start='b';f.e.targetReceipt.admission.occupied=0;f.report.calls[1].stdout='COTAL_PREINSTALL_RESULT '+JSON.stringify(f.e.targetReceipt)+'\n';f.seal();assert.throws(f.run);f.e.targetReceipt.admission.occupied=null;f.report.calls[1].stdout='COTAL_PREINSTALL_RESULT '+JSON.stringify(f.e.targetReceipt)+'\n';f.e.oldSetsAfter[0].observedSha256=null;f.seal();assert.throws(f.run,/old loaded connector/);}finally{f.close()}});
test('original artifact binding rejects report-only changes and unknown Windows scope',()=>{const f=fixture();try{f.e.recovery={phase:'paused'};assert.throws(f.run,/differs/);f.e.recovery=null;f.cell.platform='win32';assert.throws(f.run,/Windows/);}finally{f.close()}});

function updaterFixture(mode='killed-updater'){
 const f=fixture(mode),e=f.e,call=f.report.calls[0];
 const state=maintenance=>({ok:true,data:{instanceId:'manager',agentCount:0,stopImpact:{maintenance,resumeRequired:false,stopping:false}}});
 const ps={label:'paused updater public ps',exit:0,stdout:'{"result":{"items":[]}}',argv:['/prefix/cotal.js','ps','--json']};
 Object.assign(e,{fenceProducer:{pid:20,start:'updater',entry:'/prefix/cotal.js',exit:null,signal:'SIGKILL',stdout:'Saving update recovery snapshot',heldMs:2400},preparedFence:{prepared:true,managers:[{fenced:true,seats:0}]},pausedPs:JSON.parse(ps.stdout),pausedList:{ok:true,rows:[]},killedAt:1000,recoveryElapsedMs:100,recoveredManager:structuredClone(e.before.manager),observations:[{label:'paused public status',at:900,value:state('preserving')},{label:'autonomous recovery status',at:1100,value:state('active')},{label:'after default update public status',at:1200,value:state('active')}]});
 f.report.calls=[ps,call];f.report.environment={hostedDisposable:true};f.report.daemonBefore={pid:10};e.pausedMainVersion=f.report.source;
 if(mode==='official18-escape'){
  e.pausedMainVersion='0.164.18';e.before.version=e.after.version='0.164.18';e.fenceProducer.entry='/foreign/cotal.js';e.officialSource={version:'0.164.18',entry:'/foreign/cotal.js'};e.officialDist={integrity:'sha512-real-registry-receipt',tarball:'https://registry.npmjs.org/cotal-ai/-/cotal-ai-0.164.18.tgz'};e.bootstrapVersion=f.report.source;e.legacyRegistry={source:'legacy'};f.cell.legacySourceSHA='legacy';
  f.report.calls.unshift({label:'official18 registry dist receipt',exit:0,stdout:JSON.stringify(e.officialDist)},...['main','foreign'].map(name=>({label:`install official18 ${name}`,exit:0,argv:['install','cotal-ai@0.164.18','--registry','https://registry.npmjs.org/']})));
  f.report.calls.splice(-1,0,{label:'plain npm fixed A escape',exit:0,argv:['install',`cotal-ai@${f.report.source}`]});
 }
 e.preparedObservedAt=mode==='official18-escape'?f.report.calls.findIndex(row=>row.label==='plain npm fixed A escape'):1;
 if(mode==='official18-escape'){f.report.calls=f.report.calls.filter(row=>row!==ps);e.preparedObservedAt--;e.observations=[];delete e.pausedList;delete e.pausedPs;}
 f.seal();return f;
}
test('killed updater evidence requires live hold and bounded same-Manager recovery',()=>{const f=updaterFixture();try{assert.equal(f.run().assertions['dead-owner-bounded'],true);f.e.fenceProducer.heldMs=2300;f.seal();assert.throws(f.run);f.e.fenceProducer.heldMs=2400;f.e.recoveredManager.start='reused';f.seal();assert.throws(f.run);}finally{f.close()}});
test('official18 escape requires registry receipt and normal successful npm bootstrap',()=>{const f=updaterFixture('official18-escape');try{assert.equal(f.run().assertions['plainnpm-noerror'],true);f.report.calls.find(row=>row.label==='plain npm fixed A escape').argv.push('--ignore-scripts');assert.throws(f.run);}finally{f.close()}});
test('new output wording with newline still records an honest deferred action',()=>{const f=fixture();try{f.report.calls[0].stdout='Software update finished. The daemon and its Managers keep running their current generation until restarted:\n  daemon';f.seal();assert.equal(f.run().passed,true);}finally{f.close()}});
