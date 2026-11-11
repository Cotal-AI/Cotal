import assert from 'node:assert/strict';
import { lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export function privatePath(value, repository = resolve(import.meta.dirname, '..')) {
  assert(typeof value === 'string' && isAbsolute(value) && resolve(value) === value && !/[\s\x00-\x1f'"`$;<>|&\\]/.test(value), 'normalized safe absolute path required');
  const rel = relative(realpathSync(repository), value);
  assert(rel === '..' || rel.startsWith(`..${sep}`), 'private path must be outside repository');
  assert.equal(realpathSync(dirname(value)), dirname(value), 'private path parents must not contain symlinks');
  return value;
}

export function publisherNpmrc(value, repository) {
  privatePath(value, repository);
  const stat = lstatSync(value);
  assert(stat.isFile() && !stat.isSymbolicLink(), 'publisher npmrc must be a regular non-symlink file');
  assert.equal(stat.mode & 0o7777, 0o600, 'publisher npmrc must have mode 0600');
  assert.equal(stat.uid, process.getuid(), 'publisher npmrc must be owned by caller');
  return value;
}
