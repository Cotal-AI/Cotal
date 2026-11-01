/** Validate real dashboard HTTP responses and SSE payloads against the published
 * OpenAPI contract. Run after the package build and `node website/scripts/sync-docs.mjs`.
 * Uses only a private broker and generated test sessions, with no workstation auth. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect as connectTcp } from 'node:net';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { validator } from '@exodus/schemasafe';
import { CotalEndpoint, chatSubject, isReachable, newIdentity, setupSpaceStreams } from '@cotal-ai/core';
import { SMOKE_BROKER_TOKEN, emitSentinel, freePort, killAndAwaitExit, teardownOnSignal } from '@cotal-ai/smoke-kit';

const spec = JSON.parse(readFileSync(new URL('../../../website/public/dashboard.openapi.json', import.meta.url), 'utf8'));
const definitions = JSON.parse(JSON.stringify(spec.components.schemas).replaceAll('#/components/schemas/', '#/definitions/'));
let checks = 0;
const conforms = (schema: object, value: unknown) => {
  const local = JSON.parse(JSON.stringify(schema).replaceAll('#/components/schemas/', '#/definitions/'));
  const valid = validator({ $schema: 'http://json-schema.org/draft-07/schema#', ...local, definitions }, { includeErrors: true });
  assert(valid(JSON.parse(JSON.stringify(value))), JSON.stringify(valid.errors));
  checks++;
};
const responseSchema = (path: string, status: number, method = 'get') => {
  const operation = spec.paths[path]?.[method];
  assert(operation, `Undocumented operation: ${method.toUpperCase()} ${path}`);
  const entry = operation.responses[status];
  assert(entry, `Undocumented response: ${path} ${status}`);
  const response = entry.$ref ? spec.components.responses[entry.$ref.split('/').at(-1)] : entry;
  return response.content['application/json'].schema;
};

const brokerPort = await freePort();
const server = `nats://127.0.0.1:${brokerPort}`;
const space = 'httpcontract';
const store = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const broker = spawn('nats-server', ['-p', String(brokerPort), '-js', '-sd', store, '-a', '127.0.0.1'], { stdio: 'ignore' });
const release = teardownOnSignal(broker, store);
let dashboard: ReturnType<typeof spawn> | undefined;
let seed: CotalEndpoint | undefined;
const streamAbort = new AbortController();
try {
  for (let i = 0; !(await isReachable(server)); i++) {
    assert(i < 80, 'Private broker did not start');
    await delay(100);
  }
  await setupSpaceStreams({ servers: server, space });
  seed = new CotalEndpoint({ space, servers: server, channels: ['general'], consume: false,
    card: { id: newIdentity().id, name: 'http-probe', kind: 'endpoint' } });
  seed.on('error', () => {});
  await seed.start();
  await seed.multicast('history-contract', { channel: 'general' });
  await seed.unicast(`local.${newIdentity().id}`, 'direct-contract');

  const port = await freePort();
  let output = '';
  dashboard = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./openapi-server.ts', import.meta.url)), server, space, String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
  dashboard.stdout!.on('data', (data: Buffer) => { output += data.toString(); });
  let errors = '';
  dashboard.stderr!.on('data', (data: Buffer) => { errors += data.toString(); });
  let launchUrl: string | undefined;
  for (let i = 0; !launchUrl; i++) {
    assert(i < 200 && dashboard.exitCode === null, `Dashboard did not start: ${errors}`);
    for (const line of output.split('\n')) {
      if (!line.startsWith('{')) continue;
      const value = JSON.parse(line);
      if (value.ready) launchUrl = value.launchUrl;
    }
    if (!launchUrl) await delay(100);
  }
  const base = `http://127.0.0.1:${port}`;
  const refused = await fetch(base + '/api/roster');
  assert.equal(refused.status, 401);
  conforms(responseSchema('/api/roster', 401), await refused.json());
  const cross = await fetch(base + '/api/roster', { headers: { origin: 'https://other.invalid' } });
  assert.equal(cross.status, 403);
  conforms(responseSchema('/api/roster', 403), await cross.json());
  const exchange = await fetch(launchUrl, { redirect: 'manual' });
  assert.equal(exchange.status, 302);
  const cookie = exchange.headers.get('set-cookie')?.split(';')[0];
  assert(cookie);
  assert(cookie.startsWith('cotal_web_session='));
  assert(exchange.headers.get('set-cookie')?.includes('HttpOnly; SameSite=Strict'));
  const spent = await fetch(launchUrl, { redirect: 'manual' });
  assert.equal(spent.status, 401);
  conforms(responseSchema('/api/roster', 401), await spent.json());
  const headers = { cookie };
  const metadata = await fetch(base + '/api/meta', { headers });
  assert.equal(metadata.status, 200);
  const meta = await metadata.json();
  assert(meta !== null && typeof meta === 'object');
  assert('space' in meta && meta.space === space);
  assert('channelDeleteSupported' in meta && meta.channelDeleteSupported === false, 'Native dashboard service is read-only');
  conforms(responseSchema('/api/meta', 200), meta);
  const deletion = await fetch(base + '/api/channel/delete', {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ channel: 'general' }),
  });
  assert.equal(deletion.status, 403, 'Native dashboard cannot acquire channel purge authority');
  conforms(responseSchema('/api/channel/delete', 403, 'post'), await deletion.json());
  for (const path of Object.keys(spec.paths).filter((path) => path !== '/feed' && path !== '/api/meta' && spec.paths[path].get)) {
    const response = await fetch(base + path.replace('{channel}', 'general'), { headers });
    assert.equal(response.status, 200, `${path}: ${response.status}`);
    const body = await response.json();
    conforms(responseSchema(path, 200), body);
    if (path === '/api/roster') assert((body as unknown[]).length > 0, 'Roster fixture must be populated');
    if (path === '/api/activity') assert((body as { entries: unknown[] }).entries.length >= 2, 'Activity must include chat and DM data');
  }
  for (const target of ['/api/activity?limit=1.5', '/api/dms?limit=9007199254740992', '/api/channels/%ZZ/history']) {
    const response = await fetch(base + target, { headers });
    assert.equal(response.status, 400);
    const path = target.includes('/channels/') ? '/api/channels/{channel}/history' : target.split('?')[0];
    conforms(responseSchema(path, 400), await response.json());
  }
  for (const query of ['?limit=', '?limit=0']) {
    const response = await fetch(base + '/api/dms' + query, { headers });
    assert.equal(response.status, 200);
    conforms(responseSchema('/api/dms', 200), await response.json());
  }
  const bodyRefusal = await fetch(base + '/api/roster', { method: 'POST', headers, body: 'test' });
  assert.equal(bodyRefusal.status, 413);
  conforms(responseSchema('/api/roster', 413), await bodyRefusal.json());

  const feed = await fetch(base + '/feed', { headers, signal: streamAbort.signal });
  assert.equal(feed.status, 200);
  assert(feed.headers.get('content-type')?.startsWith('text/event-stream'));
  const reader = feed.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events = new Set<string>();
  const timeout = setTimeout(() => streamAbort.abort(), 10_000);
  await seed.multicast('live-contract', { channel: 'general' });
  // A permitted publisher can send JSON that is not a wire message. The observer
  // forwards it; the HTTP description must not claim it validated that payload.
  const rawSubject = chatSubject(space, 'local', 'raw_json', 'general');
  await new Promise<void>((resolve, reject) => {
    const socket = connectTcp(brokerPort, '127.0.0.1');
    socket.setTimeout(5000, () => socket.destroy(new Error('Raw test publish timed out')));
    socket.once('error', reject);
    let reply = '';
    socket.on('data', (data) => {
      reply += data.toString();
      if (reply.includes('-ERR')) { socket.destroy(); reject(new Error('Raw test publish refused')); }
      if (reply.includes('PONG')) { socket.end(); resolve(); }
    });
    socket.once('connect', () => socket.write('CONNECT {}\r\nPUB ' + rawSubject + ' 2\r\n{}\r\nPING\r\n'));
  });
  let sawRaw = false;
  try {
    while (!sawRaw || !['roster', 'presence-view', 'membership', 'message'].every((event) => events.has(event))) {
      const part = await reader.read();
      assert(!part.done, 'SSE ended before initial snapshots and a live message');
      buffer += decoder.decode(part.value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const name = /^event: (.+)$/m.exec(frame)?.[1];
        const data = /^data: (.+)$/m.exec(frame)?.[1];
        if (!name || !data) continue;
        const schema = spec.paths['/feed'].get['x-sse-events'][name];
        assert(schema, `Undocumented SSE event ${name}`);
        const value = JSON.parse(data);
        conforms(schema, value);
        if (name === 'message' && JSON.stringify(value.msg) === '{}') sawRaw = true;
        events.add(name);
      }
    }
  } finally { clearTimeout(timeout); streamAbort.abort(); await reader.cancel().catch(() => {}); }
  console.log(`openapi smoke: ${checks} real HTTP/SSE payloads conform; populated reads, bootstrap, origin, bad arguments and body refusal passed`);
} finally {
  streamAbort.abort();
  if (dashboard) await killAndAwaitExit(dashboard, 'SIGTERM');
  await seed?.stop();
  await killAndAwaitExit(broker);
  rmSync(store, { recursive: true, force: true });
  release();
}

emitSentinel({ passed: checks, failed: 0 });
