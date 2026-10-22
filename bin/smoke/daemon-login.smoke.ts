/**
 * `cotal daemon` local sign-in: live, red-first cells over the real unix socket, a REAL Better Auth
 * IdP on loopback (jwt + deviceAuthorization + bearer) for the approve/deny paths, and a scripted
 * loopback IdP that counts every request for the cancellation paths. Nothing here restates the
 * daemon's rules: every cell drives the shipped `serveDaemon` (and, for L12, the composition root)
 * and counts what happened on the wire and on disk.
 *
 * The socket helper below is deliberately local: it speaks the v1 line protocol directly, so these
 * cells assert the wire contract itself and do not trust the shipped client.
 *
 * Cells (each asserts counts):
 *  L1  approve: one login-start yields exactly 1 login-prompt and 1 login-result signed-in, the
 *      session lands in the daemon's session dir, and no frame carries a secret-named key or the
 *      session token's value;
 *  L2  deny at the verification page: 1 login-result failed/denied, nothing persisted;
 *  L3  a second login-start while one is in flight is refused LOGIN_IN_PROGRESS with 0 IdP calls;
 *  L4  login-cancel during the poll: the ack follows settlement (the start stream's result frame is
 *      already written), outcome cancelled, 0 polls after the cancel, nothing persisted;
 *  L5  login-cancel after approval while the JWT proof is in flight: cancelled, nothing persisted;
 *  L6  login-cancel after completion reports completed, never cancelled, and the session stays;
 *  L7  a stale attempt id cannot cancel its successor: not-found, and the successor completes;
 *  L8  disconnect before the result aborts the attempt: 0 further polls, nothing persisted, and the
 *      daemon accepts the next login-start;
 *  L9  closed contract: unknown field, missing idp, a non-loopback http idp, a bad attempt id are each
 *      refused with their typed code and 0 IdP calls;
 *  L10 status still answers state "ready" (listener only, no connection claim) during a sign-in;
 *  L11 the daemon caps requests per connection and closes the connection past the cap;
 *  L12 `cotal daemon login --idp` through the composition root signs in against the real IdP and
 *      prints no session token;
 *  L13 a cancel of an attempt whose sign-in finished but whose result is still being delivered waits
 *      for that delivery and answers completed; meanwhile a new login-start is refused, 0 IdP calls;
 *  L14 a failed sign-in relays none of the provider's text (an error_description, a non-JSON token
 *      body) in any frame, or on the CLI's stdout or stderr;
 *  L15 a sign-in that fails after stock wrote the session does not make the CLI claim nothing was saved.
 *
 * Run: tsx bin/smoke/daemon-login.smoke.ts   (Linux only)
 */
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { connect as netConnect, type AddressInfo, type Socket } from "node:net";
import { mkdtempSync, chmodSync, readdirSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { peerCredentials } from "@cotal-ai/seat";
import { loadIdpSession } from "@cotal-ai/auth";
import { daemonPaths } from "../daemon/endpoint.js";
import { serveDaemon } from "../daemon/server.js";
import { createLoginCoordinator } from "../daemon/login.js";

if (process.platform !== "linux") {
  console.log("daemon-login smoke: Linux only; skipped on " + process.platform);
  process.exit(0);
}

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
// better-auth is a dependency of implementations/auth, not of this root package, so it does not
// resolve from bin/. Resolve it from the package that owns it rather than widen root deps.
const authRequire = createRequire(join(repo, "implementations", "auth", "package.json"));
const fromAuth = async (spec: string): Promise<Record<string, any>> =>
  import(pathToFileURL(authRequire.resolve(spec)).href) as Promise<Record<string, any>>;
const { betterAuth } = await fromAuth("better-auth");
const { memoryAdapter } = await fromAuth("better-auth/adapters/memory");
const { jwt } = await fromAuth("better-auth/plugins/jwt");
const { deviceAuthorization } = await fromAuth("better-auth/plugins/device-authorization");
const { bearer } = await fromAuth("better-auth/plugins/bearer");
const { toNodeHandler } = await fromAuth("better-auth/node");
const peerUid = (s: Socket) => peerCredentials(s).uid;
const CLIENT_ID = "cotal-cli";
const SECRET_KEYS = ["token", "session", "jwt", "proof", "bearer", "device_code", "devicecode", "access_token", "accesstoken"];
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, what: string, ms = 10000) => {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await sleep(20); }
};
/** A provider answer no daemon frame or CLI output may echo. Not a credential: a marker. */
const SENTINEL = "SMOKESENTINELVALUE0123456789";
/** Run one cell; a cell that throws counts as one failure and the next cell still runs. */
async function cell(title: string, body: () => Promise<void>): Promise<void> {
  console.log(title);
  try { await body(); } catch (e) { fail++; console.log(`  ✗ FAIL: ${title} crashed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 600)); }
}

type Frame = Record<string, unknown>;
/** One raw connection to the daemon: write request lines, collect every reply frame in order. */
async function wire(socket: string): Promise<{ send: (req: Frame) => void; frames: Frame[]; next: (pred: (f: Frame) => boolean, ms?: number) => Promise<Frame>; closed: Promise<void>; end: () => void }> {
  const sock = netConnect(socket);
  await new Promise<void>((res, rej) => { sock.once("connect", () => res()); sock.once("error", rej); });
  const frames: Frame[] = [];
  const waiters: Array<() => void> = [];
  let buf = "";
  sock.setEncoding("utf8");
  sock.on("data", (c: string) => {
    buf += c;
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      try { frames.push(JSON.parse(line) as Frame); } catch { frames.push({ unparseable: line }); }
      for (const w of waiters.splice(0)) w();
    }
  });
  const closed = new Promise<void>((r) => sock.once("close", () => { for (const w of waiters.splice(0)) w(); r(); }));
  sock.on("error", () => {});
  const next = async (pred: (f: Frame) => boolean, ms = 8000): Promise<Frame> => {
    const deadline = Date.now() + ms;
    for (;;) {
      const hit = frames.find(pred);
      if (hit) return hit;
      if (Date.now() > deadline || sock.destroyed) throw new Error(`no matching frame within ${ms}ms; got ${JSON.stringify(frames).slice(0, 400)}`);
      await new Promise<void>((r) => { waiters.push(r); setTimeout(r, 50); });
    }
  };
  return { send: (req) => sock.write(`${JSON.stringify(req)}\n`), frames, next, closed, end: () => sock.destroy() };
}
let seq = 0;
const rid = () => `r${++seq}`;
const isPrompt = (f: Frame) => f.event === "login-prompt";
const isResult = (f: Frame) => f.event === "login-result";
const resultOf = (f: Frame) => (f.result ?? {}) as Record<string, unknown>;
const promptOf = (f: Frame) => (f.prompt ?? {}) as Record<string, unknown>;
/** Every key anywhere in the frames, lowercased, for the no-secret census. */
function keysOf(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) for (const x of v) keysOf(x, out);
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.push(k.toLowerCase().replaceAll("-", "_")); keysOf(x, out); }
  return out;
}
const secretKeys = (frames: Frame[]) => keysOf(frames).filter((k) => SECRET_KEYS.some((s) => k === s || k.includes(s)));

// A unix socket path is limited to 107 bytes, so the scratch parent must stay short. COTAL_DAEMON_SMOKE_TMP
// chooses it, as in daemon-endpoint.smoke.ts.
const root = mkdtempSync(join(process.env.COTAL_DAEMON_SMOKE_TMP ?? tmpdir(), "cdl-"));
chmodSync(root, 0o700);
let n = 0;
const fresh = () => {
  const rt = join(root, `rt${++n}`);
  const home = join(root, `home${n}`);
  return { paths: daemonPaths({ XDG_RUNTIME_DIR: rt }), rt, home };
};
const mkRuntime = async (rt: string) => { const { mkdirSync } = await import("node:fs"); mkdirSync(rt, { mode: 0o700 }); };

// ---------- a REAL Better Auth IdP on loopback ----------
let handler: ((req: IncomingMessage, res: ServerResponse) => void) | undefined;
const idpServer = createHttpServer((req, res) => handler!(req, res));
await new Promise<void>((r) => idpServer.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${(idpServer.address() as AddressInfo).port}`;
const base = `${origin}/api/auth`;
const auth = betterAuth({
  baseURL: origin,
  secret: "smoke-only-better-auth-secret-0123456789",
  database: memoryAdapter({ user: [], session: [], account: [], verification: [], jwks: [], deviceCode: [] }),
  emailAndPassword: { enabled: true },
  plugins: [jwt({ jwt: { issuer: origin, audience: origin } }), deviceAuthorization({ expiresIn: "2m", interval: "1s", validateClient: (id: string) => id === CLIENT_ID }), bearer()],
});
handler = toNodeHandler(auth);
const signup = await auth.api.signUpEmail({ body: { email: "daemon@example.test", password: "correct-horse-battery", name: "Daemon Human" }, returnHeaders: true });
const cookie = signup.headers.get("set-cookie")!.split(";")[0];
const userId = signup.response.user.id;
async function decide(userCode: string, verb: "approve" | "deny") {
  const claim = await fetch(`${base}/device?user_code=${encodeURIComponent(userCode)}`, { headers: { cookie, origin } });
  if (!claim.ok) throw new Error(`device claim failed: HTTP ${claim.status}`);
  const res = await fetch(`${base}/device/${verb}`, { method: "POST", headers: { "content-type": "application/json", cookie, origin }, body: JSON.stringify({ userCode }) });
  if (!res.ok) throw new Error(`device/${verb} failed: HTTP ${res.status}`);
}

// ---------- a scripted IdP that counts every request and can hold /token ----------
const hits: Record<string, number> = {};
let approved = false;
let tokenGate: Promise<void> | undefined;
/** When set, /device/token answers exactly this, whatever `approved` says. */
let tokenOverride: { status: number; body: string } | undefined;
const fakeJwt = (sub: string) => `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${Buffer.from(JSON.stringify({ sub, iss: "x" })).toString("base64url")}.sig`;
const scripted = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
  const route = new URL(req.url!, "http://x").pathname;
  hits[route] = (hits[route] ?? 0) + 1;
  const send = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body)); };
  if (route === "/api/auth/device/code") return send(200, { device_code: "scripted-device-code", user_code: "SCRIPTED", verification_uri: "http://127.0.0.1/v", verification_uri_complete: "http://127.0.0.1/v?c=SCRIPTED", expires_in: 60, interval: 1 });
  if (route === "/api/auth/device/token" && tokenOverride) return void res.writeHead(tokenOverride.status, { "content-type": "application/json" }).end(tokenOverride.body);
  if (route === "/api/auth/device/token") return approved ? send(200, { access_token: "scripted-session-token", expires_in: 3600 }) : send(400, { error: "authorization_pending" });
  if (route === "/api/auth/token") { if (tokenGate) await tokenGate; return send(200, { token: fakeJwt("scripted-user") }); }
  send(404, {});
});
await new Promise<void>((r) => scripted.listen(0, "127.0.0.1", r));
const sBase = `http://127.0.0.1:${(scripted.address() as AddressInfo).port}/api/auth`;
const resetScripted = () => { for (const k of Object.keys(hits)) delete hits[k]; approved = false; tokenGate = undefined; tokenOverride = undefined; };
const totalHits = () => Object.values(hits).reduce((a, b) => a + b, 0);
const polls = () => hits["/api/auth/device/token"] ?? 0;
/** The scripted IdP's session token reached the stock session file. */
const sessionSaved = (home: string) => existsSync(join(home, "idp-sessions.json")) && readFileSync(join(home, "idp-sessions.json"), "utf8").includes("scripted-session-token");
/** `cotal daemon login --idp <idp> --json` through the composition root, against the daemon at `rt`. */
async function runCli(rt: string, idp: string): Promise<{ status: number | null; out: string; err: string }> {
  const child = spawn(join(repo, "node_modules", ".bin", "tsx"), [join(repo, "bin", "cotal.ts"), "daemon", "login", "--idp", idp, "--json"], {
    cwd: root, env: { ...process.env, XDG_RUNTIME_DIR: rt, COTAL_HOME: join(root, "cli-home"), COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = new Promise<number | null>((r) => child.once("exit", (c) => r(c)));
  let out = "", err = "";
  child.stdout.on("data", (b) => { out += String(b); });
  child.stderr.on("data", (b) => { err += String(b); });
  const status = await Promise.race([exited, sleep(20000).then(() => { child.kill("SIGKILL"); return -1; })]);
  return { status, out, err };
}

try {
  // ---- L1: approve against the real IdP ----
  await cell("L1 approve (real Better Auth)", async () => {
    const { paths, rt, home } = fresh(); await mkRuntime(rt);
    const d = await serveDaemon({ paths, version: "0.0.0-smoke", peerUid, sessionDir: home } as Parameters<typeof serveDaemon>[0]);
    try {
      const w = await wire(paths.socket);
      w.send({ v: 1, id: rid(), op: "login-start", idp: base });
      const prompt = await w.next(isPrompt);
      const p = promptOf(prompt);
      check("L1 a login-prompt frame carries the verification URL, code and absolute expiry", typeof p.verificationUriComplete === "string" && typeof p.userCode === "string" && typeof p.expiresAt === "string" && !Number.isNaN(Date.parse(String(p.expiresAt))) && typeof prompt.attempt === "string", prompt);
      await decide(String(p.userCode), "approve");
      const result = await w.next(isResult, 15000);
      const r = resultOf(result);
      check("L1 one login-result signed-in with the IdP subject", r.outcome === "signed-in" && r.sub === userId && result.attempt === prompt.attempt, result);
      await sleep(200);
      check("L1 exactly 1 prompt frame and 1 result frame on the stream", w.frames.filter(isPrompt).length === 1 && w.frames.filter(isResult).length === 1, w.frames);
      const stored = loadIdpSession(home, base);
      check("L1 the session landed in the daemon's session dir through the stock writer", typeof stored?.token === "string" && stored.token.length > 0, stored ? Object.keys(stored) : stored);
      check("L1 no frame carries a secret-named key (token/session/jwt/proof/bearer/device_code)", secretKeys(w.frames).length === 0, secretKeys(w.frames));
      const raw = JSON.stringify(w.frames);
      check("L1 no frame carries the session token's value", !!stored?.token && !raw.includes(stored.token));
      w.end();
    } finally { await d.close(); }
  });

  // ---- L2: deny ----
  await cell("L2 deny (real Better Auth)", async () => {
    const { paths, rt, home } = fresh(); await mkRuntime(rt);
    const d = await serveDaemon({ paths, version: "x", peerUid, sessionDir: home } as Parameters<typeof serveDaemon>[0]);
    try {
      const w = await wire(paths.socket);
      w.send({ v: 1, id: rid(), op: "login-start", idp: base });
      const p = promptOf(await w.next(isPrompt));
      await decide(String(p.userCode), "deny");
      const r = resultOf(await w.next(isResult, 15000));
      check("L2 one login-result failed with reason denied", r.outcome === "failed" && r.reason === "denied", r);
      check("L2 nothing persisted", !existsSync(home) || readdirSync(home).length === 0, existsSync(home) ? readdirSync(home) : []);
      w.end();
    } finally { await d.close(); }
  });

  // ---- L3, L10: concurrency and status during a sign-in ----
  await cell("L3 one sign-in at a time; L10 status during it", async () => {
    resetScripted();
    const { paths, rt, home } = fresh(); await mkRuntime(rt);
    const d = await serveDaemon({ paths, version: "x", peerUid, sessionDir: home } as Parameters<typeof serveDaemon>[0]);
    try {
      const a = await wire(paths.socket);
      a.send({ v: 1, id: rid(), op: "login-start", idp: sBase });
      const prompt = await a.next(isPrompt);
      const codeHits = hits["/api/auth/device/code"] ?? 0;
      const b = await wire(paths.socket);
      const id = rid();
      b.send({ v: 1, id, op: "login-start", idp: sBase });
      const refused = await b.next((f) => f.id === id);
      await sleep(300);
      check("L3 a second login-start is refused LOGIN_IN_PROGRESS", refused.ok === false && (refused.error as Record<string, unknown> | undefined)?.code === "LOGIN_IN_PROGRESS", refused);
      check("L3 … with 0 extra IdP device-code calls", (hits["/api/auth/device/code"] ?? 0) === codeHits && codeHits === 1, hits);
      const sid = rid();
      b.send({ v: 1, id: sid, op: "status" });
      const st = await b.next((f) => f.id === sid);
      check("L10 status still answers state ready (listener only) during a sign-in", st.ok === true && (st.result as Record<string, unknown>).state === "ready", st);
      const cid = rid();
      b.send({ v: 1, id: cid, op: "login-cancel", attempt: prompt.attempt });
      await b.next((f) => f.id === cid);
      a.end(); b.end();
    } finally { await d.close(); }
  });

  // ---- L4: cancel during the poll ----
  await cell("L4 login-cancel during the poll", async () => {
    resetScripted();
    const { paths, rt, home } = fresh(); await mkRuntime(rt);
    const d = await serveDaemon({ paths, version: "x", peerUid, sessionDir: home } as Parameters<typeof serveDaemon>[0]);
    try {
      const a = await wire(paths.socket);
      a.send({ v: 1, id: rid(), op: "login-start", idp: sBase });
      const prompt = await a.next(isPrompt);
      while (polls() < 1) await sleep(20);
      const c = await wire(paths.socket);
      const cid = rid();
      c.send({ v: 1, id: cid, op: "login-cancel", attempt: prompt.attempt });
      const ack = await c.next((f) => f.id === cid);
      const pollsAtAck = polls();
      const resultWrittenBeforeAck = a.frames.some(isResult);
      check("L4 the cancel ack reports cancelled for this attempt", ack.ok === true && resultOf(ack).outcome === "cancelled" && resultOf(ack).attempt === prompt.attempt, ack);
      const r = resultOf(await a.next(isResult));
      check("L4 the start stream ends with one login-result cancelled", r.outcome === "cancelled", r);
      check("L4 the ack follows settlement: the start stream's result was already delivered", resultWrittenBeforeAck, a.frames);
      await sleep(1500);
      check("L4 0 polls after the cancel", polls() === pollsAtAck, { pollsAtAck, now: polls() });
      check("L4 nothing persisted", !existsSync(home) || readdirSync(home).length === 0);
      a.end(); c.end();
    } finally { await d.close(); }
  });

  // ---- L5: cancel after approval, before persistence ----
  await cell("L5 login-cancel after approval while the JWT proof is in flight", async () => {
    resetScripted();
    const { paths, rt, home } = fresh(); await mkRuntime(rt);
    const d = await serveDaemon({ paths, version: "x", peerUid, sessionDir: home } as Parameters<typeof serveDaemon>[0]);
    try {
      let release!: () => void;
      tokenGate = new Promise<void>((r) => { release = r; });
      approved = true;
      const a = await wire(paths.socket);
      a.send({ v: 1, id: rid(), op: "login-start", idp: sBase });
      const prompt = await a.next(isPrompt);
      while ((hits["/api/auth/token"] ?? 0) === 0) await sleep(20);
      const c = await wire(paths.socket);
      const cid = rid();
      c.send({ v: 1, id: cid, op: "login-cancel", attempt: prompt.attempt });
      await sleep(100);
      release();
      const ack = await c.next((f) => f.id === cid);
      check("L5 cancel after approval, before persistence, reports cancelled", resultOf(ack).outcome === "cancelled", ack);
      check("L5 the start stream ends cancelled", resultOf(await a.next(isResult)).outcome === "cancelled");
      check("L5 nothing persisted: no session file, no catalog file", !existsSync(home) || readdirSync(home).length === 0, existsSync(home) ? readdirSync(home) : []);
      a.end(); c.end();
    } finally { await d.close(); }
  });

  // ---- L6, L7: cancel after completion, and a stale attempt ----
  await cell("L6 cancel after completion; L7 stale attempt vs successor", async () => {
    resetScripted();
    const { paths, rt, home } = fresh(); await mkRuntime(rt);
    const d = await serveDaemon({ paths, version: "x", peerUid, sessionDir: home } as Parameters<typeof serveDaemon>[0]);
    try {
      approved = true;
      const a = await wire(paths.socket);
      a.send({ v: 1, id: rid(), op: "login-start", idp: sBase });
      const first = await a.next(isPrompt);
      const done = resultOf(await a.next(isResult, 10000));
      check("L6 instrument: the first attempt signed in", done.outcome === "signed-in", done);
      const sessionBefore = readFileSync(join(home, readdirSync(home).find((f) => /session/i.test(f)) ?? readdirSync(home)[0]!), "utf8");
      const c = await wire(paths.socket);
      const cid = rid();
      c.send({ v: 1, id: cid, op: "login-cancel", attempt: first.attempt });
      const ack = await c.next((f) => f.id === cid);
      check("L6 cancelling a completed attempt reports completed, never cancelled", resultOf(ack).outcome === "completed", ack);
      check("L6 … and the persisted session is unchanged", readFileSync(join(home, readdirSync(home).find((f) => /session/i.test(f)) ?? readdirSync(home)[0]!), "utf8") === sessionBefore);
      approved = false;
      const b = await wire(paths.socket);
      b.send({ v: 1, id: rid(), op: "login-start", idp: sBase });
      const second = await b.next(isPrompt);
      check("L7 instrument: the successor has a different attempt id", second.attempt !== first.attempt, { first: first.attempt, second: second.attempt });
      const sid = rid();
      c.send({ v: 1, id: sid, op: "login-cancel", attempt: first.attempt });
      const stale = await c.next((f) => f.id === sid);
      check("L7 a cancel naming the old attempt does not touch the successor", resultOf(stale).outcome === "completed" && !b.frames.some(isResult), { stale, b: b.frames });
      const bogus = rid();
      c.send({ v: 1, id: bogus, op: "login-cancel", attempt: "Zz9Zz9Zz9Zz9Zz9Zz9Zz9Z" });
      check("L7 an unknown attempt reports not-found", resultOf(await c.next((f) => f.id === bogus)).outcome === "not-found");
      approved = true;
      check("L7 the successor then completes", resultOf(await b.next(isResult, 10000)).outcome === "signed-in");
      a.end(); b.end(); c.end();
    } finally { await d.close(); }
  });

  // ---- L8: disconnect before the result ----
  await cell("L8 disconnect before the result aborts the attempt", async () => {
    resetScripted();
    const { paths, rt, home } = fresh(); await mkRuntime(rt);
    const d = await serveDaemon({ paths, version: "x", peerUid, sessionDir: home } as Parameters<typeof serveDaemon>[0]);
    try {
      const a = await wire(paths.socket);
      a.send({ v: 1, id: rid(), op: "login-start", idp: sBase });
      await a.next(isPrompt);
      while (polls() < 1) await sleep(20);
      a.end();
      await a.closed;
      await sleep(200);
      const pollsAfter = polls();
      await sleep(1500);
      check("L8 0 polls after the requester disconnected", polls() === pollsAfter, { pollsAfter, now: polls() });
      check("L8 nothing persisted", !existsSync(home) || readdirSync(home).length === 0);
      const b = await wire(paths.socket);
      b.send({ v: 1, id: rid(), op: "login-start", idp: sBase });
      check("L8 the daemon accepts the next login-start", isPrompt(await b.next((f) => isPrompt(f) || f.ok === false)));
      b.end();
    } finally { await d.close(); }
  });

  // ---- L9: closed contract for the new ops ----
  await cell("L9 closed contract", async () => {
    resetScripted();
    const { paths, rt, home } = fresh(); await mkRuntime(rt);
    const d = await serveDaemon({ paths, version: "x", peerUid, sessionDir: home } as Parameters<typeof serveDaemon>[0]);
    try {
      const w = await wire(paths.socket);
      const cases: Array<[string, Frame, string]> = [
        ["login-start with an unknown field", { v: 1, op: "login-start", idp: sBase, token: "x" }, "UNKNOWN_FIELD"],
        ["login-start without idp", { v: 1, op: "login-start" }, "BAD_FIELD"],
        ["login-start with a non-loopback http idp", { v: 1, op: "login-start", idp: "http://example.com/api/auth" }, "BAD_FIELD"],
        ["login-start with an empty clientId", { v: 1, op: "login-start", idp: sBase, clientId: "" }, "BAD_FIELD"],
        ["login-cancel without attempt", { v: 1, op: "login-cancel" }, "BAD_FIELD"],
        ["login-cancel with a malformed attempt", { v: 1, op: "login-cancel", attempt: "../../x" }, "BAD_FIELD"],
        ["status with an extra field", { v: 1, op: "status", idp: sBase }, "UNKNOWN_FIELD"],
      ];
      let ok = 0;
      for (const [name, req, code] of cases) {
        const id = rid();
        w.send({ ...req, id });
        const r = await w.next((f) => f.id === id);
        const good = r.ok === false && (r.error as Record<string, unknown> | undefined)?.code === code;
        if (good) ok++;
        check(`L9 ${name} refused ${code}`, good, r);
      }
      check(`L9 ${cases.length}/${cases.length} refused and 0 IdP calls`, ok === cases.length && totalHits() === 0, hits);
      w.end();
    } finally { await d.close(); }
  });

  // ---- L11: per-connection request cap ----
  await cell("L11 per-connection request cap", async () => {
    const { paths, rt, home } = fresh(); await mkRuntime(rt);
    const d = await serveDaemon({ paths, version: "x", peerUid, sessionDir: home } as Parameters<typeof serveDaemon>[0]);
    try {
      const w = await wire(paths.socket);
      for (let i = 0; i < 200; i++) w.send({ v: 1, id: `s${i}`, op: "status" });
      await Promise.race([w.closed, sleep(3000)]);
      const answered = w.frames.filter((f) => f.ok === true).length;
      const refusal = w.frames.find((f) => (f.error as Record<string, unknown> | undefined)?.code === "TOO_MANY_REQUESTS");
      check("L11 the daemon answers a bounded number of requests on one connection, then refuses and closes", answered > 0 && answered < 200 && !!refusal && w.frames.length === answered + 1, { answered, frames: w.frames.length, refusal });
    } finally { await d.close(); }
  });

  // ---- L12: the CLI through the composition root ----
  await cell("L12 `cotal daemon login` through the composition root", async () => {
    const { paths, rt, home } = fresh(); await mkRuntime(rt);
    const d = await serveDaemon({ paths, version: "x", peerUid, sessionDir: home } as Parameters<typeof serveDaemon>[0]);
    try {
      const child = spawn(join(repo, "node_modules", ".bin", "tsx"), [join(repo, "bin", "cotal.ts"), "daemon", "login", "--idp", base, "--json"], {
        cwd: root, env: { ...process.env, XDG_RUNTIME_DIR: rt, COTAL_HOME: join(root, "cli-home"), COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"],
      });
      const exited = new Promise<number | null>((r) => child.once("exit", (c) => r(c)));
      let out = "", err = "";
      child.stdout.on("data", (b) => { out += String(b); });
      child.stderr.on("data", (b) => { err += String(b); });
      let code: string | undefined;
      for (let i = 0; i < 200 && !code && child.exitCode === null; i++) { code = /approval code[^A-Z0-9]*([A-Z0-9-]{4,})/i.exec(err)?.[1]; if (!code) await sleep(100); }
      check("L12 the CLI shows the approval code from the daemon's prompt", !!code, err.slice(0, 400));
      if (code) await decide(code, "approve");
      else child.kill("SIGKILL");
      const status = await Promise.race([exited, sleep(20000).then(() => { child.kill("SIGKILL"); return -1; })]);
      const stored = loadIdpSession(home, base);
      let doc: Record<string, unknown> = {};
      try { doc = JSON.parse(out) as Record<string, unknown>; } catch { /* reported below */ }
      check("L12 exit 0 with a signed-in result for the IdP subject", status === 0 && JSON.stringify(doc).includes(userId), { status, out: out.slice(0, 400), err: err.slice(0, 400) });
      check("L12 the session landed in the DAEMON's session dir, not the CLI's COTAL_HOME", !!stored?.token && !existsSync(join(root, "cli-home", "idp-sessions.json")));
      check("L12 neither stdout nor stderr carries the session token", !!stored?.token && !out.includes(stored.token) && !err.includes(stored.token));
    } finally { await d.close(); }
  });

  // ---- L13: a cancel waits for the result's delivery, even after the sign-in itself completed ----
  await cell("L13 cancel while a completed result is still being delivered", async () => {
    resetScripted();
    const { home } = fresh();
    approved = true;
    const coord = createLoginCoordinator({ sessionDir: home });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let delivered = false;
    try {
      const started = coord.start({ idp: sBase, onPrompt: () => {}, onResult: async () => { await gate; delivered = true; } });
      if (!started) throw new Error("instrument: the attempt did not start");
      await until(() => sessionSaved(home), "the session to be written");
      await sleep(300);
      let answer: { outcome?: string; deliveredFirst?: boolean } | undefined;
      const cancelling = coord.cancel(started.attempt).then((c) => { answer = { outcome: c.outcome, deliveredFirst: delivered }; });
      const hitsBefore = totalHits();
      const second = coord.start({ idp: sBase, onPrompt: () => {}, onResult: async () => {} });
      await sleep(300);
      check("L13 the cancel is not answered while the result is undelivered", answer === undefined, answer);
      check("L13 a new sign-in is refused while the result is undelivered, with 0 IdP calls", second === undefined && totalHits() === hitsBefore, { second: second?.attempt, hitsBefore, now: totalHits() });
      release();
      await cancelling;
      check("L13 the cancel then answers completed, after the result was delivered", answer?.outcome === "completed" && answer.deliveredFirst === true, answer);
      check("L13 the session stays", sessionSaved(home));
    } finally { release(); await coord.close(); }
  });

  // ---- L14: a failed sign-in relays no provider text, over the wire or to the terminal ----
  await cell("L14 a failed sign-in relays no provider text", async () => {
    resetScripted();
    const { paths, rt, home } = fresh(); await mkRuntime(rt);
    const d = await serveDaemon({ paths, version: "x", peerUid, sessionDir: home } as Parameters<typeof serveDaemon>[0]);
    const needle = SENTINEL.slice(0, 10);
    try {
      const cases: Array<[string, { status: number; body: string }]> = [
        ["an IdP error_description", { status: 400, body: JSON.stringify({ error: "server_error", error_description: `detail-${SENTINEL}` }) }],
        ["a 200 token body that is not JSON", { status: 200, body: SENTINEL }],
      ];
      for (const [name, override] of cases) {
        tokenOverride = override;
        const w = await wire(paths.socket);
        w.send({ v: 1, id: rid(), op: "login-start", idp: sBase });
        const r = resultOf(await w.next(isResult, 10000));
        check(`L14 ${name}: the attempt fails`, r.outcome === "failed", r);
        check(`L14 ${name}: no frame carries the provider's text`, !JSON.stringify(w.frames).includes(needle), w.frames);
        w.end();
        await w.closed;
      }
      tokenOverride = cases[0]![1];
      const run = await runCli(rt, sBase);
      check("L14 the CLI exits non-zero for the failure", run.status !== 0 && run.status !== -1, { status: run.status, out: run.out.slice(0, 300), err: run.err.slice(0, 300) });
      check("L14 instrument: the CLI reported the failed sign-in", /"daemon login"|daemon login/.test(run.out + run.err) && /fail|refus|denied/i.test(run.out + run.err), { out: run.out.slice(0, 600), err: run.err.slice(0, 600) });
      check("L14 neither stdout nor stderr carries the provider's text", !run.out.includes(needle) && !run.err.includes(needle), { out: run.out.slice(0, 300), err: run.err.slice(0, 300) });
    } finally { await d.close(); }
  });

  // ---- L15: a failure after the session was written claims nothing about persistence ----
  await cell("L15 a failure after the session write", async () => {
    resetScripted();
    const { paths, rt, home } = fresh(); await mkRuntime(rt);
    // Stock writes the session, then reads the catalog file; a malformed one fails the sign-in there.
    mkdirSync(home, { mode: 0o700 });
    writeFileSync(join(home, "space-catalogs.json"), "{not json", { mode: 0o600 });
    approved = true;
    const d = await serveDaemon({ paths, version: "x", peerUid, sessionDir: home } as Parameters<typeof serveDaemon>[0]);
    try {
      const run = await runCli(rt, sBase);
      check("L15 instrument: the sign-in failed and the session was written", run.status !== 0 && run.status !== -1 && sessionSaved(home), { status: run.status, saved: sessionSaved(home), out: run.out.slice(0, 300), err: run.err.slice(0, 300) });
      check("L15 instrument: the CLI reported the failed sign-in", /"daemon login"|daemon login/.test(run.out + run.err) && /fail|refus/i.test(run.out + run.err), { out: run.out.slice(0, 600), err: run.err.slice(0, 600) });
      check("L15 the CLI does not claim nothing was saved", !/no session was saved|nothing was saved/i.test(run.out + run.err), { out: run.out.slice(0, 300), err: run.err.slice(0, 300) });
    } finally { await d.close(); }
  });
} catch (e) {
  fail++;
  console.error("  ✗ smoke crashed:", e instanceof Error ? (e.stack ?? e.message) : e);
} finally {
  idpServer.close();
  scripted.close();
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nDAEMON LOGIN SMOKE ${fail === 0 ? "OK" : "FAILED"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
