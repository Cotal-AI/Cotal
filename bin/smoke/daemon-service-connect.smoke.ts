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
 *  C0  a space without a register request reports not-requested before and after a refused connect,
 *      an explicit disconnect and a daemon restart, through the socket and CLI, without space calls;
 *  C1  register and connect before approval: `approval-pending`, never connected; no renewal record; the space
 *      reports no ready status;
 *  C2  after the owner's approval: `connected`, and the space independently reads this instance as
 *      `ready` through the stock door; status agrees offline; the renewal record is 0600;
 *  C3  two concurrent connects while connected share it: both connected, still one renewal record;
 *      registration replay does not replace the live connection state;
 *  C4  connect for a refused proposal: `refused`; for a space without service endpoints: not
 *      connected;
 *  C5  explicit disconnect: `disconnected`, status agrees, and the recorded connect intent is gone,
 *      so the disconnect outlives a restart;
 *  C6  restart resumes by itself: a connected space records its intent 0600; a new daemon over the
 *      same machine home reaches `connected` with nothing run against it, reports exactly 1 resumed
 *      connection, and reuses the same persisted activate and renew ids. After an explicit
 *      disconnect a restart resumes nothing;
 *  C6b shipped startup with authority or broker unavailable retries recorded intent, keeps the
 *      dependency refusal visible during a held retry, retries broker loss during ready, serves
 *      after recovery, and cancels pending retries on disconnect and shutdown;
 *  C7  outage: with the authority door unreachable, a fresh connect is not `connected`; once the
 *      door is back it is `connected` again;
 *  C7b a changed authority account stays account-mismatch in the socket, CLI and offline status,
 *      with no POST or changed identity or request; restoring the account reconnects;
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
 *  C13 (runs last, on its own space) broker loss while connected: the daemon's own broker path for
 *      this space (a TCP pass-through the suite cuts) is unreachable while the space's auth service
 *      keeps its broker; no 500 ms sample over 8 s says connected (all say connecting); after the
 *      path returns it is connected again, which needs a fresh ready, and the space reads ready;
 *  C14 the SHIPPED binary starts with a damaged ready or renewal record: resume and the real CLI
 *      identify local state, the damaged bytes stay private and unchanged, no responder is left, and
 *      restoring the original record recovers serving under the same request ids.
 *
 * Run: tsx bin/smoke/daemon-service-connect.smoke.ts   (Linux only; needs nats-server)
 * Account pin regression only: add --account-mismatch-only (C1, C2, C7b and C10).
 * Offline status regression only: add --status-only (C0, C1, C2, C3, C5, C6, C10 and C15).
 * Add --setup-hints-only to run approval and setup follow-up checks with a leading-hyphen space.
 * Setup progress regression only: add --setup-progress-only (uses the shipped foreground daemon).
 */
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { connect as netConnect, createServer as createNetServer, type AddressInfo, type Server as NetServer, type Socket } from "node:net";
import { mkdtempSync, chmodSync, mkdirSync, rmSync, existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { peerCredentials } from "@cotal-ai/seat";
import { connect as connectNats } from "@nats-io/transport-node";
import {
  CotalEndpoint, EpEnvelopeError, SERVICE_AUTHORITY_MAX_BYTES, VOID_SCHEMA, compileContract, epCall, unansweredRequest, composeSpaceAuth, createBrokerAuth, createSpaceAccountAuth, isReachable, mintCreds, mintLifecycleUid, mkSecretDir, newIdentity, serverConfig, setupSpaceStreams,
  standaloneConnectOpts, issuedUserCaller, resolveService, invokeCommand,
  writeSecretFileAtomic, mintMembershipObserverCreds, mintConnectionEvictorCreds, type SecretStore,
} from "@cotal-ai/core";
import {
  deleteIdpSession, deriveOwnerForIdpSubject, ensureCalloutAuth, ensureIssuer, ensureOwnerSecret, ensurePinnedIdp, grantActor, loadOwnerSecret, saveIdpSession,
  saveServiceKeys, startAuthService, cotalAuthProvider, mintServiceCallerPayloadObserverCreds, type AuthServiceHandle,
} from "@cotal-ai/auth";
import { connectionEvictorCredsKey, deliveryCredsKey, membershipObserverCredsKey, membershipRwCredsKey, findMesh, removeMesh, recordMesh, resolveControlTarget, spaceSegment, userAuthStateDir, workspaceSecretStore, type MeshEntry } from "@cotal-ai/workspace";
import { askManager } from "@cotal-ai/workspace/control";
import { startDeliveryService } from "@cotal-ai/delivery";
import { freePort, killAndAwaitExit, skipSuite, teardownOnSignal, SMOKE_BROKER_TOKEN } from "@cotal-ai/smoke-kit";
import { daemonPaths, daemonPathsFor } from "../daemon/endpoint.js";
import { daemonConnectIntentFile } from "../daemon/service.js";
import { runSetup } from "../daemon/setup.js";
import { serveDaemon } from "../daemon/server.js";
import { unitReceiptFile } from "../daemon/install.js";

if (process.platform !== "linux") skipSuite(`daemon-service-connect smoke: Linux only; skipped on ${process.platform}`);
const scratchParent = process.env.COTAL_DAEMON_SMOKE_TMP ?? tmpdir();
const upgradeFixture = process.env.COTAL_DAEMON_UPGRADE_FIXTURE;
const upgrading = ["--upgrade-repro", "--update-repro", "--setup-upgrade-repro"].some((flag) => process.argv.includes(flag));
const setupHintsOnly = process.argv.includes("--setup-hints-only");
const originalPath = process.env.PATH;
const setupProgressOnly = process.argv.includes("--setup-progress-only");
// The CLI children get no mesh identity or connection material from whatever runs this suite.
for (const key of Object.keys(process.env)) if (key.startsWith("COTAL_")) delete process.env[key];

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const fixtureVersion = (JSON.parse(readFileSync(join(repo, "bin/package.json"), "utf8")) as { version: string }).version;
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
const peerPid = (s: Socket) => peerCredentials(s).pid;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL: ${name}`, JSON.stringify(extra ?? "")?.slice(0, 600)); }
};
async function cell(title: string, body: () => Promise<void>): Promise<void> {
  if (setupProgressOnly && !/^(C1 |C1b |C2 |C4 |C17 |C17b |C10 )/.test(title)) return;
  if (process.argv.includes("--hosting-only") && !title.startsWith("H1")) return;
  if (process.argv.includes("--account-mismatch-only") && !/^(C1 |C2 |C7b |C10 )/.test(title)) return;
  if (process.argv.includes("--status-only") && !/^C(0|1|2|3|5|6|10|15) /.test(title)) return;
  if (process.argv.includes("--service-only") && title.startsWith("H1")) return;
  if (process.argv.includes("--resume-only") && !/^(C1 |C2 |C15 |C6b )/.test(title)) return;
  if (setupHintsOnly && !["C1 ", "C2 ", "C17 "].some((prefix) => title.startsWith(prefix))) return;
  if (process.argv.includes("--setup-session-only") && !title.startsWith("H2")) return;
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
if (setupProgressOnly) {
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = join(root, "config");
  process.env.XDG_RUNTIME_DIR = rtDir;
  process.env.XDG_DATA_HOME = join(root, "data");
  process.env.XDG_CACHE_HOME = join(root, "cache");
}
const explicitHome = process.argv.includes("--explicit-home-repro") ? join(root, "explicit-daemon") : undefined;
const paths = explicitHome ? daemonPathsFor(explicitHome, { XDG_RUNTIME_DIR: rtDir }) : daemonPaths({ XDG_RUNTIME_DIR: rtDir });

// A loopback signed-JWT IdP: /jwks and /token (bearer = the session handle).
const key = await generateKeyPair("EdDSA");
const jwk = { ...await exportJWK(key.publicKey), kid: "a2b2-idp" };
const SESSION = "a2b2-session-handle-not-a-secret";
let idpOrigin = "";
let catalog: unknown;
let catalogSpace: string | undefined;
let catalogTarget: string | undefined;
const jwtsIssued: string[] = [];
/** R11: the IdP rejects the session handle, as for an expired or revoked session. */
let idpRevoked = false;
let tokenFailure: "unreachable" | "unusable" | undefined;
let recoverOnApproval = false;
let deviceCodeRequests = 0;
let deviceFailure: "denied" | "expired" | "unreachable" | undefined;
let catalogUnavailable = false;
let catalogAuthorityDown = false;
let standingRenewals = 0;
let catalogAuthorityRequests = 0;
const idp = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
  res.setHeader("content-type", "application/json");
  if (req.url === "/api/auth/device/code") { deviceCodeRequests++; if (deviceFailure === "unreachable") { req.socket.destroy(); return; } return void res.end(JSON.stringify({ device_code: "daemon-smoke-device", user_code: "DAEMON", verification_uri: `${idpOrigin}/approve`, verification_uri_complete: `${idpOrigin}/approve?code=DAEMON`, expires_in: 60, interval: 1 })); }
  if (req.url === "/api/auth/device/token" && deviceFailure) { res.writeHead(400); return void res.end(JSON.stringify({ error: deviceFailure === "denied" ? "access_denied" : "expired_token" })); }
  if (req.url === "/api/auth/device/token") {
    if (recoverOnApproval) idpRevoked = false;
    return void res.end(JSON.stringify({ access_token: SESSION, expires_in: 3600 }));
  }
  if (req.url === "/catalog" && catalogUnavailable) { res.writeHead(503); return void res.end("{}"); }
  if (req.url === "/catalog" && catalog) return void res.end(JSON.stringify(catalog));
  if (catalogSpace && catalogTarget && req.url?.startsWith(`/space/${catalogSpace}/`)) {
    catalogAuthorityRequests++;
    if (catalogAuthorityDown) { res.writeHead(503); res.end("{}"); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    if (Buffer.concat(chunks).toString().includes('"renewStandingBundle"')) standingRenewals++;
    const answer = await fetch(`${catalogTarget}${req.url.slice(`/space/${catalogSpace}`.length)}`, { method: req.method, headers: { "content-type": "application/json" }, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) });
    res.writeHead(answer.status);
    return void res.end(Buffer.from(await answer.arrayBuffer()));
  }
  if (req.url === "/api/auth/jwks") return void res.end(JSON.stringify({ keys: [jwk] }));
  if (req.url === "/api/auth/token" && tokenFailure === "unreachable") { req.socket.destroy(); return; }
  if (req.url === "/api/auth/token" && tokenFailure === "unusable") { res.writeHead(503); return void res.end("{}"); }
  if (req.url === "/api/auth/token" && idpRevoked) { res.writeHead(401); return void res.end("{}"); }
  if (req.url === "/api/auth/token" && (req.headers.authorization ?? "") === `Bearer ${SESSION}`) {
    if (catalog) res.setHeader("link", `<${idpOrigin}/catalog>; rel="https://cotal.ai/relations/space-catalog"`);
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
const changedAccount = new Map<string, string>();
const droppedAt = new Map<string, number[]>();
const authorityGates = new Map<string, () => Promise<void>>();
const readyGates = new Map<string, () => Promise<void>>();
const withoutIssuer = new Set<string>();
async function relay(space: string, target: string): Promise<string> {
  const s = createHttpServer(async (req, res) => {
    if (relayDown.has(space)) {
      const times = droppedAt.get(space) ?? []; times.push(Date.now()); droppedAt.set(space, times);
      req.socket.destroy(); return;
    }
    if (req.method === "GET" && req.url === "/service-endpoint-authority") await authorityGates.get(space)?.();
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    hits.push({ space, method: req.method ?? "", path: new URL(req.url!, "http://x").pathname });
    let up: Response;
    try { up = await fetch(`${target}${req.url}`, { method: req.method, headers: { "content-type": req.headers["content-type"] ?? "application/json" }, body: chunks.length ? Buffer.concat(chunks) : undefined, redirect: "manual" }); }
    catch { req.socket.destroy(); return; }
    const headers: Record<string, string> = {};
    up.headers.forEach((v, k) => { if (k !== "content-length" && k !== "transfer-encoding") headers[k] = v; });
    let body = Buffer.from(await up.arrayBuffer());
    if (changedAccount.has(space) && req.method === "GET" && req.url === "/service-endpoint-authority" && up.ok) {
      const info = JSON.parse(body.toString()) as Record<string, unknown>;
      info.accountPublicKey = changedAccount.get(space);
      body = Buffer.from(JSON.stringify(info));
    }
    if (req.method === "POST" && req.url === "/service-endpoint-authority" && JSON.parse(Buffer.concat(chunks).toString()).request?.operation === "ready") await readyGates.get(space)?.();
    if (withoutIssuer.has(space) && req.method === "GET" && req.url === "/service-endpoint-authority" && up.ok) {
      const info = JSON.parse(body.toString()) as Record<string, unknown>;
      delete info.issuer; delete info.keys;
      body = Buffer.from(JSON.stringify(info));
    }
    res.writeHead(up.status, headers);
    res.end(body);
  });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  relays.push(s);
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}
const relays: ReturnType<typeof createHttpServer>[] = [];
const posts = (space: string) => hits.filter((h) => h.space === space && h.method !== "GET").length;

const broker = await createBrokerAuth("a2b2-broker");
const stamp = Date.now();
const spaces = ["on", "off", "deny", "brk", "session"].map((s) => `${setupHintsOnly ? "-" : ""}a2b2-${s}-${stamp}`);
const accounts = await Promise.all(spaces.map((s) => createSpaceAccountAuth(broker, s)));
const handles: AuthServiceHandle[] = [];
let nats: ChildProcess | undefined, release: (() => void) | undefined;
const fixture = { owner: "", callerUid: "", sentinelCreds: "" };

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
  writeFileSync(join(jsDir, "server.conf"), serverConfig(broker, accounts, { transport: { kind: "plaintext" }, port, storeDir: jsDir, maxPayload: SERVICE_AUTHORITY_MAX_BYTES + 1024, extraAccounts: ctx.map((c) => ({ pub: c.callout.account.pub, jwt: c.callout.account.jwt })) }));
  nats = spawn("nats-server", ["-c", join(jsDir, "server.conf")], { stdio: "ignore" });
  release = teardownOnSignal(nats, jsDir);
  for (let i = 0; i < 50 && !(await isReachable(servers)); i++) await sleep(200);
  for (const c of ctx) await setupSpaceStreams({ servers, space: c.space, creds: await mintCreds(c.auth, newIdentity(), "provisioner") });

  // The owner's interactive row, derived exactly as the stock service derives it.
  for (const c of ctx) {
    const owner = deriveOwnerForIdpSubject((await loadOwnerSecret(c.store, c.space))!, idpOrigin, "machine-owner");
    grantActor(c.stateDir, { owner, actor: "cli", scope: [], allowSubscribe: [], allowPublish: [] });
    if (c === ctx[0]) {
      fixture.owner = owner;
      fixture.callerUid = grantActor(c.stateDir, { owner, actor: "probe", scope: [], allowSubscribe: [], allowPublish: [] }).lifecycleUid!;
    }
  }
  const svc = await Promise.all(ctx.map((c, i) => startAuthService({ context: { accountPublicKey: c.auth.account.pub, lifecycleUid: mintLifecycleUid() }, space: c.space, servers,
    store: c.store, storeIdentity: c.store.identity, stateDir: c.stateDir, publicFace: { port: 0, trustedProxy: false },
    ...(process.argv.includes("--renewal-abort-repro") ? { standingRenewableTtlSeconds: 40 } : {}),
    ...(i === 1 ? {} : { serviceEndpoints: { startup: { kind: "normal" as const },
      callerPayload: { observerCreds: () => mintServiceCallerPayloadObserverCreds({ pub: c.auth.sys.pub, signingSeed: c.auth.sys.signingSeed! }) } } }) })));
  handles.push(...svc);

  // The participant records each space from the bundle the real public face serves, behind a counting relay.
  // C13: the BRK space's participant reaches the broker through a TCP pass-through the suite can cut,
  // so a broker loss is the daemon's alone; the auth services keep their own broker connections.
  let brokerPathUp = true;
  const pathSockets = new Set<Socket>();
  const brokerPath: NetServer = createNetServer((inbound) => {
    if (!brokerPathUp) { inbound.destroy(); return; }
    const outbound = netConnect(port, "127.0.0.1");
    pathSockets.add(inbound); pathSockets.add(outbound);
    const drop = () => { inbound.destroy(); outbound.destroy(); pathSockets.delete(inbound); pathSockets.delete(outbound); };
    inbound.on("error", drop); outbound.on("error", drop); inbound.on("close", drop); outbound.on("close", drop);
    inbound.pipe(outbound); outbound.pipe(inbound);
  });
  await new Promise<void>((r) => brokerPath.listen(0, "127.0.0.1", () => r()));
  const brokerPathUrl = `nats://127.0.0.1:${(brokerPath.address() as AddressInfo).port}`;
  const cutBrokerPath = () => { brokerPathUp = false; for (const s of pathSockets) s.destroy(); pathSockets.clear(); };
  for (const [i, c] of ctx.entries()) {
    const face = await relay(c.space, svc[i]!.publicUrl!.replace(/\/$/, ""));
    const bundle = await (await fetch(`${svc[i]!.publicUrl!.replace(/\/$/, "")}/.well-known/cotal-mesh`)).json() as { server: string; userAuth: MeshEntry["userAuth"]; sentinelCreds: string };
    if (i === 0) fixture.sentinelCreds = bundle.sentinelCreds;
    const dir = userAuthStateDir(participant, c.space); mkSecretDir(dir);
    const sentinelCredsPath = join(dir, "sentinel.creds"); writeSecretFileAtomic(sentinelCredsPath, bundle.sentinelCreds);
    recordMesh({ space: c.space, server: i === 3 ? brokerPathUrl : bundle.server, root: participant, mode: "user", origin: "manual",
      userAuth: { ...bundle.userAuth!, endpoints: { ...bundle.userAuth!.endpoints, url: face }, remote: true, sentinelCredsPath }, ts: new Date().toISOString() });
  }
  saveIdpSession(home, idpUrl, { token: SESSION, expiresAt: Math.floor(Date.now() / 1000) + 3600, sub: "machine-owner" });

  const [ON, OFF, DENY, BRK] = spaces as [string, string, string, string];
  const host = svc[0]!.serviceEndpointHost!, denyHost = svc[2]!.serviceEndpointHost!, brkHost = svc[3]!.serviceEndpointHost!;
  const operator = { kind: "operator", auditId: "a2b2-fixture-operator" } as const;
  const rid = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const regFile = (space: string) => readdirSync(join(home, "daemon"), { recursive: true }).map(String).find((p) => p.includes(".".concat(Buffer.from(space).toString("hex"))) && p.endsWith("register-request.json"));
  const regRecord = (space: string) => { const f = regFile(space); return f ? JSON.parse(readFileSync(join(home, "daemon", f), "utf8")) as Record<string, unknown> : undefined; };


  // ---- independent observations (the fixture's own stock clients, never the daemon's) ----
  const daemonDir = join(home, "daemon");
  /** Where a space's resume intent is recorded, read the way the daemon derives it. */
  const intentFile = (space: string) => daemonConnectIntentFile(space, home);
  const filesUnder = (dir: string) => existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String) : [];
  /** A real unit and receipt in the fixture manager's reported directory. Operational native
   *  calls reach only an owned recorder; the default fixture admits directory reads only. */
  const seedUnitReceipt = (entry = join(repo, "bin/dist/cotal.js"), marked = false): string => {
    const native = join(root, "native"), config = join(root, "config");
    mkdirSync(native, { recursive: true, mode: 0o700 });
    mkdirSync(join(config, "systemd", "user"), { recursive: true, mode: 0o700 });
    writeFileSync(join(native, "systemctl"), `#!${process.execPath}\nif (process.argv.slice(2).join(" ") !== "--user show-environment") process.exit(89);\nconsole.log(${JSON.stringify(`XDG_CONFIG_HOME=${config}`)});\n`, { mode: 0o700 });
    process.env.PATH = `${native}:${originalPath ?? ""}`;
    const unit = explicitHome ? `cotal-daemon-${createHash("sha256").update(explicitHome).digest("hex").slice(0, 16)}.service` : "cotal-daemon.service";
    const unitPath = join(config, "systemd", "user", unit);
    const unitBytes = `[Unit]\nDescription=Cotal machine daemon\n\n[Service]\nType=simple\nExecStart="${process.execPath}" "${entry}" daemon serve${explicitHome ? ` --daemon-home "${explicitHome}"` : ""}\n${marked ? "Environment=COTAL_DAEMON_NATIVE_SERVICE=1\n" : ""}Restart=always\n\n[Install]\nWantedBy=default.target\n`;
    writeFileSync(unitPath, unitBytes, { mode: 0o600 });
    mkdirSync(paths.state, { recursive: true, mode: 0o700 });
    writeFileSync(unitReceiptFile(paths), `${JSON.stringify({ v: 1, unit, unitPath, unitSha256: createHash("sha256").update(unitBytes).digest("hex"), installedAt: new Date().toISOString(), ...(explicitHome ? { daemonHome: explicitHome } : {}) })}\n`, { mode: 0o600 });
    return unit;
  };
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
  const cli = async (argv: string[], format: "--plain" | "--json" = "--json", onStderr?: (text: string) => void) => {
    const child = spawn(process.execPath, [join(repo, "bin/dist/cotal.js"), "daemon", ...argv, format], {
      cwd: root, env: { ...process.env, XDG_RUNTIME_DIR: rtDir, COTAL_HOME: home, COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"], timeout: 90_000, killSignal: "SIGKILL",
    });
    let out = "", err = "";
    child.stdout.on("data", (b) => { out += String(b); });
    child.stderr.on("data", (b) => { err += String(b); onStderr?.(err); });
    const status = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
    frames.push(out, err);
    const doc = format === "--json" ? JSON.parse(out) as Record<string, any> : undefined;
    return { status, doc, out, err };
  };
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
      input: { proposalId: pid, expectedProposalRevision: p.record?.revision ?? 0, expectedNameRevision: bound.binding?.revision ?? 0, decision: "approve",
        callerCeiling: [{ endpoint: "ai.cotal.machine", command: "machine-status", instanceId: identityOf(space)!.instanceId, instanceOnly: true }] } } as never) as { state: string; approval?: { assignment: { assignmentDigest: string } } };
    return { bound, decided, pid };
  };

  let probeCalls = 0;
  const probeMachine = async (direct?: { instanceId: string; epoch: number }) => {
    const tokenResponse = await fetch(`${idpUrl}/token`, { headers: { authorization: `Bearer ${SESSION}` } });
    if (!tokenResponse.ok) throw new Error("fixture IdP refused the probe");
    const idpToken = (await tokenResponse.json() as { token: string }).token;
    const exchange = await fetch(`${svc[0]!.publicUrl!.replace(/\/$/, "")}/exchange`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idpToken, actor: "probe" }),
    });
    if (!exchange.ok) throw new Error(`fixture probe exchange refused (${exchange.status})`);
    const token = (await exchange.json() as { token: string }).token;
    let directCall: (() => ReturnType<typeof epCall>) | undefined;
    const contract = compileContract({ root: VOID_SCHEMA });
    const caller = new CotalEndpoint({ space: ON, servers, sentinelCreds: fixture.sentinelCreds, bearer: async () => token,
      onConnection: (nc) => {
        if (direct) directCall = () => epCall(nc, ON, { mode: "inst", ...direct }, {
          endpoint: "ai.cotal.machine", command: "machine-status", contract: { input: contract, output: contract },
          caller: { owner: fixture.owner, actor: "probe", uid: fixture.callerUid }, bind: direct,
        }, { deadlineMs: 3000 });
      },
      card: { name: "daemon-probe", kind: "endpoint", owner: fixture.owner, actor: "probe" }, lifecycleUid: fixture.callerUid,
      channels: [], registerPresence: false, watchPresence: false, watchChannels: false, consume: false });
    caller.on("warning", () => {}); caller.on("error", () => {});
    try {
      await caller.start();
      probeCalls++;
      if (direct) {
        if (!directCall) throw new Error("fixture caller has no transport");
        return await directCall();
      }
      return await caller.invokeService("ai.cotal.machine", "machine-status", undefined, { instanceId: identityOf(ON)!.instanceId, deadlineMs: 3000 });
    } finally { await caller.stop(); }
  };

  let d = await serveDaemon({ paths, version: fixtureVersion, peerUid, sessionDir: home } as Parameters<typeof serveDaemon>[0]);
  let foreground: ChildProcess | undefined;
  let assignmentDigest = "";
  try {
    await cell("C0 offline status without a register request is independent of connect history", async () => {
      const missing = "no-such-space";
      const beforeHits = hits.length;
      for (const phase of ["initial", "after refused connect", "after disconnect", "after restart"]) {
        if (phase === "after refused connect") {
          const r = await cli(["service-connect", "--space", missing]);
          check("C0 connect without a request refuses NOT_REQUESTED", r.status === 2 && r.doc?.error?.code === "TARGET_NOT_FOUND" && r.doc?.error?.cause?.code === "NOT_REQUESTED", r.doc);
        } else if (phase === "after disconnect") {
          check("C0 disconnect remains an explicit successful operation", stateOf(await disconnectS(missing)) === "disconnected");
        } else if (phase === "after restart") {
          await d.close();
          d = await serveDaemon({ paths, version: fixtureVersion, peerUid, sessionDir: home } as Parameters<typeof serveDaemon>[0]);
        }
        for (const space of [missing, OFF]) {
          const socket = await statusS(space);
          check(`C0 ${phase}: socket status for ${space} is not-requested`, stateOf(socket) === "not-requested", socket);
          const json = await cli(["service-status", "--space", space]);
          check(`C0 ${phase}: JSON status for ${space} refuses NOT_REQUESTED`, json.status === 2 && json.doc?.error?.code === "TARGET_NOT_FOUND" && json.doc?.error?.cause?.code === "NOT_REQUESTED", json.doc);
          const plain = await cli(["service-status", "--space", space], "--plain");
          check(`C0 ${phase}: text status for ${space} names the missing request`, plain.status === 2 && plain.err.includes("NOT_REQUESTED") && plain.err.includes("TARGET_NOT_FOUND") && plain.err.includes(`cotal daemon register --space ${space}`), plain.err);
        }
      }
      check("C0 status and refused connect never contact the space", hits.length === beforeHits, { beforeHits, afterHits: hits.length });
      check("C0 status creates no registration or connection records", !filesUnder(daemonDir).some((p) => /(?:register-request|service-identity|service-connect)\.json$|service-store/.test(p)));
    });

    if (setupProgressOnly) {
      await d.close();
      foreground = spawn(process.execPath, [join(repo, "bin/dist/cotal.js"), "daemon", "serve"], {
        cwd: root, env: { ...process.env, COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"],
      });
      await new Promise<void>((resolve, reject) => {
        let out = "", err = "";
        const timer = setTimeout(() => reject(new Error(`foreground daemon readiness timeout: ${err}`)), 20_000);
        foreground!.stdout!.on("data", (b) => {
          out += String(b);
          if (out.includes("daemon ready at ")) { clearTimeout(timer); resolve(); }
        });
        foreground!.stderr!.on("data", (b) => { err += String(b); });
        foreground!.once("error", (e) => { clearTimeout(timer); reject(e); });
        foreground!.once("exit", (code) => { clearTimeout(timer); reject(new Error(`foreground daemon exited ${code}: ${err}`)); });
      });
    }
    await cell("C1 connect before approval is approval-pending, never connected", async () => {
      await ask(paths.socket, { op: "register", space: ON });
      check("C1 registration alone retains approval-pending for offline status", stateOf(await statusS(ON)) === "approval-pending");
      const r = await connectS(ON);
      check("C1 approval-pending", r.ok === true && stateOf(r) === "approval-pending", r);
      check("C1 no renewal record written for this space", !filesUnder(daemonDir).some((p) => p.includes("service-renewal")), filesUnder(daemonDir));
      check("C1 the space reports no ready status", (await instanceStatus(ON)) !== "ready");
    });

    await cell("C1b setup before the owner approves ends partial and says what is already done", async () => {
      // The headless case an operator meets first: the machine is registered and waiting on a
      // person. `--wait 0` reports what it reached instead of sitting there.
      seedUnitReceipt();
      const lines: string[] = [];
      let failure: Record<string, any> | undefined;
      try {
        await runSetup({ paths, daemonHome: undefined, noManager: true, space: ON, peerUid, peerPid, waitSeconds: 0,
          report: (l) => lines.push(l), onPrompt: () => { throw new Error("setup asked for a sign-in it did not need"); } });
      } catch (e) { failure = e as Record<string, any>; }
      check("C1b it ends partial, not a success and not a plain failure", failure?.outcome === "partial", failure && { outcome: failure.outcome, code: failure.code });
      check("C1b it reports the approval as what is blocking", failure?.code === "OPERATION_PARTIAL" && (failure?.detail?.native?.code ?? failure?.native?.code) === "APPROVAL_PENDING", { code: failure?.code, native: failure?.detail?.native ?? failure?.native });
      check("C1b it says the registration is already sent, so a rerun continues", String(failure?.message ?? "").includes("registration request is sent"), failure?.message);
      check("C1b its remedy names the owner's approval and the command to rerun", /approve this machine/.test(String((failure?.detail?.remedy ?? failure?.remedy) ?? "")) && /cotal daemon setup --space/.test(String((failure?.detail?.remedy ?? failure?.remedy) ?? "")), failure?.detail?.remedy ?? failure?.remedy);
      check("C1b nothing is connected and no resume intent was recorded", stateOf(await statusS(ON)) !== "connected" && !existsSync(intentFile(ON)));
      check("C1b it reported the final pending connect state", lines.filter((l) => l.startsWith("connect: approval-pending;")).length === 1, lines);
      for (const format of ["--plain", "--json"] as const) {
        const pending = await cli(["setup", "--no-manager", `--space=${ON}`, "--wait", "0"], format);
        check(`C1b ${format} exits partial with pending approval`, pending.status === 4 && (format === "--json"
          ? pending.doc?.error?.code === "OPERATION_PARTIAL" && pending.doc?.error?.cause?.code === "APPROVAL_PENDING"
          : pending.err.includes("OPERATION_PARTIAL") && pending.err.includes("APPROVAL_PENDING")), pending);
        check(`C1b ${format} reports every reached stage on stderr`, ["service", "sign-in", "register", "connect"].every((stage) => pending.err.split("\n").some((line) => line.startsWith(`${stage}: `))), pending.err);
        check(`C1b ${format} reports the final pending connect state once`, pending.err.split("\n").filter((line) => line.startsWith("connect: approval-pending;")).length === 1, pending.err);
      }
    });

    await cell("C2 after approval: connected only with a broker connection and the space's ready", async () => {
      seedUnitReceipt();
      let approval: ReturnType<typeof approve> | undefined;
      const waiting = await cli(["setup", "--no-manager", `--space=${ON}`, "--wait", "30"], "--plain", (text) => {
        if (!approval && text.includes("connect: waiting up to 30s")) approval = approve(host, ON, fixture.owner);
      });
      if (!approval) throw new Error("setup never reported waiting for approval");
      const a = await approval;
      check("C2 setup reports waiting before its terminal connected line", waiting.status === 0 && /^connect: waiting up to 30s/m.test(waiting.err)
        && waiting.err.split("\n").filter((line) => line.startsWith("connect: connected;")).length === 1
        && waiting.err.indexOf("connect: connected;") > waiting.err.indexOf("connect: waiting up to 30s"), waiting);
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

    await cell("C15 an explicitly granted native caller reaches the daemon's registered command", async () => {
      const id = identityOf(ON)!;
      const status = await cotalAuthProvider.serviceEndpointAuthority!({ store: workspaceSecretStore(participant), dir: userAuthStateDir(participant, ON, { readOnly: true }),
        request: { v: 1, kind: "service-endpoint-authority", operation: "status", requestId: rid(), space: ON,
          accountPublicKey: id.accountPublicKey, endpoint: id.endpoint, instanceId: id.instanceId, target: { kind: "instance" } } });
      if (status.result.state !== "status" || status.result.status.state !== "ready") throw new Error("fixture service is not ready");
      const witness = status.result.status.witness;
      const live = await statusS(ON);
      check("C15 instrument: daemon is connected at the same instance before the denied call", stateOf(live) === "connected" && resultOf(live).instanceId === id.instanceId);
      const beforeCalls = probeCalls;
      const direct = { instanceId: witness.instanceId, epoch: witness.processEpoch };
      // Skip discovery for this control: a denied Describe or schema read is not an invoke denial.
      let denied = false;
      try { await probeMachine(direct); } catch (e) { denied = e instanceof EpEnvelopeError && e.code === "permission-denied"; }
      check("C15 exactly one ungranted direct invoke is permission-denied while connected", denied && probeCalls === beforeCalls + 1);
      const granted = await host({ v: 1, kind: "service-endpoint-host", operation: "caller-grant", requestId: rid(), granter: { kind: "owner", owner: fixture.owner },
        input: { grantee: { owner: fixture.owner, actor: "probe", lifecycleUid: fixture.callerUid },
          service: { endpoint: id.endpoint, instanceId: id.instanceId, approvalDigest: witness.approvalDigest },
          capabilities: [{ endpoint: id.endpoint, command: "machine-status", instanceId: id.instanceId, instanceOnly: true }], expectedPolicyRevision: 0 } });
      check("C15 instrument: owner explicitly granted the exact instance and command", granted.state === "granted");
      if (granted.state !== "granted") throw new Error("fixture caller grant refused");
      const reply = await probeMachine(direct);
      check("C15 exactly one granted direct invoke answers void from the registered daemon instance", probeCalls === beforeCalls + 2 && reply.reply.ok && reply.reply.data === null && reply.responder.instanceId === id.instanceId);
      const resolved = await probeMachine();
      check("C15 the ordinary stock resolve and invoke path also reaches the daemon", probeCalls === beforeCalls + 3 && resolved.reply.ok && resolved.reply.data === null && resolved.responder.instanceId === id.instanceId);
    });

    await cell("C3 a second connect shares the connection", async () => {
      const [x, y] = await Promise.all([connectS(ON), connectS(ON)]);
      check("C3 both connected", stateOf(x) === "connected" && stateOf(y) === "connected", { x, y });
      check("C3 still exactly one renewal record", filesUnder(daemonDir).filter((p) => p.includes("service-renewal") && p.endsWith(".json")).length === 1);
      await ask(paths.socket, { op: "register", space: ON });
      check("C3 registration replay keeps the live connection state", stateOf(await statusS(ON)) === "connected");
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
      check("C5 instrument: the connection recorded its intent before the disconnect", existsSync(intentFile(ON)));
      const r = await disconnectS(ON);
      check("C5 disconnected", stateOf(r) === "disconnected", r);
      check("C5 status agrees", stateOf(await statusS(ON)) === "disconnected");
      check("C5 the recorded connect intent is gone, so the disconnect outlives a restart", !existsSync(intentFile(ON)));
      let unanswered = false;
      try { await probeMachine(); } catch (e) { unanswered = unansweredRequest(e); }
      check("C5 the disconnected daemon no longer answers an authorized caller", unanswered);
    });

    await cell("C6 a restarted daemon resumes its connection by itself, under the same ids", async () => {
      // C5 disconnected ON and forgot its intent, so re-establish it and prove it was recorded.
      check("C6 instrument: no intent is recorded after C5's disconnect", !existsSync(intentFile(ON)));
      check("C6 instrument: connected again", stateOf(await connectS(ON)) === "connected");
      check("C6 a connection that the space accepted records its intent 0600", existsSync(intentFile(ON)) && (statSync(intentFile(ON)).mode & 0o777) === 0o600, existsSync(intentFile(ON)) ? (statSync(intentFile(ON)).mode & 0o777).toString(8) : "absent");
      const before = filesUnder(daemonDir).filter((p) => p.includes("service-renewal") && p.endsWith(".json")).map((p) => readFileSync(join(daemonDir, p), "utf8"));
      const ids0 = before.map((t) => { const o = JSON.parse(t) as Record<string, string>; return `${o.activateRequestId}/${o.renewRequestId}`; });
      await d.close();
      d = await serveDaemon({ paths, version: fixtureVersion, peerUid, sessionDir: home } as Parameters<typeof serveDaemon>[0]);
      // Nothing is run against this daemon: the state it reports is the one its own resume reached.
      const st = await waitState(ON, (x) => x === "connected", 90_000);
      check("C6 it reaches connected with nothing run against it", st === "connected", st);
      check("C6 it reports exactly 1 resumed connection", d.counters.connectionsResumed === 1, d.counters);
      const after = filesUnder(daemonDir).filter((p) => p.includes("service-renewal") && p.endsWith(".json")).map((p) => JSON.parse(readFileSync(join(daemonDir, p), "utf8")) as Record<string, string>);
      check("C6 the same activate and renew ids", ids0.length === 1 && after.length === 1 && ids0[0] === `${after[0]!.activateRequestId}/${after[0]!.renewRequestId}`, { ids0, after: after.map((o) => `${o.activateRequestId}/${o.renewRequestId}`) });
      // And the other direction: an explicit disconnect must not come back.
      check("C6 instrument: an explicit disconnect forgets the intent", stateOf(await disconnectS(ON)) === "disconnected" && !existsSync(intentFile(ON)));
      await d.close();
      d = await serveDaemon({ paths, version: fixtureVersion, peerUid, sessionDir: home } as Parameters<typeof serveDaemon>[0]);
      check("C6 a restart after an explicit disconnect resumes 0 connections and is disconnected", d.counters.connectionsResumed === 0 && stateOf(await statusS(ON)) === "disconnected", { counters: d.counters, state: stateOf(await statusS(ON)) });
      check("C6 instrument: connected again for the cells that follow", stateOf(await connectS(ON)) === "connected");
    });

    await cell("C6b shipped startup retries unavailable intent and cancels pending retries", async () => {
      seedUnitReceipt();
      await d.close();
      const original = findMesh(ON)!;
      const env = { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
        XDG_CACHE_HOME: join(root, "cache"), XDG_RUNTIME_DIR: rtDir, TMPDIR: scratchParent, COTAL_HOME: home,
        COTAL_SKIP_CONNECTOR_SEED: "1", DO_NOT_TRACK: "1", NO_COLOR: "1" };
      const entry = join(repo, "bin/dist/cotal.js");
      let child: ChildProcess | undefined;
      const stop = async (signal: NodeJS.Signals) => {
        if (child) await killAndAwaitExit(child, signal);
        child = undefined;
      };
      const start = async () => {
        child = spawn(process.execPath, [entry, "daemon", "serve"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
        child.stdout!.resume(); child.stderr!.resume();
        for (let i = 0; i < 100; i++) {
          try { await ask(paths.socket, { op: "status" }, 1000); return; } catch { await sleep(100); }
        }
        throw new Error("C6b shipped daemon did not publish its local endpoint");
      };
      const cli = async (mode: string) => {
        const proc = spawn(process.execPath, [entry, "daemon", mode, "--space", ON, "--json"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
        let out = "", err = "";
        proc.stdout.on("data", (b) => { out += String(b); }); proc.stderr.on("data", (b) => { err += String(b); });
        const timer = setTimeout(() => proc.kill("SIGKILL"), 40_000);
        const code = await new Promise<number | null>((resolve) => proc.once("exit", resolve)); clearTimeout(timer);
        frames.push(out, err);
        return { code, doc: JSON.parse(out) as Record<string, any> };
      };
      try {
        // Pause a real retry request so a status sample cannot miss its in-flight state.
        relayDown.add(ON);
        await start();
        check("C6b slow retry instrument: startup is unavailable", (await waitState(ON, (s) => s === "unavailable", 15_000)) === "unavailable");
        let entered!: () => void, release!: () => void;
        const requested = new Promise<void>((resolve) => { entered = resolve; });
        const held = new Promise<void>((resolve) => { release = resolve; });
        authorityGates.set(ON, async () => { entered(); await held; });
        relayDown.delete(ON);
        try {
          await Promise.race([requested, sleep(15_000).then(() => { throw new Error("C6b retry did not reach authority gate"); })]);
          const status = await cli("service-status");
          check("C6b in-flight background retry preserves dependency refusal", status.code === 2 && status.doc.error?.code === "DEPENDENCY_UNAVAILABLE" && status.doc.error?.cause?.code === "UNAVAILABLE", status);
        } finally { authorityGates.delete(ON); release(); }
        check("C6b released retry connects and serves", (await waitState(ON, (s) => s === "connected", 15_000)) === "connected" && (await probeMachine()).reply.ok);
        await stop("SIGKILL");

        // Let the authority accept ready, but drop the broker before delivering that answer.
        recordMesh({ ...original, server: brokerPathUrl });
        let readyEntered!: () => void, releaseReady!: () => void;
        const readyRequested = new Promise<void>((resolve) => { readyEntered = resolve; });
        const readyHeld = new Promise<void>((resolve) => { releaseReady = resolve; });
        readyGates.set(ON, async () => { readyEntered(); await readyHeld; });
        try {
          await start();
          await Promise.race([readyRequested, sleep(15_000).then(() => { throw new Error("C6b startup did not reach ready gate"); })]);
          cutBrokerPath();
          await sleep(500);
          readyGates.delete(ON); releaseReady();
          const state = await waitState(ON, (s) => s === "unavailable", 15_000);
          check("C6b broker lost during ready leaves retryable unavailable state", state === "unavailable", state);
          brokerPathUp = true;
          check("C6b broker lost during ready recovers and serves without service-connect", (await waitState(ON, (s) => s === "connected", 15_000)) === "connected" && (await probeMachine()).reply.ok);
        } finally { readyGates.delete(ON); releaseReady(); brokerPathUp = true; }
        await stop("SIGKILL");
        recordMesh(original);

        for (const dependency of ["authority", "broker"]) {
          const droppedBeforeStart = droppedAt.get(ON)?.length ?? 0;
          if (dependency === "authority") relayDown.add(ON);
          else { recordMesh({ ...original, server: brokerPathUrl }); cutBrokerPath(); }
          await start();
          check(`C6b ${dependency} startup reports unavailable without blocking local status`, (await waitState(ON, (s) => s === "unavailable", 15_000)) === "unavailable");
          const outage = await cli("service-status");
          check(`C6b ${dependency} CLI reports dependency refusal`, outage.code === 2 && outage.doc.error?.code === "DEPENDENCY_UNAVAILABLE", outage);
          if (dependency === "authority") {
            const deadline = Date.now() + 5000;
            while ((droppedAt.get(ON)?.length ?? 0) < droppedBeforeStart + 2 && Date.now() < deadline) await sleep(25);
            check("C6b an unavailable startup makes another authority attempt", (droppedAt.get(ON)?.length ?? 0) >= droppedBeforeStart + 2);
            relayDown.delete(ON);
            const response = await fetch(`${original.userAuth!.endpoints!.url}/service-endpoint-authority`);
            check("C6b authority recovery is independently reachable", response.status === 200);
            await response.arrayBuffer();
          } else brokerPathUp = true;
          const recovered = await waitState(ON, (s) => s === "connected", 15_000);
          const status = await cli("service-status");
          check(`C6b ${dependency} recovery connects without service-connect`, recovered === "connected" && status.code === 0 && status.doc.result?.state === "connected", status);
          check(`C6b ${dependency} recovery serves an authorized caller`, (await probeMachine()).reply.ok);
          await stop("SIGKILL");
        }
        // Recover just after a third failed authority attempt, where immediate exponential
        // backoff otherwise leaves four seconds before the next attempt.
        recordMesh(original);
        relayDown.add(ON);
        const droppedBefore = droppedAt.get(ON)?.length ?? 0;
        await start();
        const retryDeadline = Date.now() + 15_000;
        while ((droppedAt.get(ON)?.length ?? 0) < droppedBefore + 3 && Date.now() < retryDeadline) await sleep(25);
        check("C6b recovery-latency instrument: three startup attempts failed", (droppedAt.get(ON)?.length ?? 0) >= droppedBefore + 3);
        relayDown.delete(ON);
        const recoveredAt = Date.now();
        const promptly = await waitState(ON, (s) => s === "connected", 3000);
        check("C6b early outage recovers within three seconds of authority restoration", promptly === "connected", { state: promptly, elapsedMs: Date.now() - recoveredAt });
        check("C6b recovery latency positive control eventually connects and serves", (await waitState(ON, (s) => s === "connected", 15_000)) === "connected" && (await probeMachine()).reply.ok);
        await stop("SIGKILL");
        relayDown.add(ON);
        const timesBefore = droppedAt.get(ON)?.length ?? 0;
        await start();
        const scheduleDeadline = Date.now() + 100_000;
        while ((droppedAt.get(ON)?.length ?? 0) < timesBefore + 16 && Date.now() < scheduleDeadline) await sleep(100);
        const times = (droppedAt.get(ON) ?? []).slice(timesBefore);
        const gaps = times.slice(1).map((time, i) => time - times[i]!);
        console.log(`  C6b startup retry gaps ms: ${gaps.join(",")}`);
        check("C6b first ten retries stay near one second", gaps.length >= 15 && gaps.slice(0, 10).every((gap) => gap >= 950 && gap < 2000), gaps);
        check("C6b long outage backs off to the thirty-second cap", [2000, 4000, 8000, 16000, 30000].every((delay, i) => gaps[i + 10] !== undefined && gaps[i + 10]! >= delay - 50 && gaps[i + 10]! < delay + 2000), gaps);
        const longOutage = await cli("service-status");
        check("C6b capped outage keeps dependency status", longOutage.code === 2 && longOutage.doc.error?.code === "DEPENDENCY_UNAVAILABLE", longOutage);
        await stop("SIGKILL");
        relayDown.delete(ON);
        recordMesh(original);
        for (const action of ["disconnect", "shutdown"]) {
          relayDown.add(ON);
          await start();
          check(`C6b ${action} instrument: resume is unavailable`, (await waitState(ON, (s) => s === "unavailable", 15_000)) === "unavailable");
          if (action === "disconnect") {
            const disconnected = await cli("service-disconnect");
            check("C6b disconnect cancels remembered intent during outage", disconnected.code === 0 && !existsSync(intentFile(ON)), disconnected);
          } else await stop("SIGTERM");
          const before = droppedAt.get(ON)?.length ?? 0;
          await sleep(2500);
          check(`C6b ${action} leaves no pending retry`, (droppedAt.get(ON)?.length ?? 0) === before);
          relayDown.delete(ON);
          if (action === "disconnect") {
            await stop("SIGTERM");
            await start();
            const status = await cli("service-status");
            check("C6b disconnected intent stays disconnected after restart", status.code === 2 && stateOf(await statusS(ON)) === "disconnected");
            check("C6b explicit connect restores intent for shutdown control", (await cli("service-connect")).code === 0 && existsSync(intentFile(ON)));
            await stop("SIGKILL");
          } else check("C6b shutdown closes its socket but retains intent", !existsSync(paths.socket) && existsSync(intentFile(ON)));
        }
      } finally {
        authorityGates.delete(ON); readyGates.delete(ON);
        relayDown.delete(ON); brokerPathUp = true; recordMesh(original);
        await stop("SIGTERM");
        d = await serveDaemon({ paths, version: fixtureVersion, peerUid, sessionDir: home } as Parameters<typeof serveDaemon>[0]);
      }
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
      const reply = await probeMachine();
      check("C12 the registered command still answers after credential renewals", reply.reply.ok && reply.reply.data === null && reply.responder.instanceId === identityOf(ON)!.instanceId);
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

    await cell("C17 `cotal daemon setup` reaches connected in one call", async () => {
      seedUnitReceipt();
      // Start from not connected, so reaching connected is this call's own work.
      await disconnectS(ON);
      check("C17 instrument: not connected, and no resume record, before setup runs", stateOf(await statusS(ON)) === "disconnected" && !existsSync(intentFile(ON)));
      const lines: string[] = [];
      const r = await runSetup({ paths, daemonHome: undefined, noManager: true, space: ON, peerUid, peerPid, waitSeconds: 60,
        report: (l) => lines.push(l), onPrompt: () => { throw new Error("setup asked for a sign-in it did not need"); } });
      check("C17 it reaches connected", r.state === "connected", r);
      check("C17 it ran four steps, in order", r.steps.map((x) => x.step).join(",") === "install,sign-in,register,connect", r.steps);
      check("C17 it skipped the install, because a unit was already recorded", r.steps[0]!.outcome === "already-installed", r.steps[0]);
      check("C17 it skipped the sign-in, because this machine is signed in", r.steps[1]!.outcome === "already-signed-in", r.steps[1]);
      check("C17 it reported the registration the space holds", ["registered", "pending", "approval-required"].includes(r.steps[2]!.outcome), r.steps[2]);
      check("C17 it names the unit and the instance", r.unit === "cotal-daemon.service" && r.instanceId === identityOf(ON)?.instanceId, { unit: r.unit, instanceId: r.instanceId });
      check("C17 it reports the final connected state once", lines.filter((l) => l.startsWith("connect: connected;")).length === 1, lines);
      for (const format of ["--plain", "--json"] as const) {
        await disconnectS(ON);
        const connected = await cli(["setup", "--no-manager", `--space=${ON}`, "--wait", "30"], format);
        check(`C17 ${format} first-poll connection succeeds`, connected.status === 0 && (format !== "--json" || connected.doc?.result?.state === "connected"), connected);
        check(`C17 ${format} reports every reached stage on stderr`, ["service", "sign-in", "register", "connect"].every((stage) => connected.err.split("\n").some((line) => line.startsWith(`${stage}: `))), connected.err);
        check(`C17 ${format} reports connected once without waiting`, connected.err.split("\n").filter((line) => line.startsWith("connect: connected;")).length === 1 && !connected.err.includes("connect: waiting"), connected.err);
      }
      const status = await cli(["service-status", `--space=${ON}`]);
      check("C17 independent CLI status agrees with connected setup", status.status === 0 && status.doc?.result?.state === "connected", status);
      check("C17 the connection it made is recorded for resume", existsSync(intentFile(ON)));
      check("C17 the space reads this instance ready", stateOf(await statusS(ON)) === "connected");
      check("C17 nothing secret reached its progress lines", !lines.some((l) => [SESSION, ...jwtsIssued].some((t) => l.includes(t))) && !lines.some((l) => /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./.test(l)));
      const env = { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state"), XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"), XDG_RUNTIME_DIR: rtDir, TMPDIR: scratchParent, COTAL_HOME: home, COTAL_SKIP_CONNECTOR_SEED: "1", DO_NOT_TRACK: "1", COTAL_TELEMETRY: "off", NO_COLOR: "1" };
      const followupCli = async (args: string[]) => {
        const child = spawn(process.execPath, [join(repo, "bin/dist/cotal.js"), ...args], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
        let out = "", err = "";
        child.stdout.on("data", (b) => { out += String(b); });
        child.stderr.on("data", (b) => { err += String(b); });
        const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
        try { return { code: await new Promise<number | null>((resolve) => child.once("exit", resolve)), out, err }; }
        finally { clearTimeout(timer); }
      };
      const setup = await followupCli(["daemon", "setup", "--no-manager", `--space=${ON}`, "--wait", "0", "--plain"]);
      const spaceOption = ON.startsWith("-") ? `--space=${ON}` : `--space ${ON}`;
      check("C17 shipped setup retains its space in both follow-up options, attaching leading-hyphen values", setup.code === 0 && setup.out.includes(`cotal daemon service-status ${spaceOption}`) && setup.out.includes(`cotal daemon service-disconnect ${spaceOption}`), setup);
      const suggested = [...setup.out.matchAll(/`(cotal daemon service-(?:status|disconnect) [^`]+)`/g)].map((match) => match[1]!);
      check("C17 setup offers two copyable follow-up commands", suggested.length === 2, suggested);
      for (const command of suggested) {
        const result = await followupCli(command.split(" ").slice(1));
        check(`C17 suggested ${command.includes("service-status") ? "status" : "disconnect"} command succeeds verbatim`, result.code === 0 && new RegExp(`Machine service:\\s+${command.includes("service-status") ? "connected" : "disconnected"}(?:\\n|$)`).test(result.out), result);
      }
      check("C17 restore connection after the suggested disconnect", stateOf(await connectS(ON)) === "connected");
    });

    await cell("BASELINE shipped setup connects but provides no Manager to call", async () => {
      const child = spawn(process.execPath, [join(repo, "bin", "dist", "cotal.js"), "daemon", "setup", "--no-manager", "--space", ON, "--wait", "0", "--json"], {
        cwd: root,
        env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"), XDG_RUNTIME_DIR: rtDir, TMPDIR: scratchParent, COTAL_HOME: home, COTAL_SKIP_CONNECTOR_SEED: "1", DO_NOT_TRACK: "1", COTAL_TELEMETRY: "off", NO_COLOR: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "", err = "";
      child.stdout.on("data", (b) => { out += String(b); }); child.stderr.on("data", (b) => { err += String(b); });
      const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
      const doc = JSON.parse(out) as { result?: { state?: string } };
      check("BASELINE shipped setup exits 0 connected", code === 0 && doc.result?.state === "connected", { code, out, err });
      const idpToken = (await (await fetch(`${idpUrl}/token`, { headers: { authorization: `Bearer ${SESSION}` } })).json() as { token: string }).token;
      const catalogResponse = await fetch(`${svc[0]!.publicUrl!.replace(/\/$/, "")}/manager-instances`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idpToken }) });
      const catalog = await catalogResponse.json() as { complete?: boolean; instances?: unknown[] };
      check("BASELINE owner's complete Manager catalog is empty", catalogResponse.ok && catalog.complete === true && catalog.instances?.length === 0, catalog);
      const callerResponse = await fetch(`${svc[0]!.publicUrl!.replace(/\/$/, "")}/exchange`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idpToken, actor: "cli", view: "manager-caller" }) });
      const refusal = await callerResponse.json() as { error?: string; code?: string };
      check("BASELINE manager-caller has no Manager to call", !callerResponse.ok, { status: callerResponse.status, ...refusal });
      console.log(`  BASELINE connected setup exit=${code}, complete catalog instances=${catalog.instances?.length}, manager-caller HTTP=${callerResponse.status}`);
    });

    await cell("C17b setup stops at the space's own refusal and connects nothing", async () => {
      // A refused proposal is not a wait: nothing is pending, so this is a refusal at the register
      // step and the connect step never runs.
      const lines: string[] = [];
      let failure: Record<string, any> | undefined;
      try {
        await runSetup({ paths, daemonHome: undefined, noManager: true, space: DENY, peerUid, peerPid, waitSeconds: 60,
          report: (l) => lines.push(l), onPrompt: () => { throw new Error("setup asked for a sign-in it did not need"); } });
      } catch (e) { failure = e as Record<string, any>; }
      check("C17b it refuses rather than claiming a connection", failure?.outcome === "refused" && failure?.code === "PERMISSION_DENIED", failure && { outcome: failure.outcome, code: failure.code });
      check("C17b it carries the space's own reason as the native code", (failure?.detail?.native?.code ?? failure?.native?.code) === "PROPOSAL_REFUSED", { native: failure?.detail?.native ?? failure?.native });
      check("C17b it stopped before the connect step, so it printed no connect line", !lines.some((l) => l.startsWith("connect: ")), lines);
      check("C17b it recorded no resume intent for a space it never connected", !existsSync(intentFile(DENY)));
      const refused = await cli(["setup", "--no-manager", `--space=${DENY}`, "--wait", "30"]);
      check("C17b shipped setup refuses before connect and retains JSON failure", refused.status === 2 && refused.doc?.error?.code === "PERMISSION_DENIED"
        && refused.doc?.error?.cause?.code === "PROPOSAL_REFUSED" && !/^connect: /m.test(refused.err), refused);
      check("C17b the space it did connect is untouched", stateOf(await statusS(ON)) === "connected");
    });

    await cell("C17c setup stops on local record damage without waiting for an owner", async () => {
      const file = join(home, "daemon", regFile(ON)!);
      const original = readFileSync(file);
      const marker = "PRIVATE_SETUP_RECORD_MARKER";
      for (const phase of ["before-registration", "before-connect"]) {
        await disconnectS(ON);
        const lines: string[] = [];
        let failure: Record<string, any> | undefined;
        try {
          if (phase === "before-registration") writeFileSync(file, marker);
          const started = Date.now();
          try {
            await runSetup({ paths, daemonHome: undefined, noManager: true, space: ON, peerUid, peerPid, waitSeconds: 60,
              report: (line) => { lines.push(line); if (phase === "before-connect" && line.startsWith("register: ")) writeFileSync(file, marker); },
              onPrompt: () => { throw new Error("setup asked for an unnecessary sign-in"); } });
          } catch (e) { failure = e as Record<string, any>; }
          check(`C17c ${phase} refuses local state without the approval wait`, failure?.outcome === "refused" && failure?.code === "CONFLICT" && failure?.native?.code === "LOCAL_STATE_ERROR" && Date.now() - started < 5000, failure && { outcome: failure.outcome, code: failure.code, native: failure.native });
          check(`C17c ${phase} keeps the damaged record private and creates no resume intent`, readFileSync(file, "utf8") === marker && !JSON.stringify({ lines, message: failure?.message }).includes(marker) && !existsSync(intentFile(ON)));
        } finally { writeFileSync(file, original); }
        const restored = await connectS(ON);
        check(`C17c ${phase} restores the same registration and serves again`, stateOf(restored) === "connected" && readFileSync(file).equals(original) && (await probeMachine()).reply.ok);
      }
    });

    await cell("C16 an authority without issuer identity cannot start a serving daemon", async () => {
      await disconnectS(ON);
      withoutIssuer.add(ON);
      try {
        const r = await connectS(ON);
        check("C16 missing pinned issuer identity refuses connection", stateOf(r) === "unavailable", r);
        check("C16 status remains unavailable", stateOf(await statusS(ON)) === "unavailable");
      } finally { withoutIssuer.delete(ON); }
      const r = await connectS(ON);
      check("C16 restored authority identity permits the same registration", stateOf(r) === "connected", r);
      const reply = await probeMachine();
      check("C16 restored connection actually serves", reply.reply.ok && reply.reply.data === null);
    });

    await cell("C14 the shipped daemon diagnoses damaged ready and renewal records", async () => {
      await d.close();
      const env = { PATH: process.env.PATH ?? "", HOME: home, XDG_RUNTIME_DIR: rtDir, COTAL_HOME: home, COTAL_SKIP_CONNECTOR_SEED: "1", DO_NOT_TRACK: "1", NO_COLOR: "1" };
      const cli = async (mode: string) => {
        const child = spawn(process.execPath, [join(repo, "bin", "dist", "cotal.js"), "daemon", mode, "--space", ON, "--json"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
        let out = "", err = "";
        child.stdout.on("data", (b) => { out += String(b); }); child.stderr.on("data", (b) => { err += String(b); });
        const timer = setTimeout(() => child.kill("SIGKILL"), 40_000);
        const status = await new Promise<number | null>((r) => child.once("exit", r)); clearTimeout(timer);
        let doc: Record<string, any> = {};
        try { doc = JSON.parse(out) as Record<string, any>; } catch { /* asserted below */ }
        return { status, doc, out, err };
      };
      const marker = "PRIVATE_SERVICE_RECORD_MARKER";
      let crashed = false;
      try {
        for (const kind of ["daemon-ready", "service-renewal"]) {
          const files = filesUnder(daemonDir).filter((p) => p.includes(kind) && p.endsWith(".json"));
          check(`C14 instrument: one ${kind} record exists`, files.length === 1, files);
          if (files.length !== 1) continue;
          const target = join(daemonDir, files[0]!);
          const ids = (raw: string) => {
            const o = JSON.parse(raw) as Record<string, unknown>;
            return JSON.stringify(kind === "daemon-ready" ? [o.requestId] : [o.activateRequestId, o.renewRequestId]);
          };
          for (const damaged of [`not-json ${marker}`, JSON.stringify({ v: 1, secret: marker })]) {
            const original = readFileSync(target, "utf8"), originalIds = ids(original);
            writeFileSync(target, damaged, { mode: 0o600 });
            // Damage exists before startup, so this exercises automatic resume as well as retry.
            const child = spawn(process.execPath, [join(repo, "bin", "dist", "cotal.js"), "daemon", "serve"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
            let childErr = ""; child.stderr!.on("data", (b) => { childErr += String(b); });
            const childExit = new Promise<number | null>((r) => child.once("exit", r));
            try {
              for (let i = 0; i < 100 && !existsSync(paths.socket); i++) await sleep(100);
              const resumed = await waitState(ON, (s) => s === "unavailable" || s === "local-state-error", 30_000);
              check(`C14 ${kind} resume identifies local state`, resumed === "local-state-error", { resumed });
              for (const mode of ["service-status", "service-connect"]) {
                const c = await cli(mode);
                check(`C14 ${kind} ${mode} reports a local conflict`, c.status === 2 && c.doc.error?.code === "CONFLICT" && c.doc.error?.cause?.code === "LOCAL_STATE_ERROR", { status: c.status, error: c.doc.error });
                check(`C14 ${kind} ${mode} preserves damaged bytes and hides them`, readFileSync(target, "utf8") === damaged && !(c.out + c.err).includes(marker));
              }
              let unanswered = false;
              try { await probeMachine(); } catch (e) { unanswered = unansweredRequest(e); }
              check(`C14 ${kind} failure leaves no live responder`, unanswered);
              const exited = await Promise.race([childExit, sleep(5000).then(() => "running" as const)]);
              check(`C14 ${kind} failure leaves the shipped daemon running`, exited === "running", { exited });
              writeFileSync(target, original, { mode: 0o600 });
              const again = await cli("service-connect");
              check(`C14 restoring ${kind} reconnects with the same request ids`, again.status === 0 && again.doc.result?.state === "connected" && ids(readFileSync(target, "utf8")) === originalIds, { status: again.status, state: again.doc.result?.state });
              const probe = await probeMachine();
              check(`C14 restoring ${kind} serves an authorized caller`, probe.reply.ok && probe.reply.data === null);
              check(`C14 ${kind} never exposes tokens or damaged contents on stderr`, !childErr.includes(marker) && ![SESSION, ...jwtsIssued].some((t) => childErr.includes(t)) && !/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./.test(childErr));
            } finally {
              if (child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); await childExit; }
              // Restore after shutdown only if a failing cell left the damaged fixture behind.
              if (readFileSync(target, "utf8") === damaged) writeFileSync(target, original, { mode: 0o600 });
              crashed = child.exitCode !== 0 && existsSync(paths.socket);
            }
          }
        }
      } finally {
        d = await serveDaemon({ paths, version: fixtureVersion, peerUid, sessionDir: home } as Parameters<typeof serveDaemon>[0]);
        if (crashed) check("C14 the successor recovered the crashed child's socket by itself (1 recovery)", d.counters.socketsRecovered === 1, d.counters);
      }
    });

    await cell("H2 shipped setup recovers rejected cached sessions without relogin on outages", async () => {
      seedUnitReceipt();
      await d.close();
      const sessionSpace = spaces[4]!;
      const sessionHost = svc[4]!.serviceEndpointHost!;
      const sessionOwner = deriveOwnerForIdpSubject((await loadOwnerSecret(ctx[4]!.store, sessionSpace))!, idpOrigin, "machine-owner");
      const cliEntry = join(repo, "bin/dist/cotal.js");
      const env: NodeJS.ProcessEnv = { USER: "smoke", LOGNAME: "smoke", PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"), XDG_RUNTIME_DIR: rtDir, TMPDIR: scratchParent, COTAL_HOME: home, COTAL_SKIP_CONNECTOR_SEED: "1", DO_NOT_TRACK: "1", COTAL_TELEMETRY: "off", NO_COLOR: "1" };
      const cli = async (...args: string[]) => {
        const child = spawn(process.execPath, [cliEntry, "daemon", ...args, "--json"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
        let out = "", err = "";
        child.stdout.on("data", (b) => { out += String(b); }); child.stderr.on("data", (b) => { err += String(b); });
        const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
        return { code, doc: JSON.parse(out) as Record<string, any>, err };
      };
      const start = async () => {
        const child = spawn(process.execPath, [cliEntry, "daemon", "serve"], { cwd: root, env, stdio: ["ignore", "ignore", "ignore"] });
        for (let i = 0; i < 100 && !existsSync(paths.socket) && child.exitCode === null; i++) await sleep(100);
        if (!existsSync(paths.socket)) { await killAndAwaitExit(child, "SIGTERM"); throw new Error("shipped daemon did not bind its socket"); }
        return child;
      };
      let child = await start();
      let otherProviderRequests = 0;
      const otherProvider = createHttpServer((_req, res) => {
        otherProviderRequests++;
        res.writeHead(500); res.end("{}");
      });
      await new Promise<void>((resolve) => otherProvider.listen(0, "127.0.0.1", resolve));
      const otherIdp = `http://127.0.0.1:${(otherProvider.address() as AddressInfo).port}/api/auth`;
      recoverOnApproval = true;
      try {
        deleteIdpSession(home, idpUrl);
        const mismatchBefore = deviceCodeRequests, postsBefore = posts(sessionSpace);
        for (const serviceOnly of [true, false]) {
          const mismatch = await cli("setup", "--space", sessionSpace, "--idp", otherIdp,
            ...(serviceOnly ? ["--no-manager", "--wait", "0"] : []));
          check(`H2 ${serviceOnly ? "service-only" : "Manager"} setup rejects a different provider before approval`,
            mismatch.code === 1 && mismatch.doc.error?.code === "USAGE_INVALID" && mismatch.doc.error?.cause?.code === "IDP_MISMATCH"
            && !mismatch.err.includes("Approval code") && !mismatch.err.includes("signed in as"), mismatch.doc);
          check("H2 mismatch remedy names the pinned provider and matching setup mode",
            String(mismatch.doc.error?.remedy).includes(idpUrl)
            && String(mismatch.doc.error?.remedy).includes("cotal daemon setup --space")
            && String(mismatch.doc.error?.remedy).includes("--no-manager") === serviceOnly, mismatch.doc.error);
        }
        const missingProvider = await cli("setup", "--no-manager", "--space", sessionSpace, "--wait", "0");
        check("H2 omitted provider still requires explicit sign-in", missingProvider.code === 2
          && missingProvider.doc.error?.code === "AUTH_REQUIRED" && missingProvider.doc.error?.cause?.code === "NOT_SIGNED_IN");
        check("H2 refused setup makes no device requests or registration posts",
          otherProviderRequests === 0 && deviceCodeRequests === mismatchBefore && posts(sessionSpace) === postsBefore);
        const login = await cli("setup", "--no-manager", "--space", sessionSpace, "--wait", "0", "--idp", `${idpUrl}/`);
        check("H2 normalized matching provider starts one device approval and reaches registration",
          login.code === 4 && login.doc.error?.cause?.code === "APPROVAL_PENDING"
          && deviceCodeRequests === mismatchBefore + 1 && otherProviderRequests === 0, login.doc);
        idpRevoked = true;
        console.log("  H2 waiting past the stock 60-second JWT cache cap");
        await sleep(61_000);
        const setupArgs = ["setup", "--no-manager", "--space", sessionSpace, "--wait", "0"];
        const before = deviceCodeRequests;
        const rejected = await cli("connect-check", "--space", sessionSpace);
        const missing = await cli(...setupArgs);
        check("H2 rejected cached session refuses connect-check and setup without --idp", rejected.code === 2 && rejected.doc.error?.code === "AUTH_REQUIRED" && missing.code === 2 && missing.doc.error?.code === "AUTH_REQUIRED" && deviceCodeRequests === before);
        const recovered = await cli(...setupArgs, "--idp", idpUrl);
        check("H2 revoked session starts one new device sign-in and reaches registration", deviceCodeRequests === before + 1 && recovered.err.includes("Approval code") && recovered.code === 4 && recovered.doc.error?.code === "OPERATION_PARTIAL" && recovered.doc.error?.cause?.code === "APPROVAL_PENDING", { code: recovered.code, error: recovered.doc.error });
        await approve(sessionHost, sessionSpace, sessionOwner);
        const validBefore = deviceCodeRequests;
        const valid = await cli(...setupArgs, "--idp", idpUrl);
        check("H2 valid session reuses sign-in and connects after approval", valid.code === 0 && valid.doc.result?.state === "connected" && deviceCodeRequests === validBefore && valid.doc.result?.steps?.some((step: { step: string; outcome: string }) => step.step === "sign-in" && step.outcome === "already-signed-in"), { code: valid.code, error: valid.doc.error });
        await cli("service-disconnect", "--space", sessionSpace);
        await killAndAwaitExit(child, "SIGTERM");
        saveIdpSession(home, idpUrl, { token: SESSION, expiresAt: 1, sub: "machine-owner" });
        idpRevoked = true;
        child = await start();
        for (const failure of ["unreachable", "unusable"] as const) {
          tokenFailure = failure;
          const requests = deviceCodeRequests, authorityPosts = posts(sessionSpace);
          const unavailable = await cli(...setupArgs, "--idp", idpUrl);
          check(`H2 ${failure} provider stops without device login or registration`, unavailable.code === 2 && unavailable.doc.error?.code === "DEPENDENCY_UNAVAILABLE" && deviceCodeRequests === requests && posts(sessionSpace) === authorityPosts && !unavailable.err.includes("already signed in"));
        }
        tokenFailure = undefined;
        const expired = await cli("connect-check", "--space", sessionSpace);
        const expiredBefore = deviceCodeRequests;
        const renewed = await cli(...setupArgs, "--idp", idpUrl);
        check("H2 expired rejected session also signs in once and reconnects", expired.code === 2 && expired.doc.error?.code === "AUTH_REQUIRED" && renewed.code === 0 && renewed.doc.result?.state === "connected" && deviceCodeRequests === expiredBefore + 1);
        await cli("service-disconnect", "--space", sessionSpace);
      } finally {
        tokenFailure = undefined; idpRevoked = false; recoverOnApproval = false;
        await new Promise<void>((resolve, reject) => otherProvider.close((error) => error ? reject(error) : resolve()));
        await killAndAwaitExit(child, "SIGTERM");
        d = await serveDaemon({ paths, version: fixtureVersion, peerUid, sessionDir: home } as Parameters<typeof serveDaemon>[0]);
      }
    });

    await cell("H1 shipped setup hosts an answering Manager independently of machine approval", async () => {
      seedUnitReceipt();
      await d.close();
      const cliLifecycle = grantActor(ctx[0]!.stateDir, { owner: fixture.owner, actor: "cli", scope: ["supervise", "spawn", "run", "role:default"], allowSubscribe: [">"], allowPublish: [">"] }).lifecycleUid!;
      const original = findMesh(ON)!;
      const published = await (await fetch(`${svc[0]!.publicUrl!.replace(/\/$/, "")}/.well-known/cotal-mesh`)).json() as { server: string; tlsRequired?: boolean; userAuth: NonNullable<MeshEntry["userAuth"]> };
      const deliveryStore = new MemoryStore({ kind: "injected", coordinate: `memory:delivery:${ON}` });
      const composition = { injected: true } as const;
      await deliveryStore.put(deliveryCredsKey(ON, composition), await mintCreds(ctx[0]!.auth, newIdentity(), "delivery"));
      await deliveryStore.put(membershipRwCredsKey(ON, composition), await mintCreds(ctx[0]!.auth, newIdentity(), "membership-rw"));
      await deliveryStore.put(membershipObserverCredsKey(ON, composition), await mintMembershipObserverCreds(ctx[0]!.auth, newIdentity()));
      await deliveryStore.put(connectionEvictorCredsKey(ON, composition), await mintConnectionEvictorCreds(ctx[0]!.auth, newIdentity()));
      const delivery = await startDeliveryService({ context: { accountPublicKey: ctx[0]!.auth.account.pub, lifecycleUid: mintLifecycleUid() }, space: ON, servers, store: deliveryStore, storeIdentity: deliveryStore.identity, stateDir: join(root, "delivery") });
      let secondDelivery: Awaited<ReturnType<typeof startDeliveryService>> | undefined;
      // Like remote-manager-goal-reader: this owned loopback stack is plaintext, while the public
      // face advertises production TLS. Pin the fixture transport explicitly, with a warm policy.
      recordMesh({ ...original, server: published.server, tlsRequired: false, policyCheckedAt: new Date(Date.now() + 3600_000).toISOString(), userAuth: { ...published.userAuth, remote: true, sentinelCredsPath: original.userAuth!.sentinelCredsPath } });
      const discovery = { ...published, space: ON, tlsRequired: false, userAuth: { ...published.userAuth, endpoints: { url: `${idpOrigin}/space/${ON}` } } };
      catalogSpace = ON; catalogTarget = svc[0]!.publicUrl!.replace(/\/$/, "");
      catalog = { v: 1, account: { idpUrl, issuer: idpOrigin, sub: "machine-owner" }, spaces: [{ id: ON, slug: ON, name: "Daemon smoke", kind: "team", role: "owner", registration: discovery }] };
      removeMesh(ON);
      check("H0 requested space is absent from local registry before setup", findMesh(ON) === undefined);
      deleteIdpSession(home, idpUrl);
      const prefix = join(root, "config", "cotal", "extensions");
      const pkg = join(prefix, "node_modules", "daemon-smoke-connector");
      mkdirSync(pkg, { recursive: true });
      writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "daemon-smoke-connector", version: "1.0.0", type: "module", main: "index.js", peerDependencies: { "@cotal-ai/core": ">=0.1.0" } }));
      const coreUrl = pathToFileURL(upgrading ? join(root, "global-cli/lib/node_modules/cotal-ai/node_modules/@cotal-ai/core/dist/index.js") : join(repo, "packages/core/dist/index.js")).href;
      const seatScript = join(root, "seat.mjs");
      writeFileSync(seatScript, `import {CotalEndpoint} from ${JSON.stringify(coreUrl)}; import {readFileSync} from 'node:fs'; import {execFile} from 'node:child_process';
const cmd=JSON.parse(process.env.COTAL_BEARER_CMD); const bearer=()=>new Promise((resolve,reject)=>execFile(cmd[0],cmd.slice(1),(e,out)=>e?reject(e):resolve(out.trim())));
const ep=new CotalEndpoint({space:process.env.COTAL_SPACE,servers:process.env.COTAL_SERVERS,bearer,sentinelCreds:readFileSync(process.env.COTAL_SENTINEL_CREDS,'utf8'),lifecycleUid:process.env.COTAL_LIFECYCLE_UID,channels:[],consume:false,card:{owner:process.env.COTAL_OWNER,actor:process.env.COTAL_ACTOR,name:process.env.COTAL_NAME,kind:'agent'}});ep.on('error',()=>{});await ep.start();`);
      writeFileSync(join(pkg, "index.js"), `import {registry} from ${JSON.stringify(coreUrl)}; registry.register({kind:"connector",name:"daemon-smoke",requires:["node"],${process.argv.includes("--dashboard-shape-repro") ? 'eventChannel: p=>"events."+p.owner+"."+p.actor,' : ""}buildLaunch:o=>({command:process.execPath,args:[${JSON.stringify(seatScript)}],env:{PATH:process.env.PATH,HOME:process.env.HOME,XDG_CONFIG_HOME:process.env.XDG_CONFIG_HOME,COTAL_HOME:process.env.COTAL_HOME,COTAL_SKIP_CONNECTOR_SEED:'1',COTAL_SPACE:o.space,COTAL_SERVERS:o.servers,COTAL_NAME:o.name,COTAL_OWNER:o.userAuth.owner,COTAL_ACTOR:o.userAuth.actor,COTAL_SENTINEL_CREDS:o.userAuth.sentinelCredsPath,COTAL_BEARER_CMD:JSON.stringify(o.userAuth.bearerCmd),COTAL_LIFECYCLE_UID:o.lifecycleUid}})});`);
      writeFileSync(join(prefix, "extensions.json"), JSON.stringify({ extensions: [{ pkg: "daemon-smoke-connector", version: "1.0.0", spec: "daemon-smoke-connector@1.0.0", provides: [{ kind: "connector", name: "daemon-smoke" }], commands: [], connectors: [{ name: "daemon-smoke", requires: ["node"], eventPlane: process.argv.includes("--dashboard-shape-repro") }] }] }));
      const cleanSeed = process.argv.includes("--hosted-seed-repro") || process.argv.includes("--daemon-seed-repro");
      if (cleanSeed) rmSync(prefix, { recursive: true });
      else if (!upgrading) {
        const seed = join(root, "config", "cotal", "seed");
        mkdirSync(seed, { recursive: true, mode: 0o700 });
        for (const file of ["authority.json", "authority.bak.json"]) writeFileSync(join(seed, file), JSON.stringify({ everSeeded: ["claude", "opencode", "codex", "hermes", "jcode", "pi", "web"] }));
        writeFileSync(join(seed, "witness.json"), JSON.stringify({ initialized: true, firstGeneration: fixtureVersion }));
        writeFileSync(join(seed, "stamp.json"), JSON.stringify({ generation: fixtureVersion }));
      }
      const env: NodeJS.ProcessEnv = { USER: "smoke", LOGNAME: "smoke", PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"), XDG_RUNTIME_DIR: rtDir, TMPDIR: scratchParent, COTAL_HOME: home, COTAL_SKIP_CONNECTOR_SEED: "1", DO_NOT_TRACK: "1", COTAL_TELEMETRY: "off", NO_COLOR: "1" };
      if (process.argv.includes("--daemon-seed-repro")) env.COTAL_ALLOW_CHECKOUT_SEED = "1";
      if (process.argv.includes("--hosted-seed-repro")) {
        delete env.COTAL_SKIP_CONNECTOR_SEED;
        env.COTAL_ALLOW_CHECKOUT_SEED = "1";
      }
      if (upgrading && !upgradeFixture) throw new Error("upgrade proofs require COTAL_DAEMON_UPGRADE_FIXTURE from build-daemon-upgrade-fixture.mjs");
      let npmRegistry: ReturnType<typeof createHttpServer> | undefined;
      let npmRegistryUrl = "";
      if (process.argv.includes("--update-repro")) {
        npmRegistry = createHttpServer((request, response) => {
          response.setHeader("content-type", "application/json");
          if (request.url?.includes(".tgz")) { response.setHeader("content-type", "application/octet-stream"); response.end(readFileSync(join(upgradeFixture!, "cotal-ai-0.151.3.tgz"))); return; }
          const metadata = JSON.parse(readFileSync(join(upgradeFixture!, "hoisted-fix2-0.151.3/package.json"), "utf8"));
          const bytes = readFileSync(join(upgradeFixture!, "cotal-ai-0.151.3.tgz"));
          response.end(JSON.stringify({ name: "cotal-ai", "dist-tags": { latest: "0.151.3" }, versions: { "0.151.3": { ...metadata, dist: { tarball: `${npmRegistryUrl}/cotal-ai-0.151.3.tgz`, integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` } } } }));
        });
        await new Promise<void>((resolve) => npmRegistry!.listen(0, "127.0.0.1", resolve));
        npmRegistryUrl = `http://127.0.0.1:${(npmRegistry.address() as AddressInfo).port}`;
        env.npm_config_registry = npmRegistryUrl;
      }
      let cliEntry = join(repo, "bin", "dist", "cotal.js");
      const npmRun = async (args: string[]) => {
        const child = spawn("npm", args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
        let output = "";
        child.stdout.on("data", (b) => { output += String(b); }); child.stderr.on("data", (b) => { output += String(b); });
        const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
        console.log("  npm fixture", JSON.stringify({ args, code, output: output.slice(-1500) }));
        if (code !== 0) throw new Error("owned npm fixture install failed");
      };
      const globalPrefix = join(root, "global-cli");
      if (upgrading) {
        await npmRun(["install", "-g", "--prefix", globalPrefix, "--ignore-scripts", join(upgradeFixture!, "cotal-ai-0.151.2.tgz")]);
        cliEntry = join(globalPrefix, "lib/node_modules/cotal-ai/dist/cotal.js");
        seedUnitReceipt(cliEntry, true);
      }
      const connectorUpgrade = process.argv.includes("--upgrade-connectors-repro");
      if (upgrading) {
        const fixturePackage = join(root, "daemon-smoke-connector");
        renameSync(pkg, fixturePackage);
        const adding = spawn(process.execPath, [cliEntry, "ext", "add", fixturePackage], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
        let addingOutput = "";
        adding.stdout.on("data", (b) => { addingOutput += String(b); }); adding.stderr.on("data", (b) => { addingOutput += String(b); });
        const added = await new Promise<number | null>((resolve) => adding.once("exit", resolve));
        if (added !== 0) throw new Error(`owned stand-in ext add failed: ${addingOutput}`);
        const seed = join(root, "config", "cotal", "seed");
        mkdirSync(seed, { recursive: true, mode: 0o700 });
        for (const file of ["authority.json", "authority.bak.json"]) writeFileSync(join(seed, file), JSON.stringify({ everSeeded: [...(connectorUpgrade ? [] : ["claude"]), "opencode", "codex", "hermes", "jcode", "pi", "web"] }));
        writeFileSync(join(seed, "witness.json"), JSON.stringify({ initialized: true, firstGeneration: "0.151.2" }));
        writeFileSync(join(seed, "stamp.json"), JSON.stringify({ generation: "0.151.2" }));
        if (connectorUpgrade) {
        const seedChild = spawn(process.execPath, [cliEntry, "ext", "seed"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
        let output = ""; seedChild.stdout.on("data", (b) => { output += String(b); }); seedChild.stderr.on("data", (b) => { output += String(b); });
        const code = await new Promise<number | null>((resolve) => seedChild.once("exit", resolve));
        const installed = JSON.parse(readFileSync(join(prefix, "extensions.json"), "utf8")).extensions;
        check("U0 actual seed installs one current-generation stock connector", code === 0 && installed.some((entry: { pkg: string; source?: string; version: string }) => entry.pkg === "@cotal-ai/connector-claude-code" && entry.source === "seeded" && entry.version === "0.151.2"), { code, output });
        }
      }
      const cli = async (...args: string[]) => {
        const child = spawn(process.execPath, [cliEntry, "daemon", ...args, ...(explicitHome ? ["--daemon-home", explicitHome] : []), "--json"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
        let out = "", err = "";
        child.stdout.on("data", (b) => { out += String(b); }); child.stderr.on("data", (b) => { err += String(b); });
        const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
        return { code, doc: JSON.parse(out) as Record<string, any>, err };
      };
      const plainCommand = async (...args: string[]) => {
        const process = spawn(globalThis.process.execPath, [cliEntry, "daemon", ...args, "--plain"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
        let out = "", err = "";
        process.stdout.on("data", (b) => { out += String(b); }); process.stderr.on("data", (b) => { err += String(b); });
        const code = await new Promise<number | null>((resolve) => process.once("exit", resolve));
        console.log("  H1 plain stdout", JSON.stringify(out));
        console.log("  H1 plain stderr", JSON.stringify(err));
        return { code, out, err };
      };
      const startDaemon = async (managedHome = explicitHome) => {
        const socket = managedHome ? daemonPathsFor(managedHome, env).socket : paths.socket;
        const servicePath = process.argv.includes("--setup-path-repro") ? JSON.parse(/^Environment=PATH=(.+)$/m.exec(readFileSync(join(root, "config/systemd/user/cotal-daemon.service"), "utf8"))![1]!) as string : env.PATH;
        const child = spawn(process.execPath, [cliEntry, "daemon", "serve", ...(managedHome ? ["--daemon-home", managedHome] : [])], { cwd: root, env: { ...env, PATH: servicePath, COTAL_SKIP_CONNECTOR_SEED: "1", ...(upgrading && (!process.argv.includes("--generation-process-skew-repro") || process.argv.includes("--generation-marked-repro")) ? { COTAL_DAEMON_NATIVE_SERVICE: "1" } : {}) }, stdio: ["ignore", "pipe", "pipe"] });
        child.stdout.resume(); child.stderr.on("data", (chunk) => { if (process.argv.includes("--upgrade-repro") || process.argv.includes("--update-repro")) console.log("  owned daemon", String(chunk).trim()); });
        for (let i = 0; i < 100; i++) { try { await ask(socket, { op: "status" }, 1000); return child; } catch { await sleep(100); } }
        await killAndAwaitExit(child, "SIGTERM");
        throw new Error("shipped daemon did not answer");
      };
      if (process.argv.includes("--setup-no-connectors-repro")) {
        writeFileSync(join(pkg, "index.js"), `import {registry} from ${JSON.stringify(coreUrl)}; registry.register({kind:"connector",name:"daemon-smoke",requires:["cotal-owned-missing-harness"],buildLaunch:()=>{throw new Error("unavailable connector must not launch")}});`);
        const manifest = JSON.parse(readFileSync(join(prefix, "extensions.json"), "utf8"));
        manifest.extensions[0].connectors[0].requires = ["cotal-owned-missing-harness"];
        writeFileSync(join(prefix, "extensions.json"), JSON.stringify(manifest));
      }
      const pathRecovery = process.argv.includes("--setup-path-repro");
      const pathRecording = pathRecovery || process.argv.includes("--setup-no-connectors-repro");
      const pathCalls: string[] = [];
      let pathControl: ReturnType<typeof createHttpServer> | undefined;
      const pathUnit = join(root, "config/systemd/user/cotal-daemon.service");
      const pathReceipt = unitReceiptFile(paths);
      const pathBin = join(root, "path-native");
      const oldBin = join(root, "old-application-bin");
      if (pathRecording) {
        for (const dir of [pathBin, oldBin]) mkdirSync(dir, { mode: 0o700 });
        env.PATH = `${pathBin}:${oldBin}:${env.PATH}`;
        const bytes = readFileSync(pathUnit, "utf8").replace("[Service]\n", `[Service]\nEnvironment=PATH=${JSON.stringify(env.PATH)}\n`);
        writeFileSync(pathUnit, bytes);
        const receipt = JSON.parse(readFileSync(pathReceipt, "utf8"));
        writeFileSync(pathReceipt, JSON.stringify({ ...receipt, unitSha256: createHash("sha256").update(bytes).digest("hex") }));
      }
      if (pathRecovery) {
        writeFileSync(join(oldBin, "old-application"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
        const source = readFileSync(join(pkg, "index.js"), "utf8");
        writeFileSync(join(pkg, "index.js"), source.replace('requires:["node"]', 'requires:["cotal-owned-first-app"]') + "\n" + source.slice(source.indexOf("registry.register")).replace('name:"daemon-smoke"', 'name:"daemon-second"').replace('requires:["node"]', 'requires:["cotal-owned-second-app"]'));
        const manifest = JSON.parse(readFileSync(join(prefix, "extensions.json"), "utf8"));
        manifest.extensions[0].provides.push({ kind: "connector", name: "daemon-second" });
        manifest.extensions[0].connectors = [{ name: "daemon-smoke", requires: ["cotal-owned-first-app"], eventPlane: false, setup: null }, { name: "daemon-second", requires: ["cotal-owned-second-app"], eventPlane: false, setup: null }];
        writeFileSync(join(prefix, "extensions.json"), JSON.stringify(manifest));
      }
      const recoveryBin = join(root, "application-bin");
      mkdirSync(recoveryBin, { mode: 0o700 });
      env.PATH = `${recoveryBin}:${env.PATH}`;
      let child = await startDaemon();
      let recordingRestart = process.argv.includes("--upgrade-repro") || process.argv.includes("--update-repro");
      const watchRecordedRestart = (owned: ChildProcess) => owned.once("exit", (code) => {
        if (recordingRestart && code === 0) void startDaemon().then((next) => { child = next; watchRecordedRestart(next); });
      });
      if (recordingRestart) watchRecordedRestart(child);
      let upgradeControl: ReturnType<typeof createHttpServer> | undefined;
      if (process.argv.includes("--update-repro") || process.argv.includes("--setup-upgrade-repro")) {
        const recorder = join(root, "upgrade-native");
        mkdirSync(recorder, { mode: 0o700 });
        upgradeControl = createHttpServer(async (request, response) => {
          if (request.url === "/stop") { recordingRestart = false; await killAndAwaitExit(child, "SIGTERM"); }
          else if (request.url === "/start") { child = await startDaemon(); recordingRestart = true; watchRecordedRestart(child); }
          else { response.writeHead(404).end(); return; }
          response.end("done");
        });
        await new Promise<void>((resolve) => upgradeControl!.listen(0, "127.0.0.1", resolve));
        const controlPort = (upgradeControl.address() as AddressInfo).port;
        writeFileSync(join(recorder, "systemctl"), `#!${process.execPath}\n(async()=>{const args=process.argv.slice(2).join(' ');if(args==='--user show-environment'){console.log(${JSON.stringify(`XDG_CONFIG_HOME=${join(root, "config")}`)});process.exit(0)}if(!['--user --no-ask-password --no-pager stop cotal-daemon.service','--user --no-ask-password --no-pager start cotal-daemon.service'].includes(args))process.exit(99);const op=args.includes(' stop ')?'stop':'start';const r=await fetch('http://127.0.0.1:${controlPort}/'+op);if(!r.ok)process.exit(99);})();\n`, { mode: 0o700 });
        env.PATH = `${recorder}:${env.PATH}`;
      }
      if (pathRecording) {
        pathControl = createHttpServer(async (request, response) => {
          pathCalls.push(request.url!);
          if (request.url === "/stop") await killAndAwaitExit(child, "SIGTERM");
          else if (request.url === "/start") child = await startDaemon();
          else if (!["/daemon-reload", "/disable"].includes(request.url!)) { response.writeHead(500).end(); return; }
          response.end("done");
        });
        await new Promise<void>(resolve => pathControl!.listen(0, "127.0.0.1", resolve));
        const port = (pathControl.address() as AddressInfo).port;
        writeFileSync(join(pathBin, "systemctl"), `#!${process.execPath}\nconst args=process.argv.slice(2);if(args.join(' ')==='--user show-environment'){console.log(${JSON.stringify(`XDG_CONFIG_HOME=${join(root, "config")}`)});process.exit(0)}const op=args.includes('daemon-reload')?'daemon-reload':args.at(-2);if(!['stop','start','disable','daemon-reload'].includes(op))process.exit(99);fetch('http://127.0.0.1:${port}/'+op).then(r=>{if(!r.ok)process.exit(99)}).catch(()=>process.exit(99));\n`, { mode: 0o700 });
      }
      try {
        if (explicitHome) {
          saveIdpSession(explicitHome, idpUrl, { token: SESSION, expiresAt: Math.floor(Date.now() / 1000) + 3600, sub: "machine-owner" });
          recordMesh({ ...original, server: published.server, tlsRequired: false, policyCheckedAt: new Date(Date.now() + 3600_000).toISOString(), userAuth: { ...published.userAuth, remote: true, sentinelCredsPath: original.userAuth!.sentinelCredsPath } });
        }
        const setup = explicitHome
          ? { code: 0, doc: { result: { launchReady: true, manager: resultOf(await ask(paths.socket, { op: "manager-start", space: ON }, 100_000)) } } as Record<string, any>, err: "" }
          : await cli("setup", "--space", ON, "--idp", idpUrl);
        console.log("  H1 setup", JSON.stringify(setup));
        if (pathRecovery) {
          check("P1 initial setup refuses without applications", setup.code === 2 && setup.doc.error?.cause?.code === "NO_AVAILABLE_CONNECTOR", setup);
          check("P1 remedy names applications in the setup terminal", setup.doc.error?.remedy?.includes("terminal") && !setup.doc.error?.remedy?.includes("daemon's PATH"), setup.doc.error);
          const daemonBefore = child.pid;
          writeFileSync(join(recoveryBin, "cotal-owned-first-app"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
          // The terminal has a new directory and no longer carries the old application's directory.
          env.PATH = env.PATH!.split(":").filter(entry => entry !== oldBin).join(":");
          const recovered = await cli("setup", "--space", ON);
          console.log("  P1 setup after PATH addition", JSON.stringify(recovered));
          check("P1 same setup becomes launch-ready after terminal PATH addition", recovered.code === 0 && recovered.doc.result?.launchReady === true && child.pid !== daemonBefore, recovered);
          if (recovered.code !== 0) return;
          let manager = recovered.doc.result.manager;
          const target = await resolveControlTarget({ space: ON }, "control-caller-privileged", manager.instanceId, { onRefusal: "throw", readOnly: true });
          const client = { versionSkew: (s: string) => s, roster: async () => [] };
          const launched = await askManager(client, ON, servers, "start", { name: "path_seat", agent: "daemon-smoke", events: false, persona: { prompt: "Owned PATH test", subscribe: [], allowSubscribe: [], allowPublish: [], capabilities: [] } }, target.auth, "owner", 40_000, { instanceId: manager.instanceId });
          check("P2 first discovered application launches a real seat", launched.ok, launched.error);
          const secondBin = join(root, "second-application-bin"); mkdirSync(secondBin, { mode: 0o700 });
          writeFileSync(join(secondBin, "cotal-owned-second-app"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
          env.PATH = `${secondBin}:${env.PATH}`;
          const beforeCalls = pathCalls.length, occupiedPid = child.pid;
          const beforeUnit = readFileSync(pathUnit, "utf8"), beforeReceipt = readFileSync(pathReceipt, "utf8");
          const blocked = await cli("setup", "--space", ON);
          console.log("  P2 occupied setup", JSON.stringify(blocked));
          const status = await askManager(client, ON, servers, "managerStatus", undefined, target.auth, "owner", 3000, { instanceId: manager.instanceId });
          check("P2 occupied seat prevents any service mutation or restart", launched.ok && blocked.code === 2 && child.pid === occupiedPid && pathCalls.length === beforeCalls && readFileSync(pathUnit, "utf8") === beforeUnit && readFileSync(pathReceipt, "utf8") === beforeReceipt && status.ok && (status.data as { agentCount?: number })?.agentCount === 1, blocked);
          check("P2 refusal says stop seats then rerun setup", /after the seats stop/.test(blocked.doc.error?.message ?? "") && /setup/.test(blocked.doc.error?.remedy ?? ""), blocked);
          await askManager(client, ON, servers, "stop", { name: "path_seat" }, target.auth, "owner", 10_000, { instanceId: manager.instanceId });
          const second = await cli("setup", "--space", ON);
          console.log("  P3 second application setup", JSON.stringify(second));
          manager = second.doc.result?.manager;
          check("P3 setup discovers second application while first was already available", second.code === 0 && manager?.connectors?.filter((entry: any) => entry.state === "available").length === 2, second);
          const pin = JSON.parse(/^Environment=PATH=(.+)$/m.exec(readFileSync(pathUnit, "utf8"))![1]!) as string;
          check("P4 terminal entries lead and old PATH entries survive", pin.startsWith([...new Set(env.PATH!.split(":"))].join(":")) && pin.split(":").includes(oldBin) && new Set(pin.split(":")).size === pin.split(":").length, pin);
          check("P4 old application still executes through refreshed service PATH", spawnSync("old-application", [], { env: { ...env, PATH: pin } }).status === 0);
          const receipt = JSON.parse(readFileSync(pathReceipt, "utf8"));
          check("P5 receipt digest names actual refreshed unit", receipt.unitPath === pathUnit && receipt.unitSha256 === createHash("sha256").update(readFileSync(pathUnit)).digest("hex"));
          const idlePid = child.pid, idleCalls = pathCalls.length;
          const repeated = await cli("setup", "--space", ON);
          check("P6 no new application leaves service running unchanged", repeated.code === 0 && child.pid === idlePid && pathCalls.length === idleCalls, repeated);
          const removed = await cli("uninstall", "--yes");
          check("P5 uninstall accepts refreshed receipt and removes unit and daemon", removed.code === 0 && !existsSync(pathUnit) && !existsSync(pathReceipt) && !existsSync(paths.socket), removed);
          return;
        }
        if (process.argv.includes("--setup-no-connectors-repro")) {
          check("3A setup refuses no available connector", setup.code === 2 && setup.doc.error?.message?.includes("no available connector") && !!setup.doc.error?.remedy, setup);
          check("setup remedy names the missing agent application", setup.doc.error?.remedy?.includes("cotal-owned-missing-harness"), setup);
          const before = (await cli("status", "--space", ON)).doc.result?.managers?.[0];
          writeFileSync(join(recoveryBin, "cotal-owned-missing-harness"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
          const recovered = await cli("setup", "--space", ON);
          console.log("  setup after application install", JSON.stringify(recovered));
          check("setup after application install restarts idle child and becomes launch-ready", recovered.code === 0 && recovered.doc.result?.launchReady === true && recovered.doc.result?.manager?.pid !== before?.pid && recovered.doc.result?.manager?.connectors?.some((connector: any) => connector.state === "available"), recovered);
          return;
        }
        check(explicitHome ? "Explicit-home manager-start returns answering hosted Manager" : "H1 setup exits 0 with answering hosted Manager", setup.code === 0 && setup.doc.result?.launchReady === true && setup.doc.result?.manager?.state === "answering", setup);
        if (!explicitHome) {
          check("H0 fresh setup prints device URL and code on stderr", setup.err.includes(`${idpOrigin}/approve?code=DAEMON`) && setup.err.includes("Approval code") && setup.err.includes("DAEMON"));
          check("H0 fresh discovery preserves the signed-in step", setup.doc.result?.steps?.some((step: { step: string; outcome: string }) => step.step === "sign-in" && step.outcome === "signed-in"));
        }
        if (setup.doc.result?.manager?.state !== "answering") throw new Error("setup did not become launch-ready");
        const manager = setup.doc.result.manager;
        if (process.argv.includes("--generation-process-skew-repro")) {
          if (!upgrading) throw new Error("generation process skew requires a private installed fixture");
          const metadataFile = join(globalPrefix, "lib/node_modules/cotal-ai/package.json");
          const originalBytes = readFileSync(metadataFile, "utf8");
          const installed = JSON.parse(originalBytes);
          const foreground = process.argv.includes("--generation-foreground-repro");
          const marked = process.argv.includes("--generation-marked-repro");
          if (marked) recordingRestart = false;
          const receipt = unitReceiptFile(paths);
          const savedReceipt = readFileSync(receipt);
          if (foreground) rmSync(receipt);
          try {
            writeFileSync(metadataFile, JSON.stringify({ ...installed, version: "9.9.9" }));
            const stamp = JSON.parse(readFileSync(join(root, "config/cotal/seed/stamp.json"), "utf8"));
            check("Generation instrument: stamp still matches daemon while installation changes", stamp.generation === installed.version, stamp);
            process.kill(manager.pid, "SIGKILL");
            let observed: Record<string, any> | undefined;
            for (let i = 0; i < 40; i++) {
              await sleep(500);
              observed = (await cli("status", "--space", ON)).doc.result?.managers?.[0];
              if (observed?.state === "refused" || observed?.state === "answering" && observed?.pid !== manager.pid) break;
            }
            console.log("Generation replaced-tree restart", JSON.stringify({ installed: "9.9.9", stamp, observed }));
            check("Old daemon refuses replacement-tree child even with matching stamp", observed?.state === "refused" && !observed?.pid && observed.reason.includes(installed.version) && observed.reason.includes("9.9.9"), observed);
            const next = String(observed?.next);
            const homeFlag = explicitHome ? ` --daemon-home ${explicitHome}` : "";
            check("Replacement refusal never prescribes seed repair", !/ext seed/.test(next), observed);
            check("Replacement refusal names usable case-specific installed restart", process.argv.includes("--generation-marked-repro")
              ? next.includes("verified recorded native service will activate") && next.includes("after all hosted seats stop") && next.includes(`cotal daemon status${homeFlag} --space ${ON}`)
              : foreground
              ? next.includes("explicitly stop") && next.includes(`cotal daemon serve${homeFlag}`) && !next.includes("cotal daemon start")
              : next.includes("no verified native launch marker") && next.includes(`cotal daemon setup${homeFlag} --space ${ON}`), observed);
            if (marked) {
              for (let i = 0; i < 100 && child.exitCode === null; i++) await sleep(100);
              check("Verified native daemon releases old generation for activation", child.exitCode === 0, { exitCode: child.exitCode });
            } else {
              await sleep(2500);
              const later = (await cli("status", "--space", ON)).doc.result?.managers?.[0];
              check("Replacement refusal remains childless across later observations", later?.state === "refused" && !later.pid && later.restarts === observed?.restarts, later);
            }
          } finally { writeFileSync(metadataFile, originalBytes); if (foreground) writeFileSync(receipt, savedReceipt); }
          return;
        }
        if (process.argv.includes("--connector-generation-scope-repro")) {
          const launchSeat = async (instance: string, harness: string, name: string) => {
            const seat = spawn(process.execPath, [cliEntry, "spawn", "--on", instance, "--space", ON, "--harness", harness, "--name", name, "--no-events", "--detach", "--json"], { cwd: participant, env, stdio: ["ignore", "pipe", "pipe"] });
            let output = "", error = "";
            seat.stdout.on("data", (chunk) => { output += String(chunk); });
            seat.stderr.on("data", (chunk) => { error += String(chunk); });
            const code = await new Promise<number | null>((resolve) => seat.once("exit", resolve));
            const doc = JSON.parse(output);
            console.log("3B scope launch", JSON.stringify({ instance, harness, name, code, doc, error }));
            return { code, doc, output };
          };
          const control = async (instance: string, op: string, args?: Record<string, unknown>) => {
            const target = await resolveControlTarget({ space: ON }, "control-caller-privileged", instance, { onRefusal: "throw", readOnly: true });
            return askManager({ versionSkew: (text: string) => text, roster: async () => [] }, ON, target.server, op, args, target.auth, "owner", 10_000, { instanceId: instance });
          };
          const manifestFile = join(prefix, "extensions.json");
          const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
          const installSeeded = (packageName: string, connector: string, version: string) => {
            const dir = join(prefix, "node_modules", packageName);
            mkdirSync(dir, { recursive: true });
            writeFileSync(join(dir, "package.json"), JSON.stringify({ name: packageName, version, type: "module", main: "index.js", peerDependencies: { "@cotal-ai/core": ">=0.1.0" } }));
            writeFileSync(join(dir, "index.js"), readFileSync(join(pkg, "index.js"), "utf8").replace('name:"daemon-smoke"', `name:${JSON.stringify(connector)}`));
            const entry = { pkg: packageName, version, spec: `${packageName}@${version}`, source: "seeded", provides: [{ kind: "connector", name: connector }], commands: [], connectors: [{ name: connector, requires: ["node"], eventPlane: false }] };
            const existing = manifest.extensions.findIndex((candidate: { pkg: string }) => candidate.pkg === packageName);
            if (existing < 0) manifest.extensions.push(entry); else manifest.extensions[existing] = entry;
            writeFileSync(manifestFile, JSON.stringify(manifest));
          };
          const original = await launchSeat(manager.instanceId, "daemon-smoke", "generation_original");
          check("Hosted generation instrument: existing third-party seat joined", original.code === 0 && original.doc.result?.readiness === "joined", original);
          installSeeded("@cotal-ai/connector-claude-code", "generation-warm", fixtureVersion);
          const warm = await launchSeat(manager.instanceId, "generation-warm", "generation_warm");
          check("Hosted generation instrument: matching first-party connector loads before store moves", warm.code === 0 && warm.doc.result?.readiness === "joined", warm);
          installSeeded("@cotal-ai/connector-claude-code", "generation-warm", "9.9.9");
          installSeeded("@cotal-ai/connector-codex", "generation-cold", "9.9.9");
          writeFileSync(join(root, "config/cotal/seed/stamp.json"), JSON.stringify({ generation: "9.9.9" }));
          for (const [connector, packageName, name] of [["generation-cold", "@cotal-ai/connector-codex", "generation_cold_refused"], ["generation-warm", "@cotal-ai/connector-claude-code", "generation_warm_refused"]]) {
            const result = await launchSeat(manager.instanceId, connector!, name!);
            check(`Hosted generation ${connector} refuses mismatched new launch with cause and restart`, result.code === 2 && result.doc.result === null && result.output.includes(packageName!) && result.output.includes("9.9.9") && /restart/.test(result.output), result);
            if (result.code === 0) await control(manager.instanceId, "stop", { name });
          }
          const live = await control(manager.instanceId, "managerStatus");
          const row = (await cli("status", "--space", ON)).doc.result?.managers?.[0];
          check("Hosted generation refuses new work without touching existing seats or Manager custody", live.ok && (live.data as { agentCount?: number }).agentCount === 2 && row?.pid === manager.pid && row?.restarts === manager.restarts, { live, row });
          await control(manager.instanceId, "stop", { name: "generation_original" });
          await control(manager.instanceId, "stop", { name: "generation_warm" });
          const hostedPersona = readFileSync(join(home, "daemon", spaceSegment(ON), "manager", ".cotal", "agents", "default.md"), "utf8");
          await cli("service-disconnect", "--space", ON);
          const stockCatalog = join(findMesh(ON)!.root, ".cotal", "agents");
          mkdirSync(stockCatalog, { recursive: true });
          writeFileSync(join(stockCatalog, "default.md"), hostedPersona);
          const stock = spawn(process.execPath, [cliEntry, "manager", "start", "--foreground", "--space", ON], { cwd: participant, env, stdio: ["ignore", "pipe", "pipe"] });
          let diagnostics = "";
          stock.stdout.on("data", (chunk) => { diagnostics += String(chunk); });
          stock.stderr.on("data", (chunk) => { diagnostics += String(chunk); });
          try {
            let selected: Awaited<ReturnType<typeof resolveControlTarget>> | undefined;
            for (let i = 0; i < 120 && stock.exitCode === null; i++) {
              try { selected = await resolveControlTarget({ space: ON }, "control-caller-privileged", undefined, { onRefusal: "throw", readOnly: true }); if (selected.auth.managerInstanceId && selected.auth.managerInstanceId !== manager.instanceId) break; } catch { /* stock entry is still starting */ }
              await sleep(250);
            }
            const instance = selected?.auth.managerInstanceId;
            if (!instance || instance === manager.instanceId) throw new Error(`stock Manager did not answer: ${diagnostics.slice(-1500)}`);
            const launched = await launchSeat(instance, "generation-cold", "generation_stock");
            check("Stock Manager also refuses a changed first-party generation with restart guidance", launched.code === 2 && launched.doc.result === null && launched.output.includes("9.9.9") && launched.output.includes(fixtureVersion) && /restart/.test(launched.output), launched);
            if (launched.code === 0) await control(instance, "stop", { name: "generation_stock" });
          } finally { await killAndAwaitExit(stock, "SIGTERM"); }
          const handoff = spawn(process.execPath, [cliEntry, "__machine-manager", "--space", ON, "--runtime", "pty", "--console-port", "0", "--session-directory", home, "--expected-connector-generation", "9.9.9"], { cwd: participant, env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
          let handoffOutput = "";
          handoff.stdout?.on("data", (chunk) => { handoffOutput += String(chunk); });
          handoff.stderr?.on("data", (chunk) => { handoffOutput += String(chunk); });
          try {
            const code = await Promise.race([new Promise<number | null>((resolve) => handoff.once("exit", resolve)), sleep(15_000).then(() => "timeout" as const)]);
            check("Machine entry refuses a handed generation different from its loaded implementation", code !== "timeout" && code !== 0 && handoffOutput.includes("expected connector generation 9.9.9") && handoffOutput.includes(`loaded generation ${fixtureVersion}`) && handoffOutput.includes("restart"), { code, handoffOutput });
          } finally { await killAndAwaitExit(handoff, "SIGTERM"); }
          return;
        }
        if (process.argv.includes("--setup-unsupported-repro")) {
          const other = ctx[1]!;
          grantActor(other.stateDir, { owner: deriveOwnerForIdpSubject((await loadOwnerSecret(other.store, OFF))!, idpOrigin, "machine-owner"), actor: "cli", scope: ["supervise", "spawn"], allowSubscribe: [], allowPublish: [] });
          const offEntry = findMesh(OFF)!;
          recordMesh({ ...offEntry, tlsRequired: false, policyCheckedAt: new Date(Date.now() + 3600_000).toISOString() });
          const unsupported = await cli("setup", "--space", OFF);
          const human = await plainCommand("setup", "--space", OFF);
          console.log("3A unsupported setup", JSON.stringify({ unsupported, human }));
          check("3A unsupported space reports unsupported machine service", unsupported.doc.result?.state === "unsupported" && human.out.includes("Machine service: unsupported."), { unsupported, human });
          check("3A unsupported service preserves verified sign-in", unsupported.doc.result?.steps?.some((step: { step: string; outcome: string }) => step.step === "sign-in" && step.outcome === "already-signed-in"), unsupported);
          return;
        }
        if (process.argv.includes("--daemon-seed-repro")) {
          const installed = existsSync(join(prefix, "extensions.json")) ? JSON.parse(readFileSync(join(prefix, "extensions.json"), "utf8")).extensions : [];
          check("3A daemon reconciles seven stock packages even when setup skips first-use seed", installed.filter((entry: { source?: string }) => entry.source === "seeded").length === 7, installed);
          return;
        }
        if (process.argv.includes("--stock-persona-repro")) {
          const showDefault = async (instanceId: string) => {
            const process_ = spawn(process.execPath, [cliEntry, "persona", "show", "default", "--on", instanceId, "--space", ON, "--json"], { cwd: participant, env, stdio: ["ignore", "pipe", "pipe"] });
            let output = "";
            process_.stdout.on("data", (chunk) => { output += String(chunk); });
            process_.stderr.on("data", (chunk) => { output += String(chunk); });
            const code = await new Promise<number | null>((resolve) => process_.once("exit", resolve));
            return { code, output };
          };
          const hosted = await showDefault(manager.instanceId);
          await cli("service-disconnect", "--space", ON);
          const stock = spawn(process.execPath, [cliEntry, "manager", "start", "--foreground", "--space", ON], { cwd: participant, env, stdio: ["ignore", "pipe", "pipe"] });
          let diagnostics = "";
          stock.stdout.on("data", (chunk) => { diagnostics += String(chunk); });
          stock.stderr.on("data", (chunk) => { diagnostics += String(chunk); });
          try {
            let selected: Awaited<ReturnType<typeof resolveControlTarget>> | undefined;
            for (let i = 0; i < 120 && stock.exitCode === null; i++) {
              try { selected = await resolveControlTarget({ space: ON }, "control-caller-privileged", undefined, { onRefusal: "throw", readOnly: true }); if (selected.auth.managerInstanceId) break; } catch { /* original stock entry has not answered yet */ }
              await sleep(250);
            }
            if (!selected?.auth.managerInstanceId) throw new Error(`stock manager start never answered: ${diagnostics.slice(-1500)}`);
            const fresh = await showDefault(selected.auth.managerInstanceId);
            console.log("  3A stock default parity", JSON.stringify({ hosted, stock: fresh, stockInstance: selected.auth.managerInstanceId }));
            check("3A stock manager-start and hosted default have the same owner readability", hosted.code === 2 && fresh.code === hosted.code && hosted.output.includes("TARGET_NOT_FOUND") && fresh.output.includes("TARGET_NOT_FOUND"), { hosted, fresh });
          } finally { await killAndAwaitExit(stock, "SIGTERM"); }
          return;
        }
        if (process.argv.includes("--dashboard-shape-repro")) {
          const webLifecycle = grantActor(ctx[0]!.stateDir, { owner: fixture.owner, actor: "web", scope: ["spawn", "run", "role:default"], allowSubscribe: [">"], allowPublish: [">"] }).lifecycleUid!;
          const view = await cotalAuthProvider.userCredentials({ store: workspaceSecretStore(findMesh(ON)!.root), dir: userAuthStateDir(findMesh(ON)!.root, ON), space: ON, actor: "web", view: "manager-caller", managerInstanceId: manager.instanceId });
          const target = { server: findMesh(ON)!.server, auth: { bearer: view.bearer, sentinelCreds: view.sentinelCreds, epCaller: { owner: fixture.owner, actor: "web", uid: webLifecycle } } };
          const options = standaloneConnectOpts({ bearer: target.auth.bearer, sentinelCreds: target.auth.sentinelCreds, tls: false });
          const nc = await connectNats({ servers: target.server, ...options });
          try {
            const caller = await issuedUserCaller(nc, ON, String(options.name), target.auth.epCaller!);
            const service = await resolveService(nc, ON, "manager", caller, { instanceId: manager.instanceId });
            const call = async (command: string, args?: Record<string, unknown>) => {
              const reply = await invokeCommand(nc, ON, service, command, args, { deadlineMs: 40_000 });
              check(`Dashboard ${command} answers from pinned hosted instance`, reply.reply.ok && reply.responder.instanceId === manager.instanceId, reply.reply);
              return reply.reply.ok ? reply.reply.data as any : undefined;
            };
            const personaName = `cloud_${createHash("sha256").update("owned dashboard proof").digest("hex").slice(0, 16)}`;
            check("Dashboard caller uses owner web actor distinct from daemon cli", caller.owner === fixture.owner && caller.actor === "web", caller);
            await call("list-personas");
            await call("define-persona", { name: personaName, persona: "Owned dashboard launch proof." });
            const saved = await call("show-persona", { name: personaName });
            check("Dashboard defined persona is readable by its owner web caller", JSON.stringify(saved).includes("Owned dashboard launch proof."), saved);
            await call("resolve-agent", { name: personaName, agent: "daemon-smoke" });
            await call("models", {});
            const liveStatus = await call("status");
            check("Dashboard resolved harness is available before Launch", liveStatus?.connectors?.some((row: any) => row.agent === "daemon-smoke" && row.state === "available"), liveStatus);
            const launched = await call("spawn", { name: personaName, agent: "daemon-smoke" });
            console.log("  Dashboard exact spawn result", JSON.stringify(launched));
            let terminal: any;
            for (let i = 0; i < 120 && launched?.goalId; i++) {
              const result = await invokeCommand(nc, ON, service, "goal-result", { goalId: launched.goalId }, { deadlineMs: 5000 });
              terminal = result.reply.ok ? result.reply.data : result.reply.error;
              if (typeof terminal?.result?.state === "string") break;
              await sleep(250);
            }
            console.log("  Dashboard exact spawn terminal", JSON.stringify(terminal));
            check("Dashboard exact spawn shape observes owned seat join", terminal?.result?.state === "succeeded" && terminal?.result?.committer?.instanceId === manager.instanceId, terminal);
          } finally { await nc.drain(); }
          const selected = await resolveControlTarget({ space: ON }, "control-caller-privileged", manager.instanceId, { onRefusal: "throw", readOnly: true });
          await askManager({ versionSkew: (text: string) => text, roster: async () => [] }, ON, selected.server, "stop", { name: `cloud_${createHash("sha256").update("owned dashboard proof").digest("hex").slice(0, 16)}` }, selected.auth, "owner", 10_000, { instanceId: manager.instanceId });
          return;
        }
        if (process.argv.includes("--ipc-health-repro")) {
          await sleep(1500);
          const before = catalogAuthorityRequests;
          await sleep(11_000);
          check("3A periodic hosted liveness makes no authority calls", catalogAuthorityRequests === before, { before, after: catalogAuthorityRequests });
          catalogAuthorityDown = true;
          try { await sleep(8000); }
          finally { catalogAuthorityDown = false; }
          let after = resultOf(await ask(paths.socket, { op: "manager-status", space: ON }, 5000));
          for (let i = 0; i < 80 && after.state !== "answering"; i++) { await sleep(250); after = resultOf(await ask(paths.socket, { op: "manager-status", space: ON }, 5000)); }
          check("3A authority outage never restarts a healthy IPC-responsive hosted Manager", after.state === "answering" && after.pid === manager.pid && after.restarts === manager.restarts, after);
          return;
        }
        if (process.argv.includes("--prepare-observation-repro")) {
          process.kill(manager.pid, "SIGSTOP");
          try {
            const frozen = resultOf(await ask(paths.socket, { op: "manager-status", space: ON }, 10_000));
            check("6217 failed observation withdraws answering", frozen.state === "starting", frozen);
            const prepared = ask(paths.socket, { op: "managers-prepare-restart" }, 30_000);
            setTimeout(() => process.kill(manager.pid, "SIGCONT"), 500);
            const result = await prepared;
            check("6217 preparation reobserves a recovered child instead of trusting stale failure", result.ok === true, result);
            await ask(paths.socket, { op: "managers-abort-restart" }, 30_000);
          } finally { process.kill(manager.pid, "SIGCONT"); }
          const after = resultOf(await ask(paths.socket, { op: "manager-status", space: ON }, 10_000));
          check("6217 preparation keeps the original Manager alive", after.pid === manager.pid && after.state === "answering", after);
          process.kill(manager.pid, "SIGSTOP");
          try {
            const refused = await ask(paths.socket, { op: "managers-prepare-restart" }, 45_000);
            const error = refused.error as { message?: string; remedy?: string } | undefined;
            check("6217 unavailable preparation names its actual condition and retry", refused.ok === false && String(error?.message).includes("generation request") && String(error?.remedy).includes("same command again"), refused);
          } finally { process.kill(manager.pid, "SIGCONT"); }
          return;
        }
        if (process.argv.includes("--fresh-status-repro")) {
          process.kill(manager.pid, "SIGSTOP");
          try {
            const service = await cli("service-status", "--space", ON);
            const direct = resultOf(await ask(paths.socket, { op: "manager-status", space: ON }, 30_000));
            console.log("  R2-6 fresh status results", JSON.stringify({ service, direct }));
            check("R2-6 immediate service-status probes instead of returning remembered success", service.code !== 0 && service.doc.error?.remedy?.includes(ON), service);
            check("R2-6 manager-status observes failed pinned instance", direct.state !== "answering" && direct.instanceId === manager.instanceId && typeof direct.reason === "string", direct);
          } finally { process.kill(manager.pid, "SIGCONT"); }
          const recovered = await cli("service-status", "--space", ON);
          check("R2-6 next service-status freshly confirms restored same instance", recovered.code === 0 && recovered.doc.result?.manager?.instanceId === manager.instanceId && recovered.doc.result?.manager?.state === "answering", recovered);
          return;
        }
        if (process.argv.includes("--fence-exit-repro")) {
          const prepared = await ask(paths.socket, { op: "managers-prepare-restart" }, 30_000);
          check("R2-9 instrument: real hosted generation fence is held", prepared.ok === true, prepared);
          process.kill(manager.pid, "SIGKILL");
          await sleep(500);
          const during = resultOf(await ask(paths.socket, { op: "manager-status", space: ON }));
          check("R2-9 child exit under pending fence withdraws answering and records signal", during.state !== "answering" && String(during.lastExit).includes("SIGKILL"), during);
          await ask(paths.socket, { op: "managers-abort-restart" }, 30_000);
          let after: Record<string, any> = {};
          for (let i = 0; i < 120; i++) {
            after = resultOf(await ask(paths.socket, { op: "manager-status", space: ON }));
            if (after.state === "answering" && after.pid !== manager.pid) break;
            await sleep(250);
          }
          check("R2-9 rollback reschedules exited hosted Manager", after.state === "answering" && after.pid !== manager.pid, after);
          return;
        }
        if (process.argv.includes("--renewal-abort-repro")) {
          const initial = standingRenewals;
          for (let i = 0; i < 180 && standingRenewals === initial; i++) await sleep(250);
          check("R2-2 remote standing renewal runs before preservation", standingRenewals > initial, { initial, standingRenewals });
          const prepared = await ask(paths.socket, { op: "managers-prepare-restart" }, 30_000);
          const aborted = await ask(paths.socket, { op: "managers-abort-restart" }, 30_000);
          check("R2-2 real hosted preservation fence prepares and aborts", prepared.ok === true && aborted.ok === true, { prepared, aborted });
          const atAbort = standingRenewals;
          process.kill(child.pid!, "SIGSTOP");
          try { await sleep(32_000); }
          finally { process.kill(child.pid!, "SIGCONT"); }
          console.log("  R2-2 renewal counts", JSON.stringify({ initial, atAbort, after: standingRenewals }));
          check("R2-2 remote standing renewal continues after aborted preservation", standingRenewals > atAbort, { atAbort, standingRenewals });
          return;
        }
        if (process.argv.includes("--hosted-login-repro")) {
          const managedHome = join(root, "login-home");
          mkdirSync(managedHome, { mode: 0o700 });
          const managedPaths = daemonPathsFor(managedHome, env);
          saveIdpSession(managedHome, idpUrl, { token: SESSION, expiresAt: Math.floor(Date.now() / 1000) + 3600, sub: "machine-owner" });
          const owned = await startDaemon(managedHome);
          try {
            idpRevoked = true;
            const refusal = resultOf(await ask(managedPaths.socket, { op: "manager-start", space: ON }, 100_000));
            check("3A explicit-home login reason and Next target the owning daemon", refusal.state === "refused" && refusal.reason?.includes(`--daemon-home ${managedHome}`) && refusal.next?.includes(`--daemon-home ${managedHome}`), refusal);
          } finally { idpRevoked = false; await killAndAwaitExit(owned, "SIGTERM"); }
          await cli("service-disconnect", "--space", ON);
          idpRevoked = true;
          let missing: Record<string, any>;
          try { missing = resultOf(await ask(paths.socket, { op: "manager-start", space: ON }, 100_000)); }
          finally { idpRevoked = false; }
          const remedy = `cotal daemon login --idp ${idpUrl}`;
          console.log("  HM009 login refusal", JSON.stringify(missing));
          check("HM009 sign-in refusal names same daemon login in reason and Next", missing.state === "refused" && missing.reason?.includes(remedy) && missing.next?.includes(remedy), missing);
          return;
        }
        if (process.argv.includes("--hosted-corrupt-repro")) {
          const corruptSpace = `${ON}-corrupt`;
          const corruptDir = join(home, "daemon", spaceSegment(corruptSpace));
          mkdirSync(corruptDir, { recursive: true, mode: 0o700 });
          for (const name of ["manager-host.json", "manager-refusal.json"]) {
            const file = join(corruptDir, name);
            writeFileSync(file, "not-json", { mode: 0o600 });
            const all = await cli("status");
            console.log("  HM008 running corruption", JSON.stringify({ name, all }));
            const rows = all.doc.result?.managers ?? [];
            check(`HM008 ${name} status isolates corrupt space with named file`, all.code === 0 && rows.some((row: any) => row.space === corruptSpace && row.state === "refused" && row.reason?.includes(file)) && rows.some((row: any) => row.space === ON && row.state === "answering"), all);
            rmSync(file);
          }
          const intent = join(home, "daemon", spaceSegment(ON), "manager-host.json");
          const recorder = join(root, "corrupt-native");
          mkdirSync(recorder, { mode: 0o700 });
          writeFileSync(join(recorder, "systemctl"), `#!${process.execPath}\nif(process.argv.slice(2).join(' ')==='--user show-environment'){console.log(${JSON.stringify(`XDG_CONFIG_HOME=${join(root, "config")}`)});process.exit(0)}\nif(process.argv.slice(2).join(' ')!=='--user --no-ask-password --no-pager start cotal-daemon.service')process.exit(99);\n`, { mode: 0o700 });
          env.PATH = `${recorder}:${env.PATH}`;
          writeFileSync(intent, "not-json", { mode: 0o600 });
          const repaired = await cli("setup", "--space", ON);
          console.log("  HM008 setup repair", JSON.stringify(repaired));
          check("HM008 setup repairs live corrupt hosting record without internal output error", repaired.code === 0 && repaired.doc.result?.launchReady === true && JSON.parse(readFileSync(intent, "utf8")).space === ON, repaired);
          const refusal = join(home, "daemon", spaceSegment(ON), "manager-refusal.json");
          writeFileSync(refusal, "not-json", { mode: 0o600 });
          await killAndAwaitExit(child, "SIGTERM");
          child = await startDaemon();
          const restarted = await cli("status");
          check("HM008 corrupt refusal survives restart as a named per-space refusal", restarted.code === 0 && restarted.doc.result?.managers?.some((row: any) => row.space === ON && row.state === "refused" && row.reason?.includes(refusal)), restarted);
          const repairedRefusal = await cli("setup", "--space", ON);
          check("HM008 setup repairs restarted refusal and restores readiness", repairedRefusal.code === 0 && repairedRefusal.doc.result?.launchReady === true && !existsSync(refusal), repairedRefusal);
          await killAndAwaitExit(child, "SIGTERM");
          const timeout = await cli("setup", "--space", ON);
          check("HM008 actual daemon start timeout emits supported dependency refusal", timeout.code === 2 && timeout.doc.outcome === "refused" && timeout.doc.error?.code === "DEPENDENCY_UNAVAILABLE" && !JSON.stringify(timeout).includes("internal error"), timeout);
          return;
        }
        if (process.argv.includes("--hosted-seed-repro")) {
          const manifest = join(prefix, "extensions.json");
          const installed = existsSync(manifest) ? JSON.parse(readFileSync(manifest, "utf8")).extensions : [];
          console.log("  HM003 connectors after fresh setup", JSON.stringify(installed.map((entry: { pkg: string; source?: string; version: string }) => ({ pkg: entry.pkg, source: entry.source, version: entry.version }))));
          check("HM003 fresh setup reconciles stock connector packages before readiness", installed.filter((entry: { source?: string }) => entry.source === "seeded").length === 7);
          return;
        }
        if (!process.argv.includes("--skip-default-probe")) {
          const statusPlain = await plainCommand("status");
          console.log("  HM001 plain daemon status", JSON.stringify(statusPlain));
          check("HM001 plain status exposes hosted Manager and instance", statusPlain.code === 0 && statusPlain.out.includes(manager.instanceId) && statusPlain.out.includes("Manager"), statusPlain);
          const defaultLaunch = spawn(process.execPath, [cliEntry, "spawn", "--on", manager.instanceId, "--space", ON, "--harness", "daemon-smoke", "--no-events", "--detach", "--json"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
          let out = "", err = "";
          defaultLaunch.stdout.on("data", (b) => { out += String(b); }); defaultLaunch.stderr.on("data", (b) => { err += String(b); });
          const code = await new Promise<number | null>((resolve) => defaultLaunch.once("exit", resolve));
          console.log("  HM002 default launch", JSON.stringify({ code, out, err }));
          check("HM002 default spawn joins after setup alone", code === 0 && JSON.parse(out).result?.readiness === "joined", { code, out, err });
          if (process.argv.includes("--hosted-stopped-repro")) {
            const observed = (await cli("status", "--space", ON)).doc.result?.managers?.[0];
            await cli("service-disconnect", "--space", ON);
            const stopped = (await cli("status", "--space", ON)).doc.result?.managers?.[0];
            const refused = await plainCommand("service-status", "--space", ON);
            console.log("  HM006 stopped observation", JSON.stringify({ observed, stopped, refused }));
            check("HM006 stopped status retains instance and last observation", stopped?.state === "stopped" && stopped?.instanceId === observed?.instanceId && stopped?.observedAt === observed?.observedAt, stopped);
            check("HM006 stopped service-status names setup remedy", refused.code !== 0 && refused.err.includes(`cotal daemon setup --space ${ON}`), refused);
            return;
          }
          if (process.argv.includes("--hosted-health-repro")) {
            const before = (await cli("status", "--space", ON)).doc.result?.managers?.[0];
            process.kill(manager.pid, "SIGSTOP");
            try {
              await sleep(25_000);
              const after = (await cli("status", "--space", ON)).doc.result?.managers?.[0];
              const service = await cli("service-status", "--space", ON);
              console.log("  HM007 stopped occupied Manager observation", JSON.stringify({ before, after, service }));
              check("HM007 failed periodic probe withdraws answering and advances observation", after?.state !== "answering" && after?.observedAt > before?.observedAt && after?.instanceId === manager.instanceId && typeof after?.next === "string", after);
              check("HM007 failed hosted health makes service-status nonzero", service.code !== 0, service);
              let alive = false;
              try { process.kill(manager.pid, 0); alive = true; } catch { /* failure reported */ }
              check("HM007 unknown occupied custody is not killed by health recovery", alive && after?.pid === manager.pid, after);
            } finally { process.kill(manager.pid, "SIGCONT"); }
            let recovered: any;
            for (let i = 0; i < 100; i++) {
              recovered = (await cli("status", "--space", ON)).doc.result?.managers?.[0];
              if (recovered?.state === "answering") break;
              await sleep(250);
            }
            check("HM007 periodic probe recovers same occupied instance without setup", recovered?.state === "answering" && recovered?.instanceId === manager.instanceId, recovered);
            const selected = await resolveControlTarget({ space: ON }, "control-caller-privileged", manager.instanceId, { onRefusal: "throw", readOnly: true });
            const reply = await askManager({ versionSkew: (text: string) => text, roster: async () => [] }, ON, selected.server, "managerStatus", undefined, selected.auth, "owner", 3000, { instanceId: manager.instanceId });
            check("HM007 occupied seat survives health outage", reply.ok && (reply.data as { agentCount?: number })?.agentCount === 1, reply);
            await askManager({ versionSkew: (text: string) => text, roster: async () => [] }, ON, selected.server, "stop", { name: "default_agent" }, selected.auth, "owner", 10_000, { instanceId: manager.instanceId });
            catalogAuthorityDown = true;
            try { await sleep(8000); }
            finally { catalogAuthorityDown = false; }
            const empty = (await cli("status", "--space", ON)).doc.result?.managers?.[0];
            check("HM007 authority outage keeps empty IPC-responsive child custody", empty?.pid === manager.pid && empty?.restarts === recovered?.restarts, empty);
            check("HM007 same empty Manager answers after authority returns", empty?.state === "answering" && empty?.instanceId === manager.instanceId, empty);
            return;
          }
          if (process.argv.includes("--generation-cause-repro")) {
            const occupied = await ask(paths.socket, { op: "managers-prepare-restart" }, 30_000);
            console.log("  R2-8 occupied refusal", JSON.stringify(occupied));
            check("R2-8 occupied fence refusal names actual seats and selected space", occupied.ok === false && errorOf(occupied).code === "SEATS_ACTIVE" && String(errorOf(occupied).message).includes(ON) && String(errorOf(occupied).remedy).includes(ON) && /seat/i.test(String(errorOf(occupied).message)), occupied);
            await ask(paths.socket, { op: "managers-abort-restart" }, 30_000);
          }
          const defaultFile = join(home, "daemon", spaceSegment(ON), "manager", ".cotal", "agents", "default.md");
          const editedDefault = `${readFileSync(defaultFile, "utf8")}\nOwned fixture edit.\n`;
          writeFileSync(defaultFile, editedDefault);
          await cli("setup", "--space", ON);
          check("HM002 repeated setup keeps an edited hosted persona", readFileSync(defaultFile, "utf8") === editedDefault);
          const selected = await resolveControlTarget({ space: ON }, "control-caller-privileged", manager.instanceId, { onRefusal: "throw", readOnly: true });
          await askManager({ versionSkew: (text: string) => text, roster: async () => [] }, ON, selected.server, "stop", { name: "default_agent" }, selected.auth, "owner", 10_000, { instanceId: manager.instanceId });
          if (process.argv.includes("--hosted-default-repro")) return;
        }
        const deviceBeforeMissing = deviceCodeRequests;
        const missing = await cli("setup", "--space", `${ON}-missing`, "--idp", idpUrl);
        check("H0 absent space does not repeat a valid provider device sign-in", missing.code === 2 && missing.doc.error?.code === "TARGET_NOT_FOUND" && deviceCodeRequests === deviceBeforeMissing, { missing, deviceCodeRequests, deviceBeforeMissing });
        catalogUnavailable = true;
        try {
          const failedCatalog = await cli("setup", "--space", `${ON}-missing`, "--idp", idpUrl);
          check("H0 failed catalog refresh is dependency refusal, not missing target or new sign-in", failedCatalog.code === 2 && failedCatalog.doc.error?.code === "DEPENDENCY_UNAVAILABLE" && deviceCodeRequests === deviceBeforeMissing, failedCatalog);
        } finally { catalogUnavailable = false; }
        if (process.argv.includes("--discovery-repro")) return;
        check("H1 setup retains machine-service instanceId separately from Manager", setup.doc.result.instanceId === setup.doc.result.registration?.instanceId && setup.doc.result.instanceId !== manager.instanceId);
        const badWait = await cli("setup", "--space", ON, "--wait", "0");
        check("H1 wait without no-manager refuses usage", badWait.code === 1 && badWait.doc.error?.code === "USAGE_INVALID");
        const log = join(home, "daemon", spaceSegment(ON), "manager", "manager.log");
        check("H1 hosted Manager keeps a private bounded diagnostic log", existsSync(log) && (statSync(log).mode & 0o777) === 0o600 && statSync(log).size <= 1024 * 1024);
        const plain = await plainCommand("setup", "--space", ON);
        check("H1 human success names launch-ready computer, space and instance", plain.code === 0 && plain.out.includes(`Agents can now be launched on this computer from space ${ON} through Manager instance ${manager.instanceId}.`));
        check("HM004 setup uses the same machine-service connection state as status", plain.out.includes(`Machine service: ${setup.doc.result.state}.`), plain.out);
        check("H1 human fields distinguish Manager and machine-service instances", plain.out.includes(`Manager instance: ${manager.instanceId}`) && /Instance:\s+/.test(plain.out));
        const plainStatus = await plainCommand("service-status", "--space", ON);
        check("H1 service-status names independent machine service and answering Manager", plainStatus.code === 0 && plainStatus.out.includes("Machine service and Manager") && !plainStatus.out.includes("\nDisconnected\n") && plainStatus.out.includes(manager.instanceId));
        const daemonStatus = await cli("status", "--space", ON);
        console.log("  H1 status JSON", JSON.stringify(daemonStatus.doc));
        check("H1 per-space status carries the same Manager instance", daemonStatus.doc.result?.managers?.[0]?.instanceId === manager.instanceId);
        if (!upgrading) {
          const prepared = await ask(paths.socket, { op: "managers-prepare-restart" });
          const fenced = await ask(paths.socket, { op: "manager-start", space: ON });
          const aborted = await ask(paths.socket, { op: "managers-abort-restart" });
          const resumed = await cli("setup", "--space", ON);
          if (process.argv.includes("--generation-cause-repro")) {
            check("R2-8 pending generation refusal names transition cause", fenced.ok === false && errorOf(fenced).code === "GENERATION_PENDING" && /generation|transition/.test(String(errorOf(fenced).message)), fenced);
            return;
          }
          check("H1 restart fence denies admission and rollback restores fresh readiness", prepared.ok === true && fenced.ok === false && aborted.ok === true && resumed.code === 0 && resumed.doc.result?.manager?.instanceId === manager.instanceId, { prepared, fenced, aborted, resumed });
        }
        if (process.argv.includes("--setup-upgrade-repro")) {
          // Setup only replaces its recorded installation. A different prefix is foreign reuse.
          await npmRun(["install", "-g", "--prefix", globalPrefix, "--ignore-scripts", join(upgradeFixture!, "cotal-ai-0.151.3.tgz")]);
          const setupNew = await cli("setup", "--space", ON);
          const after = await cli("status", "--space", ON);
          check("U3 setup restarts recorded old-generation daemon and restores readiness", setupNew.code === 0 && after.doc.result?.version === "0.151.3" && setupNew.doc.result?.manager?.state === "answering", { setupNew, after });
          return;
        }
        if (process.argv.includes("--upgrade-repro") || process.argv.includes("--update-repro")) {
          let activeTarget: Awaited<ReturnType<typeof resolveControlTarget>> | undefined;
          if (process.argv.includes("--upgrade-active-repro")) {
            activeTarget = await resolveControlTarget({ space: ON }, "control-caller-privileged", manager.instanceId, { onRefusal: "throw", readOnly: true });
            const launched = await askManager({ versionSkew: (text: string) => text, roster: async () => [] }, ON, activeTarget.server, "start", { name: "npm_upgrade_custody", agent: "daemon-smoke", events: false, persona: { prompt: "Owned direct upgrade custody smoke.", subscribe: [], allowSubscribe: [], allowPublish: [], capabilities: [] } }, activeTarget.auth, "owner", 40_000, { instanceId: manager.instanceId });
            check("U1 direct upgrade starts with a real legacy seat", launched.ok, launched.error);
          }
          if (process.argv.includes("--update-repro")) {
            const other = ctx[1]!;
            grantActor(other.stateDir, { owner: deriveOwnerForIdpSubject((await loadOwnerSecret(other.store, OFF))!, idpOrigin, "machine-owner"), actor: "cli", scope: ["supervise", "spawn"], allowSubscribe: [], allowPublish: [] });
            const secondStore = new MemoryStore({ kind: "injected", coordinate: `memory:delivery:${OFF}` });
            await secondStore.put(deliveryCredsKey(OFF, composition), await mintCreds(other.auth, newIdentity(), "delivery"));
            await secondStore.put(membershipRwCredsKey(OFF, composition), await mintCreds(other.auth, newIdentity(), "membership-rw"));
            await secondStore.put(membershipObserverCredsKey(OFF, composition), await mintMembershipObserverCreds(other.auth, newIdentity()));
            await secondStore.put(connectionEvictorCredsKey(OFF, composition), await mintConnectionEvictorCreds(other.auth, newIdentity()));
            secondDelivery = await startDeliveryService({ context: { accountPublicKey: other.auth.account.pub, lifecycleUid: mintLifecycleUid() }, space: OFF, servers, store: secondStore, storeIdentity: secondStore.identity, stateDir: join(root, "second-delivery") });
            const secondEntry = findMesh(OFF)!;
            recordMesh({ ...secondEntry, tlsRequired: false, policyCheckedAt: new Date(Date.now() + 3600_000).toISOString() });
            const second = resultOf(await ask(paths.socket, { op: "manager-start", space: OFF }, 100_000));
            check("U2 a second space has an answering hosted Manager", second.state === "answering", second);
            const secondTarget = await resolveControlTarget({ space: OFF }, "control-caller-privileged", second.instanceId, { onRefusal: "throw", readOnly: true });
            const secondCaller = { versionSkew: (text: string) => text, roster: async () => [] };
            const seat = await askManager(secondCaller, OFF, secondTarget.server, "start", { name: "upgrade_custody", agent: "daemon-smoke", events: false, persona: { prompt: "Owned update custody smoke, no model.", subscribe: [], allowSubscribe: [], allowPublish: [], capabilities: [] } }, secondTarget.auth, "owner", 40_000, { instanceId: second.instanceId });
            check("U2 unselected Manager has a real legacy seat", seat.ok, seat.error);
            for (const flags of [[], ["--self"]]) {
              const blocked = spawn(process.execPath, [cliEntry, "update", ...flags, "--space", ON], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
              let stdout = "", stderr = "";
              blocked.stdout.on("data", (bytes) => { stdout += String(bytes); }); blocked.stderr.on("data", (bytes) => { stderr += String(bytes); });
              const code = await new Promise<number | null>((resolve) => blocked.once("exit", resolve));
              check(`U2 update ${flags.join(" ")} refuses unselected running agents with recovery commands`, code === 1
                && stderr.includes("running agents on this computer") && stderr.includes("restarting it would end them")
                && stderr.includes("upgrade_custody") && stderr.includes("requires admin scope")
                && stderr.includes(`cotal ps --on ${second.instanceId} --space ${OFF}`)
                && stderr.includes(`cotal stop <name> --on ${second.instanceId} --space ${OFF}`)
                && stderr.includes("rerun the same update command")
                && !stdout.includes("cotal update --self") && !stdout.includes("installing cotal-ai@"), { code, stdout, stderr });
            }
            await askManager(secondCaller, OFF, secondTarget.server, "stop", { name: "upgrade_custody" }, secondTarget.auth, "owner", 10_000, { instanceId: second.instanceId });
            const seed = join(root, "config", "cotal", "seed");
            mkdirSync(seed, { recursive: true, mode: 0o700 });
            for (const file of ["authority.json", "authority.bak.json"]) writeFileSync(join(seed, file), JSON.stringify({ everSeeded: ["claude", "opencode", "codex", "hermes", "jcode", "pi", "web"] }));
            writeFileSync(join(seed, "witness.json"), JSON.stringify({ initialized: true, firstGeneration: "0.151.2" }));
            writeFileSync(join(seed, "stamp.json"), JSON.stringify({ generation: "0.151.2" }));
            env.npm_config_prefix = globalPrefix;
            const updater = spawn(process.execPath, [cliEntry, "update", "--self", "--space", ON], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
            let output = ""; updater.stdout.on("data", (b) => { output += String(b); }); updater.stderr.on("data", (b) => { output += String(b); });
            const code = await new Promise<number | null>((resolve) => updater.once("exit", resolve));
            console.log("  UPDATE REPRO", JSON.stringify({ code, output }));
            check("U2 cotal update self checks both hosted instances and completes native reconcile", code === 0 && output.includes(`instance ${manager.instanceId} answered`) && output.includes(`instance ${second.instanceId} answered`));
            const secondAfter = resultOf(await ask(paths.socket, { op: "manager-status", space: OFF }));
            check("U2 update waits for both hosted Managers to answer again", secondAfter.state === "answering");
          } else {
            await npmRun(["install", "-g", "--prefix", globalPrefix, "--ignore-scripts", join(upgradeFixture!, "cotal-ai-0.151.3.tgz")]);
            if (process.argv.includes("--generation-cold-seed-repro")) {
              const payload = join(globalPrefix, "lib/node_modules/cotal-ai/seeded-connectors/claude");
              renameSync(payload, `${payload}.held`);
              try {
                await sleep(8000);
                const held = await cli("status", "--space", ON);
                const row = held.doc.result?.managers?.[0];
                check("3A replacement restarts before reconcile and refuses stale connectors without an old Manager", held.doc.result?.version === "0.151.3" && row?.state === "refused" && row?.pid === undefined && /reconcil|seed/i.test(String(row?.reason)), held);
              } finally { renameSync(`${payload}.held`, payload); }
              // Recovery must happen on the daemon's backed-off retry, without another setup.
              let recovered: Awaited<ReturnType<typeof cli>> | undefined;
              for (let i = 0; i < 240; i++) {
                recovered = await cli("status", "--space", ON);
                if (recovered.doc.result?.managers?.[0]?.state === "answering") break;
                await sleep(500);
              }
              check("3A failed startup reconciliation retries into an answering new-generation Manager", recovered?.doc.result?.version === "0.151.3" && recovered?.doc.result?.managers?.[0]?.state === "answering", recovered);
              return;
            }
            if (connectorUpgrade) {
              const payload = join(globalPrefix, "lib/node_modules/cotal-ai/seeded-connectors/claude");
              renameSync(payload, `${payload}.held`);
              try {
                await sleep(5000);
                const held = await cli("status", "--space", ON);
                check("U0 missing replacement connector blocks activation without stopping old daemon", held.doc.result?.version === "0.151.2" && held.doc.result?.managers?.[0]?.state === "answering", held);
              } finally { renameSync(`${payload}.held`, payload); }
            }
          }
          if (activeTarget) {
            await sleep(4000);
            const held = await cli("status", "--space", ON);
            const status = await askManager({ versionSkew: (text: string) => text, roster: async () => [] }, ON, activeTarget.server, "managerStatus", undefined, activeTarget.auth, "owner", 3000, { instanceId: manager.instanceId });
            check("U1 installed replacement waits without killing active legacy custody", held.doc.result?.version === "0.151.2" && status.ok && (status.data as { agentCount?: number }).agentCount === 1, { held, status });
            if (process.argv.includes("--watcher-seat-repro")) {
              const waiting = held.doc.result?.generation;
              check("R2-1 occupied replacement is visible in daemon status", waiting?.installed === "0.151.3" && waiting?.waiting?.includes("1 seat(s)") && waiting?.waiting?.includes(ON), held);
              const admitted = await askManager({ versionSkew: (text: string) => text, roster: async () => [] }, ON, activeTarget.server, "start", { name: "watcher_admission", agent: "daemon-smoke", events: false, persona: { prompt: "Owned admission during pending version.", subscribe: [], allowSubscribe: [], allowPublish: [], capabilities: [] } }, activeTarget.auth, "owner", 40_000, { instanceId: manager.instanceId });
              check("R2-1 waiting version does not block a new seat", admitted.ok, admitted);
              await askManager({ versionSkew: (text: string) => text, roster: async () => [] }, ON, activeTarget.server, "stop", { name: "watcher_admission" }, activeTarget.auth, "owner", 10_000, { instanceId: manager.instanceId });
            }
            await askManager({ versionSkew: (text: string) => text, roster: async () => [] }, ON, activeTarget.server, "stop", { name: "npm_upgrade_custody" }, activeTarget.auth, "owner", 10_000, { instanceId: manager.instanceId });
          }
          let after: Awaited<ReturnType<typeof cli>> | undefined;
          for (let i = 0; i < 160; i++) {
            try { after = await cli("status", "--space", ON); if (after.doc.result?.version === "0.151.3" && after.doc.result?.managers?.[0]?.state === "answering") break; } catch { /* recorded restart is between generations */ }
            await sleep(250);
          }
          console.log("  UPGRADE REPRO", JSON.stringify(after));
          check("U1 npm upgrade restarts daemon at the installed generation", after?.doc.result?.version === "0.151.3");
          const current = after?.doc.result?.managers?.[0];
          const selected = await resolveControlTarget({ space: ON }, "control-caller-privileged", current?.instanceId ?? manager.instanceId, { onRefusal: "throw", readOnly: true });
          const reply = await askManager({ versionSkew: (s: string) => s, roster: async () => [] }, ON, selected.server, "managerStatus", undefined, selected.auth, "owner", 3000, { instanceId: current?.instanceId ?? manager.instanceId });
          console.log("  UPGRADE MANAGER", JSON.stringify(reply));
          check("U1 npm upgrade restores answering Manager at installed generation", reply.ok && (reply.data as { version?: string })?.version === "0.151.3");
          if (connectorUpgrade) {
            const installed = JSON.parse(readFileSync(join(prefix, "extensions.json"), "utf8")).extensions;
            check("U0 replacement activation installs core-matched seeded connector", installed.some((entry: { pkg: string; source?: string; version: string }) => entry.pkg === "@cotal-ai/connector-claude-code" && entry.source === "seeded" && entry.version === "0.151.3"));
            const meta = JSON.parse(readFileSync(join(prefix, "node_modules/@cotal-ai/connector-claude-code/package.json"), "utf8"));
            check("U0 installed connector bytes identify replacement generation", meta.version === "0.151.3");
          }
          return;
        }
        if (!process.argv.includes("--upgrade-repro")) {
          process.kill(manager.pid, "SIGSTOP");
          try {
            const rerun = await cli("setup", "--space", ON);
            console.log("  READINESS REPRO", JSON.stringify(rerun));
            check("H1 setup refuses a live child that does not answer", rerun.code === 2 && rerun.doc.result === null);
          } finally { process.kill(manager.pid, "SIGCONT"); }
          if (process.argv.includes("--readiness-repro")) return;
          const recovered = await cli("setup", "--space", ON);
          check("H1 resumed child answers a fresh setup probe", recovered.code === 0 && recovered.doc.result?.manager?.state === "answering");
        }
        check("H0 setup discovers the space through daemon-held sign-in", findMesh(ON)?.origin === "catalog");
        const target = await resolveControlTarget({ space: ON }, "control-caller-privileged", manager.instanceId, { onRefusal: "throw", readOnly: true });
        const client = { versionSkew: (s: string) => s, roster: async () => [] };
        const status = await askManager(client, ON, servers, "managerStatus", undefined, target.auth, "owner", 3000, { instanceId: manager.instanceId });
        check("H1 independent manager-caller status answers from selected instance", status.ok);
        const launch = await askManager(client, ON, servers, "start", { name: "daemon_smoke_seat", agent: "daemon-smoke", events: false, persona: { prompt: "Smoke stand-in, no model or external services.", subscribe: [], allowSubscribe: [], allowPublish: [], capabilities: [] } }, target.auth, "owner", 40_000, { instanceId: manager.instanceId });
        console.log("  H1 spawn goal", JSON.stringify({ ok: launch.ok, error: launch.error, receipt: launch.request }));
        check("H1 spawn goal is accepted by hosted instance (installed stand-in connector)", launch.request !== undefined && launch.request.managerInstanceId === manager.instanceId);
        check("H1 stand-in seat joins through native user auth", launch.ok, launch.error);
        if (launch.ok) await askManager(client, ON, servers, "stop", { name: "daemon_smoke_seat" }, target.auth, "owner", 10_000, { instanceId: manager.instanceId });
        const intent = join(home, "daemon", `space.${Buffer.from(ON).toString("hex")}`, "manager-host.json");
        check("H1 hosting intent recorded after status", existsSync(intent));
        process.kill(manager.pid, "SIGKILL");
        let replacement: Record<string, any> = {};
        for (let i = 0; i < 200; i++) { replacement = resultOf(await ask(paths.socket, { op: "manager-status", space: ON })); if (replacement.state === "answering" && replacement.pid !== manager.pid) break; await sleep(250); }
        check("H2 killed Manager restarts and answers without a command", replacement.state === "answering" && replacement.pid !== manager.pid, replacement);
        check("H2 unexpected child exit retains its native signal", String(replacement.lastExit).includes("SIGKILL"));
        const predecessorManager = replacement.pid;
        await killAndAwaitExit(child, "SIGKILL");
        child = await startDaemon();
        for (let i = 0; i < 200; i++) { replacement = resultOf(await ask(paths.socket, { op: "manager-status", space: ON })); if (replacement.state === "answering") break; await sleep(250); }
        check("H3 killed daemon resumes answering Manager without setup", replacement.state === "answering", replacement);
        let predecessorAlive = false;
        try { process.kill(predecessorManager, 0); predecessorAlive = true; } catch { /* owned predecessor exited */ }
        check("H3 killed daemon leaves no unsupervised Manager predecessor", !predecessorAlive);
        await cli("service-disconnect", "--space", ON);
        check("H4 disconnect forgets intent and stops Manager", !existsSync(intent) && resultOf(await ask(paths.socket, { op: "manager-status", space: ON })).state === "stopped");
        grantActor(ctx[0]!.stateDir, { owner: fixture.owner, actor: "cli", lifecycleUid: cliLifecycle, scope: [], allowSubscribe: [], allowPublish: [] });
        const refused = await cli("setup", "--space", ON);
        const before = resultOf(await ask(paths.socket, { op: "manager-status", space: ON }));
        const plainRefused = await plainCommand("service-status", "--space", ON);
        check("H5 service-status refusal includes Manager state, cause and next action", plainRefused.code === 2 && plainRefused.err.includes("Manager refused") && plainRefused.err.includes("supervise") && plainRefused.err.includes("Next"), plainRefused);
        await sleep(3500);
        const after = resultOf(await ask(paths.socket, { op: "manager-status", space: ON }));
        check("H5 missing supervise scope refuses with native cause and remedy", refused.code === 2 && /supervise|scope/i.test(refused.doc.error?.message ?? "") && /supervise/.test(refused.doc.error?.remedy ?? ""), refused);
        check("H5 one permanent refusal, no child restart loop or intent", before.state === "refused" && after.state === "refused" && before.restarts === after.restarts && !existsSync(intent), { before, after });
        await cli("service-disconnect", "--space", ON);
        await cli("setup", "--no-manager", "--space", ON, "--wait", "0");
        check("H6 --no-manager starts no child or hosting intent", resultOf(await ask(paths.socket, { op: "manager-status", space: ON })).state === "stopped" && !existsSync(intent));
        grantActor(ctx[0]!.stateDir, { owner: fixture.owner, actor: "cli", lifecycleUid: cliLifecycle, scope: ["supervise", "spawn"], allowSubscribe: [], allowPublish: [] });
        idpRevoked = true;
        try {
          const rejected = resultOf(await ask(paths.socket, { op: "manager-start", space: ON }, 100_000));
          await sleep(1500);
          const later = resultOf(await ask(paths.socket, { op: "manager-status", space: ON }));
          check("H6 revoked native IdP session is a permanent structured refusal", rejected.state === "refused" && later.state === "refused" && rejected.restarts === later.restarts, { rejected, later });
        } finally { idpRevoked = false; await cli("service-disconnect", "--space", ON); }
        const managedHome = join(root, "managed-daemon");
        mkdirSync(managedHome, { mode: 0o700 });
        const managedPaths = daemonPathsFor(managedHome, env);
        const managedUnit = `cotal-daemon-${createHash("sha256").update(managedHome).digest("hex").slice(0, 16)}.service`;
        const unitPath = join(root, "config", "systemd", "user", managedUnit);
        const unitBytes = `[Unit]\nDescription=Owned recording fixture\n[Service]\nExecStart="${process.execPath}" "${cliEntry}" daemon serve --daemon-home "${managedHome}"\nRestart=always\n`;
        writeFileSync(unitPath, unitBytes, { mode: 0o600 });
        writeFileSync(join(managedHome, "service-unit.json"), JSON.stringify({ v: 1, unit: managedUnit, unitPath, unitSha256: createHash("sha256").update(unitBytes).digest("hex"), installedAt: new Date().toISOString(), daemonHome: managedHome }), { mode: 0o600 });
        let managedChild = await startDaemon(managedHome);
        try {
          for (const failure of ["denied", "expired", "unreachable"] as const) {
            deviceFailure = failure;
            try {
              const rejected = await cli("setup", "--space", `${ON}-missing`, "--idp", idpUrl, "--daemon-home", managedHome);
              check(`H7 discovery ${failure} retains native reason and actionable refusal`, rejected.code === 2 && rejected.doc.error?.code === (failure === "unreachable" ? "DEPENDENCY_UNAVAILABLE" : "PERMISSION_DENIED") && rejected.doc.error?.cause?.code === failure.toUpperCase() && rejected.doc.error?.remedy?.includes("daemon login"), rejected);
            } finally { deviceFailure = undefined; }
          }
          const setupManaged = await cli("setup", "--space", ON, "--idp", idpUrl, "--daemon-home", managedHome);
          let managed = setupManaged.doc.result?.manager;
          const managedIntent = join(managedHome, "daemon", spaceSegment(ON), "manager-host.json");
          check("H7 explicit home signs in and hosts its own answering Manager", setupManaged.code === 0 && setupManaged.doc.result?.launchReady === true && managed?.state === "answering" && existsSync(managedIntent), setupManaged);
          check("H7 never-approved machine registration does not delay readiness", setupManaged.code === 0 && setupManaged.doc.result?.state === "approval-pending" && ["approval-required", "pending"].includes(setupManaged.doc.result?.registration?.outcome), setupManaged);
          const pendingManaged = await cli("setup", "--no-manager", "--space", ON, "--wait", "0", "--daemon-home", managedHome);
          check("H7 pending setup remedy keeps the selected daemon and service-only mode", pendingManaged.code === 4 && pendingManaged.doc.error?.remedy === `ask the space owner to approve this machine, then run \`cotal daemon setup --space ${ON} --no-manager --daemon-home ${managedHome}\` again`, pendingManaged);
          check("H7 explicit home does not host in the default daemon", resultOf(await ask(paths.socket, { op: "manager-status", space: ON })).state === "stopped" && !existsSync(intent));
          const recorder = join(root, "native-recorder");
          mkdirSync(recorder, { mode: 0o700 });
          const nativeLog = join(root, "native-recorder.log");
          const nativeControl = createHttpServer(async (request, response) => {
            if (request.url !== "/stop") { response.writeHead(404).end(); return; }
            await killAndAwaitExit(managedChild, "SIGTERM");
            response.end("stopped");
          });
          await new Promise<void>((resolve) => nativeControl.listen(0, "127.0.0.1", resolve));
          const nativePort = (nativeControl.address() as AddressInfo).port;
          writeFileSync(join(recorder, "systemctl"), `#!${process.execPath}\nconst fs=require('node:fs'); (async()=>{const args=process.argv.slice(2).join(' ');if(args==='--user show-environment'){console.log(${JSON.stringify(`XDG_CONFIG_HOME=${join(root, "config")}`)});process.exit(0)}fs.appendFileSync(${JSON.stringify(nativeLog)},args+'\\n');if(args==='--user --no-ask-password --no-pager stop ${managedUnit}'){const r=await fetch('http://127.0.0.1:${nativePort}/stop');if(!r.ok)process.exit(99);}else if(!['--user --no-ask-password --no-pager disable ${managedUnit}','--user --no-ask-password --no-pager daemon-reload'].includes(args))process.exit(99);})();\n`, { mode: 0o700 });
          const priorPath = env.PATH;
          env.PATH = `${recorder}:${priorPath}`;
          let removed;
          if (!process.argv.includes("--shutdown-repro")) {
            process.kill(managed.pid, "SIGSTOP");
            const uninstalling = ask(managedPaths.socket, { op: "managers-stop" }, 15_000);
            const ended = await Promise.race([uninstalling.then(() => true), sleep(12_000).then(() => false)]);
            console.log("  STOP REPRO bounded uninstall", ended);
            check("H8 unresponsive owned child cannot hang uninstall", ended);
            try { process.kill(managed.pid, "SIGCONT"); } catch { /* forced stop already reaped it */ }
            await uninstalling;
            check("H8 forced child stop is visible in Manager status", resultOf(await ask(managedPaths.socket, { op: "manager-status", space: ON })).lastStop === "killed");
            managed = (await cli("setup", "--space", ON, "--daemon-home", managedHome)).doc.result?.manager;
            check("H8 uninstall begins with a new hosted child alive", managed?.state === "answering");
            process.kill(managed.pid, "SIGSTOP");
            managedChild.kill("SIGTERM");
            await sleep(250);
            const raced = await ask(managedPaths.socket, { op: "manager-start", space: ON }, 1500);
            check("H8 start racing shutdown receives a refusal", raced.ok === false && ["MANAGER_UNAVAILABLE", "GENERATION_PENDING"].includes(String(errorOf(raced).code)), raced);
            try { process.kill(managed.pid, "SIGCONT"); } catch { /* owned child was already reaped */ }
            await killAndAwaitExit(managedChild, "SIGTERM");
            managedChild = await startDaemon(managedHome);
            managed = (await cli("setup", "--space", ON, "--daemon-home", managedHome)).doc.result?.manager;
          } else if (process.argv.includes("--shutdown-repro")) {
            process.kill(managed.pid, "SIGSTOP");
            managedChild.kill("SIGTERM");
            await sleep(250);
            let raced: Frame = {};
            try { raced = await ask(managedPaths.socket, { op: "manager-start", space: ON }, 1500); } catch { /* expected baseline leaves no response */ }
            console.log("  SHUTDOWN REPRO frame", JSON.stringify(raced));
            check("H8 start racing shutdown receives a refusal", raced.ok === false && ["MANAGER_UNAVAILABLE", "GENERATION_PENDING"].includes(String(errorOf(raced).code)), raced);
            try { process.kill(managed.pid, "SIGCONT"); } catch { /* child already exited */ }
            return;
          }
          try { removed ??= await cli("uninstall", "--yes", "--daemon-home", managedHome); }
          finally { env.PATH = priorPath; nativeControl.close(); }
          check("H8 uninstall removes the owned recorded unit and hosting intent", removed.code === 0 && removed.doc.result?.state === "removed" && !existsSync(unitPath) && !existsSync(managedIntent), removed);
          let managerAlive = false;
          if (typeof managed?.pid === "number") { try { process.kill(managed.pid, 0); managerAlive = true; } catch { /* the owned Manager exited */ } }
          check("H8 uninstall leaves the real hosted Manager exited and records native removal", typeof managed?.pid === "number" && !managerAlive && !existsSync(managedPaths.socket) && !existsSync(join(managedHome, "service-unit.json")) && readFileSync(nativeLog, "utf8").trim().split("\n").length === 3);
          check("H8 uninstall leaves the default daemon answering", resultOf(await ask(paths.socket, { op: "status" })).state === "ready");
        } finally { await killAndAwaitExit(managedChild, "SIGTERM"); }
        const defaultSetup = await cli("setup", "--space", ON);
        const defaultManager = defaultSetup.doc.result?.manager;
        check("HM005 default home has an answering Manager before uninstall", defaultManager?.state === "answering", defaultSetup);
        const defaultRecorder = join(root, "default-native");
        mkdirSync(defaultRecorder, { mode: 0o700 });
        const defaultControl = createHttpServer(async (request, response) => {
          if (request.url !== "/stop") { response.writeHead(404).end(); return; }
          await killAndAwaitExit(child, "SIGTERM"); response.end("stopped");
        });
        await new Promise<void>((resolve) => defaultControl.listen(0, "127.0.0.1", resolve));
        const defaultPort = (defaultControl.address() as AddressInfo).port;
        writeFileSync(join(defaultRecorder, "systemctl"), `#!${process.execPath}\n(async()=>{const args=process.argv.slice(2).join(' ');if(args==='--user show-environment'){console.log(${JSON.stringify(`XDG_CONFIG_HOME=${join(root, "config")}`)});process.exit(0)}if(args==='--user --no-ask-password --no-pager stop cotal-daemon.service'){const r=await fetch('http://127.0.0.1:${defaultPort}/stop');if(!r.ok)process.exit(99);}else if(!['--user --no-ask-password --no-pager disable cotal-daemon.service','--user --no-ask-password --no-pager daemon-reload'].includes(args))process.exit(99);})().catch(()=>process.exit(99));\n`, { mode: 0o700 });
        const defaultPath = env.PATH;
        env.PATH = `${defaultRecorder}:${env.PATH}`;
        try {
          const removed = await cli("uninstall", "--yes");
          check("HM005 default-home uninstall reports Removed and forgets hosting", removed.code === 0 && removed.doc.result?.state === "removed" && !existsSync(intent), removed);
          let alive = false;
          try { process.kill(defaultManager.pid, 0); alive = true; } catch { /* retained owned Manager exited */ }
          check("HM005 native stop leaves actual hosted Manager and socket gone", !alive && !existsSync(paths.socket));
          seedUnitReceipt();
          child = await startDaemon();
          check("HM005 later installation resumes no hosted Manager", (await cli("status")).doc.result?.managers?.length === 0);
        } finally { env.PATH = defaultPath; defaultControl.close(); }
      } finally {
        recordingRestart = false;
        await killAndAwaitExit(child, "SIGTERM");
        npmRegistry?.close();
        upgradeControl?.close();
        pathControl?.close();
        recordMesh(original);
        catalog = undefined; catalogSpace = undefined; catalogTarget = undefined;
        await delivery.close();
        await secondDelivery?.close();
        d = await serveDaemon({ paths, version: fixtureVersion, peerUid, sessionDir: home });
      }
    });

    await cell("C7b account mismatch survives service connection and CLI presentation", async () => {
      check("C7b instrument: connected and independently ready before the account change",
        stateOf(await connectS(ON)) === "connected" && await instanceStatus(ON) === "ready");
      await disconnectS(ON);
      const records = ["service-identity.json", "register-request.json"].map((name) => join(home, "daemon", spaceSegment(ON), name));
      const before = records.map((path) => readFileSync(path));
      const beforePosts = posts(ON);
      changedAccount.set(ON, accounts[2]!.account.pub);
      try {
        const checkResult = resultOf(await askLogged({ op: "connect-check", space: ON }));
        const connection = resultOf(await connectS(ON));
        check("C7b socket preserves account-mismatch and the readiness explanation",
          checkResult.outcome === "account-mismatch" && connection.state === "account-mismatch" && connection.message === checkResult.message, connection);
        check("C7b offline status retains account-mismatch", stateOf(await statusS(ON)) === "account-mismatch");
        const plain = await cli(["service-connect", "--space", ON], "--plain");
        check("C7b plain CLI names CONFLICT and native ACCOUNT_MISMATCH with the account explanation",
          plain.status === 2 && /Code:\s+CONFLICT/.test(plain.err) && /Native code:\s+ACCOUNT_MISMATCH/.test(plain.err)
          && plain.err.includes(String(checkResult.message)), plain);
        for (const op of ["service-connect", "service-status"]) {
          const json = await cli([op, "--space", ON]);
          const doc = json.doc!;
          check(`C7b JSON ${op} names CONFLICT and native ACCOUNT_MISMATCH`, json.status === 2 && doc.outcome === "refused"
            && doc.error?.code === "CONFLICT" && doc.error?.cause?.code === "ACCOUNT_MISMATCH"
            && String(doc.error?.message).startsWith(String(checkResult.message)), doc);
        }
        check("C7b no registration or credential POST reached the changed account", posts(ON) === beforePosts);
        check("C7b pinned identity and register request remain byte-identical", records.every((path, i) => readFileSync(path).equals(before[i]!)));
      } finally { changedAccount.delete(ON); }
      check("C7b restoring the account reconnects and the space reads ready",
        stateOf(await connectS(ON)) === "connected" && await instanceStatus(ON) === "ready");
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
      d = await serveDaemon({ paths, version: fixtureVersion, peerUid, sessionDir: home } as Parameters<typeof serveDaemon>[0]);
    });

    await cell("C11 the CLI through the composition root", async () => {
      const st = await cli(["service-status", "--space", ON]);
      // The owner revoked in C8, so the restart's own resume cannot reach connected: a revoked
      // registration is refused however the connect was started.
      check("C11 after a daemon restart `service-status` for the revoked registration is not connected, exit 2", st.status === 2 && st.doc!.result === null && st.doc!.error?.code !== undefined && st.doc!.error.code !== "OK", { status: st.status, out: st.out.slice(0, 400) });
      const re = await cli(["service-connect", "--space", ON]);
      check("C11 `service-connect` for the revoked registration refuses (exit 2) and never connects", re.status === 2 && re.doc!.outcome === "refused" && re.doc!.result === null, { status: re.status, out: re.out.slice(0, 400) });
      const off = await cli(["service-connect", "--space", OFF]);
      check("C11 `service-connect` with no register request refuses TARGET_NOT_FOUND (exit 2)", off.status === 2 && off.doc!.error?.code === "TARGET_NOT_FOUND" && off.doc!.error?.cause?.code === "NOT_REQUESTED", { status: off.status, out: off.out.slice(0, 400) });
      const dis = await cli(["service-disconnect", "--space", OFF]);
      check("C11 `cotal daemon service-disconnect` answers disconnected (exit 0)", dis.status === 0 && dis.doc!.result?.state === "disconnected", { status: dis.status, out: dis.out.slice(0, 400) });
    });

    await cell("C10 nothing secret crosses the endpoint or the CLI", async () => {
      const text = frames.join("\n");
      check("C10 no IdP session, JWT, access bearer or renewal proof in any frame", ![SESSION, ...jwtsIssued].some((s) => text.includes(s)) && !/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./.test(text) && !/accessBearer|renewalProof/.test(text), frames.length);
    });

    // Last, on its own space: stopping the broker also leaves the stock auth services' own contexts
    // unready for a while, so no other cell runs after it.
    await cell("C13 broker loss: connected is withdrawn at once and reclaimed only after the broker and a fresh ready", async () => {
      const brkOwner = deriveOwnerForIdpSubject((await loadOwnerSecret(ctx[3]!.store, BRK))!, idpOrigin, "machine-owner");
      await ask(paths.socket, { op: "register", space: BRK });
      const a = await approve(brkHost, BRK, brkOwner);
      const first = await connectS(BRK);
      check("C13 instrument: approved and connected before the broker stops", a.decided.state === "approved" && stateOf(first) === "connected", first);
      cutBrokerPath();
      const during: string[] = [];
      let gone = false;
      try {
        gone = !(await isReachable(brokerPathUrl));
        const t0 = Date.now();
        while (Date.now() - t0 < 8000) { during.push(String(stateOf(await statusS(BRK)))); await sleep(500); }
      } finally { brokerPathUp = true; }
      console.log(`  C13 broker down: ${during.length} samples, ${during.filter((s) => s === "connected").length} connected, states ${[...new Set(during)].join(",")}`);
      check("C13 instrument: the daemon's broker path is unreachable while the space stays up", gone && (await isReachable(`nats://127.0.0.1:${port}`)));
      check("C13 no sample after the broker stopped says connected", during.length >= 12 && during.every((s) => s !== "connected"), during);
      check("C13 the state is connecting while the broker is down (not ended)", during.every((s) => s === "connecting"), [...new Set(during)]);
      const back = await waitState(BRK, (s) => s === "connected", 90_000);
      check("C13 after the broker path returns, connected again and the space reads ready", back === "connected" && (await instanceStatus(BRK)) === "ready", back);
    });
  } finally {
    if (foreground && foreground.exitCode === null && foreground.signalCode === null) await killAndAwaitExit(foreground, "SIGTERM");
    await d.close(); brokerPath.close(); for (const s of pathSockets) s.destroy();
  }
} catch (e) {
  fail++;
  console.error("  ✗ smoke crashed:", e instanceof Error ? (e.stack ?? e.message) : e);
} finally {
  for (const h of handles) await h.close().catch(() => {});
  for (const r of relays) r.close();
  idp.close();
  if (nats) await killAndAwaitExit(nats, "SIGTERM").catch(() => {});
  release?.();
  if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
  if (setupProgressOnly) console.log(`Setup progress sandbox retained at ${root}; broker store at ${jsDir}`);
  else {
    rmSync(jsDir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
}

console.log(`\nDAEMON SERVICE CONNECT SMOKE ${fail === 0 ? "OK" : "FAILED"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
