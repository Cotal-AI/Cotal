import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const script = fileURLToPath(new URL('./published-replacement.mjs', import.meta.url));
test('follow-up scopes token to metadata, observes150s and lists uninstall leftovers', () => {
  const source = readFileSync(script, 'utf8');
  const powershell = readFileSync(new URL('./replacement-windows-observe.ps1', import.meta.url), 'utf8');
  assert.equal((source.match(/Authorization:/g) ?? []).length, 1);
  assert.ok(source.includes("delete process.env.DESKTOP_METADATA_TOKEN"));
  const assetFetch = source.slice(source.indexOf('const response = await fetch(asset.browser_download_url'), source.indexOf('const path = join(process.env.RUNNER_TEMP, name)'));
  assert.ok(!/headers|Authorization|metadataToken/.test(assetFetch));
  assert.ok(source.includes("process.platform === 'win32' ? 150_000 : 30_000"));
  assert.ok(source.includes('intervalMs: 5000'));
  assert.ok(source.includes('report.installationLeftovers'));
  assert.ok(source.includes('runner logon predates'));
  for (const field of ['Get-ScheduledTaskInfo', 'LastRunTime', 'NextRunTime', 'LastTaskResult']) assert.ok(powershell.includes(field));
});
test('launcher/task census, Finder authorization and scope limits stay explicit', () => {
  const source = readFileSync(script, 'utf8');
  const powershell = readFileSync(new URL('./replacement-windows-observe.ps1', import.meta.url), 'utf8');
  for (const field of ['launcherBefore', 'launcherAfter', 'launcherAfterReopen', 'sameLauncherLifetime', 'limits:', 'harness-unauthorized']) assert.ok(source.includes(field), field);
  assert.ok(source.includes('No space is signed in.'));
  assert.ok(source.includes('Gatekeeper and SmartScreen'));
  assert.ok(powershell.includes('-TaskName $Unit'));
  assert.ok(powershell.includes('ProcessId,ParentProcessId,ExecutablePath'));
  assert.ok(!/CommandLine\b/.test(powershell), 'never request a process command line');
  assert.ok(powershell.includes("state='unknown'"));
});
test('measurement refuses before any filesystem or native action outside a hosted run', () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('COTAL_')));
  delete env.GITHUB_ACTIONS; delete env.RUNNER_ENVIRONMENT;
  const result = spawnSync(process.execPath, [script], { env, encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /AssertionError/);
  assert.ok(!result.error && !result.signal);
});
test('measurement imports builtins only and contains no debug context, login or mutation fixture', () => {
  const source = readFileSync(script, 'utf8');
  const imports = [...source.matchAll(/from '([^']+)'/g)].map(match => match[1]);
  assert.ok(imports.length > 0 && imports.every(name => name.startsWith('node:')));
  assert.ok(!/import\(/.test(source), 'do not add installed native-addon holders to the test harness');
  assert.ok(!/daemon\('(?:login|setup|service-connect)'/.test(source));
  assert.ok(!/COTAL_DESKTOP_E2E_CONTEXT|firstRun\(/.test(source));
  assert.ok(source.includes("assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')"));
});
