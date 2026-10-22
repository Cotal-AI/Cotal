/**
 * `cotal daemon register` (A2b.2): live, red-first cells against a REAL stock auth service with
 * `serviceEndpoints` on, in an owned sandbox.
 *
 * The sandbox uses public exports only:
 *  - a JWT-permission loopback `nats-server` configured by stock `serverConfig`;
 *  - stock `startAuthService({ publicFace, serviceEndpoints })` over an in-memory injected store
 *    seeded by stock `ensureCalloutAuth`, `ensureIssuer`, `ensureOwnerSecret` and `saveServiceKeys`;
 *  - a loopback signed-JWT IdP (jose EdDSA, resolved from the auth package).
 * The participant is registered from the discovery bundle the real public face serves. The daemon is
 * the shipped `serveDaemon`, reached over its real unix socket.
 *
 * Approval stays real and separate. The daemon never calls `decide` or `name-bind`. The FIXTURE plays
 * the space operator and owner through the stock host handle, as the stock service-serving smoke does.
 * That is fixture authority over a fixture space, not a human decision.
 *
 * Cells (each asserts counts):
 *  R1  `register` on the ON space answers `approval-required` with a proposal id; exactly 1 POST
 *      reached the authority route; the requestId was persisted before the send;
 *  R2  a second `register` before any decision replays the SAME requestId: still approval-required
 *      with the same proposal, and still one proposal at the host;
 *  R3  the operator binds the name and the owner approves through the stock host; the daemon's
 *      replay of the same request answers `registered`, with a witness bound to the daemon's instance,
 *      endpoint and pinned account. Nothing is activated and no bearer is held;
 *  R4  a daemon restart reuses the persisted requestId (no fresh key), and the replay is still
 *      `registered`;
 *  R5  the OFF space (stock default, no serviceEndpoints) answers `unsupported-by-space` with 0 POST;
 *  R6  the owner refuses a proposal for a second space: the daemon reports refused/proposal-refused,
 *      and the persisted requestId is unchanged;
 *  R7  register before connect-check (no identity yet) is refused locally with 0 requests;
 *  R8  closed contract: register without space, or with an unknown field, is refused with its typed
 *      code and 0 requests;
 *  R9  no frame and no CLI output carries the IdP session, an IdP JWT, an access bearer or a
 *      renewal proof; no manager-instance file appears;
 *  R10 `cotal daemon register --space <s> --json` through the composition root prints the daemon's
 *      outcome.
 *
 * Run: tsx bin/smoke/daemon-register.smoke.ts   (Linux only; needs nats-server)
 */
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { connect as netConnect, type AddressInfo, type Socket } from "node:net";
import { mkdtempSync, chmodSync, mkdirSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { peerCredentials } from "@cotal-ai/seat";
import {
  composeSpaceAuth, createBrokerAuth, createSpaceAccountAuth, isReachable, mintCreds, mintLifecycleUid, newIdentity, serverConfig, setupSpaceStreams,
  writeSecretFileAtomic, type SecretStore,
} from "@cotal-ai/core";
import {
  deriveOwnerForIdpSubject, ensureCalloutAuth, ensureIssuer, ensureOwnerSecret, ensurePinnedIdp, grantActor, loadOwnerSecret, saveIdpSession,
  saveServiceKeys, startAuthService, type AuthServiceHandle,
} from "@cotal-ai/auth";
import { mkSecretDir, recordMesh, userAuthStateDir, type MeshEntry } from "@cotal-ai/workspace";
import { freePort, killAndAwaitExit, teardownOnSignal, SMOKE_BROKER_TOKEN } from "@cotal-ai/smoke-kit";
import { daemonPaths } from "../daemon/endpoint.js";
import { serveDaemon } from "../daemon/server.js";

if (process.platform !== "linux") {
  console.log("daemon-register smoke: Linux only; skipped on " + process.platform);
  process.exit(0);
}

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const authRequire = createRequire(join(repo, "implementations", "auth", "package.json"));
const { SignJWT, exportJWK, generateKeyPair } = await import(pathToFileURL(authRequire.resolve("jose")).href) as typeof import("jose");
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

class MemoryStore implements SecretStore {
  readonly values = new Map<string, string>();
  constructor(readonly identity: { kind: "injected"; coordinate: string }) {}
  async get(k: string) { return this.values.get(k); }
  async put(k: string, v: string) { this.values.set(k, v); }
  async create(k: string, v: string) { if (this.values.has(k)) return false; this.values.set(k, v); return true; }
  async delete(k: string) { this.values.delete(k); }
}

// ---------- owned sandbox ----------
const root = mkdtempSync(join(process.env.COTAL_DAEMON_SMOKE_TMP ?? tmpdir(), "cdr-"));
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
const idp = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
  res.setHeader("content-type", "application/json");
  if (req.url === "/api/auth/jwks") return void res.end(JSON.stringify({ keys: [jwk] }));
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
async function relay(space: string, target: string): Promise<string> {
  const s = createHttpServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    hits.push({ space, method: req.method ?? "", path: new URL(req.url!, "http://x").pathname });
    const up = await fetch(`${target}${req.url}`, { method: req.method, headers: { "content-type": req.headers["content-type"] ?? "application/json" }, body: chunks.length ? Buffer.concat(chunks) : undefined, redirect: "manual" });
    res.writeHead(up.status, Object.fromEntries([...up.headers].filter(([k]) => k !== "content-length" && k !== "transfer-encoding")));
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

  let d = await serveDaemon({ paths, version: "0.0.0-smoke", peerUid, sessionDir: home } as Parameters<typeof serveDaemon>[0]);
  try {
    await cell("R7 register before connect-check", async () => {
      const before = hits.length;
      const r = await ask(paths.socket, { op: "register", space: ON });
      check("R7 refused locally as not-ready (no identity yet)", r.ok === true && resultOf(r).outcome === "not-ready", r);
      check("R7 0 requests reached the space", hits.length === before, hits.slice(before));
    });
    for (const s of [ON, OFF, DENY]) await ask(paths.socket, { op: "connect-check", space: s });

    let proposalId = "", requestId = "";
    await cell("R1 register asks for approval", async () => {
      const before = posts(ON);
      const r = await ask(paths.socket, { op: "register", space: ON });
      proposalId = resultOf(r).proposalId; requestId = resultOf(r).requestId;
      check("R1 approval-required with a proposal id", resultOf(r).outcome === "approval-required" && typeof proposalId === "string" && proposalId.length > 0, r);
      check("R1 exactly 1 POST reached the authority route", posts(ON) === before + 1 && hits.filter((h) => h.space === ON).at(-1)?.path === "/service-endpoint-authority", hits.filter((h) => h.space === ON));
      const rec = regRecord(ON);
      check("R1 the requestId is persisted and matches the one reported", rec?.requestId === requestId && /^[0-9a-f]{32}$/.test(String(requestId)), rec);
    });

    await cell("R2 replay before a decision", async () => {
      const r = await ask(paths.socket, { op: "register", space: ON });
      check("R2 same requestId and same proposal", resultOf(r).outcome === "approval-required" && resultOf(r).requestId === requestId && resultOf(r).proposalId === proposalId, r);
      const list = await host({ v: 1, kind: "service-endpoint-host", requestId: rid(), operation: "proposal-read", input: { proposalId }, granter: operator } as never) as { state: string };
      check("R2 the host still holds that one proposal", list.state === "present", list);
    });

    await cell("R3 owner approval, then the replay registers", async () => {
      const bound = await host({ v: 1, kind: "service-endpoint-host", requestId: rid(), operation: "name-bind", granter: operator,
        input: { endpoint: "ai.cotal.machine", owner: fixture.owner, expectedRevision: 0, claimReference: "a2b2-fixture-namespace" } } as never) as { state: string; binding?: { revision: number } };
      const p = await host({ v: 1, kind: "service-endpoint-host", requestId: rid(), operation: "proposal-read", input: { proposalId }, granter: operator } as never) as { state: string; record?: { revision: number } };
      const decided = await host({ v: 1, kind: "service-endpoint-host", requestId: rid(), operation: "decide", granter: { kind: "owner", owner: fixture.owner },
        input: { proposalId, expectedProposalRevision: p.record?.revision ?? 0, expectedNameRevision: bound.binding?.revision ?? 0, decision: "approve", callerCeiling: [] } } as never) as { state: string };
      check("R3 instrument: fixture operator bound the name and fixture owner approved through the stock host", bound.state === "bound" && decided.state === "approved", { bound, decided });
      let r = await ask(paths.socket, { op: "register", space: ON });
      for (let i = 0; i < 10 && resultOf(r).outcome === "pending"; i++) { await sleep(500); r = await ask(paths.socket, { op: "register", space: ON }); }
      const res = resultOf(r), id = JSON.parse(readFileSync(join(home, "daemon", readdirSync(join(home, "daemon"), { recursive: true }).map(String).find((f) => f.includes(Buffer.from(ON).toString("hex")) && f.endsWith("service-identity.json"))!), "utf8")) as Record<string, string>;
      check("R3 registered with the same requestId", res.outcome === "registered" && res.requestId === requestId, r);
      check("R3 the witness names the daemon's instance, endpoint and pinned account", res.witness?.instanceId === id.instanceId && res.witness?.endpoint === "ai.cotal.machine" && res.witness?.accountPublicKey === id.accountPublicKey, res.witness);
      check("R3 nothing activated: no bearer or renewal proof in the reply", !JSON.stringify(r).match(/accessBearer|renewalProof|credential/), r);
    });

    await cell("R4 a restarted daemon replays the same request", async () => {
      await d.close();
      d = await serveDaemon({ paths, version: "0.0.0-smoke", peerUid, sessionDir: home } as Parameters<typeof serveDaemon>[0]);
      const r = await ask(paths.socket, { op: "register", space: ON });
      check("R4 same requestId after restart, still registered", resultOf(r).requestId === requestId && resultOf(r).outcome === "registered", r);
    });

    await cell("R5 a space without service endpoints", async () => {
      const before = posts(OFF);
      const r = await ask(paths.socket, { op: "register", space: OFF });
      check("R5 unsupported-by-space", resultOf(r).outcome === "unsupported-by-space", r);
      check("R5 0 POST to that space", posts(OFF) === before, hits.filter((h) => h.space === OFF));
    });

    await cell("R6 the owner refuses", async () => {
      const first = await ask(paths.socket, { op: "register", space: DENY });
      const pid = resultOf(first).proposalId, req1 = resultOf(first).requestId;
      const owner = deriveOwnerForIdpSubject((await loadOwnerSecret(ctx[2]!.store, DENY))!, idpOrigin, "machine-owner");
      const p = await denyHost({ v: 1, kind: "service-endpoint-host", requestId: rid(), operation: "proposal-read", input: { proposalId: pid }, granter: operator } as never) as { record?: { revision: number } };
      const refused = await denyHost({ v: 1, kind: "service-endpoint-host", requestId: rid(), operation: "decide", granter: { kind: "owner", owner },
        input: { proposalId: pid, expectedProposalRevision: p.record?.revision ?? 0, expectedNameRevision: 0, decision: "refuse", callerCeiling: [] } } as never) as { state: string };
      check("R6 instrument: the fixture owner refused through the stock host", resultOf(first).outcome === "approval-required" && JSON.stringify(refused).includes("refused"), { first, refused });
      const r = await ask(paths.socket, { op: "register", space: DENY });
      check("R6 the daemon reports refused with the stock code proposal-refused", resultOf(r).outcome === "refused" && resultOf(r).reason === "proposal-refused", r);
      check("R6 the persisted requestId is unchanged (no fresh key)", regRecord(DENY)?.requestId === req1, regRecord(DENY));
    });

    await cell("R8 closed contract", async () => {
      const before = hits.length;
      const a = await ask(paths.socket, { op: "register" });
      const b = await ask(paths.socket, { op: "register", space: ON, force: true });
      check("R8 without space refused BAD_FIELD", a.ok === false && errorOf(a).code === "BAD_FIELD", a);
      check("R8 unknown field refused UNKNOWN_FIELD", b.ok === false && errorOf(b).code === "UNKNOWN_FIELD", b);
      check("R8 0 requests", hits.length === before, hits.slice(before));
    });

    await cell("R10 the CLI through the composition root", async () => {
      const child = spawn(join(repo, "node_modules", ".bin", "tsx"), [join(repo, "bin", "cotal.ts"), "daemon", "register", "--space", ON, "--json"], {
        cwd: root, env: { ...process.env, XDG_RUNTIME_DIR: rtDir, COTAL_HOME: home, COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "", err = "";
      child.stdout.on("data", (b) => { out += String(b); }); child.stderr.on("data", (b) => { err += String(b); });
      const status = await Promise.race([new Promise<number | null>((r) => child.once("exit", (c) => r(c))), sleep(40000).then(() => { child.kill("SIGKILL"); return -1; })]);
      let doc: Record<string, any> = {};
      try { doc = JSON.parse(out) as Record<string, any>; } catch { /* reported */ }
      check("R10 exit 0, registered, same requestId", status === 0 && doc.result?.outcome === "registered" && doc.result?.requestId === requestId, { status, out: out.slice(0, 400), err: err.slice(0, 400) });
      check("R9 no IdP session, JWT, bearer or renewal proof in CLI output", ![SESSION, ...jwtsIssued].some((s) => (out + err).includes(s)) && !/accessBearer|renewalProof/.test(out + err));
    });

    await cell("R9 nothing secret on disk in the daemon's state, no manager identity", async () => {
      const files = readdirSync(join(home, "daemon"), { recursive: true }).map(String).filter((f) => f.endsWith(".json"));
      const text = files.map((f) => readFileSync(join(home, "daemon", f), "utf8")).join("\n");
      check("R9 daemon state holds no session handle, JWT, bearer or renewal proof", ![SESSION, ...jwtsIssued].some((s) => text.includes(s)) && !/accessBearer|renewalProof/.test(text), files);
      check("R9 no manager-instance file under the home or participant root", ![home, participant].some((p) => readdirSync(p, { recursive: true }).map(String).some((f) => f.includes("manager-instance"))));
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

console.log(`\nDAEMON REGISTER SMOKE ${fail === 0 ? "OK" : "FAILED"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
