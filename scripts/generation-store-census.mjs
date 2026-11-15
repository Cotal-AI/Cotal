import { lstatSync, readdirSync, readlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';

/** Read a settled generation store without following links or altering its entries. */
export function inspectGenerationStore(store, { required = true, maxEntries = 200000 } = {}) {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new Error('invalid generation census entry bound');
  const root = resolve(store);
  const report = { root, required, state: 'complete', entries: 0, links: [], violations: [] };
  const walk = (path, relative, depth) => {
    if (depth > 128) throw new Error('generation census depth bound exceeded');
    const before = lstatSync(path);
    if (++report.entries > maxEntries) throw new Error('generation census entry bound exceeded');
    if (relative.split('/').some(name => /^\.(?:installing|preparing)-/.test(name))) {
      report.violations.push({ path: relative, reason: 'unfinished generation staging' });
    }
    if (before.isSymbolicLink()) {
      if (!relative) throw new Error('generation store must not be a symbolic link');
      report.links.push({ path: relative, target: readlinkSync(path) });
    } else if (before.isDirectory() || before.isFile()) {
      if ((before.mode & 0o022) !== 0) report.violations.push({ path: relative || '.', reason: 'group or other writable', mode: before.mode & 0o777 });
      if (before.isDirectory()) {
        for (const name of readdirSync(path).sort()) walk(join(path, name), relative ? `${relative}/${name}` : name, depth + 1);
      }
    } else {
      report.violations.push({ path: relative || '.', reason: 'unexpected entry type' });
    }
    const after = lstatSync(path);
    if (after.dev !== before.dev || after.ino !== before.ino || after.mode !== before.mode || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw new Error(`generation store changed during census: ${relative || '.'}`);
    }
  };
  try {
    const rootInfo = lstatSync(root, { throwIfNoEntry: false });
    if (!rootInfo) {
      report.state = 'missing';
      report.passed = !required;
      return report;
    }
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('generation store must be a real directory');
    walk(root, '', 0);
    report.passed = report.violations.length === 0;
  } catch (error) {
    report.state = 'error';
    report.error = error.message;
    report.passed = false;
  }
  return report;
}
