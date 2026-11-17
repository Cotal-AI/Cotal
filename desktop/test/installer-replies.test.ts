import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { connect, createServer, type Socket } from 'node:net';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

type Request = (op: string, commit?: boolean) => Promise<{ state: string }>;
type Frame = { id: string; op: string; commit?: boolean };
const source = readFileSync(new URL('../src-tauri/installers/service-update.mjs', import.meta.url), 'utf8');
const start = source.indexOf('function createServiceRequester');
const end = source.indexOf('async function absent', start);
assert.ok(start > 0 && end > start);
assert.match(source, /request = createServiceRequester\(socket\);\s+const status = await request\('status'\)/);

// Run the shipped helper's requester over real sockets. Only the request clock is controlled.
async function fixture() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const accepted = once(server, 'connection');
  const socket = connect(address.port, '127.0.0.1');
  // The client's connect event can fire before the server's connection event; listen before awaiting either.
  const connected = once(socket, 'connect');
  const [peer] = await accepted as [Socket];
  await connected;
  const timers = new Map<number, { callback: () => void; ms: number }>();
  let sequence = 0;
  const request = runInNewContext(`${source.slice(start, end)}; createServiceRequester(socket)`, {
    socket, randomUUID, Buffer, lastStep: 'entry',
    setTimeout: (callback: () => void, ms: number) => { const id = ++sequence; timers.set(id, { callback, ms }); return id; },
    clearTimeout: (id: number) => timers.delete(id),
  }) as Request;
  peer.setEncoding('utf8');
  let buffer = '';
  const frames: Frame[] = [];
  let wake: (() => void) | undefined;
  peer.on('data', (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      frames.push(JSON.parse(buffer.slice(0, nl)) as Frame);
      buffer = buffer.slice(nl + 1);
    }
    wake?.();
  });
  peer.on('error', () => {});
  return {
    socket, peer, request, timers,
    next: async () => {
      while (!frames.length) await new Promise<void>(resolve => { wake = resolve; });
      return frames.shift()!;
    },
    expire: () => { assert.equal(timers.size, 1); [...timers.values()][0].callback(); },
    close: async () => {
      const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      socket.destroy(); peer.destroy();
      await closed;
      assert.equal(timers.size, 0);
    },
  };
}
const reply = (frame: Frame, state = frame.op) => JSON.stringify({ v: 1, id: frame.id, ok: true, result: { state } }) + '\n';

test('pinned requests keep their IDs, stop deadlines and typed service refusals', async () => {
  const f = await fixture();
  try {
    for (const [op, commit, ms] of [['status', false, 25_000], ['daemon-stop', false, 70_000], ['daemon-stop', true, 25_000]] as const) {
      const pending = f.request(op, commit);
      const frame = await f.next();
      assert.equal(frame.op, op);
      assert.equal(frame.commit, commit || undefined);
      assert.equal([...f.timers.values()][0].ms, ms);
      f.peer.write(reply(frame));
      assert.equal((await pending).state, op);
    }
    const pending = f.request('managers-prepare-restart');
    const refused = assert.rejects(pending, { message: 'seats still active', code: 'SEATS_ACTIVE' });
    const frame = await f.next();
    f.peer.write(JSON.stringify({ v: 1, id: frame.id, ok: false, error: { code: 'SEATS_ACTIVE', message: 'seats still active' } }) + '\n');
    await refused;
    const abort = f.request('managers-abort-restart');
    f.peer.write(reply(await f.next()));
    assert.equal((await abort).state, 'managers-abort-restart');
  } finally { await f.close(); }
});

for (const mode of ['coalesced', 'partial', 'idle'] as const) {
  test(`prepare timeout preserves framing and only acknowledges abort: ${mode}`, async () => {
    const f = await fixture();
    try {
      const prepare = f.request('managers-prepare-restart');
      const timedOut = assert.rejects(prepare, /timed out/);
      const frame = await f.next();
      const late = reply(frame, 'prépare');
      let tail = late;
      if (mode === 'partial') {
        // Split a UTF-8 codepoint across the timed-out read and the abort read.
        const bytes = Buffer.from(late);
        const split = bytes.indexOf(Buffer.from('é')) + 1;
        const received = once(f.socket, 'data');
        f.peer.write(bytes.subarray(0, split));
        await received;
        f.expire(); await timedOut;
        const abort = f.request('managers-abort-restart');
        const current = await f.next();
        f.peer.write(Buffer.concat([bytes.subarray(split), Buffer.from(reply(current))]));
        assert.equal((await abort).state, 'managers-abort-restart');
      } else {
        f.expire(); await timedOut;
        if (mode === 'idle') {
          const received = once(f.socket, 'data');
          f.peer.write(late); await received;
          tail = '';
        }
        const abort = f.request('managers-abort-restart');
        const current = await f.next();
        f.peer.write(tail + reply(current));
        assert.equal((await abort).state, 'managers-abort-restart');
      }
    } finally { await f.close(); }
  });
}

