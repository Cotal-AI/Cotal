import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {parse} from 'yaml';
import test from 'node:test';
const workflow=parse(readFileSync(new URL('../.github/workflows/automatic-update-platforms.yml',import.meta.url),'utf8'));
const script=workflow.jobs.select.steps.find(s=>s.id==='plan').with.script;
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
async function select({name='Publish packages',target='0.164.7',versions=['0.164.6','0.164.7'],path='.github/workflows/changesets.yml',receipt=true}={}) {
  const outputs={},saved={},calls=[];
  const repository={full_name:'Cotal-AI/Cotal'};
  const run={id:42,name,status:'completed',head_branch:'main',head_sha:'a'.repeat(40),head_repository:repository,path};
  const publication={repository:repository.full_name,sourceSHA:run.head_sha,runId:run.id,published:true,promoted:true,version:target};
  const jobsAPI=()=>{},artifactsAPI=()=>{};
  const fakeRequire=name=>{
    if(name==='node:assert/strict')return assert;
    if(name==='node:crypto')return{createHash};
    if(name==='node:url')return{pathToFileURL:value=>new URL(`file://${value}`)};
    if(name==='node:fs')return{mkdirSync(){},writeFileSync(path,bytes){if(path.endsWith('plan.json'))saved.plan=JSON.parse(bytes);}};
    assert.equal(name,'node:child_process');
    return{execFileSync(command,args){assert.equal(command,'unzip');assert(args.includes('publication.json'));return JSON.stringify(publication);}};
  };
  const summary={addHeading(){return this;},addRaw(){return this;},async write(){}};
  await new AsyncFunction('require','context','github','process','core','fetch',script)(fakeRequire,
    {eventName:'workflow_run',repo:{owner:'Cotal-AI',repo:'Cotal'},payload:{action:'completed',repository,workflow_run:run}},
    {rest:{actions:{getWorkflowRun:async args=>{calls.push(['run',args.run_id]);return{data:run};},listJobsForWorkflowRun:jobsAPI,listWorkflowRunArtifacts:artifactsAPI,downloadArtifact:async args=>{calls.push(['download',args.artifact_id]);return{data:Buffer.from('archive')};}},repos:{getContent:async()=>({data:{type:'file',content:Buffer.from(JSON.stringify({version:target})).toString('base64')}})}},paginate:async(method,args)=>{calls.push([method===jobsAPI?'jobs':'artifacts',args.run_id]);return method===jobsAPI?[{name:'publish',conclusion:'success'}]:receipt?[{id:7,name:'upgrade-publication',digest:'sha256:'+createHash('sha256').update('archive').digest('hex'),expired:false,workflow_run:{id:run.id,head_sha:run.head_sha}}]:[];}},
    {env:{GITHUB_WORKSPACE:new URL('..',import.meta.url).pathname.replace(/\/$/,''),RUNNER_TEMP:'/fixture'}},
    {setOutput(k,v){outputs[k]=v;},summary,info(){}},
    async url=>{assert.equal(url,'https://registry.npmjs.org/cotal-ai');return{ok:true,json:async()=>({'dist-tags':{latest:versions.at(-1)},versions:Object.fromEntries(versions.map(version=>[version,{version}]))})};});
  return{outputs,plan:saved.plan,calls};
}
test('actual selector accepts publisher dynamic run-name with exact completed-run receipt',async()=>{
  const result=await select();
  assert.equal(result.outputs.applicable,'true');
  assert.equal(result.plan.phase,'published');
  assert.equal(result.plan.sourceVersion,'0.164.6');
  assert.deepEqual(result.calls,[['run',42],['jobs',42],['artifacts',42],['download',7]]);
});
test('actual selector freezes newest public predecessor rather than a literal source',async()=>{
  const result=await select({name:'Changesets',target:'0.164.8',versions:['0.164.6','0.164.7','0.164.8','0.165.0']});
  assert.equal(result.plan.sourceVersion,'0.164.7');
  assert(result.plan.cells.every(cell=>cell.sourceVersion==='0.164.7'));
});
test('dynamic name cannot bypass exact publisher workflow path',async()=>{
  await assert.rejects(select({path:'.github/workflows/ci.yml'}));
});
test('missing receipt never starts published product cells',async()=>{
  const result=await select({receipt:false});
  assert.equal(result.outputs.applicable,'false');
  assert(!result.calls.some(([kind])=>kind==='download'));
});
