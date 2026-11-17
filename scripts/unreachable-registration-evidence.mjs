import {compareVersions} from './upgrade-matrix-plan.mjs';
import assert from 'node:assert/strict';

/** Reopen the public setup calls before accepting an unreachable-registration result. */
export function verifyUnreachableRegistration({report,cell}){
 assert.equal(cell.scenario,'unreachable-registration');
 assert.equal(report.method,'self');assert.equal(report.layout,'npm');
 assert(compareVersions(report.target,report.source)>0,'staged gate requires a newer target, not a no-op');
 const state=report.unreachableRegistration;assert(state?.before&&state?.after);
 assert.equal(state.local,'update-stopped');assert.equal(state.gone,'update-gone');
 assert(Number.isInteger(state.gonePort)&&state.gonePort>0&&state.gonePort<=65535);
 assert(Number.isInteger(state.localPort)&&state.localPort>0&&state.localPort<=65535);
 assert.notEqual(state.gonePort,state.localPort);
 assert.notEqual(state.commandRoot,state.localRoot);assert.notEqual(state.commandRoot,state.goneRoot);
 assert.match(state.before.journalSha256,/^[a-f0-9]{64}$/);
 assert.deepEqual(state.after,state.before,'registration and stopped-stack bytes must remain unchanged');
 const one=label=>{const rows=report.calls.filter(call=>call.label===label);assert.equal(rows.length,1,`one ${label} receipt required`);return rows[0];};
 const update=one('upgrade under test');
 assert.deepEqual(update.argv.slice(-2),['update','--self']);
 assert.equal(update.signal,null);assert.equal(update.timeout,false);assert.equal(update.npmBefore,null);
 assert.equal(state.commandContext?.cwd,state.commandRoot);assert.equal(state.commandContext.projectMarker,false);assert.equal(state.commandContext.selected,null);
 assert(Date.parse(state.commandContext.observedAt)<=Date.parse(update.startedAt));
 for(const [stage,bound] of [['Before','startedAt'],['After','finishedAt']]){
  const probes=state['probes'+stage];assert.equal(probes?.length,2);
  assert.deepEqual(probes.map(p=>p.port),[state.localPort,state.gonePort]);
  for(const probe of probes){assert.equal(probe.host,'127.0.0.1');assert.equal(probe.code,'ECONNREFUSED');assert(Number.isFinite(Date.parse(probe.observedAt)));assert(stage==='Before'?Date.parse(probe.observedAt)<=Date.parse(update[bound]):Date.parse(probe.observedAt)>=Date.parse(update[bound]));}
 }
 assert.equal(state.routeBefore?.selectedCliVersion,report.source);assert.equal(state.routeBefore.packageManagerRecordVersion,report.source);
 if(update.exit===0){
  assert.equal(report.updateRoute,'staged','successful gate must use retained staged publication');
  assert.equal(state.routeAfter?.updateRoute,'staged');assert.equal(state.routeAfter.selectedCliVersion,report.target);assert.equal(state.routeAfter.packageManagerRecordVersion,report.source);
  assert.equal(report.selectedCliVersion,report.target);assert.equal(report.packageManagerRecordVersion,report.source);
  for(const name of ['activeDescriptorSha256','inventorySha256','stagedProgramSha256'])assert.match(state.routeAfter[name],/^[a-f0-9]{64}$/);
  assert.match(state.routeAfter.generationId,/^[A-Za-z0-9._-]+$/);
 }
 const setup=['prepare stopped local space','start real local broker without Manager','stop owned local broker before update','register unreachable broker through public CLI','clear selection for install-wide continuity','selection before unreachable update','registry before unreachable update'];
 for(const label of setup){const call=one(label);assert.equal(call.exit,0);assert.equal(call.signal,null);assert.equal(call.timeout,false);assert(Date.parse(call.finishedAt)<=Date.parse(update.startedAt));}
 assert.deepEqual(one('start real local broker without Manager').argv.slice(1),['up','--root',state.localRoot,'--space',state.local,'--open','--no-manager','--server',`nats://127.0.0.1:${state.localPort}`,'--detach']);
 assert(one('stop owned local broker before update').stdout.includes('Controller stack stopped'));
 const register=one('register unreachable broker through public CLI');
 assert.deepEqual(register.argv.slice(1),['space','add',state.gone,'--server',`nats://127.0.0.1:${state.gonePort}`,'--root',state.goneRoot,'--mode','open','--force','--yes']);
 assert.equal(JSON.parse(one('selection before unreachable update').stdout).result.current,null);
 const before=one('registry before unreachable update'),after=one('registry after unreachable update');
 assert.equal(after.exit,0);assert.equal(after.signal,null);assert.equal(after.timeout,false);assert(Date.parse(after.startedAt)>=Date.parse(update.finishedAt));
 assert.equal(before.stdout,state.before.registry);assert.equal(after.stdout,state.after.registry);
 const records=before.stdout.trim().split('\n').map(line=>JSON.parse(line));
 assert.equal(records.length,1);assert.equal(records[0].space,state.gone);assert.equal(records[0].origin,'manual');assert.equal(records[0].mode,'open');assert.equal(records[0].offline,true);
 assert.equal(records[0].server,`nats://127.0.0.1:${state.gonePort}`);assert.equal(records[0].root,state.goneRoot);
 assert.equal(report.cleanupSafety?.passed,true);assert.equal(report.compositionCleanup,'owned composition stopped before reporting');
 assert(!report.error&&!report.cleanupFailure);
 const knownRed=(report.source==='0.165.3'&&report.target==='0.165.4'||report.source==='0.165.4'&&report.target==='0.165.1004')&&update.exit===1&&update.stderr===`staged pre-install check refused: ✗ no broker answered at nats://127.0.0.1:${state.gonePort}; "${state.gone}" is registered here but its mesh is not up - start it where it runs, or \`cotal space forget ${state.gone}\` to unregister it; no installed packages or connector state were changed\n`;
 return {passed:true,upgradePassed:update.exit===0,knownRed,issue:knownRed?'https://github.com/Cotal-AI/Cotal/issues/7224':null};
}
