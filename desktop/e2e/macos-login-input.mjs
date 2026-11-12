import { createHash } from 'node:crypto';
import { constants, openSync, closeSync, fstatSync, readFileSync, lstatSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

function snapshot(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (before.size > 8 * 1024 * 1024) throw Error('receipt exceeds bounded read');
    if (!before.isFile() || (process.getuid && before.uid !== process.getuid()) || (before.mode & 0o022) !== 0 || lstatSync(path).isSymbolicLink()) throw Error('receipt is not a regular owned file');
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    const named = lstatSync(path);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || bytes.length !== after.size || named.ino !== after.ino || named.dev !== after.dev) throw Error('receipt changed during read');
    const text = bytes.toString('utf8');
    if (!text.endsWith('\n') || !bytes.equals(Buffer.from(text))) throw Error('truncated receipt');
    let previous = 0;
    const rows = text.trimEnd().split('\n').map(line => {
      const r = JSON.parse(line);
      if (!Number.isSafeInteger(r.pid) || !Number.isSafeInteger(r.atUnixMs) || r.atUnixMs < previous || typeof r.stage !== 'string' || typeof r.source !== 'string' || !['requested', 'ok', 'observed'].every(k => r[k] === null || typeof r[k] === 'boolean')) throw Error('invalid owned receipt');
      previous = r.atUnixMs;
      return r;
    });
    return { dev: after.dev, ino: after.ino, size: bytes.length, prefix: bytes.toString('base64'), rows };
  } finally { closeSync(fd); }
}
export function baseline(context, pid) {
  const { traceHome } = JSON.parse(readFileSync(context, 'utf8'));
  if (typeof traceHome !== 'string' || !isAbsolute(traceHome)) throw Error('invalid native traceHome');
  const path = join(traceHome, 'login-preference-receipts.jsonl');
  const s = snapshot(path);
  if (!s.rows.some(r => r.pid === pid && r.stage === 'api-is-enabled' && r.source === 'presence-view' && r.ok === true && r.observed === true)) throw Error('missing owned initial poll');
  const last = s.rows.at(-1);
  if (last.pid !== pid || last.stage !== 'api-is-enabled' || last.source !== 'presence-view' || last.ok !== true || last.observed !== true || Date.now() - last.atUnixMs > 2000 || last.atUnixMs > Date.now()) throw Error('no fresh owned baseline poll');
  return { path, pid, dev: s.dev, ino: s.ino, size: s.size, digest: createHash('sha256').update(Buffer.from(s.prefix, 'base64')).digest('hex'), count: s.rows.length, at: last.atUnixMs };
}
export function redelivery(cursor, firstPost, now = Date.now()) {
  if (!Number.isSafeInteger(firstPost) || firstPost <= cursor.at || firstPost > now) throw Error('ambiguous first post time');
  const s = snapshot(cursor.path);
  if (s.dev !== cursor.dev || s.ino !== cursor.ino || s.size < cursor.size || createHash('sha256').update(Buffer.from(s.prefix, 'base64').subarray(0, cursor.size)).digest('hex') !== cursor.digest) throw Error('replaced or truncated receipt');
  const rows = s.rows.slice(cursor.count);
  if (rows.some(r => r.pid !== cursor.pid || r.atUnixMs <= firstPost || r.atUnixMs > now)) throw Error('ambiguous appended receipt time');
  if (rows.some(r => r.stage === 'dom-change' || r.source === 'trusted-input' || r.source === 'untrusted-input' || r.source === 'preference')) throw Error('input receipt with unchanged AXValue');
  const last = rows.at(-1);
  if (!last || last.stage !== 'api-is-enabled' || last.source !== 'presence-view' || last.ok !== true || last.observed !== true || now - last.atUnixMs > 2000) throw Error('no fresh unchanged owned poll');
  return true;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const [mode, value, time] = process.argv.slice(2);
    if (mode === 'baseline') console.log(JSON.stringify(baseline(value, Number(time))));
    else if (mode === 'check') console.log(JSON.stringify(redelivery(JSON.parse(value), Number(time))));
    else throw Error('unsupported receipt operation');
  } catch { console.error('owned login receipt policy refused'); process.exitCode = 1; }
}
