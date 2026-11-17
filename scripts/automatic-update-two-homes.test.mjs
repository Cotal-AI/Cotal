import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync, symlinkSync, unlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { planRelease, verifyResults } from './upgrade-matrix-plan.mjs';
import { verifyTwoHomeUpgrade, verifySelectedGraphs } from './automatic-update-two-homes-evidence.mjs';
import { selectedConnectorRoot, selectionPath } from './automatic-update-two-homes.mjs';

test('two-home POSIX coordinates are required in both release phases and cannot disappear from census', () => {
  for (const phase of ['candidate', 'published']) {
    const plan = planRelease({ eventName: 'workflow_dispatch', inputs: { phase, sourceSHA: 'a'.repeat(40), targetVersion: '0.165.4' } }, { sourceVersion: '0.165.3' });
    const homes = plan.cells.filter(cell => cell.scenario === 'candidate-next-two-homes');
    assert.deepEqual(homes.map(cell => cell.platform), ['linux', 'darwin']);
    assert(homes.every(cell => cell.required && cell.sourceVersion === '0.165.4' && cell.targetVersion === '0.165.1004'));
    for (const cell of homes) for (const name of ['two-home-up', 'two-home-launch', 'old-manager-preserved', 'home-only-remedy', 'owned-stack-cleanup']) assert(cell.requiredAssertions.includes(name));
    const results = plan.cells.filter(cell => cell.required).map(cell => ({ id: cell.id, status: 'passed', assertions: Object.fromEntries(cell.requiredAssertions.map(name => [name, true])) }));
    assert(verifyResults(plan.cells, results).acceptance);
    assert(!verifyResults(plan.cells, results.filter(cell => cell.id !== homes[0].id)).acceptance);
    delete results.find(cell => cell.id === homes[0].id).assertions['old-manager-preserved'];
    assert(!verifyResults(plan.cells, results).acceptance);
  }
});

test('graph evidence requires selected-root and every old byte/link receipt', () => {
  const canonical = '/private/config/cotal', logicalEntry = '/prefix/lib/node_modules/cotal-ai/dist/cotal.js', version = '0.166.1000';
  const path = selectionPath(canonical, logicalEntry, version), selectedRoot = join(dirname(path), 'cotal');
  const rows = [['extensions/extensions.json', 'file', 'a'.repeat(64)], ['extensions/node_modules/core', 'link', '/old/core']];
  const graph = { canonical, oldRoot: canonical, logicalEntry, version, selectionPath: path, selectedRoot, selection: { v: 1, entry: logicalEntry, version, root: selectedRoot }, selected: structuredClone(rows), old: [{ path: canonical, before: structuredClone(rows), after: structuredClone(rows) }] };
  verifySelectedGraphs(graph, version);
  for (const key of ['selectedRoot', 'selection', 'selected', 'old', 'oldRoot', 'canonical', 'logicalEntry']) {
    const missing = structuredClone(graph); delete missing[key];
    assert.throws(() => verifySelectedGraphs(missing, version), key);
  }
  const changed = structuredClone(graph); changed.old[0].after[1][2] = '/new/core';
  assert.throws(() => verifySelectedGraphs(changed, version), /bytes or links changed/);
  const forged = structuredClone(graph); forged.selection.entry = '/other/dist/cotal.js';
  assert.throws(() => verifySelectedGraphs(forged, version), /record differs/);
  const omitted = structuredClone(graph); omitted.oldRoot = '/old/selected/cotal';
  assert.throws(() => verifySelectedGraphs(omitted, version), /old graph checks missing/);
});

