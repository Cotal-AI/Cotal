import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const shard = fileURLToPath(new URL('../bin/smoke/shard.mjs', import.meta.url));
const mutationSuites = ['smoke:mutation-proof', 'smoke:mutation-reproof', 'smoke:mutation-reproof-full-partition', 'smoke:mutation-reproof-full-workflow', 'smoke:mutation-coverage', 'smoke:mutation-metadata'];

test('the shipped shard skips mutation infrastructure and still executes ordinary checks', () => {
  const root = mkdtempSync(join(tmpdir(), 'cotal-ci-policy-'));
  try {
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const calls = join(root, 'calls.jsonl');
    const child = join(root, 'record-call.mjs');
    writeFileSync(child, `import {appendFileSync} from 'node:fs';\nappendFileSync(${JSON.stringify(calls)},JSON.stringify(process.argv.slice(2))+'\\n');\nconsole.log('SUITE COMPLETE: 3 passed, 0 failed');\n`);
    const pnpm = join(bin, process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm');
    writeFileSync(pnpm, process.platform === 'win32'
      ? `@echo off\r\n"${process.execPath}" "${child}" %*\r\n`
      : `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${child.replaceAll("'", "'\\''")}' "$@"\n`);
    chmodSync(pnpm, 0o700);
    // Keep this selector test from enumerating or reaping any process outside its fixture.
    if (process.platform !== 'win32') {
      writeFileSync(join(bin, 'ps'), '#!/bin/sh\nexit 0\n');
      chmodSync(join(bin, 'ps'), 0o700);
    }
    const list = join(root, 'suites.txt');
    writeFileSync(list, ['smoke:ordinary-before', ...mutationSuites, 'smoke:ordinary-after'].join('\n') + '\n');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true }));
    const result = spawnSync(process.execPath, [shard, '0', '1'], {
      cwd: root,
      env: { ...process.env, PATH: bin + delimiter + process.env.PATH, COTAL_CI_SUITES: list, SMOKE_CI_JOBS: '1' },
      encoding: 'utf8', timeout: 30000,
    });
    const output = result.stdout + result.stderr;
    assert.equal(result.status, 0, output);
    assert.deepEqual(readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line)), [['smoke:ordinary-before'], ['smoke:ordinary-after']]);
    for (const suite of mutationSuites) assert.ok(output.includes(`skipped pnpm ${suite} (mutation execution disabled)`), output);
    assert.match(output, /passed \(2 smokes, 6 cells; 6 mutation suite\(s\) excluded by policy\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
