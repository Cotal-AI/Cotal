/**
 * `cotal daemon` service connection: live, red-first cells against a REAL stock auth service with
 * `serviceEndpoints` on, a real JWT-permission broker and the stock native service callout, in an
 * owned sandbox. The daemon is the shipped `serveDaemon`, reached over its real unix socket; it
 * connects with the stock renewal source (`AuthProvider.serviceEndpointRenewal`) and a real
 * `CotalEndpoint`, and reports the stock `ready` acceptance.
 *
 * Approval and name binding stay the fixture's: it plays the space operator and owner through the
 * stock host, as the register smoke does. That is fixture authority over a fixture space.
 *
 * Cells (each asserts counts):
 *  C1  connect before approval: `approval-pending`, never connected; no renewal record; the space
 *      reports no ready status;
 *  C2  after the owner's approval: `connected`, and the space independently reads this instance as
 *      `ready` through the stock door; status agrees offline; the renewal record is 0600;
 *  C3  two concurrent connects while connected share it: both connected, still one renewal record;
 *  C4  connect for a refused proposal: `refused`; for a space without service endpoints: not
 *      connected;
 *  C5  explicit disconnect: `disconnected`, and status agrees;
 *  C6  restart: a new daemon over the same machine home starts not connected, then reconnects under
 *      the same persisted activate and renew ids from its private store;
 *  C7  outage: with the authority door unreachable, a fresh connect is not `connected`; once the
 *      door is back it is `connected` again;
 *  C8  terminal: the owner revokes; the state becomes `ended approval-revoked`, never connected again;
 *  C9  daemon shutdown: the socket is gone and nothing answers;
 *  C10 no IdP session, JWT, access bearer or renewal proof in any frame or CLI output;
 *  C11 the CLI through the composition root, after C9's restart: `service-status` is not connected
 *      (state is per daemon process), `service-connect` for the revoked registration refuses and never
 *      connects, `service-connect` with no register request refuses TARGET_NOT_FOUND, and
 *      `service-disconnect` answers disconnected;
 *  C12 a connection held past two 60 s access-bearer lifetimes stays connected or connecting (never
 *      unavailable or ended), is connected for at least 80% of 1 s samples and at the end, and the
 *      space still reads it ready. The sample counts are printed, so each documented reconnect is visible;
 *  C13 broker loss while connected: with the broker stopped and unreachable, no 500 ms sample over
 *      8 s says connected (all say connecting); after the broker returns it is connected again and the
 *      space reads ready;
 *  C14 the SHIPPED binary (`node bin/dist/cotal.js daemon serve`) with its 0600 ready record corrupted:
 *      the connect answers unavailable with fixed text, status agrees (nothing left running), the
 *      process keeps running, and with the record restored the same daemon connects.
 *
 * Run: tsx bin/smoke/daemon-service-connect.smoke.ts   (Linux only; needs nats-server)
 */
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { connect as netConnect, type AddressInfo, type Socket } from "node:net";
import { mkdtempSync, chmodSync, mkdirSync, rmSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { peerCredentials } from "@cotal-ai/seat";
import {
  composeSpaceAuth, createBrokerAuth, createSpaceAccountAuth, isReachable, mintCreds, mintLifecycleUid, mkSecretDir, newIdentity, serverConfig, setupSpaceStreams,
  writeSecretFileAtomic, type SecretStore,
} from "@cotal-ai/core";
import {
  deriveOwnerForIdpSubject, ensureCalloutAuth, ensureIssuer, ensureOwnerSecret, ensurePinnedIdp, grantActor, loadOwnerSecret, saveIdpSession,
  saveServiceKeys, startAuthService, cotalAuthProvider, type AuthServiceHandle,
} from "@cotal-ai/auth";
import { recordMesh, userAuthStateDir, workspaceSecretStore, type MeshEntry } from "@cotal-ai/workspace";
import { freePort, killAndAwaitExit, skipSuite, teardownOnSignal, SMOKE_BROKER_TOKEN } from "@cotal-ai/smoke-kit";
import { daemonPaths } from "../daemon/endpoint.js";
import { serveDaemon } from "../daemon/server.js";

if (process.platform !== "linux") skipSuite(`daemon-service-connect smoke: Linux only; skipped on ${process.platform}`);
const scratchParent = process.env.COTAL_DAEMON_SMOKE_TMP ?? tmpdir();
// The CLI children get no mesh identity or connection material from whatever runs this suite.
for (const key of Object.keys(process.env)) if (key.startsWith("COTAL_")) delete process.env[key];

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const authRequire = createRequire(join(repo, "implementations", "auth", "package.json"));
// jose is a dependency of implementations/auth, not of this package; resolve it from its owner, as the
// daemon-login smoke resolves better-auth. Typed structurally for what this file uses.
type Jose = {
  generateKeyPair(alg: string): Promise<{ publicKey: CryptoKey; privateKey: CryptoKey }>;
  exportJWK(key: CryptoKey): Promise<Record<string, unknown>>;
  SignJWT: new (payload: Record<string, unknown>) => {
    setProtectedHeader(h: Record<string, unknown>): any; setIssuer(v: string): any; setAudience(v: string): any; setSubject(v: string): any;
    setIssuedAt(v: number): any; setExpirationTime(v: number): any; sign(k: CryptoKey): Promise<string>;
  };
};
const { SignJWT, exportJWK, generateKeyPair } = await import(pathToFileURL(authRequire.resolve("jose")).href) as Jose;
const peerUid = (s: Socket) => peerCredentials(s).uid;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL: ${name}`, JSON.stringify(extra ?? "")?.slice(0, 600)); }
};
async function cell(title: string, body: () => Promise<void>): Promise<void> {
  console.log(title);
  try { await body(); } catch (e) { fail++; console.log(`  ✗ FAIL: ${title} crashed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 600)); }
}
type Frame = Record<string, unknown>;
let seq = 0;
async function ask(socket: string, req: Frame, ms = 40_000): Promise<Frame> {
  const sock = netConnect(socket);
  await new Promise<void>((res, rej) => { sock.once("connect", () => res()); sock.once("error", rej); });
  const id = `g${++seq}`;
  sock.write(`${JSON.stringify({ v: 1, id, ...req })}\n`);
  sock.setEncoding("utf8");
  let buf = "";
  try {
    return await new Promise<Frame>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`no reply within ${ms}ms; got ${buf.slice(0, 300)}`)), ms);
      sock.on("data", (c: string) => { buf += c; const nl = buf.indexOf("\n"); if (nl !== -1) { clearTimeout(t); resolve(JSON.parse(buf.slice(0, nl)) as Frame); } });
      sock.once("error", (e) => { clearTimeout(t); reject(e); });
    });
  } finally { sock.destroy(); }
}
const resultOf = (f: Frame) => (f.result ?? {}) as Record<string, any>;
const errorOf = (f: Frame) => (f.error ?? {}) as Record<string, unknown>;

