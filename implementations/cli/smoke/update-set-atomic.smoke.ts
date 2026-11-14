import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

// Real CLI/natives/npm path. Only the second requested package install is refused by a transparent
// package-manager fixture, so the failure happens after the first connector's ordinary transaction.
if (process.platform === 'win32') {
  console.log('update set atomic refusal fixture: not run on Windows, POSIX npm shim required');
} else {
const root = mkdtempSync(join(tmpdir(), 'update-set-'));
try {
const home = join(root, 'home'), config = join(root, 'config'), tools = join(root, 'tools');
for (const dir of [home, config, tools]) mkdirSync(dir, { mode: 0o700 });
const bin = resolve('bin/dist/cotal.js');
const generation = (JSON.parse(readFileSync(resolve('bin/package.json'), 'utf8')) as { version: string }).version;
const env = { ...process.env, HOME: home, COTAL_HOME: join(home, '.cotal'), XDG_CONFIG_HOME: config,
  COTAL_ALLOW_CHECKOUT_SEED: '1', COTAL_SKIP_CONNECTOR_SEED: '1', COTAL_NO_UPDATE_CHECK: '1' };
const run = (args: string[], extra = {}) => spawnSync(process.execPath, [bin, ...args], { cwd: root, env: { ...env, ...extra }, encoding: 'utf8', timeout: 120000 });
const seed = run(['ext', 'seed']);
assert.equal(seed.status, 0, seed.stderr);
const prefix = join(config, 'cotal/extensions');
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
const packageRecord = JSON.parse(readFileSync(join(prefix, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
assert.equal(packageRecord.dependencies['@cotal-ai/connector-claude-code'], `file:../seed/store/${generation}/claude`);
} finally { rmSync(root, { recursive: true, force: true }); }
}
