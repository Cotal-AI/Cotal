import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = readFileSync(new URL('../.github/workflows/automatic-update-platforms.yml', import.meta.url), 'utf8');
const runner = readFileSync(new URL('./other-home-manager-runner.ts', import.meta.url), 'utf8');
const fixture = readFileSync(new URL('./other-home-manager-fixture.ts', import.meta.url), 'utf8');

test('dedicated guarded job never adds other-home cells to ordinary release or admission census', () => {
  assert(workflow.includes("const otherHomeMeasurement = context.eventName === 'workflow_dispatch' && context.ref === 'refs/heads/measure/other-home-manager-cells'"));
  assert(workflow.includes('otherHomeMeasurement ? otherHomeManagerCells(plan)'));
  assert(workflow.includes('other-home measurement must be a direct child of its final product'));
  assert(workflow.includes('for (const pull_number of [6906, 6968])'));
  assert(workflow.includes('prerequisite.merged && prerequisite.merge_commit_sha'));
  assert(workflow.includes('product does not include prerequisite'));
  assert(workflow.includes('target-owned admission prerequisite missing'));
  assert(workflow.includes('per-installation set-holder prerequisite missing'));
  const job = workflow.split('  other-home-cells:')[1].split('  release-summary:')[0];
  assert(job.includes('needs: [select, release-pack, release-next]'));
  for (const token of ['release-candidate', 'release-next', 'release-follow-on', 'verifyOtherHomeManagerEvidence', 'tsconfig.other-home-smoke.json', 'if: always()', 'other-home-evidence']) assert(job.includes(token), token);
  assert(!job.includes('mutation-proof'));
});

test('runner is import-safe hosted-only and requires official npm origin and real two public hops', () => {
  for (const token of ['hosted runner only, never local', 'https://registry.npmjs.org/', 'install official npm graph before overlay', 'plain npm candidate A replaces official graph', 'official public self prime to candidate A without Manager', 'candidatePairRegistry', 'candidateSourceIdentity', 'A-to-B', 'B-to-C', 'final public plain update C collector probe']) assert(runner.includes(token), token);
  assert(!/process\.env\.GITHUB_ACTIONS\s*=(?!=)/.test(runner));
  assert(!/writeFileSync\([^\n]*(?:dist\/cotal|\.cotal-execution)/.test(runner));
});

test('fixture uses real same-prefix separate homes, authenticated late work and native identity checks', () => {
  for (const token of ['prepareUpdateParticipant', 'managerViaDaemon', 'processBirth', 'homeA original work inventory', 'CotalEndpoint', 'lifecycleUid', 'instanceId', 'homeA resolve loaded installed graph', 'old Manager late console file read', 'owned homeA processes must exit']) assert(fixture.includes(token), token);
  assert(fixture.includes('assert.notEqual(cotalHome, context.cotalHome)'));
  assert(fixture.includes('installation prefix remains shared'));
  assert(!fixture.includes('COTAL_UPDATE_STOP_AGENTS'));
});