test('installed selector requires exact entry/version, private real directories and a private record', () => {
  const canonical = mkdtempSync(join(tmpdir(), 'cotal-selection-'));
  const entry = '/prefix/lib/node_modules/cotal-ai/dist/cotal.js', version = '0.166.1000';
  const path = selectionPath(canonical, entry, version), root = join(dirname(path), 'cotal');
  try {
    assert.equal(selectedConnectorRoot(canonical, entry, version), canonical);
    assert.throws(() => selectedConnectorRoot(canonical, entry, version, true), /receipt missing/);
    for (const name of ['seed', 'extensions']) mkdirSync(join(root, name), { recursive: true, mode: 0o700 });
    const record = { v: 1, entry, version, root };
    const save = value => writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
    save(record);
    assert.equal(selectedConnectorRoot(canonical, entry, version, true), root);
    for (const bad of [{ ...record, entry: '/wrong' }, { ...record, version: '0.166.0' }, { ...record, root: canonical }]) {
      save(bad); assert.throws(() => selectedConnectorRoot(canonical, entry, version, true), /invalid installed selection/);
    }
    save(record); chmodSync(path, 0o644);
    assert.throws(() => selectedConnectorRoot(canonical, entry, version, true), /not private/);
    chmodSync(path, 0o600); chmodSync(root, 0o755);
    assert.throws(() => selectedConnectorRoot(canonical, entry, version, true), /not private/);
    chmodSync(root, 0o700);
    rmSync(join(root, 'seed'), { recursive: true }); symlinkSync(join(root, 'extensions'), join(root, 'seed'));
    assert.throws(() => selectedConnectorRoot(canonical, entry, version, true), /not a real directory/);
    unlinkSync(join(root, 'seed')); mkdirSync(join(root, 'seed'), { mode: 0o700 });
    const other = join(canonical, 'record.json'); save(record);
    writeFileSync(other, JSON.stringify(record), { mode: 0o600 }); unlinkSync(path); symlinkSync(other, path);
    assert.throws(() => selectedConnectorRoot(canonical, entry, version, true), /not private/);
  } finally { rmSync(canonical, { recursive: true, force: true }); }
});

test('workflow downloads paired artifacts, runs actual callable and strict summary grader', () => {
  const workflow = readFileSync(new URL('../.github/workflows/automatic-update-platforms.yml', import.meta.url), 'utf8');
  assert(workflow.includes("matrix.scenario == 'candidate-next-two-homes'"));
  assert(workflow.includes("const { twoHomeUpgrade } = await import('./scripts/automatic-update-two-homes.mjs')"));
  assert(workflow.includes("const verdict = verifyTwoHomeUpgrade(report, { platform: cell.platform, hosted: true })"));
  assert(workflow.includes("report.old.manifestSha256, nextOrigin.sourceManifestSha256"));
  assert(workflow.includes("report.target.manifestSha256, nextOrigin.targetManifestSha256"));
  assert(workflow.includes("report.harnessFiles[name]"));
});

test('incomplete or success-only two-home evidence never grades acceptance', () => {
  for (const value of [undefined, {}, { acceptance: true, cleanup: 'both owned stacks stopped', checks: [] }]) assert.throws(() => verifyTwoHomeUpgrade(value));
});

