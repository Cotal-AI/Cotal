import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {matrixCell} from './automatic-update-platform-baseline.mjs';
import {candidatePairRegistry} from './candidate-pair-registry.mjs';
import {prepareUnreachableRegistration} from './unreachable-registration-state.mjs';

/** Exercise the candidate's installed updater without installing a native daemon. */
export async function unreachableRegistrationPair({candidate,next,output}){
 const pair=await candidatePairRegistry(resolve(candidate),resolve(next));
 const prior=process.env.npm_config_registry;
 try{
  pair.activateTarget();
  process.env.npm_config_registry=pair.url;
  return await matrixCell({source:pair.identity.sourceVersion,layout:'npm',state:'configured',method:'self',candidate:next,direction:'B','expected-target':pair.identity.targetVersion,output,
   prepare:async context=>{
    context.report.configuredPair=pair.identity;
    context.report.configuredPairHarnessSha256=createHash('sha256').update(readFileSync(import.meta.filename)).digest('hex');
    return prepareUnreachableRegistration(context);
   }});
 }finally{
  if(prior===undefined)delete process.env.npm_config_registry;else process.env.npm_config_registry=prior;
  await pair.close();
 }
}

export function verifyUnreachablePairIdentity(report,cell){
 const pair=report.configuredPair;
 assert.equal(pair?.source,cell.sourceSHA);assert.equal(pair.sourceVersion,cell.sourceVersion);assert.equal(pair.targetVersion,cell.targetVersion);
 assert.equal(report.candidate?.source,cell.sourceSHA);assert.equal(report.candidate.version,cell.targetVersion);
 assert.equal(report.source,cell.sourceVersion);assert.equal(report.target,cell.targetVersion);
 assert.equal(pair.sourceArchives?.length,24);assert.equal(pair.targetArchives?.length,24);
 return pair;
}
