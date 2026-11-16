import assert from 'node:assert/strict';
import fs from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

import { fileURLToPath } from 'node:url';

const reviewedWorkspace = fs.readFileSync(fileURLToPath(new URL('./ci-validator-acquisition-workspace.yaml', import.meta.url)));

function requireAbsent(path, message) {
  const parts = resolve(path).split(sep).filter(Boolean);
  let current = sep;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    let entry;
    try {
      entry = fs.lstatSync(current);
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      assert.fail('Cannot inspect acquisition preflight path');
    }
    if (index === parts.length - 1) assert.fail(message);
    assert.ok(entry.isDirectory() && !entry.isSymbolicLink(), 'Cannot inspect acquisition preflight path');
  }
}

// pnpm 11.28.2 uses XDG_CONFIG_HOME/pnpm, or the OS home/.config/pnpm on Linux.
// These are absence checks, not a config parser or a fence against concurrent writers.
export function assertAcquisitionPreflight(root, env = process.env, home = homedir()) {
  const configDir = env.XDG_CONFIG_HOME ? join(env.XDG_CONFIG_HOME, 'pnpm') : join(home, '.config', 'pnpm');
  requireAbsent(join(configDir, 'config.yaml'), 'External pnpm configuration is not admitted');
  for (const directory of [root, join(root, 'packages', 'core')]) {
    for (const name of ['.pnpmfile.mjs', '.pnpmfile.cjs']) {
      requireAbsent(join(directory, name), 'Default package hook is not admitted');
    }
  }
  let bytes;
  try {
    const path = join(root, 'pnpm-workspace.yaml');
    const before = fs.lstatSync(path);
    assert.ok(before.isFile() && before.size === reviewedWorkspace.length);
    bytes = fs.readFileSync(path);
    const after = fs.lstatSync(path);
    assert.ok(after.isFile() && after.ino === before.ino && after.size === before.size &&
      after.mtimeMs === before.mtimeMs && bytes.length === before.size);
  } catch {
    assert.fail('Reviewed workspace settings differ');
  }
  assert.ok(bytes.equals(reviewedWorkspace), 'Reviewed workspace settings differ');
}
