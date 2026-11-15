import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { archiveHostedDiagnostics, writeHostedSeatRecorder } from './hosted-consent-diagnostics.mjs';

test('real fixture child retains full output and actual exit, not only Node last line', () => {
  const root = mkdtempSync(join(tmpdir(), 'consent-diag-')), seat = join(root, 'seat.mjs');
  writeFileSync(seat, "console.log('first stdout');console.error('Error: actual launch failure\\nstack line\\nNode.js version');process.exitCode=7;");
  const { launcher, paths } = writeHostedSeatRecorder(root, seat);
  const result = spawnSync(process.execPath, [launcher], { encoding: 'utf8', timeout: 10000, env: { ...process.env, DIAGNOSTIC_SECRET: 'must-not-be-recorded' } });
  assert.equal(result.status, 7); assert.equal(readFileSync(paths.stdout, 'utf8'), result.stdout); assert.equal(readFileSync(paths.stderr, 'utf8'), result.stderr);
  assert.match(readFileSync(paths.stderr, 'utf8'), /actual launch failure\nstack line\nNode.js version/);
  const exit = JSON.parse(readFileSync(paths.exit)); assert.equal(exit.state, 'exited'); assert.equal(exit.exit, 7); assert.equal(exit.signal, null); assert(!JSON.stringify(exit).includes('must-not-be-recorded'));
});

test('archive copies fixed owned records only and names missing/unreadable evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'consent-archive-')), fixture = join(root, 'fixture'), output = join(root, 'out'), home = join(root, 'home'), space = 'test_space';
  mkdirSync(fixture); mkdirSync(output); const manager = join(home, 'daemon', `space.${Buffer.from(space).toString('hex')}`, 'manager'); mkdirSync(manager, { recursive: true });
  writeFileSync(join(fixture, 'hosted-seat.stderr.log'), 'actual full stack\n'); writeFileSync(join(manager, 'manager.log'), 'owned launch record\n'); writeFileSync(join(manager, 'credentials.json'), 'never copy');
  symlinkSync(join(manager, 'credentials.json'), join(fixture, 'hosted-seat.stdout.log'));
  const rows = archiveHostedDiagnostics({ fixture, cotalHome: home, space, output, id: 'cell' });
  assert.equal(rows.find(x => x.kind === 'agent-stdout.log').state, 'unreadable'); assert.equal(rows.find(x => x.kind === 'agent-exit.json').state, 'missing');
  assert.equal(readFileSync(join(output, 'cell-hosted-observed-agent-stderr.log'), 'utf8'), 'actual full stack\n'); assert.equal(readFileSync(join(output, 'cell-hosted-observed-manager.log'), 'utf8'), 'owned launch record\n'); assert(!rows.some(x => x.kind.includes('credentials')));
});

test('archive redacts console bearer tokens and refuses root/destination symlinks', () => {
  const root = mkdtempSync(join(tmpdir(), 'consent-security-')), fixture = join(root, 'fixture'), output = join(root, 'out'), home = join(root, 'home');
  mkdirSync(fixture); mkdirSync(output); mkdirSync(home);
  writeFileSync(join(fixture, 'hosted-seat.stderr.log'), 'full stack\nconsole: http://127.0.0.1:9000/#t=012345secret\n');
  const rows = archiveHostedDiagnostics({ fixture, cotalHome: home, space: 'test', output, id: 'safe' });
  const archived = rows.find(x => x.kind === 'agent-stderr.log'); assert(archived.redacted); assert.equal(readFileSync(join(output, archived.artifact), 'utf8'), 'full stack\nconsole: http://127.0.0.1:9000/#t=<redacted>\n');
  const alias = join(root, 'alias'); symlinkSync(fixture, alias); assert.throws(() => archiveHostedDiagnostics({ fixture: alias, cotalHome: home, space: 'test', output, id: 'alias' }), /real directory|canonical/);
  const parentAlias = join(root, 'parent-alias'); symlinkSync(root, parentAlias);
  assert.throws(() => archiveHostedDiagnostics({ fixture, cotalHome: home, space: 'test', output: join(parentAlias, 'out'), id: 'parent' }), /canonical/);
  const protectedFile = join(root, 'protected'); writeFileSync(protectedFile, 'unchanged'); symlinkSync(protectedFile, join(output, 'blocked-hosted-observed-agent-stderr.log'));
  const refused = archiveHostedDiagnostics({ fixture, cotalHome: home, space: 'test', output, id: 'blocked' }); assert.equal(refused.find(x => x.kind === 'agent-stderr.log').state, 'unreadable'); assert.equal(readFileSync(protectedFile, 'utf8'), 'unchanged');
});

