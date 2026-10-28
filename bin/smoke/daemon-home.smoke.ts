/**
 * `cotal daemon … --daemon-home <abs dir>`: red-first cells for an explicit managed daemon home,
 * driven through the real composition root (`bin/cotal.ts`) as child processes over real unix
 * sockets. Nothing here restates the rule under test: every cell runs the shipped CLI and counts
 * what it did on disk and on the wire.
 *
 * Contract (SUBHOME-DELTA.md §4):
 * - With `--daemon-home D` the daemon keeps login, connect-check, register and service state under D.
 * - It binds a socket derived from D under `$XDG_RUNTIME_DIR/cotal/`, distinct from the legacy
 *   `$XDG_RUNTIME_DIR/cotal/daemon.sock`.
 * - It holds the kernel-held lifetime lock `D/daemon.lock` while serving.
 * - Clients refuse a peer that is not that lock's live owner.
 * - It reads the shared mesh registry (`$COTAL_HOME/meshes`) and never writes it.
 * - It never copies or moves legacy identity, session or approval.
 * - With no flag, behaviour is today's exactly, which now includes its own lifetime lock.
 * - A start removes the socket its own dead predecessor published, and no other.
 *
 * Cells (each asserts counts or exact codes, never just "no error"):
 *  H0 control, no flag: legacy `serve` binds the fixed legacy socket, and `status` answers with
 *     that serve's pid. This is green today and must stay green;
 *  H1 a managed `serve --daemon-home D` beside a live legacy daemon: binds a different socket under
 *     `$XDG_RUNTIME_DIR/cotal/`. Both answer their own pid. The legacy socket keeps its inode and
 *     mtime. The no-flag client still reaches legacy. D holds a live lock owned by the managed pid;
 *  H2 state is disjoint and nothing migrates:
 *     - one space is registered only in `$COTAL_HOME/meshes`;
 *     - a legacy connect-check pins identity L under `$COTAL_HOME/daemon`;
 *     - a managed connect-check (session only in D) answers ready-to-register with identity M ≠ L,
 *       written under `D/daemon`;
 *     - the legacy identity and session are byte-identical, `D/meshes` is never created, and the
 *       authority saw GETs only;
 *  H3 home validation refuses before any bind or lock:
 *     - a 0755 home: PERMISSION_DENIED / DIR_WRONG_MODE, exit 2, mode unchanged;
 *     - a symlinked home: PERMISSION_DENIED / DIR_SYMLINK;
 *     - a relative home: USAGE_INVALID naming "absolute";
 *     - the Cotal home itself: USAGE_INVALID naming the Cotal home, and no lock in it;
 *     - in every case 0 new runtime entries and no lock file;
 *  H4 lifetime lock and stale-socket recovery:
 *     - a second managed serve on D refuses CONFLICT / LOCK_HELD naming the live holder's pid, and
 *       the first's socket keeps its inode;
 *     - after SIGKILL of the first, its socket stays and the kernel has released its lock;
 *     - a new serve needs no operator step: it binds the SAME derived path, with a different inode,
 *       and answers its own pid;
 *  H5 peer must be the lock owner:
 *     - the smoke process holds `D/daemon.lock` through the same kernel `flock` the daemon takes;
 *     - a different same-uid process listens at the derived path;
 *     - `status --daemon-home D` refuses PERMISSION_DENIED / PEER_NOT_LOCK_OWNER, exit 2, and the
 *       listener receives 0 bytes.
 *
 * Not covered here, and still to add: register approval carry-over (needs the stock auth service
 * sandbox of daemon-register.smoke.ts), a foreign-owned home (needs a user namespace) and the
 * `cotal service install` unit path.
 *
 * Run: tsx bin/smoke/daemon-home.smoke.ts   (Linux only)
 */
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { chmodSync, closeSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { skipSuite } from "@cotal-ai/smoke-kit";
import { flockExclusiveNb } from "@cotal-ai/seat";
import { saveIdpSession } from "@cotal-ai/auth";
import { recordMesh, userAuthStateDir, type MeshEntry } from "@cotal-ai/workspace";
import { daemonPaths } from "../daemon/endpoint.js";

if (process.platform !== "linux") skipSuite(`daemon-home smoke: Linux only; skipped on ${process.platform}`);
// Read the scratch-parent override before the COTAL_* environment is cleared below.
const scratchParent = process.env.COTAL_DAEMON_SMOKE_TMP ?? tmpdir();
// The CLI children get no mesh identity or connection material from whatever runs this suite.
for (const key of Object.keys(process.env)) if (key.startsWith("COTAL_")) delete process.env[key];

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
// node itself, with the tsx loader: the child's pid IS the daemon's pid (the tsx bin relays to a
// grandchild, which would hide the pid the status, lock-owner and SIGKILL cells compare).
const daemonArgv = (args: string[]) => ["--import", import.meta.resolve("tsx"), join(repo, "bin", "cotal.ts"), "daemon", ...args];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};
async function cell(title: string, body: () => Promise<void>): Promise<void> {
  console.log(title);
  try { await body(); } catch (e) { fail++; console.log(`  ✗ FAIL: ${title} crashed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 600)); }
}

// ---------- owned sandbox ----------
const root = mkdtempSync(join(scratchParent, "cdh-"));
chmodSync(root, 0o700);
const home = join(root, "home"), rt = join(root, "rt"), meshRoot = join(root, "mesh"), managed = join(root, "managed"), user = join(root, "user");
for (const d of [home, rt, meshRoot, managed, user]) mkdirSync(d, { mode: 0o700 });
process.env.COTAL_HOME = home;
const legacy = daemonPaths({ XDG_RUNTIME_DIR: rt });
const runtimeDir = join(rt, "cotal");
const lockFile = (d: string) => join(d, "daemon.lock");
/** The pid the lock record names, or undefined when there is no readable record. */
const lockRecordPid = (d: string): number | undefined => {
  try {
    const text = readFileSync(lockFile(d), "utf8");
    const o = text.trim() ? JSON.parse(text) as { pid?: unknown } : undefined;
    return typeof o?.pid === "number" ? o.pid : undefined;
  } catch { return undefined; }
};
/** Take the daemon's own kernel lock on D, or report that the kernel holds it for someone. */
const takeLock = (d: string): { fd: number; held: boolean } => {
  const fd = openSync(lockFile(d), constants.O_RDWR | constants.O_CREAT, 0o600);
  return { fd, held: flockExclusiveNb(fd) };
};
/** True when no process holds D's lock: the probe takes it and gives it straight back. */
const lockFree = (d: string): boolean => {
  const { fd, held } = takeLock(d);
  closeSync(fd);
  return held;
};
// Every per-user location the CLI could read or write points into this sandbox, never the real user's.
const childEnv = {
  ...process.env, HOME: user, XDG_CONFIG_HOME: join(user, "config"), XDG_STATE_HOME: join(user, "state"), XDG_CACHE_HOME: join(user, "cache"),
  XDG_RUNTIME_DIR: rt, COTAL_HOME: home, COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_NO_UPDATE_CHECK: "1", NO_COLOR: "1", DO_NOT_TRACK: "1",
};
const runtimeEntries = (): string[] => existsSync(runtimeDir) ? readdirSync(runtimeDir, { recursive: true }).map(String).sort() : [];

/** Every child this smoke starts, so teardown can wait for each one to exit before removing the root. */
const children = new Set<ChildProcess>();
const exited = (child: ChildProcess): Promise<void> => child.exitCode !== null || child.signalCode !== null
  ? Promise.resolve()
  : new Promise<void>((r) => child.once("exit", () => r()));
/** Kill and WAIT for the exit: a timed-out or killed child must not outlive the fixture it uses. */
async function kill(child: ChildProcess, signal: NodeJS.Signals = "SIGKILL"): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  await exited(child);
}
function track(child: ChildProcess): ChildProcess {
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}

type Doc = { outcome?: string; result?: Record<string, any>; error?: { code?: string; message?: string; remedy?: string; cause?: { code?: string } } };
/** One CLI invocation to completion. */
async function cli(args: string[], timeoutMs = 30_000): Promise<{ status: number | null; doc: Doc; out: string; err: string }> {
  const child = track(spawn(process.execPath, daemonArgv(args), { cwd: root, env: childEnv, stdio: ["ignore", "pipe", "pipe"] }));
  let out = "", err = "";
  child.stdout!.on("data", (b) => { out += String(b); });
  child.stderr!.on("data", (b) => { err += String(b); });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; void kill(child); }, timeoutMs);
  await exited(child);
  clearTimeout(timer);
  const status = timedOut ? -1 : child.exitCode;
  let doc: Doc = {};
  try { doc = JSON.parse(out.trim().split("\n").pop() ?? "") as Doc; } catch { /* reported by the caller */ }
  return { status, doc, out, err };
}

/** A `daemon serve` child, read until it reports ready or exits. */
interface Serve { child: ChildProcess; socket?: string; status?: number | null; out: string; err: string }
async function serve(extra: string[]): Promise<Serve> {
  const child = track(spawn(process.execPath, daemonArgv(["serve", ...extra]), { cwd: root, env: childEnv, stdio: ["ignore", "pipe", "pipe"] }));
  const s: Serve = { child, out: "", err: "" };
  child.stderr!.on("data", (b) => { s.err += String(b); });
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, 30_000);
    child.stdout!.on("data", (b) => {
      s.out += String(b);
      const m = /daemon ready at (\S+)/.exec(s.out);
      if (m) { s.socket = m[1]; clearTimeout(t); resolve(); }
    });
    child.once("exit", (c) => { s.status = c; clearTimeout(t); resolve(); });
  });
  return s;
}
const live = (s: Serve | undefined) => !!s && s.socket !== undefined && s.child.exitCode === null && s.child.signalCode === null;
/** Stop a serve child: the given signal, then SIGKILL if it has not exited within 10 s. Always waits. */
async function stop(s: Serve | undefined, signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
  if (!s || s.child.exitCode !== null || s.child.signalCode !== null) return;
  s.child.kill(signal);
  const graceful = await Promise.race([exited(s.child).then(() => true), sleep(10_000).then(() => false)]);
  if (!graceful) await kill(s.child);
}
const fileState = (p: string) => { const st = lstatSync(p); return { ino: st.ino, mtimeMs: st.mtimeMs }; };

// ---------- a loopback fixture for the space's service authority (connect-check reads one GET) ----------
const ACCOUNT = `A${"B".repeat(55)}`;
const hits: Array<{ method: string }> = [];
const authority = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
  for await (const _ of req) { /* drain */ }
  hits.push({ method: req.method ?? "" });
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ v: 1, kind: "service-endpoint-authority-info", space: "ready", accountPublicKey: ACCOUNT }));
});
await new Promise<void>((r) => authority.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(authority.address() as AddressInfo).port}`;
const IDP = "https://idp.example.test/api/auth";
const userMesh = (space: string): MeshEntry => ({
  space, server: "nats://127.0.0.1:4222", root: meshRoot, mode: "user", origin: "manual",
  userAuth: { provider: "cotal", idp: { url: IDP, issuer: "https://idp.example.test", audience: "https://idp.example.test" }, endpoints: { url: base }, remote: true, sentinelCredsPath: join(userAuthStateDir(meshRoot, space, { readOnly: true }), "sentinel.creds") },
  ts: new Date().toISOString(),
});
const identities = (dir: string): string[] => existsSync(join(dir, "daemon")) ? readdirSync(join(dir, "daemon"), { recursive: true }).map(String).filter((p) => p.endsWith("service-identity.json")).sort() : [];

let legacyServe: Serve | undefined, managedServe: Serve | undefined;
let derived: string | undefined;
try {
  await cell("H0 control: no flag keeps the fixed legacy socket", async () => {
    legacyServe = await serve([]);
    check("H0 legacy serve reports ready at $XDG_RUNTIME_DIR/cotal/daemon.sock", live(legacyServe) && legacyServe.socket === legacy.socket, { socket: legacyServe.socket, status: legacyServe.status, err: legacyServe.err.slice(0, 300) });
    const st = await cli(["status", "--json"]);
    check("H0 no-flag status answers ready with the legacy serve's pid, exit 0", st.status === 0 && st.doc.result?.state === "ready" && st.doc.result?.pid === legacyServe.child.pid, { status: st.status, doc: st.doc });
    check("H0 the runtime dir holds exactly the legacy socket", JSON.stringify(runtimeEntries()) === JSON.stringify(["daemon.sock"]), runtimeEntries());
  });

  await cell("H1 a managed daemon home binds its own socket beside a live legacy daemon", async () => {
    const legacyBefore = fileState(legacy.socket);
    managedServe = await serve(["--daemon-home", managed]);
    derived = managedServe.socket;
    check("H1 managed serve reports ready (not refused)", live(managedServe), { status: managedServe.status, out: managedServe.out.slice(0, 300), err: managedServe.err.slice(0, 300) });
    check("H1 its socket is under $XDG_RUNTIME_DIR/cotal/ and is not the legacy socket", typeof derived === "string" && derived.startsWith(`${runtimeDir}/`) && derived !== legacy.socket, derived);
    check("H1 its socket is a 0600 socket", typeof derived === "string" && existsSync(derived) && lstatSync(derived).isSocket() && (lstatSync(derived).mode & 0o777) === 0o600);
    const mst = await cli(["status", "--daemon-home", managed, "--json"]);
    check("H1 managed status answers ready with the managed serve's pid", mst.status === 0 && mst.doc.result?.pid === managedServe.child.pid && mst.doc.result?.pid !== legacyServe?.child.pid, { status: mst.status, doc: mst.doc });
    const lst = await cli(["status", "--json"]);
    check("H1 no-flag status still answers the legacy pid", lst.status === 0 && lst.doc.result?.pid === legacyServe?.child.pid, { status: lst.status, doc: lst.doc });
    const legacyAfter = fileState(legacy.socket);
    check("H1 the legacy socket keeps its inode and mtime", legacyAfter.ino === legacyBefore.ino && legacyAfter.mtimeMs === legacyBefore.mtimeMs, { legacyBefore, legacyAfter });
    check("H1 D/daemon.lock is held by the managed serve, whose record names its pid", !lockFree(managed) && lockRecordPid(managed) === managedServe.child.pid, { free: lockFree(managed), recorded: lockRecordPid(managed), pid: managedServe.child.pid });
    check("H1 no lock was created in the legacy home", !existsSync(lockFile(home)));
  });

  await cell("H2 managed state is disjoint and nothing migrates from legacy", async () => {
    recordMesh(userMesh("ready"));
    const meshesBefore = readdirSync(join(home, "meshes"), { recursive: true }).map(String).sort();
    saveIdpSession(home, IDP, { token: "legacy-session-handle-not-a-secret", expiresAt: Math.floor(Date.now() / 1000) + 3600, sub: "legacy-sub" });
    const legacyCheck = await cli(["connect-check", "--space", "ready", "--json"]);
    check("H2 instrument: the legacy daemon pins its identity under $COTAL_HOME", legacyCheck.status === 0 && legacyCheck.doc.result?.outcome === "ready-to-register" && identities(home).length === 1, { status: legacyCheck.status, doc: legacyCheck.doc, ids: identities(home) });
    const legacyInstance = legacyCheck.doc.result?.instanceId;
    const legacyIdentity = identities(home).length ? readFileSync(join(home, "daemon", identities(home)[0]!), "utf8") : "";
    const legacySession = readFileSync(join(home, "idp-sessions.json"), "utf8");
    // Managed sign-in state lives in D only, written by the stock session writer.
    saveIdpSession(managed, IDP, { token: "managed-session-handle-not-a-secret", expiresAt: Math.floor(Date.now() / 1000) + 3600, sub: "managed-sub" });
    hits.length = 0;
    const m = await cli(["connect-check", "--daemon-home", managed, "--space", "ready", "--json"]);
    check("H2 managed connect-check finds the shared mesh and answers ready-to-register", m.status === 0 && m.doc.result?.outcome === "ready-to-register", { status: m.status, doc: m.doc, err: m.err.slice(0, 300) });
    check("H2 the managed identity is a NEW instance, not the legacy one", typeof m.doc.result?.instanceId === "string" && m.doc.result.instanceId !== legacyInstance, { managed: m.doc.result?.instanceId, legacyInstance });
    check("H2 exactly one identity under D/daemon and still exactly one under $COTAL_HOME/daemon", identities(managed).length === 1 && identities(home).length === 1, { managed: identities(managed), home: identities(home) });
    check("H2 the legacy identity and session are byte-identical (no migration, no rewrite)", identities(home).length === 1 && readFileSync(join(home, "daemon", identities(home)[0]!), "utf8") === legacyIdentity && readFileSync(join(home, "idp-sessions.json"), "utf8") === legacySession);
    check("H2 D/meshes is never created and $COTAL_HOME/meshes is unchanged", !existsSync(join(managed, "meshes")) && JSON.stringify(readdirSync(join(home, "meshes"), { recursive: true }).map(String).sort()) === JSON.stringify(meshesBefore));
    check("H2 the authority saw GETs only (0 POST)", hits.length >= 1 && hits.every((h) => h.method === "GET"), hits);
  });

  await cell("H3 home validation refuses before any bind or lock", async () => {
    const before = runtimeEntries();
    const loose = join(root, "loose"); mkdirSync(loose, { mode: 0o700 }); chmodSync(loose, 0o755);
    const r1 = await cli(["serve", "--daemon-home", loose, "--json"]);
    check("H3 a 0755 home refuses PERMISSION_DENIED / DIR_WRONG_MODE, exit 2", r1.status === 2 && r1.doc.outcome === "refused" && r1.doc.error?.code === "PERMISSION_DENIED" && r1.doc.error?.cause?.code === "DIR_WRONG_MODE", { status: r1.status, doc: r1.doc });
    check("H3 its mode is unchanged and no lock was created", (lstatSync(loose).mode & 0o777) === 0o755 && !existsSync(lockFile(loose)));
    const link = join(root, "linked"); symlinkSync(managed, link);
    const r2 = await cli(["serve", "--daemon-home", link, "--json"]);
    check("H3 a symlinked home refuses PERMISSION_DENIED / DIR_SYMLINK, exit 2", r2.status === 2 && r2.doc.error?.code === "PERMISSION_DENIED" && r2.doc.error?.cause?.code === "DIR_SYMLINK", { status: r2.status, doc: r2.doc });
    const r3 = await cli(["serve", "--daemon-home", "relative/home", "--json"]);
    check("H3 a relative home refuses USAGE_INVALID naming an absolute path", r3.status === 1 && r3.doc.error?.code === "USAGE_INVALID" && /absolute/i.test(r3.doc.error?.message ?? ""), { status: r3.status, doc: r3.doc });
    const r4 = await cli(["serve", "--daemon-home", home, "--json"]);
    check("H3 the Cotal home itself refuses USAGE_INVALID naming the Cotal home", r4.status === 1 && r4.doc.error?.code === "USAGE_INVALID" && /Cotal home/.test(r4.doc.error?.message ?? ""), { status: r4.status, doc: r4.doc });
    check("H3 and no lock was created in the Cotal home", !existsSync(lockFile(home)));
    check("H3 the four refusals created 0 runtime entries", JSON.stringify(runtimeEntries()) === JSON.stringify(before), { before, after: runtimeEntries() });
  });

  await cell("H4 the lifetime lock is singleton, and a killed daemon's successor recovers its socket", async () => {
    check("H4 instrument: the H1 managed serve is live with a derived socket", live(managedServe) && typeof derived === "string");
    if (!live(managedServe) || typeof derived !== "string") return;
    const ino = lstatSync(derived).ino;
    const killedPid = managedServe!.child.pid;
    const second = await cli(["serve", "--daemon-home", managed, "--json"]);
    check("H4 a second managed serve refuses CONFLICT / LOCK_HELD, exit 2, naming the live holder's pid", second.status === 2 && second.doc.error?.code === "CONFLICT" && second.doc.error?.cause?.code === "LOCK_HELD" && new RegExp(`held by a live process \\(pid ${killedPid},`).test(second.doc.error?.message ?? ""), { status: second.status, doc: second.doc, err: second.err.slice(0, 300) });
    check("H4 the first serve's socket keeps its inode and still answers", lstatSync(derived).ino === ino && (await cli(["status", "--daemon-home", managed, "--json"])).doc.result?.pid === killedPid);
    await stop(managedServe, "SIGKILL");
    check("H4 instrument: after SIGKILL the socket is left behind, and the kernel has released the lock while its record still names the dead pid", existsSync(derived) && lstatSync(derived).ino === ino && lockFree(managed) && lockRecordPid(managed) === killedPid, { free: lockFree(managed), recorded: lockRecordPid(managed), killedPid });
    // No operator step: the successor removes exactly the socket the record names and binds its own.
    managedServe = await serve(["--daemon-home", managed]);
    check("H4 the successor serves with no manual removal, on the SAME derived path", live(managedServe) && managedServe.socket === derived, { socket: managedServe?.socket, derived });
    check("H4 it bound a different inode, so it did not adopt the dead socket", existsSync(derived) && lstatSync(derived).ino !== ino, { now: existsSync(derived) ? lstatSync(derived).ino : null, stale: ino });
    check("H4 status answers the successor's pid", (await cli(["status", "--daemon-home", managed, "--json"])).doc.result?.pid === managedServe!.child.pid);
  });

  await cell("H5 a client refuses a peer that is not the lock's live owner", async () => {
    check("H5 instrument: a derived socket path is known", typeof derived === "string");
    if (typeof derived !== "string") return;
    await stop(managedServe);
    check("H5 instrument: the clean stop removed its socket and released the lock", !existsSync(derived) && lockFree(managed));
    const held = takeLock(managed);
    const listener = track(spawn(process.execPath, ["-e", `const s=require("net").createServer(c=>c.on("data",()=>process.stdout.write("GOT-BYTES\\n")));s.listen(${JSON.stringify(derived)},()=>{require("fs").chmodSync(${JSON.stringify(derived)},0o600);process.stdout.write("LISTENING\\n")});`], { stdio: ["ignore", "pipe", "ignore"] }));
    let out = "";
    listener.stdout!.on("data", (b) => { out += String(b); });
    try {
      for (let i = 0; i < 100 && !out.includes("LISTENING"); i++) await sleep(50);
      check("H5 instrument: a different same-uid process listens at the derived path while this process holds the lock", out.includes("LISTENING") && held.held && listener.pid !== process.pid);
      const r = await cli(["status", "--daemon-home", managed, "--json"]);
      await sleep(200);
      check("H5 status refuses PERMISSION_DENIED / PEER_NOT_LOCK_OWNER, exit 2", r.status === 2 && r.doc.error?.code === "PERMISSION_DENIED" && r.doc.error?.cause?.code === "PEER_NOT_LOCK_OWNER", { status: r.status, doc: r.doc });
      check("H5 the impostor listener received 0 bytes", !out.includes("GOT-BYTES"), out);
    } finally {
      await kill(listener);
      closeSync(held.fd);
    }
  });
} catch (e) {
  fail++;
  console.error("  ✗ smoke crashed:", e instanceof Error ? (e.stack ?? e.message) : e);
} finally {
  await stop(managedServe);
  await stop(legacyServe);
  // No child may outlive the fixture root it uses.
  for (const child of [...children]) await kill(child);
  await new Promise<void>((r) => authority.close(() => r()));
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nDAEMON HOME SMOKE ${fail === 0 ? "OK" : "FAILED"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
