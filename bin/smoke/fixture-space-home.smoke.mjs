/** Check the desktop fixture's registry home with real broker/auth services, without a daemon. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { findMesh, homeCotalDir } from '@cotal-ai/workspace';
import { createFixtureSpace } from './_fixture-space.mjs';

const root = mkdtempSync(join(tmpdir(), 'fixture-space-home-'));
const paths = { HOME: join(root, 'home'), XDG_CONFIG_HOME: join(root, 'config'), XDG_RUNTIME_DIR: join(root, 'run'), LOCALAPPDATA: join(root, 'local') };
const keys = ['COTAL_HOME', ...Object.keys(paths)];
const prior = Object.fromEntries(keys.map(key => [key, process.env[key]]));
for (const [key, path] of Object.entries(paths)) { mkdirSync(path, { mode: 0o700 }); process.env[key] = path; }
try {
  for (const mode of ['explicit', 'default']) {
    if (mode === 'explicit') process.env.COTAL_HOME = join(root, 'machine');
    else delete process.env.COTAL_HOME;
    const machineHome = homeCotalDir();
    const rejectedRoot = join(root, `${mode}-rejected`);
    await assert.rejects(createFixtureSpace({ root: rejectedRoot, machineHome: join(root, 'wrong') }), /fixture registry must use the caller-selected machine home/);
    assert.equal(existsSync(rejectedRoot), false, 'a home mismatch must refuse before creating fixture state');
    const fixture = await createFixtureSpace({ root: join(root, mode), machineHome, runtime: resolve('bin'), node: process.execPath, env: {} });
    try {
      assert.equal(homeCotalDir(), machineHome, 'the helper must not redirect its caller');
      assert.equal(findMesh(fixture.space)?.root, fixture.participant, 'the registry uses the selected home');
      assert.equal(existsSync(join(machineHome, 'idp-sessions.json')), true, 'the session uses the same home');
    } finally { await fixture.close(); }
    console.log(`PASS fixture-space-home: ${mode} home records the real fixture and rejects a mismatch before writes`);
  }
} finally {
  for (const key of keys) {
    if (prior[key] === undefined) delete process.env[key];
    else process.env[key] = prior[key];
  }
}