test('late replies cannot reset the current request deadline or acknowledge it', async () => {
  const f = await fixture();
  try {
    const prepare = f.request('managers-prepare-restart');
    const timedOut = assert.rejects(prepare, /timed out/);
    const old = await f.next(); f.expire(); await timedOut;
    const abort = f.request('managers-abort-restart');
    const unconfirmed = assert.rejects(abort, /timed out/);
    await f.next();
    const timer = [...f.timers.keys()][0];
    const received = once(f.socket, 'data');
    f.peer.write(reply(old)); await received;
    assert.deepEqual([...f.timers.keys()], [timer]);
    f.expire(); await unconfirmed;
  } finally { await f.close(); }
});

for (const [name, raw] of [
  ['bad JSON', '{oops}\n'], ['null', 'null\n'], ['array', '[]\n'],
  ['wrong version', '{"v":2,"id":"unknown","ok":true}\n'],
  ['unknown ID', '{"v":1,"id":"unknown","ok":true,"result":{}}\n'],
  ['event', '{"v":1,"id":"unknown","ok":true,"event":"login-prompt"}\n'],
  ['invalid ok', '{"v":1,"id":"unknown","ok":"yes"}\n'],
  ['missing result', '{"v":1,"id":"unknown","ok":true}\n'],
  ['missing error', '{"v":1,"id":"unknown","ok":false}\n'],
  ['terminated oversized', 'x'.repeat(64 * 1024) + '\n'],
  ['unterminated oversized', 'é'.repeat(32 * 1024)],
] as const) {
  test(`pinned requester refuses ${name} and cannot be reused`, async () => {
    const f = await fixture();
    try {
      const pending = f.request('status');
      const refused = assert.rejects(pending, /invalid reply|unknown reply|line limit/);
      await f.next(); f.peer.write(raw);
      await refused;
      assert.ok(f.socket.destroyed);
      await assert.rejects(f.request('managers-abort-restart'), /invalid reply|unknown reply|line limit/);
    } finally { await f.close(); }
  });
}

test('a valid reply at the byte limit is accepted, one byte over is refused', async () => {
  const f = await fixture();
  try {
    const pending = f.request('status');
    const frame = await f.next();
    const empty = reply(frame, '');
    const exact = reply(frame, 'x'.repeat(64 * 1024 - Buffer.byteLength(empty)));
    assert.equal(Buffer.byteLength(exact), 64 * 1024);
    f.peer.write(exact);
    assert.equal((await pending).state.length, 64 * 1024 - Buffer.byteLength(empty));
    const next = f.request('status');
    const refused = assert.rejects(next, /line limit/);
    const other = await f.next();
    f.peer.write(reply(other, 'x'.repeat(64 * 1024 - Buffer.byteLength(empty) + 1)));
    await refused;
  } finally { await f.close(); }
});

test('a malformed response to an expired request is not silently discarded', async () => {
  const f = await fixture();
  try {
    const prepare = f.request('managers-prepare-restart');
    const timedOut = assert.rejects(prepare, /timed out/);
    const old = await f.next(); f.expire(); await timedOut;
    const abort = f.request('managers-abort-restart');
    const refused = assert.rejects(abort, /invalid reply/);
    const current = await f.next();
    f.peer.write(JSON.stringify({ v: 1, id: old.id, ok: true }) + '\n' + reply(current));
    await refused;
  } finally { await f.close(); }
});

test('only a known timed-out reply may be discarded, and only once', async () => {
  const f = await fixture();
  try {
    const prepare = f.request('managers-prepare-restart');
    const timedOut = assert.rejects(prepare, /timed out/);
    const old = await f.next(); f.expire(); await timedOut;
    const abort = f.request('managers-abort-restart');
    const refused = assert.rejects(abort, /unknown reply/);
    const current = await f.next();
    f.peer.write(reply(old) + reply(old) + reply(current));
    await refused;
  } finally { await f.close(); }
});

for (const event of ['end', 'close', 'error'] as const) {
  test(`pending request fails promptly on socket ${event}`, async () => {
    const f = await fixture();
    try {
      const pending = f.request('status');
      const refused = assert.rejects(pending, /closed|fixture failure/);
      await f.next();
      if (event === 'end') f.peer.end();
      else if (event === 'close') f.socket.destroy();
      else f.socket.destroy(new Error('fixture failure'));
      await refused;
      await assert.rejects(f.request('managers-abort-restart'), /closed|fixture failure/);
    } finally { await f.close(); }
  });
}

test('overlapping requests refuse without writing or replacing the pending read', async () => {
  const f = await fixture();
  try {
    const pending = f.request('status');
    const frame = await f.next();
    await assert.rejects(f.request('managers-abort-restart'), /already pending/);
    f.peer.write(reply(frame));
    assert.equal((await pending).state, 'status');
  } finally { await f.close(); }
});
