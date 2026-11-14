import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
assert(['linux', 'darwin', 'win32'].includes(process.platform));
process.umask(0o077);
const harness = resolve('harness');
const output = join(process.env.RUNNER_TEMP, 'hosted-update-evidence');
mkdirSync(output, { recursive: true, mode: 0o700 });
const variant = process.env.VARIANT;
assert(['agent-local', 'agent-url', 'empty-manager', 'no-manager', 'main-candidate', 'hosted-scheduler', 'repair-paused'].includes(variant));
const original = readFileSync(join(harness, 'scripts/automatic-update-platform-baseline.mjs'), 'utf8');
let source = original;
function replace(before, after) {
  assert.equal(source.split(before).length, 2, `measurement anchor must be unique: ${before.slice(0, 100)}`);
  source = source.replace(before, after);
}
replace("import { compareVersions } from './upgrade-matrix-plan.mjs';", "import { compareVersions } from './upgrade-matrix-plan.mjs';\nimport { observeHostedUpdate, fixtureUrl, repairHostedUpdate } from '../../scripts/measure-hosted-update-observer.mjs';");
replace("options['stop-agents'] === 'true', 'daemon-hosted-manager requires", "(options['stop-agents'] === 'true' || options['measure-empty'] === 'true'), 'daemon-hosted-manager requires");
replace("(options.method ?? 'self') === 'self'", "['self', 'scheduler'].includes(options.method ?? 'self')");
replace('  let uncertain = false, installedService', '  let measurements, fixtureRegistry;\n  let uncertain = false, installedService');
replace('timeout = callTimeout(label)', "timeout = label === 'upgrade under test' ? 600000 : callTimeout(label)");
replace("        ok(await cotal('register daemon-hosted stand-in connector', ['ext', 'add', fixture]), 'hosted stand-in registration');", `        {
          let spec = fixture;
          if (options['measure-url'] === 'true') { fixtureRegistry = await fixtureUrl({ fixture, call, output }); spec = 'cotal-upgrade-native-fixture@' + fixtureRegistry.url; }
          ok(await cotal('register daemon-hosted stand-in connector', ['ext', 'add', spec]), 'hosted stand-in registration');
        }`);
replace("        report.managerHost.spawn = await cotal('spawn real daemon-hosted agent'", "        if (options['measure-empty'] !== 'true') {\n        report.managerHost.spawn = await cotal('spawn real daemon-hosted agent'");
replace("        report.agentBefore = ok(await cotal('confirm daemon-hosted seat', ['ps', '--on', setup.manager.instanceId, '--space', space, '--json']), 'hosted ps').stdout;", "        report.agentBefore = ok(await cotal('confirm daemon-hosted seat', ['ps', '--on', setup.manager.instanceId, '--space', space, '--json']), 'hosted ps').stdout;\n        }");
if (process.env.REPAIR_FIXED_PACKAGE === '1') replace("version: report.target, type: 'module', main: 'index.js'", "version: report.source, type: 'module', main: 'index.js'");
replace("  const omit = exclusion({ layout, method, state });", "  const omit = exclusion({ layout, method, state: method === 'scheduler' ? 'daemon' : state });");
replace('    let update;\n', `    measurements = await observeHostedUpdate({ env, pkg, cli, project, output, cotalHome, report });
    await measurements.sample('before');
    if (options.method === 'scheduler') report.daemonBefore = JSON.parse(ok(await daemon('hosted scheduler initial status', ['daemon', 'status', '--json']), 'scheduler status').stdout).result;
    let update;\n`);
