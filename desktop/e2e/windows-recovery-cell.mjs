import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

export const recoveryCells = ['before-poll', 'after-poll'];
export const recoveryWaitMs = 180_000;

// A snapshot may catch the writer between append fragments. Never use that partial tail
// as admission evidence, and never alter the authoritative file.
export function nativeRequestRows(file) {
  const raw = readFileSync(file, 'utf8');
  assert(raw.endsWith('\n') || raw === '', 'native request snapshot has an incomplete tail');
  return raw.trimEnd().split('\n').filter(Boolean).map(line => {
    const row = JSON.parse(line);
    assert(Number.isSafeInteger(row.atUnixMs) && row.atUnixMs > 0);
    assert(Number.isSafeInteger(row.requestId));
    assert(['start', 'result', 'error', 'timeout'].includes(row.phase));
    return row;
  });
}

export function heldBeforePoll(rows, baseline, disableAtUnixMs, clickAtUnixMs, before) {
  const watch = row => ['status', 'service-status'].includes(row.request?.op);
  const interference = rows.filter(row => watch(row) && row.atUnixMs >= disableAtUnixMs && row.atUnixMs <= clickAtUnixMs);
  const pending = rows.filter(row => watch(row) && row.phase === 'start' && row.atUnixMs <= disableAtUnixMs
    && !rows.some(end => end.requestId === row.requestId && end.phase !== 'start' && end.atUnixMs <= disableAtUnixMs));
  const held = baseline?.phase === 'result' && baseline?.request?.op === 'status' && baseline?.ok === true
    && baseline.atUnixMs <= disableAtUnixMs && disableAtUnixMs - baseline.atUnixMs < 2000
    && !interference.length && !pending.length && before.action === 'connect' && before.buttonText === 'Check again'
    && before.recoveryShown === true && before.disabled === false;
  return { held, interference, pending, baseline, disableAtUnixMs, clickAtUnixMs };
}

export function stoppedPoll(rows, afterUnixMs) {
  return rows.find(row => row.phase === 'result' && row.request?.op === 'status' && row.ok === false
    && row.error?.code === 'NOT_RUNNING' && row.atUnixMs >= afterUnixMs);
}

export function restartRecovery(rows, startedAtUnixMs, restart, observed) {
  const stopped = rows.find(row => row.phase === 'result' && ['status', 'service-status'].includes(row.request?.op)
    && row.ok === false && row.error?.code === 'NOT_RUNNING' && row.atUnixMs >= startedAtUnixMs);
  const healthy = stopped && rows.find(row => row.phase === 'result' && row.request?.op === 'status'
    && row.ok === true && row.atUnixMs > stopped.atUnixMs);
  const from = Date.parse(restart?.calledAt), to = Date.parse(restart?.returnedAt);
  const noInputRequests = !rows.some(row => row.phase === 'start' && row.atUnixMs >= startedAtUnixMs
    && ['install', 'setup', 'login'].includes(row.request?.op));
  return { stopped, healthy, noInputRequests, passed: Boolean(stopped && healthy && noInputRequests
    && stopped.atUnixMs >= from && stopped.atUnixMs <= to
    && healthy.atUnixMs <= observed.atUnixMs && observed.recoveryShown === false
    && observed.connectedShown === true && observed.connectionTitle === 'This computer is connected') };
}

export function requestSummary(rows, afterUnixMs) {
  return rows.filter(row => row.atUnixMs >= afterUnixMs).map(row => ({
    atUnixMs: row.atUnixMs, requestId: row.requestId, phase: row.phase,
    op: row.request?.op, ok: row.ok, errorCode: row.error?.code, elapsedMs: row.elapsedMs,
  }));
}
