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

export function restartRecovery(rows, startedAtUnixMs, restart, observed, bridges = [], peers = [], appPid) {
  const from = Date.parse(restart?.calledAt), to = Date.parse(restart?.returnedAt);
  const before = restart?.before?.lifetime, after = restart?.after?.lifetime;
  const lifetime = value => Number.isSafeInteger(value?.pid) && value.pid > 0
    && typeof value.start === 'string' && /^[0-9]+$/.test(value.start);
  const fresh = restart?.outcome === 'passed' && Number.isFinite(from) && to >= from
    && from >= startedAtUnixMs && lifetime(before) && lifetime(after)
    && before.pid !== after.pid && before.start !== after.start;
  const stopped = rows.find(row => row.phase === 'result' && ['status', 'service-status'].includes(row.request?.op)
    && row.ok === false && row.error?.code === 'NOT_RUNNING' && row.atUnixMs >= from && row.atUnixMs <= to);
  let healthy, bridgeResult, bridgePeer;
  if (fresh && Number.isSafeInteger(appPid) && appPid > 0) for (const result of rows) {
    if (result.phase !== 'result' || result.request?.op !== 'status' || result.ok !== true
      || result.atUnixMs > observed.atUnixMs) continue;
    const start = rows.find(row => row.phase === 'start' && row.requestId === result.requestId && row.request?.op === 'status');
    if (!start || start.atUnixMs < to || start.atUnixMs > result.atUnixMs) continue;
    const matches = bridges.filter(row => row.phase === 'bridge-result' && row.parentPid === appPid
      && row.ok === true && row.daemonPid === after.pid
      && Date.parse(row.at) >= start.atUnixMs && Date.parse(row.at) <= result.atUnixMs);
    if (matches.length !== 1) continue;
    const bridge = matches[0];
    const peer = peers.filter(row => row.phase === 'pipe-connected' && row.pid === bridge.pid
      && Date.parse(row.at) >= start.atUnixMs && Date.parse(row.at) <= Date.parse(bridge.at)).at(-1);
    if (peer?.peer?.pid !== after.pid || peer?.peer?.birth !== after.start) continue;
    healthy = result; bridgeResult = bridge; bridgePeer = peer; break;
  }
  const noInputRequests = !rows.some(row => row.phase === 'start' && row.atUnixMs >= startedAtUnixMs
    && ['install', 'setup', 'login'].includes(row.request?.op));
  return { stopped, healthy, bridgeResult, bridgePeer, fresh, noInputRequests,
    passed: Boolean(fresh && healthy && bridgePeer && noInputRequests && observed.recoveryShown === false
      && observed.connectedShown === true && observed.connectionTitle === 'This computer is connected' && !observed.notice) };
}

export function requestSummary(rows, afterUnixMs) {
  return rows.filter(row => row.atUnixMs >= afterUnixMs).map(row => ({
    atUnixMs: row.atUnixMs, requestId: row.requestId, phase: row.phase,
    op: row.request?.op, ok: row.ok, errorCode: row.error?.code, elapsedMs: row.elapsedMs,
  }));
}
