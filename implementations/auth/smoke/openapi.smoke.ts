/** Real public-listener conformance with disposable broker, IdP and credentials.
 * Run after the normal package build. Native command tests remain in their own suites. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { validator } from '@exodus/schemasafe';
import { SMOKE_BROKER_TOKEN, emitSentinel, freePort, killAndAwaitExit, teardownOnSignal, teardownPathOnSignal } from '@cotal-ai/smoke-kit';
import { createSpaceAuth, isReachable, mintCreds, mintLifecycleUid, newIdentity, serverConfig, setupSpaceStreams } from '@cotal-ai/core';
import { authDir, saveSpaceAuth, userAuthStateDir, workspaceSecretStore } from '@cotal-ai/workspace';
import { cotalAuthProvider, deriveOwnerForIdpSubject, fetchIdpJwt, grantActor, loadAuthServiceInfo, loadOwnerSecret } from '@cotal-ai/auth';
import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { jwt } from 'better-auth/plugins/jwt';
import { bearer } from 'better-auth/plugins/bearer';
import { toNodeHandler } from 'better-auth/node';
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from 'jose';

type Schema = Record<string, unknown>;
type ResponseEntry = { $ref?: string; content?: Record<string, { schema: Schema }> };
type Operation = { operationId: string; requestBody?: { content: Record<string, { schema: Schema }> }; responses: Record<string, ResponseEntry> };
const spec = JSON.parse(readFileSync(new URL('../openapi.json', import.meta.url), 'utf8')) as {
  openapi: string; paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, Schema>; responses: Record<string, ResponseEntry> };
};
assert.equal(spec.openapi, '3.1.0');
assert.equal(Object.keys(spec.paths).length, 11);
const operations = Object.values(spec.paths).flatMap(Object.values);
assert.equal(operations.length, 12);
assert.equal(new Set(operations.map(op => op.operationId)).size, 12);
for (const op of operations) assert.match(op.operationId, /^[a-z][a-z0-9-]*$/);
// @exodus/schemasafe uses draft-07; this contract uses its shared JSON Schema
// subset. No OpenAPI-specific nullable keyword or remote schema loading is used.
const localize = (value: unknown) => JSON.parse(JSON.stringify(value).replaceAll('#/components/schemas/', '#/definitions/')) as Schema;
type ValidationSchema = Parameters<typeof validator>[0];
const definitions = localize(spec.components.schemas) as Record<string, ValidationSchema>;
let checks = 0;
function validate(schema: Schema) {
  return validator({ $schema: 'http://json-schema.org/draft-07/schema#', ...localize(schema), definitions } as ValidationSchema, { includeErrors: true, allowUnusedKeywords: true });
}
function rejects(schema: Schema, value: unknown): void {
  assert(!validate(schema)(value as Parameters<ReturnType<typeof validator>>[0]), 'Contract accepted a malformed control');
  checks++;
}
function conforms(schema: Schema, value: unknown): void {
  const valid = validate(schema);
  assert(valid(value as Parameters<typeof valid>[0]), JSON.stringify(valid.errors));
  checks++;
}
function schemaFor(path: string, method: string, status: number): Schema {
  const entry = spec.paths[path][method].responses[String(status)];
  assert(entry, `Undocumented response: ${method} ${path} ${status}`);
  const response = entry.$ref ? spec.components.responses[entry.$ref.split('/').at(-1)!] : entry;
  return response.content!['application/json'].schema;
}
const coverage = new Set<string>();
const success = new Set<string>();
async function request(base: string, path: string, method: string, status: number, body?: unknown,
  headers: Record<string, string> = {}, raw = false): Promise<Record<string, unknown>> {
  const op = spec.paths[path]?.[method.toLowerCase()];
  if (op && body !== undefined && !raw) conforms(op.requestBody!.content['application/json'].schema, body);
  const response = await fetch(base + path, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { body: raw ? String(body) : JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15_000) });
  assert.equal(response.status, status, `${method} ${path}: expected ${status}, got ${response.status}`);
  assert.match(response.headers.get('content-type') ?? '', /^application\/json/);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  const value = await response.json() as Record<string, unknown>;
  // A wrong-method probe is checked against the actual operation's 405 response.
  const documentedMethod = op ? method.toLowerCase() : Object.keys(spec.paths[path])[0];
  conforms(schemaFor(path, documentedMethod, status), value);
  if (op) {
    coverage.add(op.operationId);
    if (status === 200) success.add(op.operationId);
  }
  return value;
}

const root = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN + 'auth-openapi-'));
const releaseRoot = teardownPathOnSignal(root);
const home = join(root, 'home');
const space = 'authcontract';
const store = workspaceSecretStore(root);
const dir = userAuthStateDir(root, space);
const childEnv: NodeJS.ProcessEnv = { ...process.env };
for (const key of Object.keys(childEnv)) if (key.startsWith('COTAL_')) delete childEnv[key];
childEnv.COTAL_HOME = home;
let idpHandler: ReturnType<typeof toNodeHandler> | undefined;
const idp = createServer((req, res) => idpHandler!(req, res));
let broker: ReturnType<typeof spawn> | undefined;
let daemon: ReturnType<typeof spawn> | undefined;
let release: (() => void) | undefined;
let releaseDaemon: (() => void) | undefined;
try {
  await new Promise<void>(resolve => idp.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(idp.address() as AddressInfo).port}`;
  const baseIdp = origin + '/api/auth';
  const ba = betterAuth({ baseURL: origin, secret: 'private-openapi-smoke-idp-secret-0123456789',
    database: memoryAdapter({ user: [], session: [], account: [], verification: [], jwks: [] }),
    emailAndPassword: { enabled: true }, plugins: [jwt({ jwt: { issuer: origin, audience: origin } }), bearer()] });
  idpHandler = toNodeHandler(ba);
  const signup = await ba.api.signUpEmail({ body: { email: 'contract@example.test', password: 'private-fixture-password', name: 'Contract' } });
  assert(signup.token);
  const auth = await createSpaceAuth(space);
  saveSpaceAuth(authDir(root), auth);
  const prepared = await cotalAuthProvider.prepareServer({ store, space, operatorSeed: auth.operator.seed,
    account: { pub: auth.account.pub, signingSeed: auth.account.signingSeed }, dir, idpUrl: baseIdp });
  const brokerPort = await freePort();
  const server = `nats://127.0.0.1:${brokerPort}`;
  writeFileSync(join(root, 'server.conf'), serverConfig(auth, [auth], { transport: { kind: 'plaintext' }, port: brokerPort, storeDir: join(root, 'js'), extraAccounts: prepared.extraAccounts }));
  broker = spawn('nats-server', ['-c', join(root, 'server.conf')], { stdio: 'ignore' });
  release = teardownOnSignal(broker);
  for (let i = 0; !(await isReachable(server)); i++) { assert(i < 80, 'Private broker did not start'); await delay(100); }
  await setupSpaceStreams({ servers: server, space, creds: await mintCreds(auth, newIdentity(), 'provisioner') });
  const secret = await loadOwnerSecret(store, space);
  assert(secret);
  const owner = deriveOwnerForIdpSubject(secret, origin, signup.user.id);
  grantActor(dir, { owner, actor: 'cli', scope: ['spawn', 'supervise', 'admin'], allowSubscribe: ['>'], allowPublish: ['>'], label: 'private contract fixture' });
  const idpToken = await fetchIdpJwt(baseIdp, signup.token);
  async function start(enabled: boolean): Promise<string> {
    const port = await freePort();
    let errors = '';
    daemon = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), fileURLToPath(new URL('./openapi-server.ts', import.meta.url)), space, server, String(port), enabled ? 'enabled' : 'disabled'],
      { cwd: root, env: childEnv, stdio: ['ignore', 'ignore', 'pipe'] });
    releaseDaemon = teardownOnSignal(daemon);
    daemon.stderr!.on('data', (chunk: Buffer) => { errors += chunk.toString(); });
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; ; i++) {
      assert(i < 250 && daemon.exitCode === null, `Auth service did not start: ${errors}`);
      try { if ((await fetch(base + '/health')).ok) break; } catch { /* binding */ }
      await delay(100);
    }
    return base;
  }
  let base = await start(false);
  await request(base, '/health', 'GET', 200);
  const keys = await request(base, '/jwks', 'GET', 200);
  const keyResponse = await fetch(base + '/jwks');
  assert.equal(keyResponse.headers.get('cache-control'), 'max-age=300');
  await request(base, '/.well-known/cotal-mesh', 'GET', 200);
  for (const path of ['/health', '/jwks', '/.well-known/cotal-mesh']) await request(base, path, 'POST', 405);
  for (const path of ['/exchange', '/manager-service-authority', '/manager-instances', '/chat-session/open', '/chat-session/bearer', '/chat-session/retire']) {
    await request(base, path, 'GET', 405);
    await request(base, path, 'POST', 403, '{}', { origin: 'https://other.invalid' }, true);
    await request(base, path, 'POST', 415, '{}', { 'content-type': 'text/plain' }, true);
    await request(base, path, 'POST', 400, '{', {}, true);
    await request(base, path, 'POST', 413, ' '.repeat(65537), {}, true);
  }
  for (const path of ['/service-endpoint-authority', '/service-endpoint-host']) {
    await request(base, path, 'POST', 404, '{}', {}, true);
  }
  await request(base, '/service-endpoint-authority', 'GET', 404);
  for (const path of ['/interactive-lifecycle/retire', '/managed-lifecycle/retire', '/manager-service-authority/verify-enrollment', '/tool-result-human-proof/verify', '/tool-result-consent/issue', '/health?x=1', '/health/']) {
    const response = await fetch(base + path);
    assert.equal(response.status, 404);
    conforms(spec.components.schemas.Error, await response.json());
  }
  const minted = await request(base, '/exchange', 'POST', 200, { idpToken, actor: 'cli' });
  const claims = await jwtVerify(minted.token as string, createLocalJWKSet(keys as unknown as JSONWebKeySet));
  assert.equal(claims.payload.sub, owner);
  const { token: _token, ...missingToken } = minted;
  rejects(spec.components.schemas.Bearer, missingToken);
  rejects(spec.components.schemas.Bearer, { ...minted, exp: 'later' });
  const info = loadAuthServiceInfo(dir);
  assert(info);
  const localRefusal = await fetch(info.url + '/exchange', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idpToken, actor: 'cli' }) });
  assert.equal(localRefusal.status, 401, 'Loopback capability boundary must remain enforced');
  await request(base, '/exchange', 'POST', 401, { idpToken: 'invalid', actor: 'cli' });
  await request(base, '/exchange', 'POST', 403, JSON.stringify({ idpToken, actor: 'cli', view: 'admin' }), {}, true);
  const catalog = await request(base, '/manager-instances', 'POST', 200, { idpToken });
  assert.equal(catalog.owner, owner);
  assert.deepEqual(catalog.instances, []);
  rejects(spec.components.schemas.ManagerCatalog, { ...catalog, complete: false });
  await request(base, '/manager-instances', 'POST', 401, { idpToken: 'invalid' });
  const identities = Object.fromEntries(['supervisor', 'executor', 'serve', 'goalWriter', 'sessionLedger'].map(name => [name, { id: newIdentity().id }]));
  const authority = await request(base, '/manager-service-authority', 'POST', 200, { idpToken, request: {
    v: 1, kind: 'manager-service-authority', operation: 'prepare', space, actor: 'cli', instanceId: mintLifecycleUid(), managerLifecycleUid: mintLifecycleUid(), requestId: `req${mintLifecycleUid()}`, identities,
  } });
  assert((authority.credentials as Record<string, unknown>)?.supervisor, 'Manager prepare must return usable credential material');
  await request(base, '/manager-service-authority', 'POST', 403, { idpToken: 'invalid', request: { actor: 'cli' } });
  const unsupported = await request(base, '/manager-service-authority', 'POST', 403, { idpToken, request: { actor: 'cli', kind: 'manager-managed-agent-runtime-status' } });
  assert.match(String(unsupported.error), /host platform interception/);
  const holderProof = 'private-contract-holder-proof';
  const session = await request(base, '/chat-session/open', 'POST', 200, { idpToken, holderHash: createHash('sha256').update(holderProof).digest('hex'), read: ['general'], post: ['general'], ttlSec: 600 });
  const chatBearer = await request(base, '/chat-session/bearer', 'POST', 200, { idpToken, actor: session.actor, holderProof });
  await jwtVerify(chatBearer.token as string, createLocalJWKSet(keys as unknown as JSONWebKeySet));
  const rejected = await request(base, '/chat-session/bearer', 'POST', 403, { idpToken, actor: session.actor, holderProof: 'wrong-proof' });
  assert.equal(rejected.outcome, 'not-executed');
  const retired = await request(base, '/chat-session/retire', 'POST', 200, { idpToken, actor: session.actor, lifecycleUid: session.lifecycleUid, holderProof });
  if (retired.outcome === 'failed') {
    assert.equal(typeof retired.pending, 'string');
    assert(String(retired.pending).length > 0, 'Incomplete retirement must name its pending work');
    console.log('Chat retirement returned its documented failed/pending outcome; complete retirement is not exercised.');
  }

  await killAndAwaitExit(daemon!, 'SIGTERM');
  releaseDaemon?.();
  releaseDaemon = undefined;
  daemon = undefined;
  base = await start(true);
  await request(base, '/service-endpoint-authority', 'GET', 200);
  await request(base, '/service-endpoint-authority', 'GET', 403, undefined, { origin: 'https://other.invalid' });
  await request(base, '/service-endpoint-authority', 'DELETE', 405);
  await request(base, '/service-endpoint-authority', 'POST', 403, '{}', { origin: 'https://other.invalid' }, true);
  await request(base, '/service-endpoint-authority', 'POST', 415, '{}', { 'content-type': 'text/plain' }, true);
  await request(base, '/service-endpoint-authority', 'POST', 400, '{', {}, true);
  await request(base, '/service-endpoint-authority', 'POST', 413, ' '.repeat(2097153), {}, true);
  const nativeRequest = { v: 1, kind: 'service-endpoint-authority', operation: 'status', requestId: 'a'.repeat(32), space, accountPublicKey: auth.account.pub, endpoint: 'contract', instanceId: mintLifecycleUid(), target: { kind: 'instance' } };
  const denied = await request(base, '/service-endpoint-authority', 'POST', 401, { request: nativeRequest, proof: { kind: 'idp', token: 'invalid' } });
  assert.equal(denied.state, 'denied');
  assert.equal(denied.reason, 'unauthenticated');
  const { reason: _reason, ...missingReason } = denied;
  rejects(spec.components.schemas.ServiceResult, missingReason);
  const absent = await request(base, '/service-endpoint-authority', 'POST', 403, { request: nativeRequest, proof: { kind: 'idp', token: idpToken } });
  assert.equal(absent.reason, 'not-found');
  await request(base, '/service-endpoint-host', 'GET', 405);
  await request(base, '/service-endpoint-host', 'POST', 403, '{}', { origin: 'https://other.invalid' }, true);
  await request(base, '/service-endpoint-host', 'POST', 415, '{}', { 'content-type': 'text/plain' }, true);
  await request(base, '/service-endpoint-host', 'POST', 400, '{', {}, true);
  await request(base, '/service-endpoint-host', 'POST', 413, ' '.repeat(65537), {}, true);
  const host = { v: 1, kind: 'service-endpoint-host', requestId: 'b'.repeat(32), operation: 'name-read', input: { endpoint: 'contract' } };
  await request(base, '/service-endpoint-host', 'POST', 403, { idpToken: 'invalid', request: host });
  const read = await request(base, '/service-endpoint-host', 'POST', 200, { idpToken, request: host });
  assert.equal(read.state, 'absent');
  const unimplemented = await request(base, '/service-endpoint-host', 'POST', 200, { idpToken, request: { ...host, requestId: 'd'.repeat(32), operation: 'instance-read', input: { endpoint: 'contract', instanceId: nativeRequest.instanceId } } });
  assert.equal(unimplemented.state, 'denied');
  assert.equal(unimplemented.reason, 'unsupported');
  const operator = await request(base, '/service-endpoint-host', 'POST', 403, JSON.stringify({ idpToken, request: { v: 1, kind: 'service-endpoint-host', requestId: 'c'.repeat(32), operation: 'admission-open', input: {} } }), {}, true);
  assert.match(String(operator.error), /operator/);
  // Valid IdP proofs can still consume the refusal budget when native dispatch fails.
  let nativeThrottles = 0;
  for (let i = 0; i < 32; i++) {
    const response = await fetch(base + '/manager-service-authority', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idpToken, request: { actor: 'cli', kind: 'manager-managed-agent-runtime-status' } }),
      signal: AbortSignal.timeout(15_000),
    });
    assert([403, 429].includes(response.status), `Unexpected native refusal status: ${response.status}`);
    if (response.status === 429) nativeThrottles++;
    conforms(schemaFor('/manager-service-authority', 'post', response.status), await response.json());
  }
  assert(nativeThrottles > 0, 'Native dispatch failures after a valid proof must consume the public refusal budget');
  await request(base, '/exchange', 'POST', 200, { idpToken, actor: 'cli' });
  assert.equal(coverage.size, 12, 'Every documented operation must receive an actual HTTP request');
  console.log(`auth openapi smoke: ${checks} schema checks; ${coverage.size}/12 operations exercised; ${success.size}/12 success shapes exercised`);
  console.log('Not exercised: complete chat retirement; service authority successful registration/activation/renewal/ready and their native effect states; manager phases after prepare; admission saturation; deadline cutoff. Dedicated native suites own those paths.');
} finally {
  if (daemon) await killAndAwaitExit(daemon, 'SIGTERM');
  releaseDaemon?.();
  await new Promise<void>((resolve, reject) => idp.close(error => error ? reject(error) : resolve()));
  if (broker) await killAndAwaitExit(broker);
  rmSync(root, { recursive: true, force: true });
  release?.();
  releaseRoot();
}
emitSentinel({ passed: checks, failed: 0 });
