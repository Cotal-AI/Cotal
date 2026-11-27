import assert from 'node:assert/strict';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { delimiter, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { emitSentinel, skipSuite } from '@cotal-ai/smoke-kit';

// Real CLI/natives/npm path. Only the second requested package install is refused by a transparent
// package-manager fixture, so the failure happens after the first connector's ordinary transaction.
if (process.platform === 'win32') {
  skipSuite('update set atomic refusal fixture: not run on Windows, POSIX npm shim required');
} else {
const root = mkdtempSync(join(tmpdir(), 'update-set-'));
try {
const home = join(root, 'home'), config = join(root, 'config'), tools = join(root, 'tools');
for (const dir of [home, config, tools, join(root, '.cotal')]) mkdirSync(dir, { mode: 0o700 });
const bin = resolve('bin/dist/cotal.js');
const generation = (JSON.parse(readFileSync(resolve('bin/package.json'), 'utf8')) as { version: string }).version;
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('COTAL_'))), HOME: home, COTAL_HOME: join(home, '.cotal'), XDG_CONFIG_HOME: config,
  COTAL_ALLOW_CHECKOUT_SEED: '1', COTAL_SKIP_CONNECTOR_SEED: '1', COTAL_NO_UPDATE_CHECK: '1' };
const run = (args: string[], extra = {}) => spawnSync(process.execPath, [bin, ...args], { cwd: root, env: { ...env, ...extra }, encoding: 'utf8', timeout: 120000 });
const seed = run(['ext', 'seed']);
assert.equal(seed.status, 0, seed.stderr);
const key = createHash('sha256').update(bin).digest('hex');
const selectionPath = join(config, 'cotal/installs', key, 'sets', generation, 'selection.json');
const selected = existsSync(selectionPath) ? (JSON.parse(readFileSync(selectionPath, 'utf8')) as { root: string }).root : join(config, 'cotal');
assert.equal(dirname(selected), existsSync(selectionPath) ? dirname(selectionPath) : config);
const prefix = join(selected, 'extensions');
for (const pkg of ['connector-claude-code', 'connector-opencode']) writeFileSync(join(prefix, 'node_modules/@cotal-ai', pkg, 'damage.txt'), 'previous damaged bytes\n');
const digest = (directory: string): string => {
  const hash = createHash('sha256');
  const walk = (dir: string, relative = '') => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name), rel = join(relative, entry.name);
      if (entry.isDirectory()) walk(path, rel);
      else if (entry.isFile()) hash.update(rel).update(readFileSync(path));
    }
  };
  walk(directory); return hash.digest('hex');
};
// Local downloads can disappear after add because extensions are installed as copies.
const missing = ['hello-ext', '@fixture/missing-ext'];
for (const pkg of [...missing, 'kept-ext']) {
  const source = join(root, pkg.replace('/', '-'));
  mkdirSync(source);
  writeFileSync(join(source, 'package.json'), JSON.stringify({ name: pkg, version: '1.0.0', type: 'module', main: 'index.js', peerDependencies: { '@cotal-ai/core': '*' } }));
  writeFileSync(join(source, 'index.js'), `import { registry } from '@cotal-ai/core'; registry.register({ kind: 'command', name: '${pkg.split('/').pop()}', summary: 'fixture', async run() {} });\n`);
  const added = run(['ext', 'add', source]);
  assert.equal(added.status, 0, added.stderr);
  rmSync(source, { recursive: true });
}
for (const pkg of missing) rmSync(join(prefix, 'node_modules', pkg), { recursive: true });
const keptBefore = digest(join(prefix, 'node_modules/kept-ext'));
const before = digest(prefix);
const npm = spawnSync('which', ['npm'], { encoding: 'utf8' }).stdout.trim();
assert(npm);
const shim = join(tools, 'npm');
writeFileSync(shim, `#!/bin/sh\ncase "$*" in\n  *install*opencode*) echo 'fixture: second connector unavailable' >&2; exit 1;;\n  *view*cotal-ai@latest*) printf '"${generation}"\\n'; exit 0;;\nesac\nexec ${JSON.stringify(npm)} "$@"\n`);
chmodSync(shim, 0o700);
const updated = run(['update'], { PATH: [tools, process.env.PATH].join(delimiter) });
assert.notEqual(updated.status, 0, 'second package refusal must fail update');
assert.match(updated.stderr, /second connector unavailable/);
assert.equal(digest(prefix), before, 'failed whole-set update must leave live prefix byte-for-byte unchanged');
console.log('whole-set failed update leaves live prefix unchanged');
const repaired = run(['update']);
assert.equal(repaired.status, 0, repaired.stderr);
assert(!readFileSync(join(prefix, 'extensions.json'), 'utf8').includes('undefined'));
for (const pkg of ['connector-claude-code', 'connector-opencode']) assert(!readdirSync(join(prefix, 'node_modules/@cotal-ai', pkg)).includes('damage.txt'));
console.log('whole-set successful update repairs every selected package');
for (const pkg of missing) {
  assert.match(repaired.stderr, new RegExp(`${pkg} is in the extensions manifest but not installed`));
  assert(!existsSync(join(prefix, 'node_modules', pkg)), 'update must not resurrect a missing third-party extension');
  const manifest = JSON.parse(readFileSync(join(prefix, 'extensions.json'), 'utf8')) as { extensions: { pkg: string }[] };
  assert(manifest.extensions.some(entry => entry.pkg === pkg), 'missing extension remains available for explicit repair or removal');
  const lock = JSON.parse(readFileSync(join(prefix, 'package-lock.json'), 'utf8')) as { packages: Record<string, { dependencies?: Record<string, string> }> };
  assert.equal(lock.packages['']?.dependencies?.[pkg], undefined);
  assert.equal(lock.packages[`node_modules/${pkg}`], undefined);
}
assert.equal(digest(join(prefix, 'node_modules/kept-ext')), keptBefore, 'an installed local copy survives even when its source is gone');
for (let attempt = 0; attempt < 2; attempt++) {
  const repeated = run(['update', '--self']);
  assert.equal(repeated.status, 0, repeated.stderr);
}
for (const pkg of missing) {
  const removed = run(['ext', 'remove', pkg]);
  assert.equal(removed.status, 0, removed.stderr);
  assert(!readFileSync(join(prefix, 'extensions.json'), 'utf8').includes(`"${pkg}"`));
}
const repairSeed = run(['ext', 'seed', '--repair']);
assert.equal(repairSeed.status, 0, repairSeed.stderr);
console.log('deleted local extensions do not block update retries, removal or seed repair');
const packageRecord = JSON.parse(readFileSync(join(prefix, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
assert.equal(packageRecord.dependencies['@cotal-ai/connector-claude-code'], `file:../seed/store/${generation}/claude`);

// Non-release `@cotal-ai/*` local extensions stay on the "not auto-updated in v1" path during update
// and self-update, ask zero registry metadata for their package name, refuse at load when core-skewed,
// and never abort healthy connector refreshes during `cotal update`.
{
  const localScopedPkg = '@cotal-ai/local-legacy-greeting-example';
  const localScopedSrc = join(root, 'legacy extension scoped');
  mkdirSync(localScopedSrc);
  writeFileSync(join(localScopedSrc, 'package.json'), JSON.stringify({
    name: localScopedPkg,
    version: '0.179.0',
    type: 'module',
    main: 'index.mjs',
    peerDependencies: { '@cotal-ai/core': '*' },
  }));
  writeFileSync(join(localScopedSrc, 'index.mjs'), "import { registry } from '@cotal-ai/core'; registry.register({ kind: 'command', name: 'local-legacy-greeting-example', summary: 'fixture', run() { console.log('local greeting works'); } });\n");
  const addedLocal = run(['ext', 'add', localScopedSrc]);
  assert.equal(addedLocal.status, 0, addedLocal.stderr);
  const localBefore = digest(join(prefix, 'node_modules', ...localScopedPkg.split('/')));

  const npmCalls = join(root, 'npm-calls.log');
  writeFileSync(npmCalls, '');
  const logShim = join(tools, 'npm');
  writeFileSync(logShim, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(npmCalls)}\nif [ "$1" = view ] && [ "$2" = cotal-ai@latest ]; then\n  printf '"${generation}"\\n'\n  exit 0\nfi\nexec ${JSON.stringify(npm)} "$@"\n`);
  chmodSync(logShim, 0o700);
  const shimEnv = { PATH: [tools, process.env.PATH].join(delimiter) };

  const selfOne = run(['update', '--self'], shimEnv);
  assert.equal(selfOne.status, 0, selfOne.stderr);
  assert.match(selfOne.stdout, new RegExp(`${localScopedPkg}@0\\.179\\.0 - not auto-updated in v1`));
  const selfTwo = run(['update', '--self'], shimEnv);
  assert.equal(selfTwo.status, 0, selfTwo.stderr);
  assert(!readFileSync(npmCalls, 'utf8').includes(`${localScopedPkg}@${generation}`), 'self-update must not request local @cotal-ai/* package from npm');

  // Offline `cotal update --self` (`update-offline.ts` `repairOfflineExtensions`) also leaves local `@cotal-ai/*` untouched.
  const offlineShim = join(tools, 'npm');
  writeFileSync(offlineShim, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(npmCalls)}\nif [ "$1" = view ] && [ "$2" = cotal-ai@latest ]; then\n  printf '%s\\n' '{"error":{"code":"ENOTCACHED"}}'\n  echo 'npm error code ENOTCACHED' >&2\n  exit 1\nfi\nexec ${JSON.stringify(npm)} "$@"\n`);
  chmodSync(offlineShim, 0o700);
  const selfOffline = run(['update', '--self'], shimEnv);
  assert.equal(selfOffline.status, 0, selfOffline.stderr);
  assert(!readFileSync(npmCalls, 'utf8').includes(`${localScopedPkg}@${generation}`), 'offline self-update must not request local @cotal-ai/* package from npm');
  writeFileSync(logShim, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(npmCalls)}\nif [ "$1" = view ] && [ "$2" = cotal-ai@latest ]; then\n  printf '"${generation}"\\n'\n  exit 0\nfi\nexec ${JSON.stringify(npm)} "$@"\n`);
  chmodSync(logShim, 0o700);

  assert.equal(digest(join(prefix, 'node_modules', ...localScopedPkg.split('/'))), localBefore);
  const ranGreeting = run(['local-legacy-greeting-example']);
  assert.equal(ranGreeting.status, 0, ranGreeting.stderr);
  assert.equal(ranGreeting.stdout.trim(), 'local greeting works');

  // JSON contracts stay identical to main: `update --check --json`, `version --json`, and `status --json`.
  const checkJson = JSON.parse(run(['update', '--check', '--json'], shimEnv).stdout) as {
    result: {
      reconciliation: { kind: string; extensions?: { package: string; version: string }[] };
      extensions: { package: string; firstParty: boolean; matchesCli: boolean }[];
    };
  };
  assert.equal(checkJson.result.reconciliation.kind, 'version-mismatch');
  assert(checkJson.result.reconciliation.extensions?.some(e => e.package === localScopedPkg && e.version === '0.179.0'));
  const checkEntry = checkJson.result.extensions.find(e => e.package === localScopedPkg);
  assert.deepEqual(checkEntry && { firstParty: checkEntry.firstParty, matchesCli: checkEntry.matchesCli }, { firstParty: true, matchesCli: false });

  const versionJson = JSON.parse(run(['version', '--json']).stdout) as {
    result: { reconciliation: { kind: string; extensions?: { package: string }[] } };
  };
  assert.equal(versionJson.result.reconciliation.kind, 'version-mismatch');
  assert(versionJson.result.reconciliation.extensions?.some(e => e.package === localScopedPkg));

  const statusJson = JSON.parse(run(['status', '--json']).stdout) as {
    warnings: { code: string; target: { packages?: string[] } | null }[];
  };
  const skewWarning = statusJson.warnings.find(w => w.code === 'EXTENSION_VERSION_SKEW');
  assert(skewWarning?.target?.packages?.includes(localScopedPkg));

  // Corrupt the installed local `@cotal-ai/*` package's core range to simulate a CLI upgrade outgrowing it:
  // CLI command load, Manager/supervise load, and `cotal update` connector + client-setup refresh behave safely,
  // while third-party extensions keep main's load behavior unchanged.
  const localConnectorPkg = '@cotal-ai/local-skewed-connector';
  const localConnectorSrc = join(root, 'local-skewed-connector');
  const connectorLoadedMarker = join(root, 'local-skewed-connector-loaded');
  mkdirSync(localConnectorSrc);
  writeFileSync(join(localConnectorSrc, 'package.json'), JSON.stringify({
    name: localConnectorPkg,
    version: '0.179.0',
    type: 'module',
    main: 'index.mjs',
    peerDependencies: { '@cotal-ai/core': '*' },
  }));
  writeFileSync(join(localConnectorSrc, 'index.mjs'), `import { writeFileSync } from 'node:fs';
import { registry } from '@cotal-ai/core';
writeFileSync(${JSON.stringify(connectorLoadedMarker)}, 'loaded');
registry.register(
  { kind: 'command', name: 'local-skewed-cmd', summary: 'fixture', run() {} },
  { kind: 'runtime', name: 'local-skewed-runtime', available: () => true, create: () => ({ kind: 'local-skewed-runtime', spawn: () => { throw new Error('unused'); } }) },
  { kind: 'connector', name: 'local-skewed-connector', requires: [], buildLaunch: () => ({ command: 'true', args: [] }) },
  { kind: 'client-setup', name: 'local-skewed-client', summary: 'fixture', refresh: { title: 'Skewed client', async run() { return 'refreshed'; } } },
);
`);
  const addedSkewCandidate = run(['ext', 'add', localConnectorSrc]);
  assert.equal(addedSkewCandidate.status, 0, addedSkewCandidate.stderr);
  rmSync(connectorLoadedMarker, { force: true });
  const installedSkewMetaPath = join(prefix, 'node_modules', ...localConnectorPkg.split('/'), 'package.json');
  const installedSkewMeta = JSON.parse(readFileSync(installedSkewMetaPath, 'utf8')) as Record<string, unknown>;
  writeFileSync(installedSkewMetaPath, JSON.stringify({ ...installedSkewMeta, peerDependencies: { '@cotal-ai/core': '>=99.0.0' } }, null, 2));

  const thirdPartyPkg = '@fixture/third-party-unconstrained';
  const thirdPartySrc = join(root, 'third-party-unconstrained');
  mkdirSync(thirdPartySrc);
  writeFileSync(join(thirdPartySrc, 'package.json'), JSON.stringify({
    name: thirdPartyPkg,
    version: '1.0.0',
    type: 'module',
    main: 'index.mjs',
    peerDependencies: { '@cotal-ai/core': '*' },
  }));
  writeFileSync(join(thirdPartySrc, 'index.mjs'), "import { registry } from '@cotal-ai/core'; registry.register({ kind: 'command', name: 'third-party-unconstrained-cmd', summary: 'fixture', run() { console.log('third-party loaded'); } });\n");
  assert.equal(run(['ext', 'add', thirdPartySrc]).status, 0);
  const thirdPartyMetaPath = join(prefix, 'node_modules', ...thirdPartyPkg.split('/'), 'package.json');
  const thirdPartyMeta = JSON.parse(readFileSync(thirdPartyMetaPath, 'utf8')) as Record<string, unknown>;
  writeFileSync(thirdPartyMetaPath, JSON.stringify({ ...thirdPartyMeta, peerDependencies: { '@cotal-ai/core': '>=99.0.0' } }, null, 2));
  const thirdPartyRun = run(['third-party-unconstrained-cmd']);
  assert.equal(thirdPartyRun.status, 0, thirdPartyRun.stderr);
  assert.equal(thirdPartyRun.stdout.trim(), 'third-party loaded');

  const cmdLoad = run(['local-skewed-cmd']);
  assert.equal(cmdLoad.status, 1);
  assert.match(cmdLoad.stderr, /@cotal-ai\/local-skewed-connector declares @cotal-ai\/core ">=99\.0\.0"/);
  assert(!existsSync(connectorLoadedMarker), 'core-skewed command must be refused before importing entry');

  const superviseLoad = run(['supervise', '--runtime', 'local-skewed-runtime', '--server', 'nats://127.0.0.1:1']);
  assert.equal(superviseLoad.status, 1);
  assert.match(superviseLoad.stderr, /@cotal-ai\/local-skewed-connector declares @cotal-ai\/core ">=99\.0\.0"/);
  assert(!existsSync(connectorLoadedMarker), 'core-skewed runtime must be refused before importing entry in supervise/Manager');

  // Force updateOperatorExtensions + refreshConnectorInstalls + refreshClientInstalls to run with a damaged built-in connector:
  writeFileSync(join(prefix, 'node_modules/@cotal-ai/connector-claude-code/damage.txt'), 'trigger reconcile\n');
  const updateWithSkewed = run(['update']);
  assert.equal(updateWithSkewed.status, 0, updateWithSkewed.stderr);
  assert.match(updateWithSkewed.stdout, new RegExp(`${localConnectorPkg}@0\\.179\\.0 - not auto-updated in v1`));
  const skewNotices = updateWithSkewed.stderr.match(/! @cotal-ai\/local-skewed-connector declares @cotal-ai\/core ">=99\.0\.0"/g) ?? [];
  assert.equal(skewNotices.length, 2, `expected connector + client-setup refresh skew notices, got: ${updateWithSkewed.stderr}`);
  assert(!existsSync(connectorLoadedMarker), 'update refresh skips core-skewed local connector and client-setup without importing it');
  assert(!readdirSync(join(prefix, 'node_modules/@cotal-ai/connector-claude-code')).includes('damage.txt'));

  assert.equal(run(['ext', 'remove', thirdPartyPkg]).status, 0);
  assert.equal(run(['ext', 'remove', localConnectorPkg]).status, 0);
  assert.equal(run(['ext', 'remove', localScopedPkg]).status, 0);
}

// An unlisted registry `@cotal-ai/*` package pinned at an older version is release-managed and reconciled to the CLI generation.
{
  const unlistedPkg = '@cotal-ai/unlisted-release-fixture';
  const oldVer = '0.1.0';
  const buildArchive = (ver: string) => {
    const pkgDir = join(root, `unlisted-${ver}`, 'package');
    mkdirSync(pkgDir, { recursive: true });
    const meta = {
      name: unlistedPkg,
      version: ver,
      type: 'module',
      main: 'index.mjs',
      peerDependencies: { '@cotal-ai/core': ver },
    };
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify(meta));
    writeFileSync(join(pkgDir, 'index.mjs'), `import { registry } from '@cotal-ai/core'; registry.register({ kind: 'command', name: 'unlisted-release-cmd', summary: 'fixture', run() { console.log(${JSON.stringify(ver)}); } });\n`);
    const archive = execFileSync('tar', ['-czf', '-', '-C', dirname(pkgDir), 'package']);
    return { ver, meta, archive, integrity: `sha512-${createHash('sha512').update(archive).digest('base64')}` };
  };
  const versions = [buildArchive(oldVer), buildArchive(generation)];
  let origin = '';
  const server = createServer((req, res) => {
    const urlPath = decodeURIComponent(req.url ?? '');
    const tarball = versions.find(item => urlPath === `/unlisted-${item.ver}.tgz`);
    if (tarball) { res.end(tarball.archive); return; }
    if (urlPath === `/${unlistedPkg}`) {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
        name: unlistedPkg,
        'dist-tags': { latest: generation },
        versions: Object.fromEntries(versions.map(item => [item.ver, {
          ...item.meta,
          dist: { tarball: `${origin}/unlisted-${item.ver}.tgz`, integrity: item.integrity },
        }])),
      }));
      return;
    }
    res.writeHead(404).end();
  });
  try {
    await new Promise<void>((ready, reject) => server.once('error', reject).listen(0, '127.0.0.1', ready));
    const addr = server.address();
    assert(addr && typeof addr !== 'string');
    origin = `http://127.0.0.1:${addr.port}`;
    const npmrc = join(root, 'unlisted.npmrc');
    writeFileSync(npmrc, `@cotal-ai:registry=${origin}\n`);
    const registryEnv = { ...env, npm_config_userconfig: npmrc, npm_config_registry: origin, npm_config_fetch_retries: '0' };
    const execAsync = promisify(execFile);
    await execAsync(process.execPath, [bin, 'ext', 'add', `${unlistedPkg}@${oldVer}`], { cwd: root, env: registryEnv, timeout: 120000 });
    const reconciled = await execAsync(process.execPath, [bin, 'update'], { cwd: root, env: registryEnv, timeout: 120000 });
    assert.match(reconciled.stdout + reconciled.stderr, new RegExp(`${unlistedPkg}@${generation.replaceAll('.', '\\.')}`));
    const ranUnlisted = await execAsync(process.execPath, [bin, 'unlisted-release-cmd'], { cwd: root, env: registryEnv, timeout: 120000 });
    assert.equal(ranUnlisted.stdout.trim(), generation);

    // Manifest rows with a missing or non-string `spec` (e.g. omitted, `null`, `3`) complete on `cotal update`, `cotal ext seed`, and command load as on main.
    const manifestFile = join(prefix, 'extensions.json');
    for (const oddSpec of [undefined, null, 3] as const) {
      const writeOddSpec = () => {
        const parsed = JSON.parse(readFileSync(manifestFile, 'utf8')) as { extensions: Record<string, unknown>[] };
        const row = parsed.extensions.find(entry => entry.pkg === unlistedPkg);
        assert(row, 'expected unlisted-release-fixture manifest row');
        if (oddSpec === undefined) delete row.spec;
        else row.spec = oddSpec;
        const keptRow = parsed.extensions.find(entry => entry.pkg === 'kept-ext');
        assert(keptRow, 'expected kept-ext manifest row');
        if (oddSpec === undefined) delete keptRow.spec;
        else keptRow.spec = oddSpec;
        writeFileSync(manifestFile, `${JSON.stringify(parsed, null, 2)}\n`);
      };

      writeOddSpec();
      const loadOdd = await execAsync(process.execPath, [bin, 'unlisted-release-cmd'], { cwd: root, env: registryEnv, timeout: 120000 });
      assert.equal(loadOdd.stdout.trim(), generation);
      const loadKeptOdd = await execAsync(process.execPath, [bin, 'kept-ext'], { cwd: root, env: registryEnv, timeout: 120000 });
      assert.equal(loadKeptOdd.stdout.trim(), '');

      writeOddSpec();
      const updateOdd = await execAsync(process.execPath, [bin, 'update'], { cwd: root, env: registryEnv, timeout: 120000 });
      assert.match(updateOdd.stdout, new RegExp(`verified ${unlistedPkg}@${generation.replaceAll('.', '\\.')}`));
      assert.match(updateOdd.stdout, /kept-ext@1\.0\.0 - not auto-updated in v1\b/);

      writeOddSpec();
      const reconcileOdd = await execAsync(process.execPath, [bin, 'ext', 'seed', '--force'], { cwd: root, env: registryEnv, timeout: 120000 });
      assert(reconcileOdd.stdout !== undefined);
    }

    await execAsync(process.execPath, [bin, 'ext', 'remove', unlistedPkg], { cwd: root, env: registryEnv, timeout: 120000 });
  } finally {
    await new Promise<void>(done => server.close(() => done()));
  }
}
console.log('local @cotal-ai/* preservation, core-peer load refusal, and unlisted release reconciliation verified');
emitSentinel({ passed: 7, failed: 0 });
} finally { rmSync(root, { recursive: true, force: true }); }
}