replace('    if (releaseHolder) releaseHolder();', "    if (measurements) { await measurements.close(); report.independentFinalState = measurements.final; if (options['measure-repair'] === 'true') report.repairProof = await repairHostedUpdate({ env, pkg, cli, project, output, cotalHome, report, cotal, call, npmCall }).catch(error => ({ error: error.message })); }\n    if (fixtureRegistry) await fixtureRegistry.close();\n    if (releaseHolder) releaseHolder();");
// Keep both unchanged-main source and target archives in the same real registry overlay.
if (variant === 'main-candidate') {
  replace("  const entries = new Map(), archives = new Map(), requests = [];", "  const entries = new Map(), archives = new Map(), requests = [];\n  const previous = JSON.parse(readFileSync(join(process.env.RUNNER_TEMP, 'packed-source/manifest.json'), 'utf8'));\n  const previousEntries = new Map();");
  replace("  const expected = json(resolve(import.meta.dirname, '../.changeset/config.json')).fixed.flat().sort();", `  for (const pkg of previous.packages) {
    const file = join(process.env.RUNNER_TEMP, 'packed-source', pkg.archive), bytes = readFileSync(file);
    assert.equal(digest(bytes), pkg.sha256);
    let metadata;
    await list({ file, strict: true, onReadEntry(entry) {
      if (entry.path !== 'package/package.json') { entry.resume(); return; }
      const chunks = []; entry.on('data', b => chunks.push(b)); entry.on('end', () => { metadata = JSON.parse(Buffer.concat(chunks).toString()); });
    } });
    previousEntries.set(pkg.name, { metadata, pkg, bytes }); archives.set(pkg.archive, bytes);
  }
  const expected = json(resolve(import.meta.dirname, '../.changeset/config.json')).fixed.flat().sort();`);
  replace('      const local = entries.get(name);', `      const prior = previousEntries.get(name);
      if (prior) packument.versions[prior.pkg.version] = { ...prior.metadata, dist: { tarball: url + '/__candidate/' + prior.pkg.archive, integrity: 'sha512-' + createHash('sha512').update(prior.bytes).digest('base64'), shasum: createHash('sha1').update(prior.bytes).digest('hex') } };
      const local = entries.get(name);`);
}
const measured = join(harness, 'scripts/measure-hosted-generated.mjs');
writeFileSync(measured, source, { mode: 0o600 });
writeFileSync(join(output, 'instrumented-harness.mjs'), source);
writeFileSync(join(output, 'measurement-inputs.json'), JSON.stringify({ variant, sample: process.env.SAMPLE, harness: process.env.HARNESS_SOURCE, product: process.env.PRODUCT_SOURCE, originalSha256: createHash('sha256').update(original).digest('hex'), instrumentedSha256: createHash('sha256').update(source).digest('hex') }, null, 2));
const patch = spawnSync('diff', ['-u', join(harness, 'scripts/automatic-update-platform-baseline.mjs'), measured], { encoding: 'utf8' });
assert([0, 1].includes(patch.status));
writeFileSync(join(output, 'instrumentation.diff'), patch.stdout);
if (process.argv.includes('--instrument-only')) process.exit(0);
const { matrixCell } = await import(pathToFileURL(measured));
let prepareUpdateParticipant;
if (variant !== 'no-manager') ({ prepareUpdateParticipant } = await import(pathToFileURL(join(harness, 'implementations/auth/smoke/update-participant.fixture.ts'))));
const options = { source: process.env.SOURCE_VERSION ?? '0.164.7', state: variant === 'no-manager' ? 'daemon' : 'agent', method: 'self', layout: 'npm', output, 'expected-target': '0.164.8' };
if (variant !== 'no-manager') Object.assign(options, { prepare: prepareUpdateParticipant, 'daemon-hosted-manager': 'true' });
if (['empty-manager', 'hosted-scheduler'].includes(variant)) options['measure-empty'] = 'true';
else if (variant !== 'no-manager') options['stop-agents'] = 'true';
if (variant === 'agent-url') options['measure-url'] = 'true';
if (variant === 'hosted-scheduler') options.method = 'scheduler';
if (variant === 'repair-paused') options['measure-repair'] = 'true';
if (process.env.FIXED_TARGET === '1') Object.assign(options, { candidate: join(process.env.RUNNER_TEMP, 'packed-target'), direction: 'B', 'expected-target': '0.164.9' });
if (variant === 'main-candidate') Object.assign(options, { candidate: join(process.env.RUNNER_TEMP, 'packed-target'), direction: 'B', source: '0.164.8', 'expected-target': '0.164.9' });
const report = await matrixCell(options);
writeFileSync(join(output, 'result.json'), JSON.stringify(report, null, 2));
// Red product results are evidence, never converted to an expected refusal.
process.exitCode = process.env.REPAIR_FIXED_PACKAGE === '1' ? report.repairProof?.repair?.exit === 0 && report.repairProof?.managerAnswers && report.repairProof?.automatic ? 0 : 1 : report.result === 'passed' ? 0 : 1;