test('generated hosted connector records the actual Manager launch without environment values', async () => {
  const root = mkdtempSync(join(tmpdir(), 'consent-connector-')), seat = join(root, 'seat.mjs');
  const { launcher, paths } = writeHostedSeatRecorder(root, seat);
  const source = readFileSync(new URL('./automatic-update-platform-baseline.mjs', import.meta.url), 'utf8');
  const line = source.split('\n').find(line => line.includes("writeFileSync(join(fixture, 'index.js')"));
  assert(line);
  const core = new URL('../packages/core/dist/index.js', import.meta.url).href;
  const ready = join(root, 'ready'), release = join(root, 'release'), launchedSeat = launcher;
  const launchRecord = `writeFileSync(${JSON.stringify(paths.launch)},JSON.stringify({name:o.name,id:o.id,lifecycleUid:o.lifecycleUid,space:o.space,command:process.execPath,args:[${JSON.stringify(launchedSeat)}],seat:${JSON.stringify(seat)},cwd:process.cwd(),managerPid:process.pid}),{mode:0o600});`;
  const expression = line.slice(line.indexOf('`'), line.lastIndexOf('`') + 1);
  const generated = new Function('core', 'ready', 'release', 'launchRecord', 'launchedSeat', `return ${expression}`)(core, ready, release, launchRecord, launchedSeat);
  const file = join(root, 'index.mjs'); writeFileSync(file, generated); await import(new URL(`file://${file}`));
  const { registry } = await import(core); const connector = registry.resolve('connector', 'upgrade-standin');
  const opts = { name: 'upgrade_proof_worker', lifecycleUid: 'lifecycle', space: 'test_space', servers: 'nats://localhost:4222', userAuth: { owner: 'u_owner', actor: 'upgrade_proof_worker', sentinelCredsPath: '/private/sentinel.creds', bearerCmd: [process.execPath, '/private/bearer.mjs'] } };
  const launch = connector.buildLaunch(opts);
  assert.equal(launch.env.COTAL_SENTINEL_CREDS, opts.userAuth.sentinelCredsPath);
  assert.deepEqual(JSON.parse(launch.env.COTAL_BEARER_CMD), opts.userAuth.bearerCmd);
  assert.equal(launch.env.COTAL_OWNER, opts.userAuth.owner); assert.equal(launch.env.COTAL_ACTOR, opts.userAuth.actor);
  assert.equal(launch.env.COTAL_CREDS, undefined); assert.equal(launch.env.COTAL_ID, undefined);
  assert.deepEqual(launch.args, [launcher]);
  const record = JSON.parse(readFileSync(paths.launch)); assert.equal(record.name, 'upgrade_proof_worker'); assert.equal(record.managerPid, process.pid); assert(!JSON.stringify(record).includes('/private/credential'));
});

test('actual hosted matrix path archives before spawn assertion and Manager cleanup', () => {
  const source = readFileSync(new URL('./automatic-update-platform-baseline.mjs', import.meta.url), 'utf8');
  assert(source.indexOf('report.managerHost.diagnostics = archiveHostedDiagnostics') < source.indexOf("ok(report.managerHost.spawn, 'hosted spawn')"));
  assert(source.indexOf('report.managerHost.diagnosticsBeforeCleanup = archiveHostedDiagnostics') < source.indexOf("report.managerHost.stop = await daemon('stop owned daemon-hosted Manager'"));
  assert(source.includes('const recorder = daemonHostedManager ? writeHostedSeatRecorder(fixture, seat) : undefined'));
});
