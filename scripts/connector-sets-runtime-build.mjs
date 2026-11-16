import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export function buildConnectorRuntime({ source, output, version, pnpm = process.env.npm_execpath, exec = execFileSync }) {
  assert(process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted' && process.platform === 'linux', 'runtime measurement requires disposable hosted Linux');
  assert(/^0\.164\.(18|1018)$/.test(version), 'only declared candidate runtime versions');
  assert(pnpm && isAbsolute(pnpm) && existsSync(pnpm), 'run through pnpm exec node');
  const root = realpathSync(source), destination = resolve(output);
  assert(isAbsolute(destination) && !existsSync(destination), 'new absolute runtime output required');
  const run = (args, options = {}) => exec(process.execPath, [pnpm, ...args], { cwd: root, stdio: 'inherit', timeout: 900000, env: { ...process.env, PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: 'warn', PNPM_CONFIG_WORKSPACE_CONCURRENCY: '3' }, ...options });
  const fixed = JSON.parse(readFileSync(join(root, '.changeset/config.json'), 'utf8')).fixed.flat();
  const rows = JSON.parse(run(['list', '-r', '--include-workspace-root', '--depth', '-1', '--json'], { encoding: 'utf8', stdio: 'pipe' }));
  const originals = rows.filter(row => fixed.includes(row.name)).map(row => ({path: join(row.path, 'package.json'), bytes: readFileSync(join(row.path, 'package.json'), 'utf8')}));
  assert.equal(originals.length, fixed.length, 'complete lockstep runtime source');
  try {
    for (const row of originals) {
      const metadata = JSON.parse(row.bytes);
      metadata.version = version;
      for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) for (const name of Object.keys(metadata[field] ?? {})) {
        if (fixed.includes(name) && !metadata[field][name].startsWith('workspace:')) metadata[field][name] = version;
      }
      writeFileSync(row.path, JSON.stringify(metadata, null, 2) + '\n');
    }
    run(['--filter', 'cotal-ai...', '--workspace-concurrency', '3', 'build']);
    run(['--filter', 'cotal-ai', 'seeded-connectors']);
    // Use the product's bundled-runtime builder, not an npm approximation of the app.
    run(['--dir', 'desktop', 'prepare:runtime']);
    const runtime = join(root, 'desktop/src-tauri/runtime');
    const record = JSON.parse(readFileSync(join(runtime, 'desktop-runtime.json'), 'utf8'));
    assert.equal(record.version, version);
    const binary = join(root, 'desktop/src-tauri/binaries', `cotal-node-${record.target}`);
    mkdirSync(dirname(destination), { recursive: true });
    mkdirSync(destination);
    renameSync(runtime, join(destination, 'runtime'));
    renameSync(binary, join(destination, 'cotal-node'));
    return { version, runtime: join(destination, 'runtime'), node: join(destination, 'cotal-node'), target: record.target };
  } finally {
    for (const row of originals) writeFileSync(row.path, row.bytes);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const { values } = parseArgs({ options: { source: {type:'string'}, output: {type:'string'}, version: {type:'string'} } });
  buildConnectorRuntime(values);
}
