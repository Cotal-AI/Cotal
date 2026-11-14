/** Disposable real user-auth space for desktop service acceptance. No external account or model. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { composeSpaceAuth, createBrokerAuth, createSpaceAccountAuth, isReachable, mintCreds, mintLifecycleUid, mkSecretDir, newIdentity, serverConfig, setupSpaceStreams, globalConfigDir, mintMembershipObserverCreds, mintConnectionEvictorCreds } from '@cotal-ai/core';
import { deriveOwnerForIdpSubject, ensureCalloutAuth, ensureIssuer, ensureOwnerSecret, ensurePinnedIdp, grantActor, loadOwnerSecret, saveIdpSession, saveServiceKeys, startAuthService } from '@cotal-ai/auth';
import { recordMesh, userAuthStateDir, deliveryCredsKey, membershipRwCredsKey, membershipObserverCredsKey, connectionEvictorCredsKey } from '@cotal-ai/workspace';
import { startDeliveryService } from '@cotal-ai/delivery';
import { freePort, killAndAwaitExit, teardownOnSignal, SMOKE_BROKER_TOKEN } from '@cotal-ai/smoke-kit';

class MemoryStore {
  values = new Map();
  identity = { kind: 'injected', coordinate: 'desktop-upgrade-fixture' };
  async get(key) { return this.values.get(key); }
  async put(key, value) { this.values.set(key, value); }
  async create(key, value) { if (this.values.has(key)) return false; this.values.set(key, value); return true; }
  async delete(key) { this.values.delete(key); }
}
export async function createFixtureSpace({ root, machineHome, runtime, node, env }) {
  const space = 'desktop-upgrade-fixture';
  const participant = join(root, 'participant');
  const authState = join(root, 'authority');
  const storeDir = join(root, `${SMOKE_BROKER_TOKEN}desktop-upgrade`);
  for (const folder of [root, participant, authState, storeDir]) mkSecretDir(folder);
  const key = await generateKeyPair('EdDSA');
  const jwk = { ...await exportJWK(key.publicKey), kid: 'fixture' };
  const session = 'disposable-desktop-upgrade-session';
  let origin;
  const idp = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/auth/jwks') { res.end(JSON.stringify({ keys: [jwk] })); return; }
    if (req.url === '/api/auth/token' && req.headers.authorization === `Bearer ${session}`) {
      const token = await new SignJWT({ email: 'fixture@example.test' }).setProtectedHeader({ alg: 'EdDSA', kid: 'fixture' }).setIssuer(origin).setAudience(origin).setSubject('fixture-owner').setIssuedAt().setExpirationTime('1h').sign(key.privateKey);
      res.end(JSON.stringify({ token })); return;
    }
    res.writeHead(404); res.end('{}');
  });
  await new Promise(resolve => idp.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${idp.address().port}`;
  const idpUrl = `${origin}/api/auth`;
  const broker = await createBrokerAuth('desktop-upgrade');
  const account = await createSpaceAccountAuth(broker, space);
  const auth = composeSpaceAuth(broker, account);
  const store = new MemoryStore();
  const callout = await ensureCalloutAuth(store, { space, operatorSeed: broker.operator.seed, accountPub: auth.account.pub });
  await ensureIssuer(store, space); await ensureOwnerSecret(store, space);
  await saveServiceKeys(store, space, { dataAccount: { pub: auth.account.pub, signingSeed: auth.account.signingSeed } });
  ensurePinnedIdp(authState, idpUrl);
  const owner = deriveOwnerForIdpSubject(await loadOwnerSecret(store, space), origin, 'fixture-owner');
  grantActor(authState, { owner, actor: 'cli', scope: ['supervise', 'spawn', 'run', 'role:default'], allowSubscribe: ['>'], allowPublish: ['>'] });
  const port = await freePort();
  const servers = `nats://127.0.0.1:${port}`;
  const config = join(storeDir, 'server.conf');
  writeFileSync(config, serverConfig(broker, [account], { transport: { kind: 'plaintext' }, port, storeDir, maxPayload: 1024 * 1024, extraAccounts: [{ pub: callout.account.pub, jwt: callout.account.jwt }] }));
  const child = spawn(process.env.NATS_SERVER_BIN ?? 'nats-server', ['-c', config], { stdio: 'ignore', windowsHide: true });
  const release = teardownOnSignal(child, storeDir);
  let service, delivery;
  const close = async () => {
    await service?.close();
    await delivery?.close();
    await new Promise(resolve => idp.close(resolve));
    await killAndAwaitExit(child, 'SIGTERM');
    release();
  };
  try {
    for (let i = 0; i < 100 && !(await isReachable(servers)); i++) await delay(100);
    assert.ok(await isReachable(servers), 'Fixture broker must answer');
    await setupSpaceStreams({ servers, space, creds: await mintCreds(auth, newIdentity(), 'provisioner') });
    service = await startAuthService({ context: { accountPublicKey: auth.account.pub, lifecycleUid: mintLifecycleUid() }, space, servers, store, storeIdentity: store.identity, stateDir: authState, publicFace: { port: 0, trustedProxy: false } });
    const deliveryStore = new MemoryStore();
    deliveryStore.identity = { kind: 'injected', coordinate: 'desktop-upgrade-delivery' };
    const composition = { injected: true };
    await deliveryStore.put(deliveryCredsKey(space, composition), await mintCreds(auth, newIdentity(), 'delivery'));
    await deliveryStore.put(membershipRwCredsKey(space, composition), await mintCreds(auth, newIdentity(), 'membership-rw'));
    await deliveryStore.put(membershipObserverCredsKey(space, composition), await mintMembershipObserverCreds(auth, newIdentity()));
    await deliveryStore.put(connectionEvictorCredsKey(space, composition), await mintConnectionEvictorCreds(auth, newIdentity()));
    delivery = await startDeliveryService({ context: { accountPublicKey: auth.account.pub, lifecycleUid: mintLifecycleUid() }, space, servers, store: deliveryStore, storeIdentity: deliveryStore.identity, stateDir: join(root, 'delivery') });
    const discovery = await (await fetch(`${service.publicUrl.replace(/\/$/, '')}/.well-known/cotal-mesh`)).json();
    const state = userAuthStateDir(participant, space); mkSecretDir(state);
    const sentinel = join(state, 'sentinel.creds'); writeFileSync(sentinel, discovery.sentinelCreds, { mode: 0o600 });
    recordMesh({ space, server: servers, tlsRequired: false, policyCheckedAt: new Date(Date.now() + 3600_000).toISOString(), root: participant, mode: 'user', origin: 'manual', userAuth: { ...discovery.userAuth, remote: true, sentinelCredsPath: sentinel }, ts: new Date().toISOString() });
    saveIdpSession(machineHome, idpUrl, { token: session, expiresAt: Math.floor(Date.now() / 1000) + 3600, sub: 'fixture-owner' });
    const seed = join(globalConfigDir(), 'seed'); mkdirSync(seed, { recursive: true });
    const version = JSON.parse(readFileSync(join(runtime, 'package.json'), 'utf8')).version;
    for (const file of ['authority.json', 'authority.bak.json']) writeFileSync(join(seed, file), JSON.stringify({ everSeeded: ['claude', 'opencode', 'codex', 'hermes', 'jcode', 'pi', 'web'] }));
    writeFileSync(join(seed, 'witness.json'), JSON.stringify({ initialized: true, firstGeneration: version }));
    writeFileSync(join(seed, 'stamp.json'), JSON.stringify({ generation: version }));
    const cli = join(runtime, 'dist', 'cotal.js');
    const call = args => new Promise((resolve, reject) => execFile(node, [cli, ...args], { env, cwd: participant, timeout: 120_000, windowsHide: true }, (error, stdout, stderr) => error ? reject(new Error(stderr || stdout || error.message)) : resolve(JSON.parse(stdout))));
    return { space, participant, close, async startManager() {
      const { pathToFileURL } = await import('node:url');
      const { openVerified, readLine } = await import(pathToFileURL(join(runtime, 'dist', 'daemon', 'client.js')).href);
      const { daemonPaths } = await import(pathToFileURL(join(runtime, 'dist', 'daemon', 'endpoint.js')).href);
      const socket = await openVerified({ paths: daemonPaths() });
      try {
        const id = 'fixture-manager-start';
        const pending = readLine(socket, 110_000);
        socket.write(`${JSON.stringify({ v: 1, id, op: 'manager-start', space })}\n`);
        const reply = JSON.parse(await pending);
        assert.ok(reply.ok && reply.result.state === 'answering', JSON.stringify(reply));
        return reply.result;
      } finally { socket.destroy(); }
    }, call };
  } catch (error) { await close(); throw error; }
}
