import assert from 'node:assert/strict';
import test from 'node:test';
import { rootOwnedCell, rootOwnedAssertions } from './root-owned-cell.mjs';
test('root machine proof refuses nonhosted execution before native side effects',async()=>{
 if(process.env.GITHUB_ACTIONS==='true'&&process.env.RUNNER_ENVIRONMENT==='github-hosted')return;
 await assert.rejects(()=>rootOwnedCell({}),/Assertion/);
});
test('reported root mode flag cannot replace actual metadata entries',()=>{
 const cell={sourceVersion:'1.2.3',targetVersion:'1.2.1003',requiredAssertions:['readable-generation-metadata']};
 const report={passed:true,calls:[],observations:[{modes:{passed:true,entries:[{path:'/usr/local/lib/.cotal-generations',mode:0o755,uid:0}]}}]};
 assert.equal(rootOwnedAssertions(report,cell).passed,false);
 const entries=report.observations[0].modes.entries;
 entries.push({path:'/usr/local/lib/node_modules/cotal-ai/dist/cotal.js',mode:0o755,uid:0},{path:'/usr/local/lib/.cotal-generations/generation/inventory.json',mode:0o644,uid:0},{path:`/usr/local/lib/.cotal-generations/.active-${'a'.repeat(64)}.json`,mode:0o644,uid:0});
 assert.equal(rootOwnedAssertions(report,cell).passed,true);
 entries.at(-1).mode=0o600;assert.equal(rootOwnedAssertions(report,cell).passed,false);
});
test('fixed normal-account refusal must leave no staging folders or store growth',()=>{
 const cell={requiredAssertions:['refusal-store-unchanged']};
 const report={passed:true,observations:[{store:{passed:true,logicalBytes:100}},{afterNormalRefusal:{passed:true,logicalBytes:100}}]};
 assert.equal(rootOwnedAssertions(report,cell).passed,true);
 report.observations[1].afterNormalRefusal.logicalBytes=101;
 assert.equal(rootOwnedAssertions(report,cell).passed,false);
 report.observations[1].afterNormalRefusal={passed:false,logicalBytes:100};
 assert.equal(rootOwnedAssertions(report,cell).passed,false);
});
