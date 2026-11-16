import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { candidatePairRegistry } from './candidate-pair-registry.mjs';
import { candidateSourceIdentity } from './candidate-next-evidence.mjs';
import { inspectInstalledUpdateRoute } from './daemon-cell-diagnostics.mjs';
import { redactDiagnostic } from './hosted-consent-diagnostics.mjs';

type Options = { candidate: string; next: string; followOn: string; mode: 'fresh-official-npm' | 'selected-generation'; sourceSHA: string; officialVersion: '0.164.18'; output: string };
type Overrides = { env?: NodeJS.ProcessEnv; cwd?: string };
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const json = (file: string) => JSON.parse(readFileSync(file, 'utf8'));

/** Hosted-only preparation. Importing this module performs no installation or native work. */
export async function runOtherHomeManagerCell(options: Options) {
  assert(process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_TEMP, 'hosted runner only, never local');
  assert(['linux', 'darwin'].includes(process.platform), 'Linux/macOS only');
  assert.equal(process.versions.node.split('.')[0], '24', 'Node 24 required');
  assert.equal(options.officialVersion, '0.164.18');
  assert(['fresh-official-npm', 'selected-generation'].includes(options.mode));
  assert.match(options.sourceSHA, /^[a-f0-9]{40}$/);
  const output = resolve(options.output);
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(join(process.env.RUNNER_TEMP!, 'other-home-'));
  chmodSync(root, 0o700);
  const home = join(root, 'updater-home-b'), project = join(root, 'project-b'), prefix = join(home, 'npm');
  const cotalHome = join(home, '.cotal'), config = join(home, 'config', 'cotal');
  for (const directory of [home, project, cotalHome, config, prefix]) mkdirSync(directory, { recursive: true, mode: 0o700 });
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (/^(COTAL_|NPM_CONFIG_|npm_config_)/.test(key)) delete env[key];
  Object.assign(env, { HOME: home, XDG_CONFIG_HOME: join(home, 'config'), COTAL_HOME: cotalHome,
    npm_config_userconfig: join(home, '.npmrc'), npm_config_cache: join(home, '.npm'), npm_config_prefix: prefix,
    npm_config_registry: 'https://registry.npmjs.org/', XDG_RUNTIME_DIR: join(home, 'runtime'), TMPDIR: join(home, 'tmp'),
    XDG_CACHE_HOME: join(home, '.cache'), XDG_DATA_HOME: join(home, '.local/share'), XDG_STATE_HOME: join(home, '.state'),
    DO_NOT_TRACK: '1', COTAL_TELEMETRY: 'off', NO_COLOR: '1' });
  for (const path of [env.XDG_RUNTIME_DIR, env.TMPDIR, env.XDG_CACHE_HOME, env.XDG_DATA_HOME, env.XDG_STATE_HOME]) {
    assert(path); mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  const pkg = join(prefix, 'lib/node_modules/cotal-ai'), cli = join(pkg, 'dist/cotal.js');
  const report: any = { mode: options.mode, sourceSHA: options.sourceSHA, root, output, startedAt: new Date().toISOString(),
    status: 'unrun', platform: process.platform, calls: [], assertions: [], selections: {}, observations: {}, hops: [], evidenceGaps: [], artifacts: [] };
  const archive = (name: string, text: string) => {
    const bytes = redactDiagnostic(text), file = join(output, name);
    writeFileSync(file, bytes, { mode: 0o600, flag: 'wx' });
    const entry = { file: name, sha256: hash(bytes), bytes: Buffer.byteLength(bytes) };
    report.artifacts.push(entry); return entry;
  };
  const check = (label: string, passed: unknown, evidence?: unknown) => {
    report.assertions.push({ label, passed: Boolean(passed), evidence }); assert(passed, label);
  };
  async function call(label: string, file: string, argv: string[], timeout = 600000, overrides: Overrides = {}) {
    const commandEnv = overrides.env ?? env, cwd = overrides.cwd ?? project;
    const startedAt = new Date().toISOString();
    const result = await new Promise<any>(done => execFile(file, argv, { env: commandEnv, cwd, timeout, maxBuffer: 32 * 1024 * 1024 }, (error: any, stdout, stderr) =>
      done({ stdout: redactDiagnostic(String(stdout)), stderr: redactDiagnostic(String(stderr)), exit: error ? error.code ?? null : 0,
        signal: error?.signal ?? null, timeout: Boolean(error?.killed), ...(error?.message ? { error: redactDiagnostic(error.message) } : {}) })));
    const row = { label, file, argv, startedAt, endedAt: new Date().toISOString(), cwd,
      envhome: { HOME: commandEnv.HOME, COTAL_HOME: commandEnv.COTAL_HOME, XDG_CONFIG_HOME: commandEnv.XDG_CONFIG_HOME }, ...result };
    row.artifact = archive(`command-${String(report.calls.length).padStart(3, '0')}.json`, JSON.stringify(row, null, 2));
    report.calls.push(row);
    appendFileSync(join(output, 'commands.jsonl'), JSON.stringify(row) + '\n', { mode: 0o600 });
    return row;
  }
  const ok = (row: any) => { check(`${row.label}: exits 0`, row.exit === 0 && !row.signal && !row.timeout); return row; };
  const npm = async (label: string, argv: string[]) => ok(await call(label, 'npm', argv));
  const cotal = async (label: string, argv: string[]) => ok(await call(label, process.execPath, [cli, ...argv]));
  // Inventory names only. Never read credential file contents or follow symlinks.
  const credentials = () => {
    const found: string[] = [];
    const visit = (directory: string) => {
      if (!existsSync(directory)) return;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) visit(path);
        else if (/(?:token|credential|creds|bearer|idp|actor|sentinel|secret)/i.test(entry.name)) found.push(path);
      }
    };
    for (const directory of [cotalHome, config, join(project, '.cotal')]) visit(directory);
    return found.sort();
  };
  const recovery = () => existsSync(join(cotalHome, 'update-recovery.json')) ? json(join(cotalHome, 'update-recovery.json')) : null;
  let registry: any, fixture: any;
  async function selection(label: string, expected: string, staged: boolean) {
    const route = inspectInstalledUpdateRoute(pkg);
    const probe = `const {selectExecutionProgram}=await import(${JSON.stringify(pathToFileURL(cli).href)});const s=selectExecutionProgram(${JSON.stringify(pkg)});console.log(JSON.stringify(s));`;
    const selected = JSON.parse(ok(await call(`${label} read-only installed bootstrap selection`, process.execPath, ['--input-type=module', '-e', probe])).stdout);
    check(`${label} real selected version`, route.selectedCliVersion === expected && (route.updateRoute === 'staged') === staged, route);
    check(`${label} bootstrap retained route`, selected.retained === staged, selected);
    report.selections[label] = { route, selected };
    return selected.root as string;
  }
  try {
    report.officialDist = JSON.parse((await npm('official npm dist', ['view', 'cotal-ai@0.164.18', 'dist', '--json'])).stdout);
    check('official dist SRI recorded', typeof report.officialDist.integrity === 'string');
    await npm('install official npm graph before overlay', ['install', '-g', '--prefix', prefix, 'cotal-ai@0.164.18', '--no-audit', '--no-fund']);
    report.officialManifest = { value: json(join(pkg, 'package.json')), sha256: hash(readFileSync(join(pkg, 'package.json'))) };
    report.official = { version: '0.164.18', registry: 'https://registry.npmjs.org/', installedVersion: report.officialManifest.value.version, dist: report.officialDist };
    await selection('official', '0.164.18', false);
    registry = await candidatePairRegistry(resolve(options.candidate), resolve(options.next), resolve(options.followOn));
    report.registry = registry.identity;
    report.candidate = registry.identity;
    check('candidate packs share requested source', registry.identity.source === options.sourceSHA);
    env.npm_config_registry = registry.url;
    writeFileSync(join(home, '.npmrc'), `registry=${registry.url}\n`, { mode: 0o600 });
    const a = registry.identity.sourceVersion;
    if (options.mode === 'fresh-official-npm') {
      report.candidateInstall = await npm('plain npm candidate A replaces official graph', ['install', '-g', '--prefix', prefix, `cotal-ai@${a}`, '--no-audit', '--no-fund']);
    } else {
      report.prime = await cotal('official public self prime to candidate A without Manager', ['update', '--self']);
    }
    const selectedA = await selection('candidate-A-before-Manager', a, options.mode === 'selected-generation');
    check('canonical npm anchor', json(join(pkg, 'package.json')).version === (options.mode === 'selected-generation' ? '0.164.18' : a));
    report.candidateSourceInvocation = candidateSourceIdentity({ pkg: selectedA, cli: join(selectedA, 'dist/cotal.js'), identity: registry.identity, argv: [join(selectedA, 'dist/cotal.js'), 'update', '--self'] });
    // Fixture is separately owned and loaded only when this explicitly invoked hosted cell runs.
    const { prepareOtherHomeManager } = await import('./other-home-manager-fixture.js');
    report.logicalUpdaterEntry = cli;
    report.updaterCredentialsBefore = credentials();
    check('updater B has no credentials before fixture', report.updaterCredentialsBefore.length === 0);
    fixture = await prepareOtherHomeManager({ env, project, pkg, loadedRoot: selectedA, root, config, cotalHome, prefix, cli, output, report, call, check, version: a, options: { 'other-home-manager': options.mode } });
    check('fixture uses custom daemon', fixture.customDaemon === true);
    report.before = fixture.before;
    report.origin = report.selections['candidate-A-before-Manager'].route;
    report.homes = { updater: cotalHome, manager: fixture.homes.manager.cotalHome };
    const beforeText = JSON.stringify(fixture.before);
    const instance = fixture.before?.instanceId ?? fixture.before?.manager?.instanceId;
    check('fixture pins Manager instance', typeof instance === 'string' && instance.length > 0);
    check('fixture measured candidate A version', fixture.before.version === a);
    for (const [label, target, activate] of [
      ['A-to-B', registry.identity.targetVersion, () => registry.activateTarget()],
      ['B-to-C', registry.identity.followOnVersion, () => registry.activateFollowOn()],
    ] as const) {
      activate();
      const plain = ok(await fixture.runFromOtherHome(`${label} normal public plain update from credential-free B`, ['update']));
      check(`${label} exact plain other-home message`, plain.stdout.split(/\r?\n/).includes(`Manager ${instance}, started from another Cotal home, was left running.`));
      const self = ok(await fixture.runFromOtherHome(`${label} public self update from credential-free B`, ['update', '--self']));
      check(`${label} exact self other-home message`, self.stdout.split(/\r?\n/).includes(`Updated to ${target}. Manager ${instance}, started from another Cotal home, keeps running ${a} until it is restarted.`));
      check(`${label} no activation deferred`, !/activation deferred/i.test(self.stdout + self.stderr));
      await selection(label, target, true);
      report.observations[label] = await fixture.observe(label);
      archive(`${label}-observation.json`, JSON.stringify(report.observations[label], null, 2));
      report.hops.push({ target, plain, self, selected: report.selections[label].route, after: report.observations[label], recovery: recovery() });
      check('before snapshot preserved', JSON.stringify(fixture.before) === beforeText);
    }
    report.finalCleanupProbe = ok(await fixture.runFromOtherHome('final public plain update C collector probe', ['update']));
    check('final exact plain other-home message', report.finalCleanupProbe.stdout.split(/\r?\n/).includes(`Manager ${instance}, started from another Cotal home, was left running.`));
    report.afterCleanup = await fixture.observe('after-cleanup-probe');
    report.updaterCredentialsAfter = credentials();
    check('updater B has no credentials after hops', report.updaterCredentialsAfter.length === 0);
    report.status = 'collected';
  } catch (error) {
    report.status = 'failed'; report.error = redactDiagnostic(String(error));
  } finally {
    for (const [label, close] of [['fixture', () => fixture?.close()], ['registry', () => registry?.close()]] as const) {
      try { await close(); } catch (error) { report.status = 'cleanup-failed'; (report.cleanupErrors ??= []).push({ label, error: redactDiagnostic(String(error)) }); }
    }
    report.cleanup = { ...report.cleanup, passed: !report.cleanupErrors?.length && Array.isArray(report.cleanup?.remaining) && report.cleanup.remaining.length === 0, ...(report.cleanupErrors ? { errors: report.cleanupErrors } : {}) };
    if (!report.cleanup.passed) report.status = 'cleanup-failed';
    report.registryRequests = registry?.requests;
    report.finishedAt = new Date().toISOString();
    report.retainedScratch = { root, reason: 'Evidence and fixture cleanup inspection retained, no recursive deletion without ownership barrier.' };
    if (report.calls.length) report.artifacts.push({ file: 'commands.jsonl', sha256: hash(readFileSync(join(output, 'commands.jsonl'))) });
    const evidenceBytes = redactDiagnostic(JSON.stringify(report, null, 2)) + '\n';
    report.evidence = { name: 'evidence.json', bytes: Buffer.byteLength(evidenceBytes), sha256: hash(evidenceBytes) };
    writeFileSync(join(output, 'evidence.json'), evidenceBytes, { mode: 0o600, flag: 'wx' });
    const bytes = redactDiagnostic(JSON.stringify(report, null, 2)) + '\n';
    writeFileSync(join(output, 'report.json'), bytes, { mode: 0o600, flag: 'wx' });
    writeFileSync(join(output, 'report.json.sha256'), `${hash(bytes)}  report.json\n`, { mode: 0o600, flag: 'wx' });
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: Object.fromEntries(['candidate', 'next', 'followOn', 'mode', 'sourceSHA', 'officialVersion', 'output'].map(key => [key, { type: 'string' as const }])) });
  for (const key of ['candidate', 'next', 'followOn', 'mode', 'sourceSHA', 'officialVersion', 'output']) assert(values[key], `--${key} required`);
  const report = await runOtherHomeManagerCell(values as Options);
  if (report.status !== 'collected') process.exitCode = 1;
}
