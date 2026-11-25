import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const installer = fileURLToPath(new URL('../install.sh', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'cotal-installer-prerequisites-'));
const bin = join(root, 'bin');
mkdirSync(bin);
// Match the minimal image: curl and gzip exist, but tar, node and npm do not.
for (const tool of ['sh', 'gzip', 'mktemp', 'sha256sum', 'uname', 'sed', 'cut', 'grep', 'id', 'date',
  'dirname', 'basename', 'readlink', 'mkdir', 'rm', 'chmod', 'ln', 'find']) {
  const found = spawnSync('/bin/sh', ['-c', 'command -v "$1"', 'find-tool', tool], { encoding: 'utf8' });
  assert.equal(found.status, 0, `host supplies ${tool}`);
  symlinkSync(found.stdout.trim(), join(bin, tool));
}
const attempts = join(root, 'unexpected-command');
for (const tool of ['curl', 'sudo', 'dnf']) {
  const path = join(bin, tool);
  writeFileSync(path, '#!/bin/sh\nprintf "%s\\n" "$0 $*" >> "$ATTEMPTS"\nexit 97\n');
  chmodSync(path, 0o755);
}

const docs = readFileSync(new URL('../docs/installation.mdx', import.meta.url), 'utf8');
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
for (const [label, page] of [['installation page', docs], ['README', readme]]) {
  const prerequisite = page.indexOf('sudo dnf install tar');
  assert(prerequisite >= 0 && prerequisite < page.indexOf('curl -fsSL https://get.cotal.ai'),
    `${label} declares the Rocky prerequisite before the first install command`);
}
assert.match(docs, /tar` with gzip support/);
assert.match(docs, /installer does not run sudo or install system packages/);

for (const [label, args, status] of [
  ['no-setup', ['--no-setup'], 1],
  ['yes', ['--yes'], 1],
  ['dry-run', ['--dry-run'], 0],
]) {
  const home = join(root, label);
  mkdirSync(home);
  const run = spawnSync('/bin/sh', [installer, ...args], {
    env: { HOME: home, PATH: bin, SHELL: '/bin/sh', TERM: 'dumb', LC_ALL: 'C',
      TMPDIR: root, COTAL_HOME: join(home, 'state'), COTAL_ALLOW_ROOT: '1', ATTEMPTS: attempts },
    encoding: 'utf8', timeout: 10_000,
  });
  writeFileSync(join(root, `${label}.stdout`), run.stdout ?? '');
  writeFileSync(join(root, `${label}.stderr`), run.stderr ?? '');
  writeFileSync(join(root, `${label}.exit`), `${run.status}\n`);
  const output = `${run.stdout}${run.stderr}`;
  assert.equal(run.status, status, output);
  if (status === 1) {
    assert.match(output, /Need tar to unpack the Node runtime\./);
    assert.match(output, /sudo dnf install tar/);
    assert.match(output, /again as your own user, without sudo/);
    assert.match(output, /https:\/\/docs.cotal.ai\/docs\/installation\/#use-the-shell-installer/);
    assert(!readdirSync(join(home, '.local/share/cotal')).includes('.install-lock'), 'refusal releases the install lock');
  } else {
    assert.match(output, /nothing was changed/i);
    assert(!existsSync(join(home, '.local')), 'dry run creates no install directories');
  }
  for (const tool of ['cotal', 'node', 'npm'])
    assert(!existsSync(join(home, '.local/bin', tool)), `no ${tool} installed during ${label}`);
  assert(!existsSync(attempts), 'no downloads or privileged package commands are attempted');
  console.log(`installer prerequisites: ${label} passed (exit ${run.status})`);
}
console.log(`installer prerequisites: 3 entrypoint cases passed; fixtures retained at ${root}`);
