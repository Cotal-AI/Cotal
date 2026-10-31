/**
 * `cotal daemon` connection readiness (A2b.1): live, red-first cells over the real unix socket.
 *
 * `connect-check {space}` answers one closed outcome saying whether this machine's daemon could
 * register with a space, and if not, exactly why. It never registers, never holds a bearer and
 * starts nothing. Every cell drives the shipped `serveDaemon` with a temp machine home
 * (`COTAL_HOME`), a mesh record seeded through the stock registry writer, a stock IdP session file,
 * and a loopback HTTP fixture standing in for the space's auth service. The fixture counts every
 * request by method and route. No real credentials and no provider calls.
 *
 * Cells (each asserts counts):
 *  C1  an unknown space: not-registered, 0 fixture requests, no daemon identity written;
 *  C2  an open (non-user-auth) space: not-user-auth, 0 fixture requests;
 *  C3  a user-auth space with no stock sign-in for its IdP: not-signed-in, 0 fixture requests;
 *  C4  the auth service answers the authority route with 404 (serviceEndpoints off):
 *      unsupported-by-space, exactly 1 GET, 0 POST, no identity written;
 *  C5  the auth service answers with its DATA account: ready-to-register, carrying that account,
 *      the daemon's endpoint and a lifecycle-shaped instance id, the identity record is 0600 in a
 *      0700 dir, and 0 POST reached the fixture;
 *  C6  a second check reuses the same instance id and account (no re-mint), 1 more GET, 0 POST;
 *  C7  the service later answers a different account: account-mismatch, the pinned account is
 *      unchanged on disk (no repin), 0 POST;
 *  C8  the authority answers a redirect, or garbage: refused, 0 POST, nothing pinned;
 *  C9  the authority is unreachable: unreachable, nothing pinned;
 *  C10 the daemon writes nothing under the Manager's identity path or the mesh root;
 *  C11 closed contract: connect-check without space, with an unknown field, or with a malformed
 *      space is refused with its typed code and 0 fixture requests;
 *  C12 `cotal daemon connect-check --space <s> --json` through the composition root prints the
 *      daemon's outcome and no secret;
 *  C13 a daemon closed and started again on the same machine home reuses the identity: same instance
 *      id and account, the record byte-identical and still the only one, 0 POST;
 *  C14 N concurrent first checks for one space through one daemon yield one instance id and exactly
 *      one new identity record, 0 POST.
 *
 * Run: tsx bin/smoke/daemon-connect.smoke.ts   (Linux only)
 */
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { connect as netConnect, type AddressInfo, type Socket } from "node:net";
import { mkdtempSync, chmodSync, mkdirSync, rmSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { skipSuite } from "@cotal-ai/smoke-kit";
import { peerCredentials } from "@cotal-ai/seat";
import { saveIdpSession } from "@cotal-ai/auth";
import { recordMesh, userAuthStateDir, type MeshEntry } from "@cotal-ai/workspace";
import { daemonPaths } from "../daemon/endpoint.js";
import { serveDaemon } from "../daemon/server.js";

if (process.platform !== "linux") skipSuite(`daemon-connect smoke: Linux only; skipped on ${process.platform}`);
const scratchParent = process.env.COTAL_DAEMON_SMOKE_TMP ?? tmpdir();
// The CLI children get no mesh identity or connection material from whatever runs this suite.
for (const key of Object.keys(process.env)) if (key.startsWith("COTAL_")) delete process.env[key];

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const peerUid = (s: Socket) => peerCredentials(s).uid;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};
async function cell(title: string, body: () => Promise<void>): Promise<void> {
  console.log(title);
  try { await body(); } catch (e) { fail++; console.log(`  ✗ FAIL: ${title} crashed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 600)); }
}

type Frame = Record<string, unknown>;
let seq = 0;
const rid = () => `c${++seq}`;
async function ask(socket: string, req: Frame): Promise<Frame> {
  const sock = netConnect(socket);
  await new Promise<void>((res, rej) => { sock.once("connect", () => res()); sock.once("error", rej); });
  const id = typeof req.id === "string" ? req.id : rid();
  sock.write(`${JSON.stringify({ v: 1, id, ...req })}\n`);
  sock.setEncoding("utf8");
  let buf = "";
  try {
    return await new Promise<Frame>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`no reply within 10s; got ${buf.slice(0, 300)}`)), 10_000);
      sock.on("data", (c: string) => {
        buf += c;
        const nl = buf.indexOf("\n");
        if (nl !== -1) { clearTimeout(t); resolve(JSON.parse(buf.slice(0, nl)) as Frame); }
      });
      sock.once("error", (e) => { clearTimeout(t); reject(e); });
    });
  } finally { sock.destroy(); }
}
const resultOf = (f: Frame) => (f.result ?? {}) as Record<string, unknown>;
const errorOf = (f: Frame) => (f.error ?? {}) as Record<string, unknown>;

// ---------- a loopback fixture for the space's auth service ----------
type Answer = { status: number; body?: unknown; headers?: Record<string, string> } | "hang";
let answer: Answer = { status: 404 };
const hits: Array<{ method: string; path: string }> = [];
const authority = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
  for await (const _ of req) { /* drain */ }
  hits.push({ method: req.method ?? "", path: new URL(req.url!, "http://x").pathname });
  const a = answer;
  if (a === "hang") return;
  res.writeHead(a.status, { "content-type": "application/json", ...(a.headers ?? {}) });
  res.end(a.body === undefined ? "" : typeof a.body === "string" ? a.body : JSON.stringify(a.body));
});
await new Promise<void>((r) => authority.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(authority.address() as AddressInfo).port}`;
const gets = () => hits.filter((h) => h.method === "GET").length;
const posts = () => hits.filter((h) => h.method !== "GET").length;
const resetHits = () => { hits.length = 0; };

// A dead loopback port for the unreachable cell.
const dead = createHttpServer();
await new Promise<void>((r) => dead.listen(0, "127.0.0.1", r));
const deadBase = `http://127.0.0.1:${(dead.address() as AddressInfo).port}`;
await new Promise<void>((r) => dead.close(() => r()));

// ---------- an isolated machine home ----------
const root = mkdtempSync(join(scratchParent, "cdc-"));
chmodSync(root, 0o700);
const home = join(root, "home");
mkdirSync(home, { mode: 0o700 });
process.env.COTAL_HOME = home;
const meshRoot = join(root, "mesh");
mkdirSync(meshRoot, { mode: 0o700 });
const IDP = "https://idp.example.test/api/auth";
// Two account-key-shaped values. The daemon only pins and compares them; nothing signs with them.
const ACCOUNT_A = `A${"B".repeat(55)}`;
const ACCOUNT_B = `A${"C".repeat(55)}`;
// The shape `cotal meshes add --from` records for a remote user-auth space: the sentinel path lives under
// that space's own state dir, which the stock client checks. The file itself is never read by this check.
const userMesh = (space: string, url: string): MeshEntry => ({
  space, server: "nats://127.0.0.1:4222", root: meshRoot, mode: "user", origin: "manual",
  userAuth: { provider: "cotal", idp: { url: IDP, issuer: "https://idp.example.test", audience: "https://idp.example.test" }, endpoints: { url }, remote: true, sentinelCredsPath: join(userAuthStateDir(meshRoot, space, { readOnly: true }), "sentinel.creds") },
  ts: new Date().toISOString(),
});
recordMesh(userMesh("signedout", base));
recordMesh({ space: "openspace", server: "nats://127.0.0.1:4222", root: meshRoot, mode: "open", ts: new Date().toISOString() });
const daemonStateDir = join(home, "daemon");
const listDaemonState = (): string[] => existsSync(daemonStateDir) ? readdirSync(daemonStateDir, { recursive: true }).map(String).sort() : [];
const identityFiles = (): string[] => listDaemonState().filter((p) => p.endsWith("service-identity.json"));
const meshRootBefore = readdirSync(meshRoot, { recursive: true }).map(String).sort();

const rtDir = join(root, "rt");
mkdirSync(rtDir, { mode: 0o700 });
const paths = daemonPaths({ XDG_RUNTIME_DIR: rtDir });

/** The instance id C5 first observes; C6, C12 and C13 compare against it. */
let firstInstance: unknown;
try {
  const d = await serveDaemon({ paths, version: "0.0.0-smoke", peerUid, sessionDir: home } as Parameters<typeof serveDaemon>[0]);
  try {
    await cell("C1 unknown space", async () => {
      resetHits();
      const r = await ask(paths.socket, { op: "connect-check", space: "nosuch" });
      check("C1 not-registered", r.ok === true && resultOf(r).outcome === "not-registered", r);
      check("C1 0 fixture requests and no identity written", hits.length === 0 && identityFiles().length === 0, { hits, ids: identityFiles() });
    });

    await cell("C2 open space", async () => {
      resetHits();
      const r = await ask(paths.socket, { op: "connect-check", space: "openspace" });
      check("C2 not-user-auth", r.ok === true && resultOf(r).outcome === "not-user-auth", r);
      check("C2 0 fixture requests", hits.length === 0, hits);
    });

    await cell("C3 not signed in", async () => {
      resetHits();
      const r = await ask(paths.socket, { op: "connect-check", space: "signedout" });
      check("C3 not-signed-in", r.ok === true && resultOf(r).outcome === "not-signed-in", r);
      check("C3 0 fixture requests", hits.length === 0, hits);
    });

    // From here the machine is signed in to the space's IdP through the stock session writer.
    saveIdpSession(home, IDP, { token: "smoke-session-handle-not-a-secret", expiresAt: Math.floor(Date.now() / 1000) + 3600, sub: "smoke-sub" });
    recordMesh(userMesh("ready", base));

    await cell("C4 service endpoints off at the space", async () => {
      resetHits();
      answer = { status: 404 };
      const r = await ask(paths.socket, { op: "connect-check", space: "ready" });
      check("C4 unsupported-by-space", r.ok === true && resultOf(r).outcome === "unsupported-by-space", r);
      check("C4 exactly 1 GET of the authority route and 0 POST", gets() === 1 && posts() === 0 && hits[0]?.path === "/service-endpoint-authority", hits);
      check("C4 no identity written", identityFiles().length === 0, identityFiles());
    });

    firstInstance = undefined;
    await cell("C5 ready to register", async () => {
      resetHits();
      answer = { status: 200, body: { v: 1, kind: "service-endpoint-authority-info", space: "ready", accountPublicKey: ACCOUNT_A } };
      const r = await ask(paths.socket, { op: "connect-check", space: "ready" });
      const res = resultOf(r);
      firstInstance = res.instanceId;
      check("C5 ready-to-register with the space's account", r.ok === true && res.outcome === "ready-to-register" && res.accountPublicKey === ACCOUNT_A, r);
      check("C5 carries the daemon's endpoint and a lifecycle-shaped instance id", res.endpoint === "ai.cotal.machine" && typeof res.instanceId === "string" && /^[a-z0-9]{26,32}$/.test(res.instanceId), res);
      const files = identityFiles();
      const file = files.length === 1 ? join(daemonStateDir, files[0]!) : "";
      check("C5 one identity record, 0600 in a 0700 dir", files.length === 1 && (statSync(file).mode & 0o777) === 0o600 && (statSync(dirname(file)).mode & 0o777) === 0o700, files);
      const rec = file ? JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown> : {};
      check("C5 the record names the space, endpoint, instance and pinned account, and nothing else", JSON.stringify(Object.keys(rec).sort()) === JSON.stringify(["accountPublicKey", "endpoint", "instanceId", "kind", "space", "v"]) && rec.instanceId === res.instanceId && rec.accountPublicKey === ACCOUNT_A, rec);
      check("C5 1 GET, 0 POST", gets() === 1 && posts() === 0, hits);
    });

    await cell("C6 a later check reuses the identity", async () => {
      resetHits();
      const r = await ask(paths.socket, { op: "connect-check", space: "ready" });
      check("C6 same instance id and account", resultOf(r).outcome === "ready-to-register" && resultOf(r).instanceId === firstInstance && resultOf(r).accountPublicKey === ACCOUNT_A, r);
      check("C6 still one identity record; 1 GET, 0 POST", identityFiles().length === 1 && gets() === 1 && posts() === 0, { ids: identityFiles(), hits });
    });

    await cell("C7 the space's account changed", async () => {
      resetHits();
      answer = { status: 200, body: { v: 1, kind: "service-endpoint-authority-info", space: "ready", accountPublicKey: ACCOUNT_B } };
      const r = await ask(paths.socket, { op: "connect-check", space: "ready" });
      check("C7 account-mismatch naming both accounts", resultOf(r).outcome === "account-mismatch" && resultOf(r).pinnedAccountPublicKey === ACCOUNT_A && resultOf(r).observedAccountPublicKey === ACCOUNT_B, r);
      const rec = JSON.parse(readFileSync(join(daemonStateDir, identityFiles()[0]!), "utf8")) as Record<string, unknown>;
      check("C7 the pinned account is unchanged on disk; 0 POST", rec.accountPublicKey === ACCOUNT_A && posts() === 0, { rec, hits });
    });

    await cell("C8 redirect or garbage from the authority", async () => {
      recordMesh(userMesh("bad", base));
      resetHits();
      answer = { status: 302, headers: { location: "http://127.0.0.1:1/elsewhere" } };
      const r1 = await ask(paths.socket, { op: "connect-check", space: "bad" });
      answer = { status: 200, body: "not json at all" };
      const r2 = await ask(paths.socket, { op: "connect-check", space: "bad" });
      answer = { status: 200, body: { v: 1, kind: "service-endpoint-authority-info", space: "someone-else", accountPublicKey: ACCOUNT_B } };
      const r3 = await ask(paths.socket, { op: "connect-check", space: "bad" });
      check("C8 redirect, garbage and a wrong-space answer are each refused", [r1, r2, r3].every((r) => resultOf(r).outcome === "refused"), [r1, r2, r3]);
      check("C8 0 POST and only 3 GETs (no redirect followed)", posts() === 0 && gets() === 3, hits);
      check("C8 nothing pinned for the space", identityFiles().length === 1, identityFiles());
    });

    await cell("C9 authority unreachable", async () => {
      recordMesh(userMesh("gone", deadBase));
      const r = await ask(paths.socket, { op: "connect-check", space: "gone" });
      check("C9 unreachable", resultOf(r).outcome === "unreachable", r);
      check("C9 nothing pinned for the space", identityFiles().length === 1, identityFiles());
    });

    await cell("C10 nothing written outside the daemon's own state", async () => {
      const after = readdirSync(meshRoot, { recursive: true }).map(String).sort();
      check("C10 the mesh root (and any manager identity under it) is unchanged", JSON.stringify(after) === JSON.stringify(meshRootBefore), { before: meshRootBefore, after });
      check("C10 no manager-instance file anywhere under the machine home", !readdirSync(home, { recursive: true }).map(String).some((p) => p.includes("manager-instance")));
    });

    await cell("C11 closed contract", async () => {
      resetHits();
      const cases: Array<[string, Frame, string]> = [
        ["without space", { op: "connect-check" }, "BAD_FIELD"],
        ["with an unknown field", { op: "connect-check", space: "ready", register: true }, "UNKNOWN_FIELD"],
        ["with a malformed space", { op: "connect-check", space: "bad space/../x" }, "BAD_FIELD"],
      ];
      let ok = 0;
      for (const [name, req, code] of cases) {
        const r = await ask(paths.socket, req);
        const good = r.ok === false && errorOf(r).code === code;
        if (good) ok++;
        check(`C11 connect-check ${name} refused ${code}`, good, r);
      }
      check(`C11 ${cases.length}/${cases.length} refused with 0 fixture requests`, ok === cases.length && hits.length === 0, hits);
    });

    await cell("C12 the CLI through the composition root", async () => {
      answer = { status: 200, body: { v: 1, kind: "service-endpoint-authority-info", space: "ready", accountPublicKey: ACCOUNT_A } };
      const child = spawn(join(repo, "node_modules", ".bin", "tsx"), [join(repo, "bin", "cotal.ts"), "daemon", "connect-check", "--space", "ready", "--json"], {
        cwd: root, env: { ...process.env, XDG_RUNTIME_DIR: rtDir, COTAL_HOME: home, COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "", err = "";
      child.stdout.on("data", (b) => { out += String(b); });
      child.stderr.on("data", (b) => { err += String(b); });
      const status = await Promise.race([new Promise<number | null>((r) => child.once("exit", (c) => r(c))), sleep(20000).then(() => { child.kill("SIGKILL"); return -1; })]);
      let doc: Record<string, any> = {};
      try { doc = JSON.parse(out) as Record<string, any>; } catch { /* reported below */ }
      check("C12 exit 0 with ready-to-register and the pinned instance", status === 0 && doc.result?.outcome === "ready-to-register" && doc.result?.instanceId === firstInstance, { status, out: out.slice(0, 400), err: err.slice(0, 400) });
      check("C12 no session handle in stdout or stderr", !out.includes("smoke-session-handle") && !err.includes("smoke-session-handle"));
    });
  } finally { await d.close(); }

  // C13: a daemon stopped and started again on the same machine home reuses its identity.
  await cell("C13 a restarted daemon reuses the identity", async () => {
    resetHits();
    answer = { status: 200, body: { v: 1, kind: "service-endpoint-authority-info", space: "ready", accountPublicKey: ACCOUNT_A } };
    const recordBefore = readFileSync(join(daemonStateDir, identityFiles()[0]!), "utf8");
    check("C13 instrument: the first daemon's socket is gone after close", !existsSync(paths.socket), paths.socket);
    const d2 = await serveDaemon({ paths, version: "0.0.0-smoke", peerUid, sessionDir: home } as Parameters<typeof serveDaemon>[0]);
    try {
      const r = await ask(paths.socket, { op: "connect-check", space: "ready" });
      check("C13 the new daemon answers ready-to-register with the first daemon's instance id and account", resultOf(r).outcome === "ready-to-register" && resultOf(r).instanceId === firstInstance && resultOf(r).accountPublicKey === ACCOUNT_A, r);
      check("C13 the identity record is byte-identical and still the only one; 1 GET, 0 POST", identityFiles().length === 1 && readFileSync(join(daemonStateDir, identityFiles()[0]!), "utf8") === recordBefore && gets() === 1 && posts() === 0, { ids: identityFiles(), hits });
    } finally { await d2.close(); }
  });

  // C14: concurrent first checks for one space create exactly one identity.
  await cell("C14 concurrent first checks create one identity", async () => {
    const N = 8;
    recordMesh(userMesh("burst", base));
    resetHits();
    answer = { status: 200, body: { v: 1, kind: "service-endpoint-authority-info", space: "burst", accountPublicKey: ACCOUNT_A } };
    const before = identityFiles().length;
    const d3 = await serveDaemon({ paths, version: "0.0.0-smoke", peerUid, sessionDir: home } as Parameters<typeof serveDaemon>[0]);
    try {
      const replies = await Promise.all(Array.from({ length: N }, () => ask(paths.socket, { op: "connect-check", space: "burst" })));
      const ids = new Set(replies.map((r) => resultOf(r).instanceId));
      check(`C14 all ${N} answer ready-to-register`, replies.every((r) => resultOf(r).outcome === "ready-to-register"), replies.map((r) => resultOf(r).outcome));
      check(`C14 the ${N} answers name exactly one instance id`, ids.size === 1 && typeof [...ids][0] === "string", [...ids]);
      check("C14 exactly one new identity record for the space", identityFiles().length === before + 1, identityFiles());
      check(`C14 ${N} GETs reached the space and 0 POST`, gets() === N && posts() === 0, hits);
    } finally { await d3.close(); }
  });
} catch (e) {
  fail++;
  console.error("  ✗ smoke crashed:", e instanceof Error ? (e.stack ?? e.message) : e);
} finally {
  authority.close();
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nDAEMON CONNECT SMOKE ${fail === 0 ? "OK" : "FAILED"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
