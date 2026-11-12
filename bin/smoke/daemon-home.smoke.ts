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
 *  H0b a different COTAL_HOME refuses the same default listener with advice for both daemon forms,
 *     identical in plain and JSON. The matching home still reaches the same ready daemon;
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
 *     - a new serve needs no operator step: with the dead inode pinned under a second name, it
 *       leaves the pin as that inode's only link, binds another inode at the SAME derived path,
 *       and answers its own pid;
 *  H5 peer must be the lock owner:
 *     - the smoke process holds `D/daemon.lock` through the same kernel `flock` the daemon takes;
 *     - a different same-uid process listens at the derived path;
 *     - `status --daemon-home D` refuses PERMISSION_DENIED / PEER_NOT_LOCK_OWNER, exit 2, and the
 *       listener receives 0 bytes. Plain and JSON give the same conditional explicit-home advice.
 *  H6 managed catalog refresh keeps shared registrations, sentinel files and selection unchanged,
 *     including on provider failure; default refresh still applies additions and removals. An
 *     account switch drops the old catalog cache in either home, but only the default daemon
 *     removes the old account's shared registrations, their credential files and selection. A
 *     manual registration and its credential file stay.
 *     An unrelated damaged registration stays untouched while healthy entries refresh.
 *
 * Not covered here, and still to add: register approval carry-over (needs the stock auth service
 * sandbox of daemon-register.smoke.ts), a foreign-owned home (needs a user namespace) and the
 * `cotal service install` unit path.
 *
 * Run: tsx bin/smoke/daemon-home.smoke.ts   (Linux only)
 */
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { chmodSync, closeSync, constants, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { skipSuite } from "@cotal-ai/smoke-kit";
import { flockExclusiveNb } from "@cotal-ai/seat";
import { saveIdpSession } from "@cotal-ai/auth";
import { getCurrent, loadMeshes, meshFile, readMeshRegistry, recordMesh, setCurrent, userAuthStateDir, type MeshEntry } from "@cotal-ai/workspace";
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
const home = join(root, "home"), rt = join(root, "rt"), meshRoot = join(root, "mesh"), managed = join(root, "managed\u2014unicode '$home"), user = join(root, "user");
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

type Doc = { command?: string; target?: { space?: string; idp?: string } | null; outcome?: string; result?: Record<string, any>; error?: { code?: string; message?: string; remedy?: string; cause?: { code?: string } } };
/** One CLI invocation to completion. A command string exercises copied guidance through the built CLI. */
async function cli(args: string[] | string, timeoutMs = 30_000): Promise<{ status: number | null; doc: Doc; out: string; err: string }> {
  const child = track(typeof args === "string"
    ? spawn("/bin/sh", ["-c", `cotal() { exec "$DAEMON_COPY_NODE" "$DAEMON_COPY_ENTRY" "$@"; }\n${args} --json`], { cwd: root, env: { ...childEnv, DAEMON_COPY_NODE: process.execPath, DAEMON_COPY_ENTRY: join(repo, "bin", "dist", "cotal.js") }, stdio: ["ignore", "pipe", "pipe"] })
    : spawn(process.execPath, daemonArgv(args), { cwd: root, env: childEnv, stdio: ["ignore", "pipe", "pipe"] }));
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
  if (req.url === "/api/auth/token") {
    res.writeHead(200, { "content-type": "application/json" });
    const token = [JSON.stringify({ alg: "EdDSA" }), JSON.stringify({ sub: "fixture", exp: Date.now() / 1000 + 30 })].map((s) => Buffer.from(s).toString("base64url")).join(".") + ".fixture";
    res.end(JSON.stringify({ token }));
    return;
  }
  hits.push({ method: req.method ?? "" });
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ v: 1, kind: "service-endpoint-authority-info", space: "ready", accountPublicKey: ACCOUNT }));
});
await new Promise<void>((r) => authority.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(authority.address() as AddressInfo).port}`;
const IDP = `${base}/api/auth`;
const userMesh = (space: string): MeshEntry => ({
  space, server: "nats://127.0.0.1:4222", root: meshRoot, mode: "user", origin: "manual",
  userAuth: { provider: "cotal", idp: { url: IDP, issuer: base, audience: base }, endpoints: { url: base }, remote: true, sentinelCredsPath: join(userAuthStateDir(meshRoot, space, { readOnly: true }), "sentinel.creds") },
  ts: new Date().toISOString(),
});
const identities = (dir: string): string[] => existsSync(join(dir, "daemon")) ? readdirSync(join(dir, "daemon"), { recursive: true }).map(String).filter((p) => p.endsWith("service-identity.json")).sort() : [];

let legacyServe: Serve | undefined, managedServe: Serve | undefined;
let derived: string | undefined;
try {
  await cell("G0 mode discovery needs no running daemon", async () => {
    const missing = await cli([]);
    check("G0 the missing-mode error itself includes desktop", missing.status === 1 && missing.err.split("\n")[0]!.includes("desktop"), missing.err.slice(0, 400));
    check("G0 the remedy names help, not a live status read", missing.err.includes("cotal help daemon") && !missing.err.split("\n")[1]!.includes("cotal daemon status"), missing.err.slice(0, 400));
    const help = await cli(["--help"]);
    check("G0 scoped help succeeds before any daemon starts", help.status === 0 && help.out.includes("desktop"), { status: help.status });
    for (const mode of ["setup", "connect-check", "register", "service-connect", "service-disconnect", "service-status"]) {
      const scoped = await cli([mode, "--help"]);
      check(`G0 ${mode} help requires an explicit space without promising a resolved default`, scoped.status === 0 && scoped.out.includes(`cotal daemon ${mode} --space <s>`) && scoped.out.includes("target space (required") && !scoped.out.includes("the resolved mesh"), scoped.out);
      const missingSpace = await cli([mode, "--json"]);
      check(`G0 ${mode} still refuses an omitted space`, missingSpace.status === 1 && missingSpace.doc.error?.code === "USAGE_INVALID" && missingSpace.doc.error.message?.includes("needs --space <s>") === true, missingSpace.doc);
    }
    const setupHelp = await cli(["setup", "--help"]);
    check("G0 setup provider options do not claim to be login-only", !setupHelp.out.includes("login:") && setupHelp.out.includes("--idp <auth base URL>") && setupHelp.out.includes("--client-id <id>"), setupHelp.out);
    const loginHelp = await cli(["login", "--help"]);
    check("G0 login usage requires a provider", loginHelp.status === 0 && loginHelp.out.includes("cotal daemon login --idp <auth base URL>"), loginHelp.out);
    const statusHelp = await cli(["status", "--help"]);
    check("G0 local status keeps its optional space selector", statusHelp.status === 0 && statusHelp.out.includes("cotal daemon status [--space <s>]"), statusHelp.out);
    for (const mode of ["spaces", "start", "desktop"]) {
      const scoped = await cli([mode, "--help"]);
      check(`G0 ${mode} has scoped usage and examples`, scoped.status === 0 && scoped.out.includes(`cotal daemon ${mode} [`) && scoped.out.includes("Examples"), scoped.out);
    }
    check("G0 discovery creates no runtime entries or lifetime lock", runtimeEntries().length === 0 && !existsSync(lockFile(home)) && !existsSync(lockFile(managed)));
  });

  await cell("G2 failure documents retain their selected operation", async () => {
    const absent = await cli(["status", "--daemon-home", managed, "--json"]);
    check("G2 absent status retains its mode and null local target", absent.status === 2 && absent.doc.command === "daemon status" && absent.doc.target === null, absent.doc);
    for (const mode of ["connect-check", "register", "service-connect", "service-disconnect", "service-status", "setup"]) {
      const result = await cli([mode, "--daemon-home", managed, "--space", "missing", "--json", ...(mode === "setup" ? ["--wait", "bad"] : [])]);
      check(`G2 ${mode} refuses with its selected space and command`, result.status === (mode === "setup" ? 1 : 2) && result.doc.command === `daemon ${mode}` && result.doc.target?.space === "missing", result.doc);
    }
    const invalid = await cli(["login", "--daemon-home", managed, "--idp", "http://user:PRIVATE_MARKER@127.0.0.1/api/auth", "--json"]);
    check("G2 a rejected provider URL is not recorded as a target or echoed", invalid.status === 1 && invalid.doc.command === "daemon login" && invalid.doc.target === null && !(invalid.out + invalid.err).includes("PRIVATE_MARKER"), { status: invalid.status, command: invalid.doc.command, target: invalid.doc.target });
    check("G2 failure-context reads create no runtime entries or daemon lock", runtimeEntries().length === 0 && !existsSync(lockFile(managed)));
  });

  await cell("H0 control: no flag keeps the fixed legacy socket", async () => {
    legacyServe = await serve([]);
    check("H0 legacy serve reports ready at $XDG_RUNTIME_DIR/cotal/daemon.sock", live(legacyServe) && legacyServe.socket === legacy.socket, { socket: legacyServe.socket, status: legacyServe.status, err: legacyServe.err.slice(0, 300) });
    const st = await cli(["status", "--json"]);
    check("H0 no-flag status answers ready with the legacy serve's pid, exit 0", st.status === 0 && st.doc.result?.state === "ready" && st.doc.result?.pid === legacyServe.child.pid, { status: st.status, doc: st.doc });
    check("H0 the runtime dir holds exactly the legacy socket", JSON.stringify(runtimeEntries()) === JSON.stringify(["daemon.sock"]), runtimeEntries());
  });

  await cell("H0b a default daemon's COTAL_HOME mismatch has actionable recovery advice", async () => {
    const otherHome = join(root, "other-home");
    mkdirSync(otherHome, { mode: 0o700 });
    const before = fileState(legacy.socket);
    childEnv.COTAL_HOME = otherHome;
    try {
      const json = await cli(["status", "--json"]);
      const plain = await cli(["status", "--plain"]);
      const remedy = json.doc.error?.remedy ?? "";
      check("H0b mismatched COTAL_HOME refuses PERMISSION_DENIED / PEER_NOT_LOCK_OWNER in both formats", json.status === 2 && json.doc.error?.code === "PERMISSION_DENIED" && json.doc.error?.cause?.code === "PEER_NOT_LOCK_OWNER" && plain.status === 2 && plain.err.includes("PEER_NOT_LOCK_OWNER"), { json, plain });
      check("H0b Next distinguishes default COTAL_HOME from explicit --daemon-home and matches plain output", remedy.includes("For the default daemon use its COTAL_HOME") && remedy.includes("For an explicit --daemon-home use the same directory as the intended daemon") && remedy.includes("inspect the conflicting listener with your operating system") && remedy.endsWith("No process was stopped") && plain.err.includes(remedy), { remedy, plain: plain.err });
    } finally {
      childEnv.COTAL_HOME = home;
    }
    const json = await cli(["status", "--json"]);
    const plain = await cli(["status", "--plain"]);
    check("H0b matching COTAL_HOME still reports the original daemon ready in both formats", json.status === 0 && json.doc.result?.state === "ready" && json.doc.result?.pid === legacyServe?.child.pid && plain.status === 0 && plain.out.includes("ready") && plain.out.includes(String(legacyServe?.child.pid)), { json, plain });
    check("H0b refusal leaves the default socket unchanged", JSON.stringify(fileState(legacy.socket)) === JSON.stringify(before));
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

  await cell("H1b remedies retain the selected daemon and known provider or space", async () => {
    recordMesh(userMesh("needs-login"));
    const quotedHome = `'${managed.replace(/'/g, `'\\''`)}'`;
    for (const extra of [[], ["--daemon-home", managed]]) {
      const homeFlag = extra.length ? ` --daemon-home ${quotedHome}` : "";
      for (const mode of ["connect-check", "register"]) {
        const expected = `run \`cotal daemon login --idp '${IDP}'${homeFlag}\``;
        const result = await cli([mode, "--space", "needs-login", ...extra, "--json"]);
        check(`H1b ${mode} JSON has a concrete sign-in remedy (${extra.length ? "managed" : "default"})`, result.status === 2 && result.doc.error?.cause?.code === "NOT_SIGNED_IN" && result.doc.error.remedy === expected && !result.out.includes("<url>"), result);
        const plain = await cli([mode, "--space", "needs-login", ...extra, "--plain"]);
        check(`H1b ${mode} plain prints the same Next`, plain.status === 2 && plain.err.includes("Next") && plain.err.includes(expected), plain.err);
      }
    }
    for (const mode of ["service-connect", "service-status"]) {
      const result = await cli([mode, "--space", "needs-login", "--daemon-home", managed, "--json"]);
      const expected = `run \`cotal daemon register --space needs-login --daemon-home ${quotedHome}\` first`;
      check(`H1b ${mode} JSON names the selected space and daemon`, result.status === 2 && result.doc.error?.cause?.code === "NOT_REQUESTED" && result.doc.error.remedy === expected && !result.out.includes("<s>"), result);
      const plain = await cli([mode, "--space", "needs-login", "--daemon-home", managed, "--plain"]);
      check(`H1b ${mode} plain prints the same Next`, plain.status === 2 && plain.err.includes("Next") && plain.err.includes(expected), plain.err);
    }
    const st = await cli(["status", "--daemon-home", managed, "--json"]);
    check("H1b refusal reads leave the selected daemon serving", st.status === 0 && st.doc.result?.pid === managedServe?.child.pid, st.doc);
    rmSync(meshFile("needs-login"));
  });

  await cell("H1c copied recovery commands preserve leading-hyphen spaces", async () => {
    const quotedHome = `'${managed.replace(/'/g, `'\\''`)}'`;
    for (const space of ["copy-control", "-leading-dash", "--json", "-1"]) {
      recordMesh(userMesh(space));
      const option = space.startsWith("-") ? `--space=${space}` : `--space ${space}`;
      for (const mode of ["service-connect", "service-status"]) {
        await cli(["service-disconnect", `--space=${space}`, "--daemon-home", managed, "--json"]);
        const result = await cli([mode, `--space=${space}`, "--daemon-home", managed, "--json"]);
        const command = `cotal daemon register ${option} --daemon-home ${quotedHome}`;
        const remedy = `run \`${command}\` first`;
        check(`H1c ${mode} emits a parseable register command for ${space}`, result.status === 2 && result.doc.error?.cause?.code === "NOT_REQUESTED" && result.doc.error.remedy === remedy, result);
        if (result.doc.error?.remedy !== remedy) throw new Error("unexpected copied registration command");
        const copied = await cli(result.doc.error.remedy.slice(5, -7));
        check(`H1c copied ${mode} remedy reaches ${space} on the selected daemon`, copied.status === 2 && copied.doc.command === "daemon register" && copied.doc.target?.space === space && copied.doc.error?.cause?.code === "NOT_SIGNED_IN" && copied.doc.error.remedy?.includes(IDP) === true && copied.doc.error.remedy.includes(quotedHome), copied);
        await cli(["service-disconnect", `--space=${space}`, "--daemon-home", managed, "--json"]);
        const plain = await cli([mode, `--space=${space}`, "--daemon-home", managed, "--plain"]);
        const printed = /`([^`]+)`/.exec(plain.err)?.[1];
        check(`H1c ${mode} plain command preserves Unicode punctuation for ${space}`, plain.status === 2 && printed === command, plain);
        if (printed !== command) throw new Error("plain command changed the selected daemon home");
        const copiedPlain = await cli(printed);
        check(`H1c copied plain ${mode} remedy reaches ${space}`, copiedPlain.status === 2 && copiedPlain.doc.target?.space === space && copiedPlain.doc.error?.cause?.code === "NOT_SIGNED_IN", copiedPlain);
      }
      const setup = await cli(["setup", "--no-manager", `--space=${space}`, "--daemon-home", managed, "--wait", "0", "--json"]);
      check(`H1c setup manual recovery retains ${space}`, setup.status === 2 && setup.doc.error?.cause?.code === "RUNNING_WITHOUT_UNIT", setup);
      const commands = [...(setup.doc.error?.remedy ?? "").matchAll(/`([^`]+)`/g)].map(match => match[1]!);
      const expected = ["register", "service-connect"].map(op => `cotal daemon ${op} ${option} --daemon-home ${quotedHome}`);
      if (JSON.stringify(commands) !== JSON.stringify(expected)) throw new Error("unexpected copied setup commands");
      for (const command of commands) {
        const copied = await cli(command);
        check(`H1c copied setup ${command.includes(" register ") ? "register" : "service-connect"} reaches ${space}`, copied.status === 2 && copied.doc.target?.space === space && ["NOT_SIGNED_IN", "NOT_REQUESTED"].includes(copied.doc.error?.cause?.code ?? ""), copied);
      }
      rmSync(meshFile(space));
    }
    const status = await cli(["status", "--daemon-home", managed, "--json"]);
    check("H1c copied commands leave the selected daemon serving", status.status === 0 && status.doc.result?.pid === managedServe?.child.pid, status.doc);
  });

  await cell("G1 flags are scoped before daemon actions", async () => {
    for (const flags of [["--idp", "not-a-url"], ["--wait", "not-a-number"], ["--refresh"], ["--dry-run"], ["--yes"], ["--client-id", ""]]) {
      const result = await cli(["status", "--daemon-home", managed, "--json", ...flags]);
      check(`G1 status refuses ${flags[0]} from another mode`, result.status === 1 && result.doc.error?.code === "USAGE_INVALID" && result.doc.error.message?.includes(flags[0]!) === true, { status: result.status, doc: result.doc });
    }
    const filtered = await cli(["status", "--daemon-home", managed, "--space", "nonexistent", "--json"]);
    check("G1 status accepts the hosted Manager space filter", filtered.status === 0 && filtered.doc.result?.pid === managedServe?.child.pid && filtered.doc.result?.managers?.[0]?.space === "nonexistent" && filtered.doc.result?.managers?.[0]?.state === "stopped", filtered);
    const unused = join(root, "unused"); mkdirSync(unused, { mode: 0o700 });
    const before = runtimeEntries();
    const dry = await cli(["serve", "--daemon-home", unused, "--dry-run", "--json"]);
    check("G1 serve --dry-run refuses rather than starting a daemon", dry.status === 1 && dry.doc.error?.code === "USAGE_INVALID" && dry.doc.error.message?.includes("--dry-run") === true, { status: dry.status, doc: dry.doc });
    check("G1 refused serve creates no socket or lifetime lock", JSON.stringify(runtimeEntries()) === JSON.stringify(before) && !existsSync(lockFile(unused)));
    const st = await cli(["status", "--daemon-home", managed, "--json"]);
    check("G1 valid status still reaches the same daemon", st.status === 0 && st.doc.result?.pid === managedServe?.child.pid, { status: st.status, doc: st.doc });
  });

  await cell("H6 managed catalog refresh never applies to the shared registry", async () => {
    let origin = "", idp = "", catalogHits = 0, unavailable = false;
    let slugs = ["catalog-new"], sub = "catalog-account", denied = false;
    const session = "owned-catalog-session";
    const catalog = createHttpServer(async (req, res) => {
      for await (const _ of req) { /* drain */ }
      const send = (status: number, value: unknown, headers = {}) => res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(value));
      if (req.url === "/api/auth/device/code") return void send(200, { device_code: "owned-device", user_code: "OWNED", verification_uri: `${origin}/verify`, verification_uri_complete: `${origin}/verify?code=OWNED`, expires_in: 60, interval: 1 });
      if (req.url === "/api/auth/device/token") return void (denied ? send(400, { error: "access_denied" }) : send(200, { access_token: session, expires_in: 3600 }));
      if (req.headers.authorization !== `Bearer ${session}`) return void send(401, {});
      if (req.url === "/api/auth/token") {
        // Catalog discovery decodes the provider's account claims; no broker authenticates here.
        const token = [JSON.stringify({ alg: "none" }), JSON.stringify({ sub, iss: origin, exp: Math.floor(Date.now() / 1000) + 30 })].map((s) => Buffer.from(s).toString("base64url")).join(".") + ".fixture";
        return void send(200, { token }, { link: `<${origin}/catalog>; rel="https://cotal.ai/relations/space-catalog"` });
      }
      if (req.url !== "/catalog") return void send(404, {});
      catalogHits++;
      if (unavailable) return void send(503, {});
      send(200, {
        v: 1, account: { idpUrl: idp, issuer: origin, sub },
        spaces: slugs.map((slug) => ({
          id: slug, slug, name: slug, kind: "team", role: "member",
          registration: {
            space: slug, server: "nats://127.0.0.1:4222", tlsRequired: false, sentinelCreds: `fixture-sentinel-${slug}`,
            userAuth: { provider: "cotal", idp: { url: idp, issuer: origin, audience: origin }, endpoints: { url: `${origin}/exchange` } },
          },
        })),
      });
    });
    await new Promise<void>((r) => catalog.listen(0, "127.0.0.1", r));
    origin = `http://127.0.0.1:${(catalog.address() as AddressInfo).port}`;
    idp = `${origin}/api/auth`;
    const sharedState = (): string => {
      const files: { path: string; mode: number; hash: string }[] = [];
      const visit = (path: string, relative: string): void => {
        if (!existsSync(path)) return;
        const stat = lstatSync(path);
        if (stat.isDirectory()) for (const name of readdirSync(path).sort()) visit(join(path, name), `${relative}/${name}`);
        else files.push({ path: relative, mode: stat.mode & 0o777, hash: createHash("sha256").update(readFileSync(path)).digest("hex") });
      };
      for (const name of ["meshes", "catalog", "current-mesh"]) visit(join(home, name), name);
      return JSON.stringify(files);
    };
    try {
      saveIdpSession(managed, idp, { token: session, sub: "catalog-account", expiresAt: Math.floor(Date.now() / 1000) + 3600 });
      const empty = sharedState();
      const first = await cli(["spaces", "--refresh", "--daemon-home", managed, "--json"]);
      check("H6 managed refresh reaches the catalog and keeps its own cache", first.status === 0 && first.doc.result?.refresh === "complete" && catalogHits > 0 && existsSync(join(managed, "space-catalogs.json")), first.doc);
      check("H6 managed-only refresh creates no shared registration or credential", sharedState() === empty && !existsSync(join(home, "idp-sessions.json")));
      slugs = ["catalog-kept", "catalog-removed"];
      saveIdpSession(home, idp, { token: session, sub: "catalog-account", expiresAt: Math.floor(Date.now() / 1000) + 3600 });
      const initial = await cli(["spaces", "--refresh", "--json"]);
      check("H6 default refresh registers its own catalog", initial.status === 0 && loadMeshes().some((m) => m.space === "catalog-removed"), initial.doc);
      const corrupt = join(home, "meshes", "corrupt.json");
      const damaged = "{broken json";
      writeFileSync(corrupt, damaged, { mode: 0o600 });
      const listed = await cli(["spaces", "--json"]);
      check("H6 damaged registration leaves healthy spaces visible without refresh", listed.status === 4 && listed.doc.outcome === "partial" && listed.doc.result?.refresh === "not-requested" && listed.doc.result?.unreadable === 1 && listed.doc.result?.spaces.length === 2, listed.doc);
      setCurrent("catalog-removed");
      const before = sharedState();
      slugs = ["catalog-kept", "catalog-added"];
      const changed = await cli(["spaces", "--refresh", "--daemon-home", managed, "--json"]);
      check("H6 managed refresh preserves shared registrations, credentials and selection", changed.status === 4 && changed.doc.result?.refresh === "complete" && changed.doc.result?.unreadable === 1 && sharedState() === before && getCurrent() === "catalog-removed", changed.doc);
      check("H6 managed space list still reflects the shared registry", changed.doc.result?.spaces.some((s: { space: string }) => s.space === "catalog-removed") === true && changed.doc.result?.spaces.every((s: { space: string }) => s.space !== "catalog-added") === true);
      unavailable = true;
      const failed = await cli(["spaces", "--refresh", "--daemon-home", managed, "--json"]);
      check("H6 a failed managed refresh does not write shared failure metadata", failed.status === 4 && failed.doc.result?.refresh === "failed" && sharedState() === before, failed.doc);
      unavailable = false;
      const applied = await cli(["spaces", "--refresh", "--json"]);
      const refreshed = readMeshRegistry().entries;
      check("H6 default refresh adds and removes healthy registrations beside damage", applied.status === 4 && applied.doc.outcome === "partial" && applied.doc.result?.refresh === "complete" && applied.doc.result?.unreadable === 1 && applied.doc.result?.spaces.map((s: { space: string }) => s.space).sort().join() === "catalog-added,catalog-kept" && refreshed.some((m) => m.space === "catalog-added") && !refreshed.some((m) => m.space === "catalog-removed"), applied.doc);
      check("H6 default refresh clears its removed selection", getCurrent() === undefined);
      const plain = await cli(["spaces", "--refresh", "--plain"]);
      check("H6 plain refresh reports partial success and the unreadable count", plain.status === 4 && /Catalog refresh:\s+complete/.test(plain.out) && /Unreadable:\s+1/.test(plain.out) && plain.out.includes("catalog-added"), plain);
      const cached = Object.values(JSON.parse(readFileSync(join(home, "space-catalogs.json"), "utf8")).accounts) as { applied: boolean }[];
      check("H6 healthy catalog application completes despite an unrelated damaged file", cached.length === 1 && cached[0]?.applied === true && readFileSync(corrupt, "utf8") === damaged);
      unavailable = true;
      const failedDefault = await cli(["spaces", "--refresh", "--json"]);
      check("H6 provider failure with damage remains a partial listing, not an endpoint failure", failedDefault.status === 4 && failedDefault.doc.result?.refresh === "failed" && failedDefault.doc.result?.unreadable === 1 && failedDefault.doc.result?.spaces.length === 2 && readMeshRegistry().entries.every((m) => Boolean(m.catalogError)) && readFileSync(corrupt, "utf8") === damaged, failedDefault.doc);
      unavailable = false;
      const blocked = meshFile("catalog-blocked");
      writeFileSync(blocked, damaged, { mode: 0o600 });
      slugs = ["catalog-kept", "catalog-added", "catalog-blocked"];
      const targeted = await cli(["spaces", "--refresh", "--json"]);
      check("H6 a catalog cannot overwrite its own damaged canonical target", targeted.status === 4 && targeted.doc.result?.refresh === "failed" && targeted.doc.result?.unreadable === 2 && readFileSync(blocked, "utf8") === damaged && readFileSync(corrupt, "utf8") === damaged, targeted.doc);
      rmSync(blocked);
      rmSync(corrupt);
      slugs = ["catalog-kept", "catalog-added"];
      const recovered = await cli(["spaces", "--refresh", "--json"]);
      check("H6 duplicate fixture starts from a fully applied healthy catalog", recovered.status === 0 && recovered.doc.result?.refresh === "complete" && recovered.doc.result?.unreadable === 0, recovered.doc);
      const canonical = meshFile("catalog-kept");
      const legacy = join(home, "meshes", "catalog-kept.json");
      const keptBytes = readFileSync(canonical, "utf8");
      writeFileSync(legacy, keptBytes, { mode: 0o600 });
      writeFileSync(canonical, damaged, { mode: 0o600 });
      setCurrent("catalog-kept");
      unavailable = true;
      const failedDuplicate = await cli(["spaces", "--refresh", "--json"]);
      check("H6 provider failure preserves damaged canonical and usable legacy bytes", failedDuplicate.status === 4 && failedDuplicate.doc.result?.refresh === "failed" && failedDuplicate.doc.result?.unreadable === 1 && readFileSync(canonical, "utf8") === damaged && existsSync(legacy) && readFileSync(legacy, "utf8") === keptBytes, failedDuplicate.doc);
      check("H6 failure metadata still reaches unrelated healthy registrations", Boolean(readMeshRegistry().entries.find((m) => m.space === "catalog-added")?.catalogError));
      unavailable = false;
      slugs = ["catalog-added"];
      const removedDuplicate = await cli(["spaces", "--refresh", "--json"]);
      check("H6 catalog removal preserves damaged canonical, legacy and selection", removedDuplicate.status === 4 && removedDuplicate.doc.result?.refresh === "complete" && removedDuplicate.doc.result?.unreadable === 1 && readFileSync(canonical, "utf8") === damaged && existsSync(legacy) && readFileSync(legacy, "utf8") === keptBytes && getCurrent() === "catalog-kept", removedDuplicate.doc);
      slugs = ["catalog-kept", "catalog-added"];
      const appliedDuplicate = await cli(["spaces", "--refresh", "--json"]);
      check("H6 application failure cannot rewrite damage from a usable legacy duplicate", appliedDuplicate.status === 4 && appliedDuplicate.doc.result?.refresh === "failed" && appliedDuplicate.doc.result?.unreadable === 1 && readFileSync(canonical, "utf8") === damaged && existsSync(legacy) && readFileSync(legacy, "utf8") === keptBytes, appliedDuplicate.doc);
      writeFileSync(canonical, keptBytes, { mode: 0o600 });
      rmSync(legacy);
      check("H6 no private registry or sentinel tree was created", !existsSync(join(managed, "meshes")) && !existsSync(join(managed, "catalog")));

      const subjects = (dir: string): string[] => Object.values(JSON.parse(readFileSync(join(dir, "space-catalogs.json"), "utf8")).accounts as Record<string, { sub: string }>).map((a) => a.sub).sort();
      const oldSpaces = loadMeshes().filter((m) => m.origin === "catalog");
      const sentinels = oldSpaces.map((m) => m.userAuth?.sentinelCredsPath).filter((p): p is string => typeof p === "string");
      check("H6 switch fixture has two discovered spaces and their sentinel files", oldSpaces.length === 2 && sentinels.length === 2 && sentinels.every((p) => existsSync(p)));
      const manual = userMesh("catalog-manual"); recordMesh(manual);
      const manualSentinel = manual.userAuth!.sentinelCredsPath!;
      mkdirSync(dirname(manualSentinel), { recursive: true, mode: 0o700 });
      writeFileSync(manualSentinel, "manual-sentinel", { mode: 0o600 });
      setCurrent("catalog-kept");
      const beforeSwitch = sharedState();
      sub = "catalog-next";
      const managedLogin = await cli(["login", "--idp", idp, "--daemon-home", managed, "--json"]);
      check("H6 managed account switch removes its old catalog entry", managedLogin.status === 0 && subjects(managed).join() === "catalog-next", managedLogin.doc);
      check("H6 managed account switch preserves shared credentials, records and selection", sharedState() === beforeSwitch && getCurrent() === "catalog-kept");
      sub = "catalog-account";
      const same = await cli(["login", "--idp", idp, "--json"]);
      check("H6 signing in as the same account preserves discovered spaces", same.status === 0 && sharedState() === beforeSwitch, same.doc);
      denied = true;
      const rejected = await cli(["login", "--idp", idp, "--json"]);
      check("H6 a denied sign-in preserves the prior account and its spaces", rejected.status !== 0 && subjects(home).join() === "catalog-account" && sharedState() === beforeSwitch, rejected.doc);
      denied = false; sub = "catalog-next";
      const switched = await cli(["login", "--idp", idp, "--json"]);
      check("H6 default account switch removes its old catalog entry", switched.status === 0 && switched.doc.result?.previousSub === "catalog-account" && subjects(home).join() === "catalog-next", switched.doc);
      check("H6 default account switch removes its old registrations", oldSpaces.every((old) => !loadMeshes().some((m) => m.space === old.space)));
      check("H6 default account switch deletes its old credential files and reports none kept", sentinels.every((p) => !existsSync(p)) && switched.doc.result?.credentialsKept === undefined, switched.doc);
      check("H6 default account switch clears the removed selection", getCurrent() === undefined);
      check("H6 default account switch preserves manual registration", JSON.stringify(loadMeshes().find((m) => m.space === manual.space)) === JSON.stringify(manual));
      check("H6 default account switch preserves the manual registration's credential file", readFileSync(manualSentinel, "utf8") === "manual-sentinel");
      slugs = ["catalog-next-space"];
      const next = await cli(["spaces", "--refresh", "--json"]);
      check("H6 refreshing the new account discovers only its own spaces", next.status === 0 && loadMeshes().filter((m) => m.origin === "catalog").map((m) => m.space).join() === "catalog-next-space", next.doc);
    } finally {
      await new Promise<void>((r) => catalog.close(() => r()));
    }
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
    // A second name keeps the dead inode allocated through the restart, so the successor's socket
    // cannot be given its number, which some filesystems hand straight back once it is freed. Its
    // link count then shows whether the successor removed the public name.
    const pin = join(dirname(derived), "stale-pin");
    linkSync(derived, pin);
    managedServe = await serve(["--daemon-home", managed]);
    check("H4 the successor serves with no manual removal, on the SAME derived path", live(managedServe) && managedServe.socket === derived, { socket: managedServe?.socket, derived });
    check("H4 it removed the dead socket and bound a new one: the pinned dead inode has lost its public name and the path holds another inode", existsSync(derived) && lstatSync(pin).nlink === 1 && lstatSync(derived).ino !== ino, { pinLinks: lstatSync(pin).nlink, now: existsSync(derived) ? lstatSync(derived).ino : null, stale: ino });
    rmSync(pin);
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
      const plain = await cli(["status", "--daemon-home", managed, "--plain"]);
      const remedy = r.doc.error?.remedy ?? "";
      check("H5 explicit-home advice is conditional and matches plain output", remedy.includes("For an explicit --daemon-home use the same directory as the intended daemon") && plain.status === 2 && plain.err.includes("PEER_NOT_LOCK_OWNER") && plain.err.includes(remedy), { remedy, plain: plain.err });
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