function fullTwoHomeReport() {
  const old = '0.166.3', target = '0.166.1003';
  const packages = ['connector-claude-code', 'connector-opencode', 'connector-codex', 'connector-hermes', 'connector-jcode', 'pi', 'web'];
  const inventory = version => `cotal-ai ${version}\n${['claude', 'opencode', 'codex', 'hermes', 'jcode', 'pi', 'web, web-service'].map(name => `  ${name} ${version}`).join('\n')}\n`;
  const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const report = { platform: 'linux', arch: 'x64', environment: { hostedDisposable: true }, acceptance: true, cleanup: 'both owned stacks stopped', old: { version: old }, target: { version: target }, calls: [], checks: [], graphs: {}, readOnly: {}, managers: {}, seat: { pid: 4201, name: 'twohome-proof', lifecycleUid: 'launch-seat-uid' }, oldManagerSeat: { pid: 4202, name: 'twohome-proof', lifecycleUid: 'old-manager-seat-uid' } };
  const check = name => report.checks.push({ name, passed: true });
  for (const route of ['up', 'launch', 'old-manager']) {
    const call = (home, label, args, stdout = '') => {
      report.calls.push({ route, home, label, args, stdout, stderr: '', code: 0, signal: null });
      check(`${route} ${home} ${label} exits zero`);
    };
    const canonical = `/private/twohomes/${route}/B/config/cotal`, logicalEntry = '/private/twohomes/prefix/lib/node_modules/cotal-ai/dist/cotal.js';
    const oldRoot = join(dirname(selectionPath(canonical, logicalEntry, old)), 'cotal');
    const path = selectionPath(canonical, logicalEntry, target), selectedRoot = join(dirname(path), 'cotal');
    const oldManifest = { extensions: packages.map(name => ({ pkg: `@cotal-ai/${name}`, version: old })) };
    const oldRows = [['extensions', 'directory'], ['extensions/extensions.json', 'file', hash(oldManifest)], ['extensions/node_modules/@cotal-ai/core', 'link', '/private/old/core']];
    const selected = [['extensions', 'directory'], ['extensions/extensions.json', 'file', hash({ extensions: packages.map(name => ({ pkg: `@cotal-ai/${name}`, version: target })) })], ['extensions/node_modules/@cotal-ai/core', 'link', '/private/target/core']];
    report.graphs[route] = { canonical, logicalEntry, oldRoot, version: target, selectionPath: path, selectedRoot, selection: { v: 1, entry: logicalEntry, version: target, root: selectedRoot }, selected, old: [{ path: canonical, before: [['installs', 'directory']], after: [['installs', 'directory']] }, { path: oldRoot, before: structuredClone(oldRows), after: structuredClone(oldRows) }] };
    report.readOnly[route] = { targetSelectionAbsent: true, oldRoot, oldManifest, oldManifestRaw: JSON.stringify(oldManifest), oldManifestSha256: hash(oldManifest) };
    report[`${route}ManifestSha256`] = selected[1][2];
    call('A', 'install old closure', ['install', '-g', `cotal-ai@${old}`]);
    for (const home of ['A', 'B']) {
      call(home, 'seed old home', ['ext', 'seed']);
      call(home, 'old version', ['--version'], inventory(old));
    }
    call('B', 'prepare space', ['space', 'create', 'twohomes', '--plain']);
    call('B', 'start original space', ['up', '--detach']);
    call('A', route === 'old-manager' ? 'old Manager candidate install setup' : 'self update shared installation', route === 'old-manager' ? ['install', '-g', `cotal-ai@${target}`] : ['update', '--self']);
    call('A', 'updated home version', ['--version'], inventory(target));
    call('B', 'stale home version before command', ['--version'], `cotal-ai ${target}\n`);
    const launchLabel = route === 'up' ? 'ordinary next up' : route === 'launch' ? 'ordinary next agent launch' : 'ordinary old Manager agent launch';
    call('B', launchLabel, route === 'up' ? ['up', '--detach'] : ['spawn', '--foreground', '--agent', 'two-home-seat', '--name', 'twohome-proof', '--on', 'old-manager-instance']);
    call('B', 'home version after ordinary command', ['--version'], inventory(target));
    call('B', 'home status after command', ['status', '--json'], JSON.stringify({ outcome: 'ok', completeness: 'complete' }));
    call('B', 'final owned stack down', ['down', '--yes']);
    for (const name of ['home has no recovery obligation', 'target selected root is isolated', 'old graphs byte and link unchanged', 'owned stack cleanup confirmed']) check(`${route} ${name}`);
    if (route === 'old-manager') {
      const identity = { version: old, instanceId: 'old-manager-instance', pid: 4100, birth: '847213', native: { pid: 4100, token: '847213' } };
      report.managers[route] = { before: structuredClone(identity), after: structuredClone(identity) };
      for (const when of ['before', 'after']) call('B', `old Manager served identity ${when}`, ['--input-type=module', '-e', '/* installed manager control probe */'], JSON.stringify({ version: old, instanceId: identity.instanceId, native: identity.native }));
      call('B', 'old Manager remains answering', ['ps', '--json'], '{"outcome":"ok"}');
      for (const name of ['starts exact old Manager', 'real old fixture joined', 'version PID and birth unchanged']) check(`old-manager ${name}`);
    }
  }
  return report;
}

