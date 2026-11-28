import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

async function globalNpmConfigCell(repo, mode, setting) {
  const root = mkdtempSync(join(tmpdir(), 'npm-global-config-'));
  const home = join(root, 'home'), prefix = join(root, 'prefix with spaces');
  const config = join(root, 'config'), cotal = join(root, 'cotal'), tmp = join(root, 'tmp');
  const installed = join(prefix, 'lib/node_modules/cotal-ai');
  const entry = join(installed, 'dist/cotal.js');
  const manifests = new Map(), archives = new Map();
  const target = '99.0.0', extension = '@cotal-ai/global-config-smoke';
  let registry;
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, registry).pathname);
    if (archives.has(path)) return res.end(archives.get(path));
    if (manifests.has(path)) {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify(manifests.get(path)));
    }
    res.writeHead(404).end();
  });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:cotal_|npm_config_|(?:https?_proxy|all_proxy|no_proxy)$)/i.test(key)));
  Object.assign(env, { HOME: home, COTAL_HOME: cotal, XDG_CONFIG_HOME: config, TMPDIR: tmp, XDG_RUNTIME_DIR: tmp, DO_NOT_TRACK: '1',
    HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1', NO_PROXY: '127.0.0.1' });
  const write = (path, text) => writeFileSync(path, typeof text === 'string' ? text : JSON.stringify(text));
  const observations = join(root, 'npm.jsonl');
  const run = async (file, args) => {
    const child = spawn(file, args, { cwd: home, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const [code, signal] = await once(child, 'close');
    return { code, signal, output };
  };
  const resultWithNpm = (result, extra = {}) => ({ ...result, ...extra, defaultCacheExists: existsSync(join(home, '.npm')),
    npm: existsSync(observations) ? readFileSync(observations, 'utf8').trim().split('\n').map(JSON.parse) : [] });
  const publish = (name, latest, versions) => {
    const document = { name, 'dist-tags': { latest }, versions: {} };
    for (const [version, extra, files] of versions) {
      const artifact = `/${name}/-/${version}.tgz`;
      const payload = mkdtempSync(join(root, 'payload-'));
      const source = join(payload, 'package');
      mkdirSync(source);
      const manifest = { name, version, ...extra };
      write(join(source, 'package.json'), manifest);
      for (const [file, text] of Object.entries(files)) {
        mkdirSync(dirname(join(source, file)), { recursive: true });
        writeFileSync(join(source, file), text, { mode: 0o755 });
      }
      const archive = join(payload, 'payload.tgz');
      const packed = spawnSync('tar', ['-czf', archive, '-C', payload, 'package'], { env });
      assert.equal(packed.status, 0, String(packed.stderr));
      const bytes = readFileSync(archive);
      archives.set(artifact, bytes);
      document.versions[version] = { ...manifest, dist: {
        tarball: `${registry}${artifact}`, integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
      } };
    }
    manifests.set(`/${name}`, document);
  };
  try {
    for (const dir of [home, config, cotal, tmp, join(prefix, 'bin'), join(prefix, 'etc'), installed]) mkdirSync(dir, { recursive: true, mode: 0o700 });
    cpSync(join(repo, 'bin/dist'), dirname(entry), { recursive: true });
    cpSync(join(repo, 'bin/package.json'), join(installed, 'package.json'));
    const workspaceModules = join(repo, 'bin/node_modules');
    const modules = join(installed, 'node_modules');
    if (mode === 'seed') {
      const scope = join(modules, '@cotal-ai');
      const cli = join(scope, 'cli');
      const source = join(repo, 'implementations/cli');
      mkdirSync(cli, { recursive: true });
      for (const name of readdirSync(workspaceModules)) if (!name.startsWith('.') && name !== '@cotal-ai')
        symlinkSync(join(workspaceModules, name), join(modules, name), 'dir');
      for (const name of readdirSync(join(workspaceModules, '@cotal-ai'))) if (name !== 'cli')
        symlinkSync(join(workspaceModules, '@cotal-ai', name), join(scope, name), 'dir');
      cpSync(join(source, 'dist'), join(cli, 'dist'), { recursive: true });
      cpSync(join(source, 'package.json'), join(cli, 'package.json'));
      symlinkSync(join(source, 'node_modules'), join(cli, 'node_modules'), 'dir');
    } else symlinkSync(workspaceModules, modules, 'dir');
    symlinkSync(entry, join(prefix, 'bin/cotal'));
    const findNpm = spawnSync('/bin/sh', ['-c', 'command -v npm'], { env, encoding: 'utf8' });
    assert.equal(findNpm.status, 0, findNpm.stderr);
    const tools = join(root, 'tools');
    mkdirSync(tools);
    writeFileSync(join(tools, 'npm'), `#!${process.execPath}
const { appendFileSync, existsSync, lstatSync, readFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const { join } = require('node:path');
const args = process.argv.slice(2);
const result = spawnSync(${JSON.stringify(findNpm.stdout.trim())}, args, { stdio: 'inherit' });
const prefix = args.includes('--prefix') ? args[args.indexOf('--prefix') + 1] : undefined;
const root = prefix && (args.includes('-g') ? join(prefix, 'lib/node_modules') : join(prefix, 'node_modules'));
const installed = root && join(root, 'cotal-ai');
const staged = args.includes('install') && installed && existsSync(join(installed, 'package.json')) ? {
  version: JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')).version,
  link: lstatSync(installed).isSymbolicLink(),
  optional: existsSync(join(root, 'global-config-optional')) || existsSync(join(installed, 'node_modules/global-config-optional')),
} : undefined;
appendFileSync(${JSON.stringify(observations)}, JSON.stringify({ command: args[0], staged }) + '\\n');
process.exit(result.status ?? 1);
`, { mode: 0o700 });
    env.PATH = `${tools}:${env.PATH}`;
    const { version } = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
    const seed = join(config, 'cotal/seed');
    const { SEEDED_EXTENSIONS } = await import(pathToFileURL(join(repo, 'packages/workspace/dist/index.js')));
    if (mode !== 'seed') {
      mkdirSync(seed, { recursive: true });
      for (const name of ['authority.json', 'authority.bak.json'])
        write(join(seed, name), { everSeeded: ['claude', 'opencode', 'codex', 'hermes', 'jcode', 'pi', 'web'] });
      write(join(seed, 'witness.json'), { initialized: true, firstGeneration: version });
      write(join(seed, 'stamp.json'), { generation: version });
    }
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    registry = `http://127.0.0.1:${server.address().port}`;
    write(join(home, '.npmrc'), `prefix=${prefix}\ncache=${join(root, 'cache')}\nregistry=${registry}/\nfetch-retries=0\nupdate-notifier=false\n`);
    if (!globalNpmConfigCell.npmVersion) {
      const result = spawnSync(findNpm.stdout.trim(), ['--version'], { cwd: home, env, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      globalNpmConfigCell.npmVersion = result.stdout.trim();
      console.log(`npm ${globalNpmConfigCell.npmVersion}`);
    }
    const globalConfig = join(prefix, 'etc/npmrc');
    const applySetting = () => {
      const line = { default: '', 'save-dev': 'save-dev=true', 'save-optional': 'save-optional=true', 'save-peer': 'save-peer=true',
        linked: 'install-strategy=linked', lockv1: 'lockfile-version=1', 'legacy-peer-deps': 'legacy-peer-deps=true',
        'strict-peer-deps': 'strict-peer-deps=true', omit: 'omit=optional', 'global-style': 'global-style=true',
        lock: 'package-lock=false' }[setting];
      assert.notEqual(line, undefined, `unexpected setting ${setting}`);
      if (line) write(globalConfig, `${line}\n`);
    };
    const extensionFiles = { 'index.mjs': `import { registry } from '@cotal-ai/core';
registry.register({ kind: 'command', name: 'global-config-fixture', group: 'Extensions', summary: 'Global npm config fixture', flags: [], run: async () => {} });` };
    const optionalDependencies = { 'global-config-optional': '1.0.0' };
    publish('global-config-optional', '1.0.0', [['1.0.0', {}, {}]]);
    const extensionMeta = { main: './index.mjs', optionalDependencies, peerDependencies: { '@cotal-ai/core': '*' } };
    publish(extension, target, [[version, extensionMeta, extensionFiles], [target, extensionMeta, extensionFiles]]);
    const inspectPrefix = path => {
      const read = name => existsSync(join(path, name)) ? JSON.parse(readFileSync(join(path, name), 'utf8')) : {};
      const manifest = read('package.json'), lock = read('package-lock.json');
      const packages = Object.keys(manifest.dependencies ?? {}).sort();
      return { packages, lockVersion: lock.lockfileVersion, lockPackages: Object.keys(lock.packages ?? {}).sort(),
        optional: existsSync(join(path, 'node_modules/global-config-optional')),
        links: packages.filter(pkg => existsSync(join(path, 'node_modules', pkg)) && lstatSync(join(path, 'node_modules', pkg)).isSymbolicLink()) };
    };
    if (mode === 'seed') {
      const shared = join(installed, 'seeded-connectors', '_shared');
      mkdirSync(shared, { recursive: true });
      write(join(shared, 'placements.json'), { v: 1, files: {}, placements: {} });
      for (const [name, { pkg, srcDir, commands }] of Object.entries(SEEDED_EXTENSIONS)) {
        const payload = join(installed, 'seeded-connectors', name);
        mkdirSync(payload, { recursive: true });
        write(join(payload, 'package.json'), { name: pkg, version, type: 'module', main: './index.mjs', optionalDependencies,
          peerDependencies: { '@cotal-ai/core': '*' }, ...Object.fromEntries(Object.entries(JSON.parse(readFileSync(join(repo, srcDir, 'package.json'), 'utf8'))).filter(([key]) => key === 'cotal')) });
        const code = [`registry.register({ kind: 'seed-fixture', name: ${JSON.stringify(name)} });`,
          ...commands.map(word => `registry.register({ kind: 'command', name: ${JSON.stringify(word)}, group: 'Extensions', summary: 'Fixture', flags: [], run: async () => {} });`)];
        write(join(payload, 'index.mjs'), [`import { registry } from '@cotal-ai/core';`, ...code].join('\n'));
      }
      applySetting();
      const result = await run(process.execPath, [entry, 'ext', 'seed']);
      const current = await run(process.execPath, [entry, 'ext', 'root']);
      assert.equal(current.code, 0, current.output);
      return resultWithNpm(result, { layout: inspectPrefix(current.output.trim()) });
    }
    if (mode === 'ext') {
      applySetting();
      const result = await run(process.execPath, [entry, 'ext', 'add', extension]);
      const afterRoot = await run(process.execPath, [entry, 'ext', 'root']);
      assert.equal(afterRoot.code, 0, afterRoot.output);
      const selected = afterRoot.output.trim();
      return resultWithNpm(result, { packagePresent: existsSync(join(selected, 'node_modules', extension)), layout: inspectPrefix(selected) });
    }
    applySetting();
    publish('@cotal-ai/core', target, [[target, {}, {}]]);
    const extensions = join(config, 'cotal/extensions');
    mkdirSync(extensions, { recursive: true });
    write(join(extensions, 'extensions.json'), { extensions: [{ pkg: extension, version, spec: `${extension}@${version}`, commands: [] }] });
    const bin = { cotal: 'dist/cotal.js' };
    const cli = `#!/usr/bin/env node\nconsole.log('cotal-ai ${target}');\n`;
    publish('cotal-ai', target, [[version, { bin }, { 'dist/cotal.js': cli }],
      [target, { bin, optionalDependencies, cotalPreinstall: { v: 1, entry: 'dist/preinstall.js' } }, {
        'dist/cotal.js': cli, 'dist/cotal-program.js': cli,
        'dist/preinstall.js': `const { nonce, installedEntry } = JSON.parse(process.argv[2]); console.log('COTAL_PREINSTALL_RESULT ' + JSON.stringify({ v: 1, nonce, installedEntry, hostedSpaces: [], occupied: 0, admission: { disposition: 'restart-empty', occupied: 0, hostedSpaces: [] } }));`,
      }]]);
    const result = await run(process.execPath, [entry, 'update', '--self']);
    return resultWithNpm(result, { version: (await run(process.execPath, [entry, '--version'])).output.trim().split('\n')[0] });
  } finally {
    server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
}

export async function npmInstallShape(repo) {
  const settings = ['default', 'save-dev', 'save-optional', 'save-peer', 'linked', 'lockv1', 'legacy-peer-deps',
    'strict-peer-deps', 'omit', 'global-style', 'lock'];
  const cells = [];
  for (const setting of settings) for (const mode of ['ext', 'seed', 'update']) {
    const result = await globalNpmConfigCell(repo, mode, setting);
    assert.equal(result.code, 0, `${setting}/${mode}: ${result.output}`);
    const installs = result.npm.filter(({ command }) => command === 'install');
    cells.push(JSON.parse(JSON.stringify({ setting, mode, code: result.code, version: result.version, layout: result.layout,
      packagePresent: result.packagePresent, defaultCacheExists: result.defaultCacheExists,
      staged: installs.flatMap(call => call.staged ? [call.staged] : []), installs: installs.length })));
  }
  return { npm: globalNpmConfigCell.npmVersion.split('.')[0], cells };
}
