import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseDocument } from 'yaml';

const document = parseDocument(readFileSync(new URL('../../.github/workflows/desktop.yml', import.meta.url), 'utf8'));

test('macOS26 exercises the same installed and native journeys without artifact collisions', () => {
  assert.deepEqual(document.errors, []);
  const job = document.toJS().jobs['native-build'];
  const choices = [...job.strategy.matrix.include.matchAll(/'(\[[^']*\])'/g)].map(match => JSON.parse(match[1]));
  assert.equal(choices.length, 2);
  const [windows, rows] = choices;
  assert.deepEqual(windows, [{ os: 'windows-2022', bundles: 'nsis,msi' }]);
  assert.equal(document.toJS().on.workflow_dispatch.inputs.windows_only.default, false);
  assert.match(job.strategy.matrix.include, /fromJSON\(inputs\.windows_only &&/);
  assert.equal(document.toJS().jobs.render.if, '${{ !inputs.windows_only }}');
  assert.deepEqual(rows.filter(row => row.os.startsWith('macos')).map(row => row.os).sort(), ['macos-15', 'macos-15-intel', 'macos-26']);
  assert.equal(rows.find(row => row.os === 'macos-26').artifact_suffix, '-macos26');
  for (const architecture of ['ARM64', 'X64']) {
    const names = rows.filter(row => row.os.startsWith('macos') && (row.os.endsWith('intel') ? architecture === 'X64' : architecture === 'ARM64')).map(row => `macOS-${architecture}${row.artifact_suffix ?? ''}`);
    assert.equal(new Set(names).size, names.length);
  }
  for (const step of job.steps.filter(step => step.uses?.startsWith('actions/upload-artifact') && step.with.name.includes('runner.arch'))) {
    assert.ok(step.with.name.includes('matrix.artifact_suffix'), step.name);
  }
  const node = job.steps.find(step => step.name === 'Run the bundled Node under the signature the app ships with');
  assert.equal(node.if, "runner.os == 'macOS'");
  assert.match(node.run, /codesign -d --entitlements -/);
  assert.match(node.run, /com\.apple\.security\.cs\.allow-jit/);
  assert.match(node.run, /"\$node" "\$runtime\/dist\/cotal\.js" --version/);
  const launch = job.steps.find(step => step.name === 'Launch the installed release package and capture its first window');
  assert.equal(launch.if, undefined);
  const account = job.steps.find(step => step.name === 'Connected account Ready, native Settings and login-command lifecycle');
  assert.equal(account.if, "runner.os != 'Windows'");
  const peer = job.steps.find(step => step.name === 'Verify Windows stock peer identity observation');
  assert.equal(peer.env.PEER_TRACE_BUNDLED_RUNTIME, '${{ github.workspace }}/desktop/src-tauri/target/debug/runtime');
  assert.ok(job.steps.findIndex(step => step.name === 'Build release-isolated real-window test binary') < job.steps.indexOf(peer));
  const release = job.steps.find(step => step.name === 'Stage release installers');
  assert.match(release.if, /matrix\.os != 'macos-26'/, 'validation must not publish duplicate same-architecture installers');
});
