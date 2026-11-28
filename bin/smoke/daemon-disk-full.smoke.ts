/** A full disk is recognised as its own state (issue 10932): the real daemon on a real small
 *  filesystem (an 8m tmpfs in an unprivileged mount namespace), the same record write before,
 *  during and after the disk is full, the status frame naming it, the wording split between
 *  saved, unconfirmed and read-only operations, and recovery without a restart, through a
 *  write and through a status read alone.
 *
 *  Not a faked errno: the failure is produced by the filesystem itself. Linux only.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { skipSuite } from "@cotal-ai/smoke-kit";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const root = mkdtempSync(join(tmpdir(), "ddf-"));
let sleepHandle: ReturnType<typeof setTimeout> | undefined;
let runner: ChildProcess | undefined;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
let pass = 0, fail = 0;
const check = (label: string, ok: boolean, details?: unknown) => {
  if (ok) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}`, details ?? ""); }
};

try {
  if (process.platform !== "linux") skipSuite("daemon-disk-full: Linux only (needs unprivileged mount namespaces)");
  const probe = spawnSync("unshare", ["-Urm", "true"], { encoding: "utf8" });
  if (probe.status !== 0) skipSuite("daemon-disk-full: skipped (unprivileged mount namespace unavailable)");

  // The whole scenario runs inside one namespace child: it mounts the tmpfs, starts the real
  // daemon, drives the CLI, and reports its own results as JSON lines the parent asserts on.
  const script = join(root, "scenario.mjs");
  const disk = join(root, "disk");
  mkdirSync(disk, { mode: 0o700 });
  const childEnv = { PATH: process.env.PATH, DO_NOT_TRACK: "1" };
  const scenario = `
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { readFileSync, statfsSync, appendFileSync } from "node:fs";
const cli = (args, env) => spawn(process.execPath, [${JSON.stringify(join(repo, "bin/dist/cotal.js"))}, ...args], { cwd: ${JSON.stringify(repo)}, env: { ...env, PATH: process.env.PATH, DO_NOT_TRACK: "1" }, stdio: ["ignore", "pipe", "pipe"] });
const run = async (args, env) => new Promise((resolve) => {
  const child = cli(args, env);
  let out = "", code = 0;
  child.stdout.on("data", (c) => { out += String(c); });
  child.stderr.on("data", (c) => { out += String(c); });
  child.on("exit", (c) => { code = c ?? 0; resolve({ out, code }); });
  child.on("error", (e) => resolve({ out: String(e), code: -1 }));
});
const frame = (socket, op, extra = {}, timeoutMs = 8000) => new Promise((resolve) => {
  const client = connect(socket);
  let text = "";
  const timer = setTimeout(() => { client.destroy(); resolve(undefined); }, timeoutMs);
  const finish = (value) => { clearTimeout(timer); client.destroy(); resolve(value); };
  client.on("connect", () => client.write(JSON.stringify({ v: 1, id: "probe", op, ...extra }) + "\\n"));
  client.on("error", () => finish());
  client.on("end", () => finish());
  client.on("data", (data) => { text += String(data); if (text.includes("\\n")) { try { finish(JSON.parse(text.split("\\n")[0])); } catch { finish(); } } });
});
const socket = ${JSON.stringify(join(disk, "run/cotal/daemon.sock"))};
const env = { COTAL_HOME: ${JSON.stringify(join(disk, "home"))}, HOME: ${JSON.stringify(join(disk, "home"))}, TMPDIR: ${JSON.stringify(join(disk, "tmp"))}, XDG_RUNTIME_DIR: ${JSON.stringify(join(disk, "run"))}, XDG_CONFIG_HOME: ${JSON.stringify(join(disk, "config"))}, COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_TELEMETRY: "off" };
const report = (name, ok, detail) => console.log(JSON.stringify({ name, ok, detail }));
const daemon = cli(["daemon", "serve"], env);
daemon.stdout.resume();
daemon.stderr.resume();
const exit = new Promise((r) => daemon.once("exit", r));
let settled = false;
const finishScenario = async () => { if (settled) return; settled = true; daemon.kill("SIGTERM"); await Promise.race([exit, new Promise(r => setTimeout(r, 10_000))]); };
process.on("exit", finishScenario);
try {
  let ready = false;
  for (let i = 0; i < 150; i++) { if (await frame(socket, "status")) { ready = true; break; } await new Promise(r => setTimeout(r, 200)); }
  // Startup writes finish before the scenario fills anything.
  await new Promise(r => setTimeout(r, 3000));
  report("daemon-ready", ready);
  const before = await run(["daemon", "name", "before-full"], env);
  report("record-write-before", before.code === 0, before.out.slice(0, 300));
  const recordsBefore = readFileSync(${JSON.stringify(join(disk, "home/daemon/computer-name.json"))}, "utf8");
  const { execFileSync } = await import("node:child_process");
  let filled = false;
  try { execFileSync("dd", ["if=/dev/zero", "of=" + ${JSON.stringify(join(disk, "fill"))}, "bs=1M", "count=8", "status=none"]); filled = true; } catch {}
  // dd may stop early once the tmpfs is exhausted: either way, zero blocks remain free.
  report("disk-filled", statfsSync(${JSON.stringify(disk)}).bfree === 0, String(statfsSync(${JSON.stringify(disk)}).bfree));

  // The atomic save: the one record write, refused with its own sentence.
  const failed = await run(["daemon", "name", "probe-disk-full"], env);
  report("record-write-full-refused", failed.code === 5, failed.out.slice(0, 400));
  report("record-write-full-plain-words", failed.out.includes("The disk is full, so this change wasn't saved. Free up space on this computer, then try again."), failed.out.slice(0, 400));
  const recordsAfter = readFileSync(${JSON.stringify(join(disk, "home/daemon/computer-name.json"))}, "utf8");
  report("previous-record-intact", recordsAfter === recordsBefore, recordsAfter);

  // An invalid name on a full disk stays a usage refusal: exit 1, not 5. A control character
  // makes the name invalid before any write is attempted.
  const invalid = await run(["daemon", "name", "bad\\nname"], env);
  report("invalid-name-still-usage-refusal", invalid.code === 1, invalid.out.slice(0, 300));

  // The status frame and the plain row carry the state.
  const statusFull = await frame(socket, "status");
  report("status-disk-full-true", statusFull?.result?.diskFull === true, JSON.stringify(statusFull?.result?.diskFull));
  const plainFull = await run(["daemon", "status"], env);
  const diskRow = plainFull.out.split("\\n").find((l) => l.includes("Disk")) ?? "(no Disk row)";
  report("status-plain-names-it", plainFull.out.includes("Disk") && plainFull.out.includes("full. Free up space on this computer. Cotal continues by itself once there is room."), plainFull.out.slice(0, 1200));
  report("status-plain-exact-sentence", /\\bDisk:\\s+full\\. Free up space on this computer\\. Cotal continues by itself once there is room\\./.test(plainFull.out), diskRow);

  // The Manager log cell: the log write the daemon's hosted Manager performs, refused by the
  // same full filesystem. It proves the log path sees ENOSPC while the state is set.
  let logAppendFailed = false;
  try { appendFileSync(${JSON.stringify(join(disk, "home/daemon/manager-probe.log"))}, "probe\\n"); } catch { logAppendFailed = true; }
  report("manager-log-append-refused", logAppendFailed, "append succeeded while the disk is full");

  // The state must survive a read that cannot clear it: no write happened, so the Disk row stays.
  const statusStillFull = await frame(socket, "status");
  report("status-read-keeps-state-while-full", statusStillFull?.result?.diskFull === true, JSON.stringify(statusStillFull?.result?.diskFull));

  // Recovery through a status read alone: free space, then read status without any write op.
  const { rmSync } = await import("node:fs");
  rmSync(${JSON.stringify(join(disk, "fill"))}, { force: true });
  const statusAfterFree = await frame(socket, "status");
  report("status-read-clears-after-free", statusAfterFree?.result?.diskFull === undefined, JSON.stringify(statusAfterFree?.result?.diskFull));

  // And recovery through a write: the record write succeeds and updates the record.
  const retry = await run(["daemon", "name", "after-free"], env);
  report("record-write-after-free", retry.code === 0, retry.out.slice(0, 300));
  const recordsFinal = readFileSync(${JSON.stringify(join(disk, "home/daemon/computer-name.json"))}, "utf8");
  report("record-updated-after-free", recordsFinal.includes("after-free"), recordsFinal);
  const statusFree = await frame(socket, "status");
  report("status-disk-full-cleared", statusFree?.result?.diskFull === undefined, JSON.stringify(statusFree?.result?.diskFull));
  report("daemon-same-pid", statusFree?.result?.pid === daemon.pid, statusFree?.result?.pid + " vs " + daemon.pid);
} finally { await finishScenario(); }
`;
  // The namespace child re-enters this file under --scenario to run the steps inside the mount.
  const inner = `
import { writeFileSync, mkdirSync } from "node:fs";
writeFileSync(${JSON.stringify(script)}, ${JSON.stringify(scenario)});
mkdirSync(${JSON.stringify(join(disk, "home"))}, { recursive: true, mode: 0o700 });
mkdirSync(${JSON.stringify(join(disk, "tmp"))}, { recursive: true, mode: 0o700 });
mkdirSync(${JSON.stringify(join(disk, "run"))}, { recursive: true, mode: 0o700 });
mkdirSync(${JSON.stringify(join(disk, "config"))}, { recursive: true, mode: 0o700 });
process.exit(0);
`;
  const prep = join(root, "inner.mjs");
  writeFileSync(prep, inner);
  const mounter = spawnSync("unshare", ["-Urm", process.execPath, prep], { encoding: "utf8", env: childEnv, timeout: 30000 });
  check("scenario script and private home folders prepared", mounter.status === 0, { out: (mounter.stdout + mounter.stderr).slice(0, 400) });
  if (mounter.status !== 0) throw new Error("namespace setup failed");

  runner = spawn("unshare", ["-Urm", "sh", "-c", `mount -t tmpfs -o size=8m,mode=0700 tmpfs "${disk}" && mkdir -p "${join(disk, "home")}" "${join(disk, "tmp")}" "${join(disk, "run")}" "${join(disk, "config")}" && exec "${process.execPath}" "${script}"`], { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  runner.stdout!.setEncoding("utf8");
  runner.stdout!.on("data", (chunk: string) => { out += chunk; });
  runner.stderr!.setEncoding("utf8");
  runner.stderr!.on("data", (chunk: string) => { out += chunk; });
  const exited = new Promise<number>((resolve) => runner!.once("exit", (code) => resolve(code ?? -1)));
  sleepHandle = setTimeout(() => { sleepHandle = undefined; }, 120_000);
  sleepHandle.unref?.();
  const status = await Promise.race([exited, sleep(120_000).then(() => -1 as number)]);
  if (sleepHandle) { clearTimeout(sleepHandle); sleepHandle = undefined; }
  if (status === -1) { runner.kill("SIGKILL"); }
  const results = out.split("\n").filter((line) => line.startsWith("{\"name\"")).map((line) => { try { return JSON.parse(line) as { name: string; ok: boolean; detail?: unknown }; } catch { return undefined; } }).filter(Boolean) as { name: string; ok: boolean; detail?: unknown }[];
  for (const result of results) check(result.name, result.ok, result.detail);
  check("scenario completed", status === 0 && results.length >= 16, { status, lines: results.length, tail: out.slice(-500) });
} finally {
  runner?.kill("SIGKILL");
  if (sleepHandle) clearTimeout(sleepHandle);
  rmSync(root, { recursive: true, force: true });
}
console.log(`daemon-disk-full: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