test('full modern selected-root evidence accepts all three routes with read-only CLI-only output', () => {
  const report = fullTwoHomeReport();
  assert.deepEqual(verifyTwoHomeUpgrade(report, { platform: 'linux', hosted: true }), { acceptance: true, routes: 3, checks: report.checks.length });
});

test('full report rejects missing or forged read-only inventory and changed old graph links on every route', () => {
  for (const route of ['up', 'launch', 'old-manager']) {
    const cases = [
      [r => { delete r.readOnly[route]; }, /read-only old selection evidence missing/],
      [r => { r.readOnly[route].targetSelectionAbsent = false; }, /read-only old selection evidence missing/],
      [r => { delete r.readOnly[route].oldManifestRaw; }, /old manifest raw bytes missing/],
      [r => { r.readOnly[route].oldManifestRaw = {}; }, /old manifest raw bytes missing/],
      [r => { r.readOnly[route].oldManifestRaw += '\n'; }, /old manifest raw hash differs/],
      [r => {
        const evidence = r.readOnly[route];
        evidence.oldManifestRaw = JSON.stringify({ extensions: [] });
        evidence.oldManifestSha256 = createHash('sha256').update(evidence.oldManifestRaw).digest('hex');
      }, /parsed old manifest differs from raw bytes/],
      [r => { delete r.readOnly[route].oldManifest; }, /parsed old manifest differs from raw bytes/],
      [r => { r.readOnly[route].oldManifest.extensions.pop(); }, /parsed old manifest differs from raw bytes/],
      [r => { delete r.readOnly[route].oldManifest.extensions[0].version; }, /parsed old manifest differs from raw bytes/],
      [r => { r.readOnly[route].oldManifest.extensions[0].version = r.target.version; }, /parsed old manifest differs from raw bytes/],
      ...[
        manifest => { manifest.extensions.pop(); },
        manifest => { delete manifest.extensions[0].version; },
        manifest => { manifest.extensions[0].version = 'forged-version'; },
      ].map(change => [r => {
        const evidence = r.readOnly[route];
        change(evidence.oldManifest);
        evidence.oldManifestRaw = JSON.stringify(evidence.oldManifest);
        evidence.oldManifestSha256 = createHash('sha256').update(evidence.oldManifestRaw).digest('hex');
      }, /every old built-in/]),
      [r => {
        const evidence = r.readOnly[route];
        evidence.oldManifestRaw += '\n';
        evidence.oldManifestSha256 = createHash('sha256').update(evidence.oldManifestRaw).digest('hex');
      }, /old manifest raw inventory differs/],
      [r => { delete r.readOnly[route].oldManifestSha256; }, /old manifest raw hash differs/],
      [r => { r.readOnly[route].oldManifestSha256 = 'f'.repeat(64); }, /old manifest raw hash differs/],
      [r => { r.calls.find(call => call.route === route && call.label === 'home status after command').stdout = JSON.stringify({ outcome: 'ok', completeness: 'partial' }); }, /final status is not complete and healthy/],
      [r => { r.calls.find(call => call.route === route && call.label === 'home status after command').stdout = JSON.stringify({ outcome: 'error', completeness: 'complete' }); }, /final status is not complete and healthy/],
      [r => { r.graphs[route].old[1].after[2][2] = '/private/forged/core'; }, /bytes or links changed/],
      [r => { r.calls = r.calls.filter(call => call.route !== route || call.label !== 'final owned stack down'); }, /missing successful final owned stack down/],
    ];
    for (const [change, expected] of cases) {
      const report = fullTwoHomeReport(); change(report);
      assert.throws(() => verifyTwoHomeUpgrade(report), expected, route);
    }
  }
});

