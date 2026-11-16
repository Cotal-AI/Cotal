import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ambiguous, guard, pinMetadata, preservation, sha256, statusEvidence } from './reproduce-6385-legacy.mjs';

const hosted = { env: { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Linux', RUNNER_TEMP: '/runner/temp', GITHUB_RUN_ID: '1' }, platform: 'linux', uid: 1001, os: 'ID=ubuntu\n' };
test('hosted nonroot Ubuntu guard rejects each disallowed environment', () => {
  assert.doesNotThrow(() => guard(hosted));
  for (const patch of [{ uid: 0 }, { uid: null }, { platform: 'darwin' }, { os: 'ID=debian' }, { env: {} }, { env: { ...hosted.env, RUNNER_ENVIRONMENT: 'self-hosted' } }, { env: { ...hosted.env, GITHUB_RUN_ID: '' } }]) assert.throws(() => guard({ ...hosted, ...patch }));
});
test('only real ambiguous marker shape qualifies, missing and corrupt do not', () => {
  assert.equal(ambiguous('{"phase":"ambiguous","owner":123,"nonce":"private-nonce"}'), true);
  for (const input of [undefined, '', 'null', '{}', '{', '{"phase":"running","owner":123,"nonce":"n"}', '{"phase":"ambiguous","owner":"123","nonce":"n"}', '{"phase":"ambiguous","owner":123,"nonce":""}']) assert.equal(ambiguous(input), false);
});
test('pinning keeps exact published source and target integrity unchanged', () => {
  const source = { version: '0.160.2', dist: { integrity: 'sha512-source' } };
  const target = { version: '0.160.3', dist: { integrity: 'sha512-target' } };
  const metadata = { 'dist-tags': { latest: '9.0.0' }, versions: { '0.160.2': source, '0.160.3': target } };
  assert.equal(pinMetadata(metadata, '0.160.3')['dist-tags'].latest, '0.160.3');
  assert.equal(pinMetadata(metadata, '0.160.3', 'latest'), target);
  assert.equal(pinMetadata(metadata, '0.160.3', '0.160.2'), source);
  assert.equal(metadata['dist-tags'].latest, '9.0.0');
  assert.throws(() => pinMetadata(metadata, '0.160.4'));
});
test('status evidence drops secrets and freeform daemon errors', () => {
  const evidence = statusEvidence(JSON.stringify({ result: { state: 'ready', version: '0.160.2', token: 'secret', update: { automatic: true, next: 123, lastResult: 'secret', credential: 'secret' } } }));
  assert.equal(evidence.update.next, 123);
  assert(!JSON.stringify(evidence).includes('secret'));
  assert.deepEqual(statusEvidence('not-json secret'), { unreadable: true });
  assert.equal(sha256('a').length, 64);
});
test('preservation receipts distinguish intact, changed and missing canaries without content', () => {
  const root = mkdtempSync(join(tmpdir(), '6385-preserve-'));
  const file = join(root, 'canary'), missing = join(root, 'missing');
  writeFileSync(file, 'opaque fixture only', { mode: 0o600 });
  const before = preservation([file, missing]);
  assert.equal(before[0].sha256, sha256('opaque fixture only'));
  assert.equal(before[1].exists, false);
  assert(!JSON.stringify(before).includes('opaque fixture only'));
  writeFileSync(file, 'changed');
  assert.notDeepEqual(preservation([file, missing]), before);
});

test('effectful exports guard before effects, marker never manufactured, clocks require real learning', () => {
  const source = readFileSync(new URL('./reproduce-6385-legacy.mjs', import.meta.url), 'utf8');
  for (const signature of ['export function command(file, args, env, timeoutMs = 180000)', 'export async function publishedRegistry()', 'export async function runLegacy(options)']) assert(source.includes(`${signature} {\n  guard();`));
  assert(!/writeFileSync\(marker/.test(source));
  assert(source.includes("check.latest === '0.160.3' && Number.isFinite(check.firstSeenAt)"));
  assert(source.includes("['mask', '--runtime', nativePlan.unit]"));
  assert(source.includes('assertNoFixtureProcesses([root, state, config])'));
  assert(source.includes('report.originalMarkerSha256, report.broken.marker.sha256'));
  assert(source.includes("for (const route of ['npm', 'installer'])"));
  assert(source.includes('row.nextUpdate = await cotal'));
  assert(!source.includes('/cmdline'));
  assert(source.includes("report.result = 'reproduction-not-observed'"));
});
