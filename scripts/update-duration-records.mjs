import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function captureRecords(root, env) {
  const records = {};
  for (const [base, names] of [
    [env.COTAL_HOME, ['update-settings.json', 'update-recovery.json', 'update-check.json', 'update-attempt.json']],
    [join(env.XDG_CONFIG_HOME, 'cotal', 'seed'), ['stamp.json', 'authority.json', 'authority.bak.json', 'witness.json', 'reconcile.cursor.json', 'reconcile.child.json', 'reconcile.recovery.json']],
    [join(env.XDG_CONFIG_HOME, 'cotal', 'extensions'), ['extensions.json', 'package.json', 'package-lock.json']],
  ]) {
    for (const name of names) {
      const file = join(base, name);
      records[file.replace(root, '<sample-root>')] = existsSync(file) ? JSON.parse(readFileSync(file)) : { absent: true };
    }
  }
  return records;
}