test('full report rejects failed or signalled nonrequired command receipts', () => {
  for (const failure of [{ code: 1, signal: null }, { code: 0, signal: 'SIGTERM' }]) {
    const report = fullTwoHomeReport();
    report.calls.push({ route: 'extra', home: 'A', label: 'nonrequired diagnostic', args: ['diagnostic'], stdout: '', stderr: '', ...failure });
    assert.throws(() => verifyTwoHomeUpgrade(report), /every recorded two-home command must succeed/);
  }
});

test('full report requires served old Manager probes, retained identity, pinned launch and joined seats', () => {
  const cases = [
    [r => { r.calls = r.calls.filter(call => call.label !== 'old Manager served identity before'); }, /served Manager probe missing/],
    [r => { r.calls = r.calls.filter(call => call.label !== 'old Manager served identity after'); }, /served Manager probe missing/],
    [r => { r.managers['old-manager'].before.pid = 0; }, /old Manager identity missing/],
    [r => { r.managers['old-manager'].before.birth = ''; }, /old Manager identity missing/],
    [r => { r.managers['old-manager'].after.pid++; }, /old Manager identity changed/],
    [r => { r.managers['old-manager'].after.birth = 'different-birth'; }, /old Manager identity changed/],
    [r => { r.managers['old-manager'].before.version = r.target.version; }, /old Manager identity missing/],
    [r => { r.calls.find(call => call.label === 'old Manager served identity after').stdout = JSON.stringify({ version: r.target.version, instanceId: 'old-manager-instance' }); }, /served Manager version differs/],
    [r => { r.calls.find(call => call.label === 'ordinary old Manager agent launch').args = ['spawn', '--on', 'other-instance']; }, /launch not pinned/],
    [r => { r.calls.find(call => call.label === 'ordinary old Manager agent launch').args = ['spawn']; }, /launch not pinned/],
    [r => { delete r.oldManagerSeat; }, /fixture join missing/],
    [r => { delete r.seat; }, /real no-sign-in seat join required/],
  ];
  for (const [change, expected] of cases) {
    const report = fullTwoHomeReport(); change(report);
    assert.throws(() => verifyTwoHomeUpgrade(report), expected);
  }
  for (const when of ['before', 'after']) {
    for (const change of [native => { native.pid++; }, native => { native.token = 'forged-birth'; }]) {
      const report = fullTwoHomeReport();
      const receipt = report.calls.find(call => call.label === `old Manager served identity ${when}`);
      const served = JSON.parse(receipt.stdout);
      change(served.native);
      receipt.stdout = JSON.stringify(served);
      assert.throws(() => verifyTwoHomeUpgrade(report), /served Manager native lifetime differs/);
    }
  }
  const missingNative = fullTwoHomeReport();
  for (const when of ['before', 'after']) delete missingNative.managers['old-manager'][when].native;
  assert.throws(() => verifyTwoHomeUpgrade(missingNative), /native Manager record differs/);
  assert.throws(() => verifyTwoHomeUpgrade(fullTwoHomeReport(), { platform: 'darwin' }), /native platform differs/);
});

test('a Linux receipt cannot qualify a Darwin coordinate or pretend to be hosted', () => {
  const report = { platform: 'linux', arch: 'x64', environment: { hostedDisposable: false } };
  assert.throws(() => verifyTwoHomeUpgrade(report, { platform: 'darwin' }), /native platform differs/);
  assert.throws(() => verifyTwoHomeUpgrade(report, { platform: 'linux', hosted: true }), /disposable hosted runner/);
  assert.throws(() => verifyTwoHomeUpgrade({ ...report, arch: undefined }), /architecture required/);
});
