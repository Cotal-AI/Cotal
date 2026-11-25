import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const installer = readFileSync(new URL('../install.sh', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'cotal-installer-arguments-'));
const unicodeWhitespace = '\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a' +
  '\u2028\u2029\u202f\u205f\u3000\ufeff';

for (const [label, args, status] of [
  ['omitted version', [], 0],
  ['pin with equals', ['--version=0.14.2'], 0],
  ['pin with a separate operand', ['--version', '0.14.2'], 0],
  ['missing operand', ['--version'], 1],
  ['empty version with equals', ['--version='], 1],
  ['empty version as a separate operand', ['--version', ''], 1],
  ['empty version followed by a pin', ['--version=', '--version=0.14.2'], 1],
  ['ASCII whitespace with equals', ['--version= \t\n\r\f\v'], 1],
  ['mixed whitespace as a separate operand', ['--version', ` \t${unicodeWhitespace}\n`], 1],
  ['nonempty version with surrounding whitespace', ['--version=\u00a00.14.2\n'], 0],
]) {
  test(label, () => {
    const home = mkdtempSync(join(root, 'home-'));
    const run = spawnSync('/bin/sh', ['-s', '--', '--dry-run', ...args], {
      cwd: home, input: installer, encoding: 'utf8', timeout: 10_000,
      env: { HOME: home, PATH: process.env.PATH, SHELL: '/bin/sh', TERM: 'dumb', LC_ALL: 'C',
        TMPDIR: root, COTAL_ALLOW_ROOT: '1' },
    });
    assert.ifError(run.error);
    const output = `${run.stdout}${run.stderr}`;
    assert.equal(run.status, status, output);
    if (status === 1) {
      assert.match(output, /--version needs a value/);
      assert.match(output, /omit --version to install the latest release/);
    } else {
      assert.match(output, /Dry run\. Nothing was changed\./);
    }
    assert.deepEqual(readdirSync(home), []);
  });
}
