/**
 * The auth callout derives one NaCl shared key per server xkey and keeps the `xkv1` wire bytes.
 *
 * `startAuthCallout` opens each request and seals each response with an X25519 box against the key
 * in the request's `Nats-Server-Xkey` header. It derives that box's shared key once per server key
 * and keeps at most `XKEY_SHARED_KEY_CAP` of them. The suite counts `nacl.box.before` (the scalar
 * multiplication nkeys' `seal` and `open` run on every call), `nacl.box.after` and
 * `nacl.box.open.after` on the one tweetnacl instance nkeys and the callout share, and drives the
 * shipped callout:
 *
 *  - one server key: requests sealed by nkeys' `seal` derive one key; every response opens with
 *    nkeys' `open`, answers its own request, and equals nkeys' `seal` of the same plaintext under the
 *    nonce it carries;
 *  - two callouts in one process, each with its own seed, and one server key: each derives its own
 *    key, answers every request, and seals nothing the other's key opens;
 *  - requests that fail admission after their header key was read are never kept: the same forged
 *    header derives again on every request;
 *  - the cache keeps `XKEY_SHARED_KEY_CAP` server keys and drops the least recently admitted;
 *  - live, on a real nats-server: connects derive one key, and after a broker restart on the same port
 *    the new server key derives once more and connects still succeed.
 *
 * Run: pnpm smoke:callout-xkey   (needs nats-server on PATH)
 */
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator, tokenAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import { Algorithms, decode, encode } from "@nats-io/jwt";
import { createCurve, createServer, createUser, fromCurveSeed, type KeyPair } from "@nats-io/nkeys";
import nacl from "tweetnacl";
import { SignJWT, generateKeyPair } from "jose";
import { createSpaceAuth, isReachable, serverConfig } from "@cotal-ai/core";
import { createCalloutAuth, deriveOwnerToken, startAuthCallout, USER_TOKEN_VER, type CalloutAuth, type CalloutConnection, type CalloutMsg } from "../src/index.js";
import { XKEY_SHARED_KEY_CAP } from "../src/callout.js";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, createSuite, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";

const { check, finish } = createSuite();
const enc = (s: string) => new TextEncoder().encode(s);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const HEADER = "Nats-Server-Xkey";

// ---- count the box steps on the tweetnacl instance the callout and nkeys both load ----
const nkeysNacl = createRequire(createRequire(import.meta.url).resolve("@nats-io/nkeys"))("tweetnacl") as typeof nacl;
check("the callout and nkeys load one tweetnacl instance, so the counts below see every derivation", nkeysNacl === nacl);
const count = { before: 0, after: 0, openAfter: 0 };
const { before, after } = nacl.box;
const openAfter = nacl.box.open.after;
nacl.box.before = (publicKey, secretKey) => { count.before++; return before(publicKey, secretKey); };
nacl.box.after = (msg, nonce, key) => { count.after++; return after(msg, nonce, key); };
nacl.box.open.after = (box, nonce, key) => { count.openAfter++; return openAfter(box, nonce, key); };
/** The box steps `f` ran. Requests are built and replies checked outside it: nkeys' own `seal` and
 *  `open` run `box.before` too. */
async function counted(f: () => Promise<unknown>): Promise<typeof count> {
  const start = { ...count };
  await f();
  return { before: count.before - start.before, after: count.after - start.after, openAfter: count.openAfter - start.openAfter };
}

