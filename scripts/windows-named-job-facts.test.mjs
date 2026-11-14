import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const cs = readFileSync(new URL('./windows-named-job-facts.cs', import.meta.url), 'utf8');
const ps = readFileSync(new URL('./windows-named-job-facts.ps1', import.meta.url), 'utf8');
const workflow = readFileSync(new URL('../.github/workflows/automatic-update-platforms.yml', import.meta.url), 'utf8');
test('named job has explicit user owner and protected user-only DACL, nonce and no inheritance', () => {
  for (const value of ['Global\\\\cotal-update-facts-', 'Guid.NewGuid().ToString("N")', '"O:"+sid+"D:P(A;;GA;;;"+sid+")"', 'inherit=false', '0x2000', '0x3800']) assert.ok(cs.includes(value), value);
  assert.ok(cs.indexOf('Save(dir,"attempt.json"') < cs.indexOf('PI root=Spawn(dir,"tree",job)'));
});
test('natural successor opens only after exact owner intervention, never creates or duplicates a job', () => {
  const observer = cs.slice(cs.indexOf('static void Observe('));
  assert.doesNotMatch(observer, /CreateJobObjectW\(|DuplicateHandle\(/);
  assert.ok(observer.includes('mode=="after-owner-exit"&&WaitForSingleObject(owner,10000)'));
  assert.ok(observer.includes('if(error!=2)throw'));
  assert.ok(observer.includes('if(Array.Exists(liveAfter,v=>v))unsafeAbsence=true'));
  assert.ok(observer.includes('liveBefore=liveBefore,liveAfter=liveAfter'));
  assert.ok(observer.includes('ownerBefore=ownerBefore,ownerAfter=ownerAfter'));
});
test('known snapshot identities and late birth handshake are pinned before kill', () => {
  for (const value of ['job-members.json', 'member-*.json', 'spawning-active.json', 'spawn-go', 'snapshot exact membership']) assert.ok(cs.includes(value), value);
  const observer = cs.slice(cs.indexOf('static void Observe('));
  assert.ok(observer.indexOf('pins.Add(Pin(id,false))') < observer.indexOf('TerminateProcess(owner,197)'));
  assert.ok(observer.indexOf('report["spawningActive"]') < observer.indexOf('TerminateProcess(owner,197)'));
  assert.doesNotMatch(cs, /Thread\.Sleep/);
});
test('exact job accounting is complete and temporary member handles released before drain', () => {
  for (const value of ['active==0&&assigned==0&&count==0', 'count<assigned', 'TerminateJobObject(job,199)', 'clock.ElapsedMilliseconds<20000']) assert.ok(cs.includes(value), value);
  assert.ok(cs.indexOf('pins.Clear()') < cs.indexOf('Drain(job,dir,"successor")'));
  assert.ok(cs.includes('owner-alive open control'));
  assert.ok(cs.includes('NOT last-close absence measurement'));
});
test('controller records setup failures and keeps all three cases independent', () => {
  assert.ok(ps.includes("@('open-control','after-owner-exit','immediate-successor')"));
  assert.ok(ps.includes("$entry.error=$_.Exception.ToString()"));
  assert.ok(ps.includes("ownerExitObserved=$false"));
  assert.ok(ps.includes("artifact-hashes.json"));
  assert.doesNotMatch(ps, /Stop-Process|taskkill/);
});
test('named marker routes one diagnostic cell, preserves prior native facts and always uploads', () => {
  assert.ok(workflow.includes('scripts/windows-named-job-facts.cs'));
  assert.ok(workflow.includes("if: \"contains(github.event.head_commit.message, '[windows-named-job]')\""));
  assert.ok(workflow.includes("if: \"!contains(github.event.head_commit.message, '[windows-named-job]')\""));
  assert.ok(workflow.includes('windows-named-job-facts.ps1 -Output'));
});
