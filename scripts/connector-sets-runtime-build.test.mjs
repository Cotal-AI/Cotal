import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { buildConnectorRuntime } from './connector-sets-runtime-build.mjs';

test('runtime preparation refuses this host before creating output or invoking tools', () => {
  if (process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted') return;
  const output = '/var/tmp/app-service-wording/must-not-build-desktop-runtime';
  assert.equal(existsSync(output), false);
  let called = false;
  assert.throws(() => buildConnectorRuntime({source:'.',output,version:'0.164.18',exec:()=>{called=true;}}), /disposable hosted Linux/);
  assert.equal(called, false);
  assert.equal(existsSync(output), false);
});

test('runtime measurement composes product preparation and restores versioned source manifests', () => {
  const source = readFileSync(new URL('./connector-sets-runtime-build.mjs', import.meta.url), 'utf8');
  assert(source.includes("run(['--dir', 'desktop', 'prepare:runtime'])"));
  assert(source.includes("run(['--filter', 'cotal-ai', 'seeded-connectors'])"));
  assert(source.includes("record.version, version"));
  assert(source.includes('finally {'));
  assert(source.includes('writeFileSync(row.path, row.bytes)'));
  assert(!source.includes('npm install'));
});
