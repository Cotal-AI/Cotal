import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/automatic-update-platforms.yml', import.meta.url), 'utf8');
const section = name => {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  assert(start >= 0, `missing job ${name}`);
  // A job boundary has two spaces, while its properties have four.
  return workflow.slice(start + 1).split(/\n(?=  [a-zA-Z][\w-]*:\n)/)[0];
};

test('6385 selection bypasses ordinary candidate admission and accepted cells', () => {
  assert.match(workflow, /options: \[none, legacy, current, all\]/);
  assert.match(section('select'), /inputs\.repro_6385 == '' \|\| inputs\.repro_6385 == 'none'/);
  assert.match(section('release-cells'), /needs\.select\.outputs\.applicable == 'true'/);
  assert.match(section('repro-6385-legacy'), /inputs\.repro_6385 == 'legacy' \|\| inputs\.repro_6385 == 'all'/);
  assert.match(section('repro-6385-native'), /inputs\.repro_6385 == 'current' \|\| inputs\.repro_6385 == 'all'/);
});

test('installed main is a separate immutable source with all native gates', () => {
  for (const name of ['repro-6385-native', 'repro-6385-pack']) {
    assert.match(section(name), /ref: 85e85968d09fa81972611d94954569f147bbbf97/);
  }
  const pack = section('repro-6385-pack');
  assert.match(pack, /path: product/);
  assert.match(pack, /seat\/scripts\/assert-shipped-natives\.mjs/);
  assert.match(pack, /workspace\/scripts\/assert-shipped-natives\.mjs/);
  assert.match(pack, /--version 0\.164\.18 --source-root "\$GITHUB_WORKSPACE\/product"/);
  assert.match(pack, /pack-candidate-next\.mjs --source-root/);
  assert.doesNotMatch(pack, /ignore-scripts|skip.*guard/i);
});

test('native service setup is hosted Linux only and evidence uploads on failure', () => {
  for (const name of ['repro-6385-current', 'repro-6385-legacy']) {
    const job = section(name);
    assert.match(job, /runs-on: ubuntu-24\.04/);
    assert(job.indexOf('test "$RUNNER_ENVIRONMENT" = github-hosted') < job.indexOf('sudo loginctl'));
    assert(job.indexOf('test "$(id -u)" -ne 0') < job.indexOf('sudo loginctl'));
    assert.match(job, /if: always\(\)/);
    assert.match(job, /if-no-files-found: error/);
    assert.doesNotMatch(job, /docker|systemd-run|CPUQuota|MemoryMax/);
  }
  assert.match(section('repro-6385-current'), /fault: \[exit, hang\]/);
});
