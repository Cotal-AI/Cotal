/**
 * `cotal daemon`: the lifetime lock, stale-socket recovery, and the user-service install surface.
 *
 * Every cell drives the shipped code: `serveDaemon` in this process or a real child of the
 * composition root (`bin/cotal.ts`), over real unix sockets, with real SIGKILLs. Nothing restates
 * the rule under test; each cell counts what happened on disk, on the wire, or in the daemon's own
 * counters.
 *
 * Contract:
 * - Both daemon forms hold one lifetime lock. The default daemon's is `$COTAL_HOME/daemon/daemon.lock`.
 * - The lock is a kernel-held `flock(2)`: the kernel releases it when the holder dies, SIGKILL
 *   included, so the next start learns its predecessor is gone without judging a recorded pid.
 * - A second serve for the same daemon refuses CONFLICT / LOCK_HELD naming the live holder.
 * - Holding the lock, a start removes the socket at the public path only when the lock record names
 *   that exact `(dev, ino)` and a connect to it is refused. Any other socket, one a process answers
 *   on, and any socket after a clean stop, is refused ALREADY_RUNNING and left in place.
 * - `install` writes one systemd user unit with `Restart=always` and `WantedBy=default.target`,
 *   and refuses a second install. `uninstall` refuses with no recorded unit.
 * - `serve` prints one ready line, `daemon ready at <socket>`, on stdout and none on stderr.
 * - A refusal that names a command after other words writes it in backticks, and its plain text
 *   and its `--json` text are the same.
 *
 * Cells (each asserts counts or exact codes, never just "no error"):
 *  L1 control: `serve` binds the fixed socket and prints one ready line, on stdout; `status` answers
 *     that pid, the lock file exists, and a second serve refuses CONFLICT / LOCK_HELD naming the live
 *     pid with the socket's inode unchanged, its Next naming `cotal daemon status` in plain and --json;
 *  L2 the lock is kernel-held, not a pid record: an independent `flock` on the lock file is refused
 *     while the daemon serves and granted after SIGKILL, with the record still naming the dead pid.
 *     This is the cell that fails if the lock ever becomes an inferred-liveness record again;
 *  L3 recovery: after SIGKILL the socket survives with inode I, which the suite pins under a second
 *     name; the next serve succeeds, reports `socketsRecovered === 1`, leaves the pin as I's only
 *     link, binds another inode at the path, and `status` answers the new pid;
 *  L4 a socket the record does not name is refused: after SIGKILL the operator replaces the stale
 *     socket with a different same-uid listener's, bound while the dead inode is pinned so its number
 *     differs. The next serve refuses CONFLICT / ALREADY_RUNNING, removes 0 files, the listener's
 *     inode is unchanged and it received 0 bytes. Its Next names `cotal daemon status` and
 *     `cotal daemon serve` in plain and --json;
 *  L4b a live socket with the recorded numbers is refused: after SIGKILL a same-uid listener replaces
 *     the stale socket and the record names its device and inode numbers, as a filesystem that reuses
 *     a freed inode number leaves it. The next serve refuses CONFLICT / ALREADY_RUNNING because a
 *     connect to it was answered, removes 0 files, and the listener received 0 bytes;
 *  L5 a clean stop leaves no generation to recover: after `close()` the record names no socket and
 *     `status` refuses NOT_RUNNING naming `cotal daemon serve`, so a foreign socket placed at the path
 *     is refused ALREADY_RUNNING and kept;
 *  L6 `install --dry-run` through the CLI: it names the unit, path and digest, writes nothing, and
 *     the rendered unit carries `Restart=always`, `WantedBy=default.target`, an absolute pinned
 *     PATH and a `daemon serve` ExecStart under this entry. With a recorded unit it refuses CONFLICT
 *     naming `cotal daemon uninstall`;
 *  L7 refusals with no effect: `uninstall` with no recorded unit refuses TARGET_NOT_FOUND naming
 *     `cotal daemon install`, and `uninstall` outside a terminal without `--yes` refuses USAGE_INVALID;
 *  L8 `setup` validates before it touches anything: a missing `--space`, a non-loopback HTTP
 *     `--idp` and an out-of-range `--wait` each refuse USAGE_INVALID with no unit written; and with
 *     a daemon already answering while no unit is recorded it refuses CONFLICT /
 *     RUNNING_WITHOUT_UNIT rather than installing a second one its lifetime lock would refuse.
 *     `setup` reaching connected is proven against a real space in
 *     `bin/smoke/daemon-service-connect.smoke.ts`.
 *  L9 `install --dry-run` outside a logged-in session: with USER and LOGNAME unset it refuses
 *     TARGET_UNAVAILABLE naming both, and with them set and a private runtime directory it refuses
 *     DEPENDENCY_UNAVAILABLE naming `systemctl --user show-environment`. Each has a Next, in plain
 *     and --json, and writes no receipt.
 *
 * L6's dry-run cell needs a systemd user manager to answer its own config directory. Where there is
 * none it is skipped by name and counted, never reported as passed. L8 needs none: it refuses before
 * any unit is rendered.
 *
 * Applying an install writes a unit into the operator's own `~/.config/systemd/user` and enables it
 * with their user manager, which this suite will not do. So `install` and `uninstall` are covered
 * here up to their refusals and their preview, and the apply path, the restart systemd performs
 * after `systemctl --user kill -s KILL`, logout survival through linger, and removal are proven
 * against a real user manager in a disposable container.
 *
 * Run: tsx bin/smoke/daemon-lifetime.smoke.ts   (Linux only)
 */
import { closeSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { constants } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { skipSuite } from "@cotal-ai/smoke-kit";
import { flockExclusiveNb, peerCredentials } from "@cotal-ai/seat";
import { daemonPaths } from "../daemon/endpoint.js";
import { serveDaemon } from "../daemon/server.js";

if (process.platform !== "linux") skipSuite(`daemon-lifetime smoke: Linux only; skipped on ${process.platform}`);
const scratchParent = process.env.COTAL_DAEMON_SMOKE_TMP ?? tmpdir();
for (const key of Object.keys(process.env)) if (key.startsWith("COTAL_")) delete process.env[key];

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0, skipped = 0;

function check(what: string, ok: boolean, detail?: unknown): void {
  if (ok) { pass++; console.log(`  ✓ ${what}`); return; }
  fail++;
  console.error(`  ✗ ${what}${detail === undefined ? "" : `\n      ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
}
function skip(what: string, why: string): void {
  skipped++;
  console.log(`  - SKIPPED ${what}: ${why}`);
}
async function cell(title: string, body: () => Promise<void>): Promise<void> {
  console.log(`\n${title}`);
  const before = children.length;
  try { await body(); } catch (e) { fail++; console.error(`  ✗ ${title} threw:`, e instanceof Error ? (e.stack ?? e.message) : e); }
  finally {
    // A cell that threw must not leave a child holding the lifetime lock for the next one.
    for (const c of children.slice(before)) await kill(c);
    children.length = before;
  }
}

/** An owned scratch root standing in for the operator's home: its own COTAL_HOME and runtime dir. */
const root = mkdtempSync(join(scratchParent, "cdl-"));
const home = join(root, "h");
const rtDir = join(root, "r");
mkdirSync(home, { mode: 0o700, recursive: true });
mkdirSync(rtDir, { mode: 0o700, recursive: true });
const paths = daemonPaths({ XDG_RUNTIME_DIR: rtDir }, home);
// `sun_path` is 108 bytes including its terminator, and the daemon binds a private name beside its
// socket before publishing it. A root too deep to hold that name would fail as an opaque EINVAL
// from listen(2), so it is refused here by name instead.
const longestBind = join(paths.dir, ".bind-1234567-0123456789ab");
if (Buffer.byteLength(longestBind) > 107) {
  rmSync(root, { recursive: true, force: true });
  skipSuite(`daemon-lifetime smoke: ${scratchParent} is too deep for a unix socket path (${longestBind} is ${Buffer.byteLength(longestBind)} bytes, the limit is 107). Set COTAL_DAEMON_SMOKE_TMP to a shorter directory.`);
}
const peerUid = (s: Parameters<typeof peerCredentials>[0]) => peerCredentials(s).uid;
const serve = () => serveDaemon({ paths, version: "0.0.0-smoke", peerUid, sessionDir: home } as Parameters<typeof serveDaemon>[0]);

const children: ChildProcess[] = [];
/** The operator's own runtime directory, which `systemctl --user` needs to reach its bus. Only the
 *  cells that read the user manager use it, and they write nothing outside the sandbox. */
const realRuntimeDir = process.env.XDG_RUNTIME_DIR;
/** The daemon as a real child whose own pid is the daemon's, so a SIGKILL kills the holder. */
function child(args: string[], opts: { userManager?: boolean; env?: NodeJS.ProcessEnv } = {}): ChildProcess {
  const runtime = opts.userManager && realRuntimeDir ? realRuntimeDir : rtDir;
  const c = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), join(repo, "bin", "cotal.ts"), "daemon", ...args], {
    cwd: root, env: { ...process.env, XDG_RUNTIME_DIR: runtime, COTAL_HOME: home, COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1", ...opts.env }, stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(c);
  return c;
}
async function cli(...args: string[]): Promise<{ status: number | null; doc: Record<string, any>; out: string; err: string }> {
  return cliEnv({}, ...args);
}
/** Like {@link cli}, with `env` laid over the child's environment; an `undefined` value unsets it. */
async function cliEnv(env: NodeJS.ProcessEnv, ...args: string[]): Promise<{ status: number | null; doc: Record<string, any>; out: string; err: string }> {
  const c = child(args, { env });
  let out = "", err = "";
  c.stdout!.on("data", (b) => { out += String(b); });
  c.stderr!.on("data", (b) => { err += String(b); });
  const status = await Promise.race([new Promise<number | null>((r) => c.once("exit", (x) => r(x))), sleep(120_000).then(() => { c.kill("SIGKILL"); return -1; })]);
  let doc: Record<string, any> = {};
  try { doc = JSON.parse(out) as Record<string, any>; } catch { /* reported by the cell */ }
  return { status, doc, out, err };
}
/** The built CLI entry. A systemd unit must pin a durable executable, so the install cells drive
 *  this rather than the tsx loader the other cells use. */
const shipped = join(repo, "bin", "dist", "cotal.js");
/** {@link cliUserManager} through the shipped entry. */
async function shippedCli(...args: string[]): Promise<{ status: number | null; doc: Record<string, any>; out: string; err: string }> {
  const c = spawn(process.execPath, [shipped, "daemon", ...args], {
    cwd: root, env: { ...process.env, ...(realRuntimeDir ? { XDG_RUNTIME_DIR: realRuntimeDir } : {}), COTAL_HOME: home, COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(c);
  let out = "", err = "";
  c.stdout!.on("data", (b) => { out += String(b); });
  c.stderr!.on("data", (b) => { err += String(b); });
  const status = await Promise.race([new Promise<number | null>((r) => c.once("exit", (x) => r(x))), sleep(120_000).then(() => { c.kill("SIGKILL"); return -1; })]);
  let doc: Record<string, any> = {};
  try { doc = JSON.parse(out) as Record<string, any>; } catch { /* reported by the cell */ }
  return { status, doc, out, err };
}

/** Like {@link cli}, with the operator's real runtime directory so `systemctl --user` can answer. */
async function cliUserManager(...args: string[]): Promise<{ status: number | null; doc: Record<string, any>; out: string; err: string }> {
  const c = child(args, { userManager: true });
  let out = "", err = "";
  c.stdout!.on("data", (b) => { out += String(b); });
  c.stderr!.on("data", (b) => { err += String(b); });
  const status = await Promise.race([new Promise<number | null>((r) => c.once("exit", (x) => r(x))), sleep(120_000).then(() => { c.kill("SIGKILL"); return -1; })]);
  let doc: Record<string, any> = {};
  try { doc = JSON.parse(out) as Record<string, any>; } catch { /* reported by the cell */ }
  return { status, doc, out, err };
}

/** Start a serving child and wait for its ready line, returning its pid and what it printed so far. */
async function serveChild(): Promise<{ proc: ChildProcess; pid: number; out: () => string; err: () => string }> {
  const c = child(["serve"]);
  let out = "", err = "";
  c.stdout!.on("data", (b) => { out += String(b); });
  c.stderr!.on("data", (b) => { err += String(b); });
  // The child loads the whole composition root through tsx, which is slow on a loaded host.
  for (let i = 0; i < 1200 && !out.includes("daemon ready at") && c.exitCode === null; i++) await sleep(50);
  if (!out.includes("daemon ready at")) {
    await kill(c);
    throw new Error(`the serving child never reported ready (exit ${c.exitCode}); stdout=${JSON.stringify(out)} stderr=${JSON.stringify(err.slice(-600))}`);
  }
  return { proc: c, pid: c.pid!, out: () => out, err: () => err };
}
/** A refusal's message and Next, read from its --json document and found as the same text in its
 *  plain output, so the two presentations cannot drift. */
function sameText(json: { doc: Record<string, any> }, plain: { out: string; err: string }): boolean {
  const text = `${plain.out}${plain.err}`;
  return typeof json.doc.error?.message === "string" && typeof json.doc.error?.remedy === "string"
    && text.includes(json.doc.error.message) && text.includes(`Next\n  ${json.doc.error.remedy}`);
}
async function kill(c: ChildProcess, signal: NodeJS.Signals = "SIGKILL"): Promise<void> {
  if (c.exitCode !== null || c.signalCode !== null) return;
  const exit = new Promise<void>((r) => c.once("exit", () => r()));
  c.kill(signal);
  await Promise.race([exit, sleep(10_000)]);
}
const ino = (p: string) => lstatSync(p).ino;
const lockRecord = (): Record<string, any> | undefined => {
  try { const t = readFileSync(paths.lock, "utf8"); return t.trim() ? JSON.parse(t) as Record<string, any> : undefined; } catch { return undefined; }
};
/** True when an independent descriptor can take the lock, i.e. the kernel holds it for nobody. */
function lockIsFree(): boolean {
  const fd = openSync(paths.lock, constants.O_RDWR | constants.O_CREAT, 0o600);
  try { return flockExclusiveNb(fd); } finally { closeSync(fd); }
}
/** A different same-uid process listening at `path`, reporting any byte it receives. */
async function impostor(path: string): Promise<{ proc: ChildProcess; gotBytes: () => boolean }> {
  const c = spawn(process.execPath, ["-e", `const s=require("net").createServer(x=>x.on("data",()=>process.stdout.write("GOT-BYTES\\n")));s.listen(${JSON.stringify(path)},()=>{require("fs").chmodSync(${JSON.stringify(path)},0o600);process.stdout.write("LISTENING\\n")});`], { stdio: ["ignore", "pipe", "ignore"] });
  children.push(c);
  let out = "";
  c.stdout!.on("data", (b) => { out += String(b); });
  for (let i = 0; i < 200 && !out.includes("LISTENING"); i++) await sleep(50);
  if (!out.includes("LISTENING")) throw new Error("the impostor listener never bound");
  return { proc: c, gotBytes: () => out.includes("GOT-BYTES") };
}
const unitDirAvailable = realRuntimeDir !== undefined && spawnSync("systemctl", ["--user", "show-environment", "--no-pager"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] }).status === 0;

console.log(`daemon lifetime smoke in ${root}`);

try {
  await cell("L1 the lifetime lock serializes serve", async () => {
    const first = await serveChild();
    const st = await cli("status", "--json");
    check("L1 status answers the serving child's pid, exit 0", st.status === 0 && st.doc.result?.pid === first.pid, { status: st.status, pid: st.doc.result?.pid, expected: first.pid, out: st.out.slice(0, 300) });
    // Read once status has answered, so the daemon is past its ready point on both streams.
    const readyLines = (text: string) => text.split("\n").filter((line) => line.includes("ready at"));
    check("L1 serve printed one ready line, `daemon ready at <socket>`, on stdout and none on stderr", JSON.stringify(readyLines(first.out())) === JSON.stringify([`daemon ready at ${paths.socket}`]) && readyLines(first.err()).length === 0, { out: first.out(), err: first.err() });
    check("L1 the lock file exists in the daemon's own state directory", existsSync(paths.lock) && paths.lock === join(home, "daemon", "daemon.lock"), paths.lock);
    const rec = lockRecord();
    check("L1 its record names the live holder", rec?.v === 1 && rec?.pid === first.pid, rec);
    const socketIno = ino(paths.socket);
    const second = await cli("serve", "--json");
    check("L1 a second serve refuses CONFLICT / LOCK_HELD, exit 2", second.status === 2 && second.doc.error?.code === "CONFLICT" && second.doc.error?.cause?.code === "LOCK_HELD", { status: second.status, out: second.out.slice(0, 300) });
    check("L1 the refusal names the live holder's pid", String(second.doc.error?.message ?? "").includes(`pid ${first.pid}`), second.doc.error?.message);
    const secondPlain = await cli("serve", "--plain");
    check("L1 its Next names `cotal daemon status` in backticks, in plain and --json alike", String(second.doc.error?.remedy).includes("run `cotal daemon status`, with the same --daemon-home") && secondPlain.status === 2 && sameText(second, secondPlain), { remedy: second.doc.error?.remedy, plain: secondPlain.out + secondPlain.err });
    check("L1 the first daemon's socket keeps its inode, so 0 replacements", ino(paths.socket) === socketIno);
    await kill(first.proc, "SIGTERM");
  });

  await cell("L2 the lock is kernel-held, not an inferred-liveness record", async () => {
    const d = await serveChild();
    check("L2 an independent flock is refused while the daemon serves", lockIsFree() === false);
    await kill(d.proc, "SIGKILL");
    await sleep(500);
    const rec = lockRecord();
    check("L2 after SIGKILL the record still names the dead pid (a record cannot release itself)", rec?.pid === d.pid, rec);
    check("L2 instrument: that pid really is gone", !(() => { try { process.kill(d.pid, 0); return true; } catch { return false; } })());
    check("L2 yet the kernel has released the lock, so an independent flock is granted", lockIsFree() === true);
    check("L2 the stale socket is still published", existsSync(paths.socket) && lstatSync(paths.socket).isSocket());
  });

  await cell("L3 a killed daemon's successor recovers the exact socket it published", async () => {
    // L2 left the socket of a SIGKILLed daemon, and its record names that generation.
    const stale = ino(paths.socket);
    const rec = lockRecord();
    check("L3 instrument: the record names the stale socket's inode", rec?.socket?.ino === stale && rec?.socket?.path === paths.socket, { rec, stale });
    // A second name keeps the dead inode allocated through the restart, so the successor's socket
    // cannot be given its number, which some filesystems hand straight back once it is freed. Its
    // link count then shows whether the successor removed the public name.
    const pin = join(paths.dir, "stale-pin");
    linkSync(paths.socket, pin);
    const d = await serve();
    check("L3 the successor started with no operator step", d.status().state === "ready");
    check("L3 it reports exactly 1 recovered socket", d.counters.socketsRecovered === 1, d.counters);
    check("L3 it removed the dead socket and bound a new one: the pinned dead inode has lost its public name and the path holds another inode", lstatSync(pin).nlink === 1 && ino(paths.socket) !== stale, { pinLinks: lstatSync(pin).nlink, now: ino(paths.socket), stale });
    rmSync(pin);
    const st = await cli("status", "--json");
    check("L3 status answers the successor's pid, exit 0", st.status === 0 && st.doc.result?.pid === process.pid, { status: st.status, pid: st.doc.result?.pid, expected: process.pid, out: st.out.slice(0, 300) });
    check("L3 the record now names the new generation", lockRecord()?.socket?.ino === ino(paths.socket));
    await d.close();
    check("L3 a clean close removes its own socket", !existsSync(paths.socket));
  });

  await cell("L4 a socket the record does not name is refused, never removed", async () => {
    const d = await serveChild();
    const published = ino(paths.socket);
    await kill(d.proc, "SIGKILL");
    await sleep(500);
    check("L4 instrument: the record names the killed daemon's socket", lockRecord()?.socket?.ino === published);
    // The operator removes that socket and something else binds the path: a generation this
    // daemon home never published. The dead inode is pinned meanwhile, so the listener gets another
    // number on any filesystem; L4b covers a listener given the same numbers.
    const pin = join(paths.dir, "stale-pin");
    linkSync(paths.socket, pin);
    unlinkSync(paths.socket);
    const other = await impostor(paths.socket);
    const foreign = ino(paths.socket);
    rmSync(pin);
    check("L4 instrument: a different same-uid process now holds the path with another inode", foreign !== published);
    const before = readdirSync(paths.dir).length;
    const r = await cli("serve", "--json");
    check("L4 serve refuses CONFLICT / ALREADY_RUNNING, exit 2", r.status === 2 && r.doc.error?.code === "CONFLICT" && r.doc.error?.cause?.code === "ALREADY_RUNNING", { status: r.status, out: r.out.slice(0, 300) });
    check("L4 the refusal says it is not the socket this home published", String(r.doc.error?.message ?? "").includes("is not the socket this daemon home's last daemon published"), r.doc.error?.message);
    const plain = await cli("serve", "--plain");
    check("L4 its Next names `cotal daemon status` and `cotal daemon serve` in backticks, in plain and --json alike", /^run `cotal daemon status`: .*confirm no `cotal daemon serve` process is running/.test(String(r.doc.error?.remedy)) && plain.status === 2 && sameText(r, plain), { remedy: r.doc.error?.remedy, plain: plain.out + plain.err });
    check("L4 that socket keeps its inode and 0 entries were removed", ino(paths.socket) === foreign && readdirSync(paths.dir).length === before);
    check("L4 the other process received 0 bytes", !other.gotBytes());
    await kill(other.proc, "SIGTERM");
    rmSync(paths.socket, { force: true });
  });

  await cell("L4b a live socket with the numbers the record names is refused, never removed", async () => {
    const d = await serveChild();
    await kill(d.proc, "SIGKILL");
    await sleep(500);
    unlinkSync(paths.socket);
    const other = await impostor(paths.socket);
    const live = lstatSync(paths.socket);
    // A filesystem that hands a freed inode number straight back (ext4 does) gives the listener the
    // dead socket's numbers by itself. Where it does not, the record is made to name them, which is
    // the state such a filesystem leaves.
    writeFileSync(paths.lock, `${JSON.stringify({ ...lockRecord(), socket: { path: paths.socket, dev: live.dev, ino: live.ino } })}\n`);
    const rec = lockRecord();
    check("L4b instrument: the killed daemon's record names the live listener's device and inode numbers", rec?.pid === d.pid && rec?.socket?.dev === live.dev && rec?.socket?.ino === live.ino, rec);
    const before = readdirSync(paths.dir).length;
    const r = await cli("serve", "--json");
    check("L4b serve refuses CONFLICT / ALREADY_RUNNING, exit 2", r.status === 2 && r.doc.error?.code === "CONFLICT" && r.doc.error?.cause?.code === "ALREADY_RUNNING", { status: r.status, out: r.out.slice(0, 300) });
    check("L4b the refusal says a connect to that socket was answered", String(r.doc.error?.message ?? "").includes("but a connect to it was answered"), r.doc.error?.message);
    check("L4b that socket keeps its inode and 0 entries were removed", ino(paths.socket) === live.ino && readdirSync(paths.dir).length === before);
    check("L4b the other process received 0 bytes", !other.gotBytes());
    await kill(other.proc, "SIGTERM");
    rmSync(paths.socket, { force: true });
  });

  await cell("L5 a clean stop leaves no generation to recover", async () => {
    const d = await serve();
    const mine = ino(paths.socket);
    check("L5 instrument: the record names this daemon's socket while it serves", lockRecord()?.socket?.ino === mine);
    await d.close();
    check("L5 a clean close clears the record, so it names no generation", lockRecord() === undefined, lockRecord());
    const stopped = await cli("status", "--json"), stoppedPlain = await cli("status", "--plain");
    check("L5 status then refuses TARGET_UNAVAILABLE / NOT_RUNNING, exit 2", stopped.status === 2 && stopped.doc.error?.cause?.code === "NOT_RUNNING", { status: stopped.status, out: stopped.out.slice(0, 300) });
    check("L5 its Next names `cotal daemon serve` in backticks, in plain and --json alike", stopped.doc.error?.remedy === "start it with `cotal daemon serve`" && stoppedPlain.status === 2 && sameText(stopped, stoppedPlain), { remedy: stopped.doc.error?.remedy, plain: stoppedPlain.out + stoppedPlain.err });
    const other = await impostor(paths.socket);
    const foreign = ino(paths.socket);
    const r = await cli("serve", "--json");
    check("L5 a foreign socket after a clean stop refuses CONFLICT / ALREADY_RUNNING, exit 2", r.status === 2 && r.doc.error?.cause?.code === "ALREADY_RUNNING", { status: r.status, out: r.out.slice(0, 300) });
    check("L5 it was kept: the inode is unchanged and it received 0 bytes", ino(paths.socket) === foreign && !other.gotBytes());
    await kill(other.proc, "SIGTERM");
    rmSync(paths.socket, { force: true });
  });

  await cell("L6 install --dry-run names one unit and writes nothing", async () => {
    if (!unitDirAvailable) {
      skip("L6 install --dry-run", "no systemd user manager answered `systemctl --user show-environment` on this host; the real install is proven in a container");
      return;
    }
    if (!existsSync(shipped)) {
      skip("L6 install --dry-run", `the built entry ${shipped} is absent; run pnpm build first`);
      return;
    }
    // A unit must pin a durable entry, so the loader-based entry the other cells use is refused.
    const viaLoader = await cliUserManager("install", "--dry-run", "--json");
    check("L6 a transient loader entry is refused UNSUPPORTED and pins no unit, exit 2", viaLoader.status === 2 && viaLoader.doc.error?.code === "UNSUPPORTED" && viaLoader.doc.result === null, { status: viaLoader.status, out: viaLoader.out.slice(0, 300) });
    const r = await shippedCli("install", "--dry-run", "--json");
    check("L6 it reports a would-install, exit 0", r.status === 0 && r.doc.result?.state === "would-install", { status: r.status, out: r.out.slice(0, 400) });
    check("L6 it names the daemon's own unit", r.doc.result?.unit === "cotal-daemon.service", r.doc.result?.unit);
    check("L6 it names an absolute unit path under the user manager's own config directory", typeof r.doc.result?.unitPath === "string" && r.doc.result.unitPath.endsWith("/systemd/user/cotal-daemon.service"), r.doc.result?.unitPath);
    check("L6 it reports a sha256 digest of the bytes it would write", /^[0-9a-f]{64}$/.test(String(r.doc.result?.sha256)), r.doc.result?.sha256);
    check("L6 nothing was written: the unit path does not exist", typeof r.doc.result?.unitPath === "string" && !existsSync(r.doc.result.unitPath));
    // The policy fields are read back out of the bytes the install would write, so a template that
    // stopped restarting the daemon would report "absent" here rather than pass.
    check("L6 the unit it would write restarts the daemon on its own", r.doc.result?.restart === "always", r.doc.result?.restart);
    check("L6 the unit it would write starts at login", r.doc.result?.wantedBy === "default.target", r.doc.result?.wantedBy);
    check("L6 it names the user whose manager would run it", r.doc.result?.user === (process.env.USER || process.env.LOGNAME), r.doc.result?.user);
    // A recorded unit refuses a second install before anything is read from the user manager's linger.
    const receipt = join(home, "daemon", "service-unit.json");
    writeFileSync(receipt, `${JSON.stringify({ v: 1, unit: "cotal-daemon.service", unitPath: join(root, "cotal-daemon.service"), unitSha256: r.doc.result?.sha256, installedAt: new Date().toISOString() })}\n`, { mode: 0o600 });
    try {
      const again = await shippedCli("install", "--dry-run", "--json"), againPlain = await shippedCli("install", "--dry-run", "--plain");
      check("L6 with a recorded unit it refuses CONFLICT, exit 2", again.status === 2 && again.doc.error?.code === "CONFLICT", { status: again.status, out: again.out.slice(0, 300) });
      const text = `${againPlain.out}${againPlain.err}`;
      check("L6 that refusal names `cotal daemon uninstall` in backticks, in plain and --json alike", String(again.doc.error?.message).includes("remove it with `cotal daemon uninstall` before installing again") && againPlain.status === 2 && text.includes(again.doc.error.message), { message: again.doc.error?.message, plain: text });
    } finally {
      rmSync(receipt, { force: true });
    }
  });

  await cell("L7 uninstall refuses with no effect", async () => {
    const r = await cli("uninstall", "--yes", "--json");
    check("L7 with no recorded unit it refuses TARGET_NOT_FOUND, exit 2", r.status === 2 && r.doc.error?.code === "TARGET_NOT_FOUND", { status: r.status, out: r.out.slice(0, 300) });
    const plain = await cli("uninstall", "--yes", "--plain");
    check("L7 that refusal names `cotal daemon install` in backticks, in plain and --json alike", String(r.doc.error?.message).includes("no installed unit recorded by `cotal daemon install`") && plain.status === 2 && `${plain.out}${plain.err}`.includes(r.doc.error.message), { message: r.doc.error?.message, plain: plain.out + plain.err });
    check("L7 no unit receipt was created", !existsSync(join(home, "daemon", "service-unit.json")));
    const noYes = await cli("uninstall", "--json");
    check("L7 outside a terminal without --yes it refuses USAGE_INVALID, exit 1", noYes.status === 1 && noYes.doc.error?.code === "USAGE_INVALID", { status: noYes.status, out: noYes.out.slice(0, 300) });
  });
  await cell("L8 setup validates before it changes anything", async () => {
    const receipt = join(home, "daemon", "service-unit.json");
    const noSpace = await cli("setup", "--json");
    check("L8 a missing --space refuses USAGE_INVALID naming it, exit 1", noSpace.status === 1 && noSpace.doc.error?.code === "USAGE_INVALID" && String(noSpace.doc.error?.message).includes("--space"), { status: noSpace.status, out: noSpace.out.slice(0, 250) });
    const badIdp = await cli("setup", "--space", "demo", "--idp", "http://example.com/api/auth", "--json");
    check("L8 a non-loopback HTTP --idp refuses USAGE_INVALID, exit 1", badIdp.status === 1 && badIdp.doc.error?.code === "USAGE_INVALID", { status: badIdp.status, out: badIdp.out.slice(0, 250) });
    for (const [value, what] of [["-1", "negative"], ["90000", "past a day"], ["5.5", "fractional"]] as const) {
      const r = await cli("setup", "--space", "demo", "--wait", value, "--json");
      check(`L8 a ${what} --wait refuses USAGE_INVALID, exit 1`, r.status === 1 && r.doc.error?.code === "USAGE_INVALID", { value, status: r.status, out: r.out.slice(0, 200) });
    }
    check("L8 none of those refusals wrote a unit receipt", !existsSync(receipt));

    // A daemon running with nothing recorded for it: installing now would start a second one.
    const running = await serveChild();
    try {
      const r = await cli("setup", "--space", "demo", "--json");
      check("L8 setup refuses CONFLICT / RUNNING_WITHOUT_UNIT, exit 2", r.status === 2 && r.doc.error?.code === "CONFLICT" && r.doc.error?.cause?.code === "RUNNING_WITHOUT_UNIT", { status: r.status, out: r.out.slice(0, 300) });
      check("L8 it installed nothing: no unit receipt", !existsSync(receipt));
      check("L8 the running daemon is untouched and still answers its own pid", (await cli("status", "--json")).doc.result?.pid === running.pid);
    } finally {
      await kill(running.proc, "SIGTERM");
    }
  });

  await cell("L9 install --dry-run outside a logged-in session names what it read and gives a Next", async () => {
    const receipt = join(home, "daemon", "service-unit.json");
    const noUser = { USER: undefined, LOGNAME: undefined };
    const a = await cliEnv(noUser, "install", "--dry-run", "--json"), aPlain = await cliEnv(noUser, "install", "--dry-run", "--plain");
    check("L9 with USER and LOGNAME unset it refuses TARGET_UNAVAILABLE, exit 2", a.status === 2 && a.doc.error?.code === "TARGET_UNAVAILABLE", { status: a.status, out: a.out.slice(0, 300) });
    check("L9 that refusal names USER and LOGNAME, with a Next, in plain and --json alike", /USER and LOGNAME/.test(String(a.doc.error?.message)) && /USER and LOGNAME/.test(String(a.doc.error?.remedy)) && aPlain.status === 2 && sameText(a, aPlain), { error: a.doc.error, plain: aPlain.out + aPlain.err });
    // The suite's own runtime directory reaches no user manager, and no session bus is inherited.
    const unreachable = { USER: userInfo().username, LOGNAME: userInfo().username, XDG_RUNTIME_DIR: rtDir, DBUS_SESSION_BUS_ADDRESS: undefined };
    const b = await cliEnv(unreachable, "install", "--dry-run", "--json"), bPlain = await cliEnv(unreachable, "install", "--dry-run", "--plain");
    check("L9 with a private runtime directory it refuses DEPENDENCY_UNAVAILABLE, exit 2", b.status === 2 && b.doc.error?.code === "DEPENDENCY_UNAVAILABLE", { status: b.status, out: b.out.slice(0, 300) });
    check("L9 that refusal names `systemctl --user show-environment` and XDG_RUNTIME_DIR, with a Next, in plain and --json alike", String(b.doc.error?.message).includes("did not answer `systemctl --user show-environment`") && String(b.doc.error?.remedy).includes("XDG_RUNTIME_DIR") && bPlain.status === 2 && sameText(b, bPlain), { error: b.doc.error, plain: bPlain.out + bPlain.err });
    check("L9 neither refusal wrote a unit receipt", !existsSync(receipt));
  });
} catch (e) {
  fail++;
  console.error("  ✗ smoke crashed:", e instanceof Error ? (e.stack ?? e.message) : e);
} finally {
  for (const c of children) await kill(c);
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nDAEMON LIFETIME SMOKE ${fail === 0 ? "OK" : "FAILED"}  (${pass} passed, ${fail} failed, ${skipped} skipped)`);
process.exit(fail === 0 ? 0 : 1);
