import { lstatSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** Read modes only. The caller separately proves root ownership and normal-account execution. */
export function inspectSharedGenerationModes(pkg, { requireGeneration = true } = {}) {
  const installed = resolve(pkg), store = join(dirname(dirname(installed)), '.cotal-generations');
  const report = { installed, store, entries: [], violations: [] };
  const inspect = (path, mode, kind, expectedOwner) => {
    const info = lstatSync(path);
    const row = { path, kind, mode: info.mode & 0o7777, uid: info.uid, gid: info.gid };
    report.entries.push(row);
    if (info.isSymbolicLink() || (kind === 'directory' ? !info.isDirectory() : !info.isFile())) throw new Error(`unexpected entry type: ${path}`);
    if (row.mode !== mode) report.violations.push({ path, reason: 'unexpected mode', expected: mode, actual: row.mode });
    if (expectedOwner !== undefined && info.uid !== expectedOwner) report.violations.push({ path, reason: 'ownership differs from package', expected: expectedOwner, actual: info.uid });
    return info;
  };
  try {
    const owner = lstatSync(installed).uid;
    inspect(store, 0o755, 'directory', owner);
    inspect(join(installed, 'dist/cotal.js'), 0o755, 'file', owner);
    let generations = 0, descriptors = 0;
    for (const name of readdirSync(store).sort()) {
      const path = join(store, name);
      if (/^[a-f0-9]{32}$/.test(name)) {
        generations++;
        inspect(path, 0o755, 'directory', owner);
        inspect(join(path, 'inventory.json'), 0o644, 'file', owner);
      } else if (/^\.active-[a-f0-9]{64}\.json$/.test(name)) {
        descriptors++;
        inspect(path, 0o644, 'file', owner);
      } else if (/^\.transaction-/.test(name)) {
        const journal = inspect(path, 0o700, 'directory', owner);
        if (journal.isDirectory() && !journal.isSymbolicLink()) {
          for (const child of readdirSync(path)) inspect(join(path, child), 0o600, 'file', owner);
        }
      }
    }
    report.generations = generations;
    report.descriptors = descriptors;
    if (requireGeneration && (!generations || !descriptors)) report.violations.push({ path: store, reason: 'published generation and descriptor required' });
    report.passed = report.violations.length === 0;
  } catch (error) { report.passed = false; report.error = error.message; }
  return report;
}
