import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {verifyReleasedUpdaterEvidence} from './released-updater-evidence.mjs';

// Synthetic verifier contract tests only. Native acceptance belongs to the matrix cells.
function fixture(mode='no-service') {
 const output=mkdtempSync(join(tmpdir(),'released-evidence-'));
 const update={label:'upgrade under test',argv:['/old/dist/cotal.js','update','--self'],exit:0,signal:null,timeout:false,stdout:'updated',stderr:''};
 const receipt={v:1,installedEntry:'/old/dist/cotal.js',hostedSpaces:[],occupied:0};
 const readerProbe={accepted:true,legacy:{hostedSpaces:[],occupied:0},receipt};
 const probe={label:'released reader probe before update',exit:0,stdout:'RELEASED_READER_RESULT '+JSON.stringify(readerProbe)+'\n',stderr:''};
 const officialDist={integrity:'sha512-public',tarball:'https://registry.npmjs.org/cotal-ai/-/cotal-ai-0.164.18.tgz'};
 const noServiceAfter={label:'released no-service custody after',exit:2};
 const e={noServiceAfter,mode,sourceVersion:'0.164.18',sourceEntry:'/old/dist/cotal.js',sourcePackageSha256:'a'.repeat(64),officialDist,update,selectedVersion:'0.165.0',recovery:null,readerProbe,readerProbeCall:probe,before:null,after:null};
 const report={source:'0.164.18',selectedCliVersion:'0.165.0',releasedUpdater:e,calls:[{label:'released source public dist',exit:0,stdout:JSON.stringify(officialDist)},probe,noServiceAfter,update]};
 const cell={platform:'linux',releasedUpdater:mode,targetVersion:'0.165.0'};
 function archive(){const {artifact,...saved}=e;const bytes=Buffer.from(JSON.stringify(saved));writeFileSync(join(output,'observations.json'),bytes);e.artifact={name:'observations.json',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};}
 archive();return {report,cell,output,archive,close:()=>rmSync(output,{recursive:true,force:true})};
}

test('released updater verifier accepts complete no-service evidence',()=>{
 const f=fixture();try{const result=verifyReleasedUpdaterEvidence(f);assert.equal(result.passed,true);assert.deepEqual(Object.keys(result.assertions),['released-updater-source','released-updater-self','released-reader-probe','custody-preserved']);}finally{f.close()}
});
for(const [name,alter] of [
 ['wrong released source',f=>{f.report.source='0.164.17'}],
 ['nonzero public update',f=>{f.report.calls.at(-1).exit=1}],
 ['projection mismatch',f=>{f.report.releasedUpdater.readerProbe.receipt.occupied=1;f.report.calls[1].stdout='RELEASED_READER_RESULT '+JSON.stringify(f.report.releasedUpdater.readerProbe)+'\n';f.archive()}],
 ['unrecorded custody',f=>{f.report.releasedUpdater.before={daemon:{pid:1,start:'native'}};f.archive()}],
 ['artifact tamper',f=>{writeFileSync(join(f.output,'observations.json'),'{}')}],
 ['missing public self flag',f=>{f.report.calls.at(-1).argv.pop();f.archive()}],
 ['wrong selected target',f=>{f.report.selectedCliVersion='0.164.18'}],
]) test(`released updater verifier rejects ${name}`,()=>{const f=fixture();try{alter(f);assert.throws(()=>verifyReleasedUpdaterEvidence(f));}finally{f.close()}});