class MemoryStore implements SecretStore /* the auth services' stores; the daemon uses its own file store */ {
  readonly values = new Map<string, string>();
  constructor(readonly identity: { kind: "injected"; coordinate: string }) {}
  async get(k: string) { return this.values.get(k); }
  async put(k: string, v: string) { this.values.set(k, v); }
  async create(k: string, v: string) { if (this.values.has(k)) return false; this.values.set(k, v); return true; }
  async delete(k: string) { this.values.delete(k); }
}

// ---------- owned sandbox ----------
const root = mkdtempSync(join(scratchParent, "cdr-"));
chmodSync(root, 0o700);
const home = join(root, "home"), participant = join(root, "participant"), rtDir = join(root, "rt"), jsDir = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}a2b2-js-`));
for (const d of [home, participant, rtDir]) mkdirSync(d, { mode: 0o700 });
process.env.COTAL_HOME = home;
const paths = daemonPaths({ XDG_RUNTIME_DIR: rtDir });

// A loopback signed-JWT IdP: /jwks and /token (bearer = the session handle).
const key = await generateKeyPair("EdDSA");
const jwk = { ...await exportJWK(key.publicKey), kid: "a2b2-idp" };
const SESSION = "a2b2-session-handle-not-a-secret";
let idpOrigin = "";
const jwtsIssued: string[] = [];
/** R11: the IdP rejects the session handle, as for an expired or revoked session. */
let idpRevoked = false;
const idp = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
  res.setHeader("content-type", "application/json");
  if (req.url === "/api/auth/jwks") return void res.end(JSON.stringify({ keys: [jwk] }));
  if (req.url === "/api/auth/token" && idpRevoked) { res.writeHead(401); return void res.end("{}"); }
  if (req.url === "/api/auth/token" && (req.headers.authorization ?? "") === `Bearer ${SESSION}`) {
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({}).setProtectedHeader({ alg: "EdDSA", kid: jwk.kid }).setIssuer(idpOrigin).setAudience(idpOrigin).setSubject("machine-owner").setIssuedAt(now).setExpirationTime(now + 120).sign(key.privateKey);
    jwtsIssued.push(token);
    return void res.end(JSON.stringify({ token }));
  }
  res.writeHead(401); res.end("{}");
});
await new Promise<void>((r) => idp.listen(0, "127.0.0.1", () => r()));
idpOrigin = `http://127.0.0.1:${(idp.address() as AddressInfo).port}`;
const idpUrl = `${idpOrigin}/api/auth`;