// ---- fake-connection fixtures: the request a nats-server would seal ----
const space = `xkey-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const calloutA = await createCalloutAuth({ space, operatorSeed: auth.operator.seed, accountPub: auth.account.pub });
const calloutB = await createCalloutAuth({ space, operatorSeed: auth.operator.seed, accountPub: auth.account.pub });

interface Server { kp: KeyPair; id: string; curve: KeyPair; xkey: string }
const newServer = (): Server => {
  const kp = createServer(), curve = createCurve();
  return { kp, id: kp.getPublicKey(), curve, xkey: curve.getPublicKey() };
};
interface Req { user: string; data: Uint8Array; header: string; replies: Uint8Array[] }
/** A request from `server` sealed to `to`. Overrides bend one property for the forged cases. */
async function request(server: Server, to: CalloutAuth, o: { sealer?: KeyPair; header?: string; sealTo?: string } = {}): Promise<Req> {
  const user = createUser().getPublicKey();
  const claim = {
    aud: to.xkey.pub,
    sub: "nats_user_auth_request",
    nats: {
      user_nkey: user,
      server_id: { name: "n", host: "127.0.0.1", id: server.id, xkey: server.xkey },
      connect_opts: { auth_token: "not.a.bearer", name: user },
      client_info: { id: 1 },
      type: "authorization_request",
      version: 2,
    },
  } as never;
  const jwt = await encode(Algorithms.v2, claim, server.kp);
  return { user, data: (o.sealer ?? server.curve).seal(enc(jwt), o.sealTo ?? to.xkey.pub), header: o.header ?? server.xkey, replies: [] };
}
const asMsg = (r: Req): CalloutMsg => ({
  data: r.data,
  headers: { get: (k) => (k === HEADER ? r.header : undefined) },
  respond: (d) => { r.replies.push(d); },
});
/** Run the shipped callout over `reqs` in order until it has answered everything it admitted.
 *  `marks[i]` is the derivation count before request i was read; the last mark follows the last. */
function serve(callout: CalloutAuth, reqs: Req[], o: { expectedServerIds?: string[]; log?: string[]; marks?: number[] } = {}): Promise<void> {
  const conn: CalloutConnection = {
    async *subscribe() {
      for (const r of reqs) { o.marks?.push(count.before); yield asMsg(r); }
      o.marks?.push(count.before);
    },
  };
  return startAuthCallout(conn, {
    xkeySeed: callout.xkey.seed,
    authAccount: { pub: callout.account.pub, signingSeed: callout.account.signingSeed },
    dataAccount: { pub: auth.account.pub, signingSeed: auth.account.signingSeed },
    space,
    token: { key: {} as never, issuer: "https://auth.test" },
    ...(o.expectedServerIds ? { expectedServerIds: o.expectedServerIds } : {}),
    recordIssuance: async () => {},
    authorizeActor: () => {},
    permissionsFor: () => ({}),
    log: (line) => o.log?.push(line),
  }).done;
}
const curveOf = (callout: CalloutAuth) => fromCurveSeed(enc(callout.xkey.seed));
/** The reply opened with nkeys' own `open`, as the server that sent `r` would. */
const opened = (r: Req, server: Server, callout: CalloutAuth): Uint8Array | null => (r.replies.length === 1 ? server.curve.open(r.replies[0], callout.xkey.pub) : null);
/** The reply answers its own request: the response JWT is addressed to the request's user key. */
const answersItself = (r: Req, server: Server, callout: CalloutAuth): boolean => {
  const plain = opened(r, server, callout);
  return !!plain && (decode(new TextDecoder().decode(plain)) as { sub?: string }).sub === r.user;
};
/** The reply is byte for byte nkeys' `seal` of its own plaintext under the nonce it carries. */
const sameAsNkeysSeal = (r: Req, server: Server, callout: CalloutAuth): boolean => {
  const plain = opened(r, server, callout);
  if (!plain) return false;
  const reply = r.replies[0];
  return Buffer.from(curveOf(callout).seal(plain, server.xkey, reply.subarray(4, 28))).equals(Buffer.from(reply));
};

// ---- one server key ----
{
  const server = newServer();
  const reqs = await Promise.all(Array.from({ length: 8 }, () => request(server, calloutA)));
  const n = await counted(() => serve(calloutA, reqs));
  check("8 requests from one server key derive its shared key once, and open and seal all 8 under it",
    n.before === 1 && n.openAfter === 8 && n.after === 8, n);
  check("every response opens with nkeys' own open and answers its own request", reqs.every((r) => answersItself(r, server, calloutA)));
  check("every response equals nkeys' seal of the same plaintext under the nonce it carries", reqs.every((r) => sameAsNkeysSeal(r, server, calloutA)));
}

// ---- two callouts in one process, one server key ----
{
  const server = newServer();
  const toA = await Promise.all(Array.from({ length: 6 }, () => request(server, calloutA)));
  const toB = await Promise.all(Array.from({ length: 6 }, () => request(server, calloutB)));
  const n = await counted(() => Promise.all([serve(calloutA, toA), serve(calloutB, toB)]));
  check("two callouts with their own seeds and one server key derive one key each", n.before === 2 && n.openAfter === 12 && n.after === 12, n);
  check("each callout answers every request sent to it", toA.every((r) => answersItself(r, server, calloutA)) && toB.every((r) => answersItself(r, server, calloutB)));
  check("neither callout seals a response the other's key opens",
    toA.every((r) => opened(r, server, calloutB) === null) && toB.every((r) => opened(r, server, calloutA) === null));
}

// ---- requests that fail admission keep nothing ----
{
  const server = newServer(), forger = createCurve(), stranger = newServer();
  const log: string[] = [];
  const twice = async (f: () => Promise<Req>) => [await f(), await f()];
  // A real header key whose box was sealed for someone else; a box sealed and named by a forger's
  // key while the signed request names the server's; a consistent request from an untrusted server.
  const unopenable = await twice(() => request(server, calloutA, { sealTo: calloutB.xkey.pub }));
  const resealed = await twice(() => request(server, calloutA, { sealer: forger, header: forger.getPublicKey() }));
  const untrusted = await twice(() => request(stranger, calloutA));
  const genuine = await twice(() => request(server, calloutA));
  const forged = [...unopenable, ...resealed, ...untrusted];
  const n = await counted(() => serve(calloutA, [...forged, ...genuine], { expectedServerIds: [server.id], log }));
  check("each forged request is dropped at its own check, with no response",
    forged.every((r) => r.replies.length === 0) &&
    log.filter((l) => l.startsWith("auth callout: dropped an undecryptable/unverifiable request")).length === 2 &&
    log.filter((l) => l === "auth callout: dropped a request whose signed server_id.xkey != sealing header key").length === 2 &&
    log.filter((l) => l === `auth callout: dropped a request from an untrusted server id ${stranger.id}`).length === 2, log);
  check("a forged header is never kept: each repeat derives again, and the genuine key derives once after them",
    n.before === forged.length + 1 && genuine.every((r) => answersItself(r, server, calloutA)), n);
}

// ---- the bound ----
{
  const servers = Array.from({ length: XKEY_SHARED_KEY_CAP + 1 }, newServer);
  const last = servers.length - 1;
  // Every server once, then the newest again, the oldest again, the third, the second.
  const order = [...servers.keys(), last, 0, 2, 1];
  const reqs = await Promise.all(order.map((i) => request(servers[i], calloutA)));
  const marks: number[] = [];
  await serve(calloutA, reqs, { marks });
  const derived = order.map((_, i) => marks[i + 1] - marks[i]);
  check(`the cap is ${XKEY_SHARED_KEY_CAP} server keys`, XKEY_SHARED_KEY_CAP === 64);
  check(`${XKEY_SHARED_KEY_CAP + 1} new server keys derive once each`, derived.slice(0, servers.length).every((d) => d === 1), derived);
  check("past the cap the least recently admitted key is dropped: the newest still hits, the oldest derives again and drops the second oldest, the third still hits",
    JSON.stringify(derived.slice(servers.length)) === JSON.stringify([0, 1, 0, 1]), derived.slice(servers.length));
  check("every request past the cap is still answered", reqs.every((r, i) => answersItself(r, servers[order[i]], calloutA)));
}

// ---- live: a real nats-server, then a restart that brings a new server key ----
const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const live = await createCalloutAuth({ space, operatorSeed: auth.operator.seed, accountPub: auth.account.pub });
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const conf = join(dir, "server.conf");
writeFileSync(conf, serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js"), extraAccounts: [{ pub: live.account.pub, jwt: live.account.jwt }] }));
let srv: ChildProcess = spawn("nats-server", ["-c", conf], { stdio: "ignore" });
let releaseBroker = teardownOnSignal(srv, dir);
const conns: NatsConnection[] = [];
let calloutNc: NatsConnection | undefined;
const up = async () => {
  for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS)) return; await wait(200); }
  throw new Error(`nats-server did not come up on ${PORT}`);
};

const { publicKey, privateKey } = await generateKeyPair("EdDSA");
const ISS = "https://auth.cotal.test";
const owner = deriveOwnerToken("s".repeat(32), "better-auth|xkey");
const bearer = async () => {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ sub: owner, scope: ["chat"], ver: USER_TOKEN_VER, act: { owner, actor: "agent_1" } })
    .setProtectedHeader({ alg: "EdDSA" }).setIssuer(ISS).setAudience(space)
    .setIssuedAt(now - 60).setNotBefore(now - 60).setExpirationTime(now + 300).sign(privateKey);
};
/** Connect K clients one after another through the callout; each closes once it is in. */
async function connects(k: number): Promise<number> {
  let ok = 0;
  for (let i = 0; i < k; i++) {
    const nonce = `ibx${randomUUID().replace(/-/g, "")}`;
    try {
      const nc = await connect({ servers: SERVERS, maxReconnectAttempts: 0, timeout: 4000, name: nonce, inboxPrefix: `_INBOX_${nonce}`,
        authenticator: [credsAuthenticator(enc(live.sentinelCreds)), tokenAuthenticator(await bearer())] });
      conns.push(nc);
      ok++;
      await nc.close();
    } catch { /* counted by ok */ }
  }
  return ok;
}

try {
  await up();
  const nc = await connect({ servers: SERVERS, authenticator: credsAuthenticator(enc(live.calloutCreds)), reconnectTimeWait: 250, maxReconnectAttempts: -1 });
  calloutNc = nc;
  // The server keys the requests arrive under, read off the real connection the callout serves on.
  const headers = new Set<string>();
  const recorded: CalloutConnection = {
    subscribe: (subject, opts) => (async function* () {
      for await (const m of nc.subscribe(subject, opts)) { headers.add(m.headers?.get(HEADER) ?? ""); yield m; }
    })(),
  };
  startAuthCallout(recorded, {
    xkeySeed: live.xkey.seed,
    authAccount: { pub: live.account.pub, signingSeed: live.account.signingSeed },
    dataAccount: { pub: auth.account.pub, signingSeed: auth.account.signingSeed },
    space,
    token: { key: publicKey, issuer: ISS },
    recordIssuance: async () => {},
    authorizeActor: () => {},
    permissionsFor: (_t, connId) => ({ pub: { allow: [`_INBOX_${connId}.>`] }, sub: { allow: [`_INBOX_${connId}.>`] } }),
    log: () => {},
  });
  await nc.flush();

  const K = 6;
  let ok = 0;
  const first = await counted(async () => { ok = await connects(K); });
  check(`${K} live connects through one nats-server succeed and derive its shared key once`, ok === K && first.before === 1 && first.openAfter === K && first.after === K, { ok, ...first });
  check("one nats-server process seals every request under one xkey", headers.size === 1 && !headers.has(""), [...headers]);

  // Restart the broker on the same port: a new process, so a new server xkey.
  const reconnected = (async () => { for await (const s of nc.status()) if (s.type === "reconnect") return; })();
  await killAndAwaitExit(srv, "SIGTERM");
  releaseBroker();
  srv = spawn("nats-server", ["-c", conf], { stdio: "ignore" });
  releaseBroker = teardownOnSignal(srv, dir);
  await up();
  await Promise.race([reconnected, wait(15_000).then(() => { throw new Error("the callout connection did not reconnect after the broker restart"); })]);
  await nc.flush();
  const second = await counted(async () => { ok = await connects(K); });
  check(`after a broker restart, ${K} live connects succeed and the new server key derives once more`, ok === K && second.before === 1 && second.openAfter === K && second.after === K, { ok, ...second });
  check("the restarted nats-server seals under a new xkey", headers.size === 2 && !headers.has(""), [...headers]);
} catch (e) {
  check(`live cells ran (${e instanceof Error ? e.message : String(e)})`, false);
} finally {
  for (const c of conns) await c.close().catch(() => {});
  await calloutNc?.close().catch(() => {});
  await killAndAwaitExit(srv, "SIGKILL");
  rmSync(dir, { recursive: true, force: true });
  releaseBroker();
}

finish();
process.exit(process.exitCode ?? 0);