// Count every request reaching each public face's authority route, through a counting relay.
const hits: Array<{ space: string; method: string; path: string }> = [];
/** C7: spaces whose authority door the relay drops, as an unreachable auth service. */
const relayDown = new Set<string>();
async function relay(space: string, target: string): Promise<string> {
  const s = createHttpServer(async (req, res) => {
    if (relayDown.has(space)) { req.socket.destroy(); return; }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    hits.push({ space, method: req.method ?? "", path: new URL(req.url!, "http://x").pathname });
    let up: Response;
    try { up = await fetch(`${target}${req.url}`, { method: req.method, headers: { "content-type": req.headers["content-type"] ?? "application/json" }, body: chunks.length ? Buffer.concat(chunks) : undefined, redirect: "manual" }); }
    catch { req.socket.destroy(); return; }
    const headers: Record<string, string> = {};
    up.headers.forEach((v, k) => { if (k !== "content-length" && k !== "transfer-encoding") headers[k] = v; });
    res.writeHead(up.status, headers);
    res.end(Buffer.from(await up.arrayBuffer()));
  });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  relays.push(s);
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}
const relays: ReturnType<typeof createHttpServer>[] = [];
const posts = (space: string) => hits.filter((h) => h.space === space && h.method !== "GET").length;

const broker = await createBrokerAuth("a2b2-broker");
const stamp = Date.now();
const spaces = ["on", "off", "deny"].map((s) => `a2b2-${s}-${stamp}`);
const accounts = await Promise.all(spaces.map((s) => createSpaceAccountAuth(broker, s)));
const handles: AuthServiceHandle[] = [];
let nats: ChildProcess | undefined, release: (() => void) | undefined;
const fixture = { owner: "" };

try {
  const ctx = await Promise.all(spaces.map(async (space, i) => {
    const auth = composeSpaceAuth(broker, accounts[i]!);
    const store = new MemoryStore({ kind: "injected", coordinate: `memory:${space}` });
    const callout = await ensureCalloutAuth(store, { space, operatorSeed: broker.operator.seed!, accountPub: auth.account.pub });
    await ensureIssuer(store, space); await ensureOwnerSecret(store, space);
    await saveServiceKeys(store, space, { dataAccount: { pub: auth.account.pub, signingSeed: auth.account.signingSeed! } });
    const stateDir = join(root, `state-${i}`); mkdirSync(stateDir, { mode: 0o700 });
    ensurePinnedIdp(stateDir, idpUrl);
    return { space, auth, store, stateDir, callout };
  }));
  const port = await freePort();
  const servers = `nats://127.0.0.1:${port}`;
  writeFileSync(join(root, "server.conf"), serverConfig(broker, accounts, { transport: { kind: "plaintext" }, port, storeDir: jsDir, extraAccounts: ctx.map((c) => ({ pub: c.callout.account.pub, jwt: c.callout.account.jwt })) }));
  nats = spawn("nats-server", ["-c", join(root, "server.conf")], { stdio: "ignore" });
  release = teardownOnSignal(nats, jsDir);
  for (let i = 0; i < 50 && !(await isReachable(servers)); i++) await sleep(200);
  for (const c of ctx) await setupSpaceStreams({ servers, space: c.space, creds: await mintCreds(c.auth, newIdentity(), "provisioner") });

  // The owner's interactive row, derived exactly as the stock service derives it.
  for (const c of ctx) {
    const owner = deriveOwnerForIdpSubject((await loadOwnerSecret(c.store, c.space))!, idpOrigin, "machine-owner");
    grantActor(c.stateDir, { owner, actor: "cli", scope: [], allowSubscribe: [], allowPublish: [] });
    if (c === ctx[0]) fixture.owner = owner;
  }
  const svc = await Promise.all(ctx.map((c, i) => startAuthService({ context: { accountPublicKey: c.auth.account.pub, lifecycleUid: mintLifecycleUid() }, space: c.space, servers,
    store: c.store, storeIdentity: c.store.identity, stateDir: c.stateDir, publicFace: { port: 0, trustedProxy: false },
    ...(i === 1 ? {} : { serviceEndpoints: { startup: { kind: "normal" as const } } }) })));
  handles.push(...svc);

  // The participant records each space from the bundle the real public face serves, behind a counting relay.
  for (const [i, c] of ctx.entries()) {
    const face = await relay(c.space, svc[i]!.publicUrl!.replace(/\/$/, ""));
    const bundle = await (await fetch(`${svc[i]!.publicUrl!.replace(/\/$/, "")}/.well-known/cotal-mesh`)).json() as { server: string; userAuth: MeshEntry["userAuth"]; sentinelCreds: string };
    const dir = userAuthStateDir(participant, c.space); mkSecretDir(dir);
    const sentinelCredsPath = join(dir, "sentinel.creds"); writeSecretFileAtomic(sentinelCredsPath, bundle.sentinelCreds);
    recordMesh({ space: c.space, server: bundle.server, root: participant, mode: "user", origin: "manual",
      userAuth: { ...bundle.userAuth!, endpoints: { ...bundle.userAuth!.endpoints, url: face }, remote: true, sentinelCredsPath }, ts: new Date().toISOString() });
  }
  saveIdpSession(home, idpUrl, { token: SESSION, expiresAt: Math.floor(Date.now() / 1000) + 3600, sub: "machine-owner" });

  const [ON, OFF, DENY] = spaces as [string, string, string];
  const host = svc[0]!.serviceEndpointHost!, denyHost = svc[2]!.serviceEndpointHost!;
  const operator = { kind: "operator", auditId: "a2b2-fixture-operator" } as const;
  const rid = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const regFile = (space: string) => readdirSync(join(home, "daemon"), { recursive: true }).map(String).find((p) => p.includes(".".concat(Buffer.from(space).toString("hex"))) && p.endsWith("register-request.json"));
  const regRecord = (space: string) => { const f = regFile(space); return f ? JSON.parse(readFileSync(join(home, "daemon", f), "utf8")) as Record<string, unknown> : undefined; };


  // ---- independent observations (the fixture's own stock clients, never the daemon's) ----
  const daemonDir = join(home, "daemon");
  const filesUnder = (dir: string) => existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String) : [];
  const identityOf = (space: string) => {
    const f = filesUnder(daemonDir).find((p) => p.includes(Buffer.from(space).toString("hex")) && p.endsWith("service-identity.json"));
    return f ? JSON.parse(readFileSync(join(daemonDir, f), "utf8")) as { instanceId: string; endpoint: string; accountPublicKey: string } : undefined;
  };
  /** The space's own view of this daemon's instance, read through the stock door with the owner's IdP proof. */
  const instanceStatus = async (space: string): Promise<string | undefined> => {
    const id = identityOf(space);
    if (!id) return undefined;
    const r = await cotalAuthProvider.serviceEndpointAuthority!({ store: workspaceSecretStore(participant), dir: userAuthStateDir(participant, space, { readOnly: true }),
      request: { v: 1, kind: "service-endpoint-authority", operation: "status", requestId: rid(), space, accountPublicKey: id.accountPublicKey, endpoint: id.endpoint,
        instanceId: id.instanceId, target: { kind: "instance" } } as never });
    return r.result.state === "status" ? r.result.status.state : `denied:${(r.result as { reason?: string }).reason}`;
  };
  const frames: string[] = [];
  const askLogged = async (req: Frame, ms?: number) => { const f = await ask(paths.socket, req, ms); frames.push(JSON.stringify(f)); return f; };
  const connectS = (space: string) => askLogged({ op: "service-connect", space }, 90_000);
  const statusS = (space: string) => askLogged({ op: "service-status", space });
  const disconnectS = (space: string) => askLogged({ op: "service-disconnect", space });
  const stateOf = (f: Frame) => resultOf(f).state as string | undefined;
  const waitState = async (space: string, want: (s: string | undefined) => boolean, ms = 60_000) => {
    const t0 = Date.now(); let last: string | undefined;
    while (Date.now() - t0 < ms) { last = stateOf(await statusS(space)); if (want(last)) return last; await sleep(500); }
    return last;
  };
  const approve = async (h: typeof host, space: string, owner: string) => {
    const bound = await h({ v: 1, kind: "service-endpoint-host", requestId: rid(), operation: "name-bind", granter: operator,
      input: { endpoint: "ai.cotal.machine", owner, expectedRevision: 0, claimReference: "connect-fixture-namespace" } } as never) as { state: string; binding?: { revision: number } };
    const reg = await ask(paths.socket, { op: "register", space });
    const pid = resultOf(reg).proposalId as string;
    const p = await h({ v: 1, kind: "service-endpoint-host", requestId: rid(), operation: "proposal-read", input: { proposalId: pid }, granter: operator } as never) as { record?: { revision: number } };
    const decided = await h({ v: 1, kind: "service-endpoint-host", requestId: rid(), operation: "decide", granter: { kind: "owner", owner },
      input: { proposalId: pid, expectedProposalRevision: p.record?.revision ?? 0, expectedNameRevision: bound.binding?.revision ?? 0, decision: "approve", callerCeiling: [] } } as never) as { state: string; approval?: { assignment: { assignmentDigest: string } } };
    return { bound, decided, pid };
  };

  let d = await serveDaemon({ paths, version: "0.0.0-smoke", peerUid, sessionDir: home } as Parameters<typeof serveDaemon>[0]);
  let assignmentDigest = "";
  try {
    await cell("C1 connect before approval is approval-pending, never connected", async () => {
      await ask(paths.socket, { op: "register", space: ON });
      const r = await connectS(ON);
      check("C1 approval-pending", r.ok === true && stateOf(r) === "approval-pending", r);
      check("C1 no renewal record written for this space", !filesUnder(daemonDir).some((p) => p.includes("service-renewal")), filesUnder(daemonDir));
      check("C1 the space reports no ready status", (await instanceStatus(ON)) !== "ready");
    });

    await cell("C2 after approval: connected only with a broker connection and the space's ready", async () => {
      const a = await approve(host, ON, fixture.owner);
      assignmentDigest = a.decided.approval?.assignment.assignmentDigest ?? "";
      check("C2 instrument: fixture operator bound and fixture owner approved through the stock host", a.bound.state === "bound" && a.decided.state === "approved", a);
      const r = await connectS(ON);
      const spaceSays = await instanceStatus(ON);
      check("C2 connected", r.ok === true && stateOf(r) === "connected", r);
      check("C2 the space independently reads this instance as ready", spaceSays === "ready", spaceSays);
      const s = await statusS(ON);
      check("C2 offline status agrees and names the witness instance", stateOf(s) === "connected" && resultOf(s).instanceId === identityOf(ON)?.instanceId, s);
      check("C2 the private renewal record exists, mode 0600 in a 0700 directory",
        filesUnder(daemonDir).filter((p) => p.includes("service-renewal") && p.endsWith(".json")).every((p) => (statSync(join(daemonDir, p)).mode & 0o777) === 0o600)
        && filesUnder(daemonDir).some((p) => p.includes("service-renewal")));
    });

    await cell("C3 a second connect shares the connection", async () => {
      const [x, y] = await Promise.all([connectS(ON), connectS(ON)]);
      check("C3 both connected", stateOf(x) === "connected" && stateOf(y) === "connected", { x, y });
      check("C3 still exactly one renewal record", filesUnder(daemonDir).filter((p) => p.includes("service-renewal") && p.endsWith(".json")).length === 1);
    });

    await cell("C4 a refused proposal is refused, never connected", async () => {
      const first = await ask(paths.socket, { op: "register", space: DENY });
      const pid = resultOf(first).proposalId;
      const owner = deriveOwnerForIdpSubject((await loadOwnerSecret(ctx[2]!.store, DENY))!, idpOrigin, "machine-owner");
      const p = await denyHost({ v: 1, kind: "service-endpoint-host", requestId: rid(), operation: "proposal-read", input: { proposalId: pid }, granter: operator } as never) as { record?: { revision: number } };
      await denyHost({ v: 1, kind: "service-endpoint-host", requestId: rid(), operation: "decide", granter: { kind: "owner", owner },
        input: { proposalId: pid, expectedProposalRevision: p.record?.revision ?? 0, expectedNameRevision: 0, decision: "refuse", callerCeiling: [] } } as never);
      const r = await connectS(DENY);
      check("C4 refused", stateOf(r) === "refused", r);
      const off = await connectS(OFF);
      check("C4 a space without service endpoints is not connected", stateOf(off) !== "connected" && stateOf(off) !== undefined, off);
    });

    await cell("C5 explicit disconnect", async () => {
      const r = await disconnectS(ON);
      check("C5 disconnected", stateOf(r) === "disconnected", r);
      check("C5 status agrees", stateOf(await statusS(ON)) === "disconnected");
    });

    await cell("C6 a restarted daemon reconnects from its private store under the same ids", async () => {
      const before = filesUnder(daemonDir).filter((p) => p.includes("service-renewal") && p.endsWith(".json")).map((p) => readFileSync(join(daemonDir, p), "utf8"));
      const ids0 = before.map((t) => { const o = JSON.parse(t) as Record<string, string>; return `${o.activateRequestId}/${o.renewRequestId}`; });
      await d.close();
      d = await serveDaemon({ paths, version: "0.0.0-smoke", peerUid, sessionDir: home } as Parameters<typeof serveDaemon>[0]);
      check("C6 a fresh daemon starts disconnected (no claim without a connection)", stateOf(await statusS(ON)) !== "connected");
      const r = await connectS(ON);
      const after = filesUnder(daemonDir).filter((p) => p.includes("service-renewal") && p.endsWith(".json")).map((p) => JSON.parse(readFileSync(join(daemonDir, p), "utf8")) as Record<string, string>);
      check("C6 connected again", stateOf(r) === "connected", r);
      check("C6 the same activate and renew ids", ids0.length === 1 && after.length === 1 && ids0[0] === `${after[0]!.activateRequestId}/${after[0]!.renewRequestId}`, { ids0, after: after.map((o) => `${o.activateRequestId}/${o.renewRequestId}`) });
    });

    await cell("C12 held past two access-bearer lifetimes: the space keeps it ready and connected returns after each reconnect", async () => {
      const samples: string[] = [];
      const t0 = Date.now();
      while (Date.now() - t0 < 130_000) { samples.push(String(stateOf(await statusS(ON)))); await sleep(1000); }
      const connected = samples.filter((s) => s === "connected").length, other = samples.filter((s) => s !== "connected" && s !== "connecting");
      console.log(`  C12 ${samples.length} samples: ${connected} connected, ${samples.length - connected - other.length} connecting, ${other.length} other`);
      check("C12 never unavailable or ended while the space stands; only connected or connecting", other.length === 0, other.slice(0, 5));
      check("C12 connected for most of the window and connected at the end", connected >= samples.length * 0.8 && samples.at(-1) === "connected", { connected, n: samples.length });
      check("C12 the space still reads the instance as ready", (await instanceStatus(ON)) === "ready");
    });

    await cell("C13 broker loss: connected is withdrawn at once and reclaimed only after the broker and a fresh ready", async () => {
      check("C13 instrument: connected before the broker stops", stateOf(await statusS(ON)) === "connected");
      await killAndAwaitExit(nats!, "SIGTERM");
      const during: string[] = [];
      let gone = false;
      try {
        gone = !(await isReachable(`nats://127.0.0.1:${port}`));
        const t0 = Date.now();
        while (Date.now() - t0 < 8000) { during.push(String(stateOf(await statusS(ON)))); await sleep(500); }
      } finally {
        // Later cells share this broker: bring it back whatever the checks above found.
        nats = spawn("nats-server", ["-c", join(root, "server.conf")], { stdio: "ignore" });
        for (let i = 0; i < 50 && !(await isReachable(`nats://127.0.0.1:${port}`)); i++) await sleep(200);
      }
      console.log(`  C13 broker down: ${during.length} samples, ${during.filter((s) => s === "connected").length} connected, states ${[...new Set(during)].join(",")}`);
      check("C13 instrument: the broker is unreachable", gone);
      check("C13 no sample after the broker stopped says connected", during.length >= 12 && during.every((s) => s !== "connected"), during);
      check("C13 the state is connecting while the broker is down (not ended)", during.every((s) => s === "connecting"), [...new Set(during)]);
      const back = await waitState(ON, (s) => s === "connected", 60_000);
      check("C13 after the broker returns, connected again and the space reads ready", back === "connected" && (await instanceStatus(ON)) === "ready", back);
    });

    await cell("C7 outage: not connected while the door is gone, connected again after", async () => {
      relayDown.add(ON);
      try {
        await disconnectS(ON);
        const r = await connectS(ON);
        check("C7 while the door is unreachable the state is not connected", stateOf(r) !== "connected" && ["unavailable", "connecting"].includes(String(stateOf(r))), r);
      } finally { relayDown.delete(ON); }
      const back = await connectS(ON);
      check("C7 once the door is back, connected again", stateOf(back) === "connected", back);
    });

    await cell("C14 the shipped daemon survives a corrupt ready record and leaves nothing running", async () => {
      // The shipped binary, as `cotal daemon serve` runs it: no handler of this suite in its process.
      await d.close();
      const child = spawn(process.execPath, [join(repo, "bin", "dist", "cotal.js"), "daemon", "serve"], {
        env: { PATH: process.env.PATH ?? "", HOME: home, XDG_RUNTIME_DIR: rtDir, COTAL_HOME: home, COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] });
      let childErr = ""; child.stderr!.on("data", (b) => { childErr += String(b); });
      const childExit = new Promise<number | null>((r) => child.once("exit", (code) => r(code)));
      try {
        for (let i = 0; i < 100 && !existsSync(paths.socket); i++) await sleep(100);
        const readyFiles = filesUnder(daemonDir).filter((p) => p.includes("daemon-ready") && p.endsWith(".json"));
        const target = readyFiles.length === 1 ? join(daemonDir, readyFiles[0]!) : "";
        const original = target ? readFileSync(target, "utf8") : "";
        if (target) writeFileSync(target, "not-json", { mode: 0o600 });
        let r: Frame = {}, s: Frame = {};
        try {
          r = await connectS(ON);
          s = await statusS(ON);
        } finally { if (target) writeFileSync(target, original, { mode: 0o600 }); }
        const exited = await Promise.race([childExit, sleep(5000).then(() => "running" as const)]);
        console.log(`  C14 frame ${String(stateOf(r))}, status ${String(stateOf(s))}, process ${String(exited)}`);
        check("C14 instrument: exactly one ready record was corrupted", readyFiles.length === 1, readyFiles);
        check("C14 the connect is not connected, with fixed text", stateOf(r) === "unavailable" && !String(resultOf(r).message).includes("not-json"), r);
        check("C14 status agrees: no live connection left behind", stateOf(s) === stateOf(r), { frame: stateOf(r), status: stateOf(s) });
        check("C14 the shipped daemon process is still running", exited === "running", { exited, err: childErr.split("\n").filter((x) => /Error|Unexpected/.test(x)).slice(0, 2) });
        const again = await connectS(ON);
        check("C14 with the record restored, the same daemon connects", stateOf(again) === "connected", again);
        check("C14 the daemon wrote nothing secret to stderr", ![SESSION, ...jwtsIssued].some((t) => childErr.includes(t)) && !/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./.test(childErr));
      } finally {
        if (child.exitCode === null) { child.kill("SIGTERM"); await childExit; }
      }
      d = await serveDaemon({ paths, version: "0.0.0-smoke", peerUid, sessionDir: home } as Parameters<typeof serveDaemon>[0]);
    });

    await cell("C8 the owner revokes: ended, never connected again", async () => {
      check("C8 instrument: connected before the revoke", stateOf(await connectS(ON)) === "connected");
      const id = identityOf(ON)!;
      const rv = await host({ v: 1, kind: "service-endpoint-host", requestId: rid(), operation: "revoke", granter: { kind: "owner", owner: fixture.owner },
        input: { endpoint: id.endpoint, instanceId: id.instanceId, expectedAssignmentDigest: assignmentDigest, cause: "owner-request" } } as never) as { state: string };
      check("C8 instrument: the fixture owner revoked through the stock host", rv.state !== "denied", rv);
      const st = await waitState(ON, (s) => s === "ended", 90_000);
      const s = await statusS(ON);
      check("C8 ended approval-revoked", st === "ended" && resultOf(s).reason === "approval-revoked", s);
      const again = await connectS(ON);
      check("C8 a later connect stays ended", stateOf(again) === "ended", again);
    });

    await cell("C9 daemon shutdown closes the connection and its socket", async () => {
      await d.close();
      check("C9 the daemon socket is gone after close", !existsSync(paths.socket));
      let refused = false;
      try { await ask(paths.socket, { op: "service-status", space: ON }, 2000); } catch { refused = true; }
      check("C9 nothing answers after shutdown", refused);
      d = await serveDaemon({ paths, version: "0.0.0-smoke", peerUid, sessionDir: home } as Parameters<typeof serveDaemon>[0]);
    });

    await cell("C11 the CLI through the composition root", async () => {
      const cli = async (...argv: string[]) => {
        const child = spawn(join(repo, "node_modules", ".bin", "tsx"), [join(repo, "bin", "cotal.ts"), "daemon", ...argv, "--json"], {
          cwd: root, env: { ...process.env, XDG_RUNTIME_DIR: rtDir, COTAL_HOME: home, COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "", err = "";
        child.stdout.on("data", (b) => { out += String(b); }); child.stderr.on("data", (b) => { err += String(b); });
        const status = await Promise.race([new Promise<number | null>((r) => child.once("exit", (c) => r(c))), sleep(90_000).then(() => { child.kill("SIGKILL"); return -1; })]);
        frames.push(out, err);
        let doc: Record<string, any> = {};
        try { doc = JSON.parse(out) as Record<string, any>; } catch { /* reported */ }
        return { status, doc, out };
      };
      const st = await cli("service-status", "--space", ON);
      check("C11 after a daemon restart `service-status` is not connected (state is per daemon process), exit 2", st.status === 2 && st.doc.error?.code === "TARGET_UNAVAILABLE" && st.doc.error?.cause?.code === "DISCONNECTED", { status: st.status, out: st.out.slice(0, 400) });
      const re = await cli("service-connect", "--space", ON);
      check("C11 `service-connect` for the revoked registration refuses (exit 2) and never connects", re.status === 2 && re.doc.outcome === "refused" && re.doc.result === null, { status: re.status, out: re.out.slice(0, 400) });
      const off = await cli("service-connect", "--space", OFF);
      check("C11 `service-connect` with no register request refuses TARGET_NOT_FOUND (exit 2)", off.status === 2 && off.doc.error?.code === "TARGET_NOT_FOUND" && off.doc.error?.cause?.code === "NOT_REQUESTED", { status: off.status, out: off.out.slice(0, 400) });
      const dis = await cli("service-disconnect", "--space", OFF);
      check("C11 `cotal daemon service-disconnect` answers disconnected (exit 0)", dis.status === 0 && dis.doc.result?.state === "disconnected", { status: dis.status, out: dis.out.slice(0, 400) });
    });

    await cell("C10 nothing secret crosses the endpoint or the CLI", async () => {
      const text = frames.join("\n");
      check("C10 no IdP session, JWT, access bearer or renewal proof in any frame", ![SESSION, ...jwtsIssued].some((s) => text.includes(s)) && !/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./.test(text) && !/accessBearer|renewalProof/.test(text), frames.length);
    });
  } finally { await d.close(); }
} catch (e) {
  fail++;
  console.error("  ✗ smoke crashed:", e instanceof Error ? (e.stack ?? e.message) : e);
} finally {
  for (const h of handles) await h.close().catch(() => {});
  for (const r of relays) r.close();
  idp.close();
  if (nats) await killAndAwaitExit(nats, "SIGTERM").catch(() => {});
  release?.();
  rmSync(jsDir, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nDAEMON SERVICE CONNECT SMOKE ${fail === 0 ? "OK" : "FAILED"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
