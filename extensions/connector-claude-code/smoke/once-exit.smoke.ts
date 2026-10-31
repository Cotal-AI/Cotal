/**
 * HOW A CLAUDE ONCE SEAT ENDS ITSELF.
 *
 * Claude's MCP server is a child of `claude`, so its once exit has to end its parent. It records
 * that parent at start only when the parent's executable is the file the launch named, and before
 * each signal it reads the pid's start token and executable again. It sends SIGTERM, then SIGKILL
 * if the same process is still there five seconds later. Anything it cannot prove (a wrapper, an
 * unreadable entry, an executable that changed) declines with no signal, and a pid now held by
 * another process is never signalled.
 *
 * Live: real child processes stand in for `claude`; every one is ended by its own pid. Linux only.
 * Run: pnpm smoke:claude-once-exit
 */
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOST_EXE_ENV, endHost, recordHost, resolveHostExe } from "../src/once-exit.js";

if (process.platform !== "linux") throw new Error("claude-once-exit reads /proc, which only Linux has");
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const node = realpathSync(process.execPath);
const children: ChildProcess[] = [];
/** A stand-in for `claude`: a node process that ends on SIGTERM, or ignores it. */
const host = async (ignoreTerm = false) => {
  const child = spawn(node, ["-e", `${ignoreTerm ? "process.on('SIGTERM', () => {});" : ""} process.stdout.write('up'); setInterval(() => {}, 1 << 30);`], { stdio: ["ignore", "pipe", "ignore"] });
  children.push(child);
  await new Promise<void>((r) => child.stdout!.once("data", () => r()));
  const exit = new Promise<NodeJS.Signals | null>((r) => child.once("exit", (_code, signal) => r(signal)));
  return { child, pid: child.pid!, exit };
};
const startOf = (pid: number) => { const stat = readFileSync(`/proc/${pid}/stat`, "utf8"); return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]!; };
const running = (c: ChildProcess) => c.exitCode === null && c.signalCode === null;
const dir = mkdtempSync(join(tmpdir(), "cotal-claude-once-exit-"));

try {
  console.log("1. the launch names the real file it starts");
  const bin = join(dir, "bin"); const other = join(dir, "other");
  for (const d of [bin, other]) mkdirSync(d);
  symlinkSync(node, join(bin, "claude"));
  writeFileSync(join(other, "claude"), "#!/bin/sh\n"); chmodSync(join(other, "claude"), 0o644);
  check("a bare name resolves on the launch's PATH, through a symlink, to the real file; a non-executable match and a relative entry are passed over",
    resolveHostExe("claude", { PATH: ["relative/bin", other, bin].join(":") }) === node, resolveHostExe("claude", { PATH: ["relative/bin", other, bin].join(":") }));
  check("...an absolute path resolves to its real file, and a name nothing matches answers nothing",
    resolveHostExe(join(bin, "claude"), {}) === node && resolveHostExe("claude", { PATH: other }) === undefined);

  console.log("\n2. the host is recorded only when its executable is the launched file");
  const a = await host();
  const recorded = recordHost({ [HOST_EXE_ENV]: node }, a.pid);
  check("a parent running the launched file is recorded with its start token", recorded?.pid === a.pid && recorded.exe === node && recorded.start === startOf(a.pid), recorded);
  check("a parent running another file, as a wrapper does, is not recorded, and nothing recorded declines",
    recordHost({ [HOST_EXE_ENV]: realpathSync("/bin/sh") }, a.pid) === undefined && recordHost({}, a.pid) === undefined && await endHost(undefined) === false && running(a.child));

  console.log("\n3. a host it cannot prove is declined, with no signal");
  check("a pid now held by another process (its start token changed) counts as the host gone, and is not signalled",
    await endHost({ pid: a.pid, start: "1", exe: node }) === true && (await wait(300), running(a.child)));
  check("a host whose executable is now another file is declined, and not signalled",
    await endHost({ pid: a.pid, start: startOf(a.pid), exe: "/usr/bin/claude-elsewhere" }) === false && (await wait(300), running(a.child)));
  // Pid 1's executable is unreadable to an unprivileged user. The path named can never match, so
  // even a privileged run reaches the same decline and never signals pid 1.
  check("a host whose executable cannot be read is declined", await endHost({ pid: 1, start: startOf(1), exe: "/nonexistent/cotal-claude" }) === false);

  console.log("\n4. the host is ended: SIGTERM, then SIGKILL when it is still the same process");
  const t0 = Date.now();
  const ended = await endHost(recorded);
  check("a host that ends on SIGTERM ends with it", ended === true && await a.exit === "SIGTERM" && Date.now() - t0 < 5_000, { ended, ms: Date.now() - t0 });
  const stubborn = await host(true);
  const t1 = Date.now();
  const killed = await endHost(recordHost({ [HOST_EXE_ENV]: node }, stubborn.pid));
  const lapse = Date.now() - t1;
  check("a host that ignores SIGTERM is killed five seconds later", killed === true && await stubborn.exit === "SIGKILL" && lapse >= 4_900 && lapse < 8_000, { killed, lapse });
} catch (e) {
  fail++;
  console.log("  ✗ FAIL: the suite threw before its last cell", e instanceof Error ? e.message : e);
} finally {
  for (const c of children) if (running(c)) { try { process.kill(c.pid!, "SIGKILL"); } catch { /* already gone */ } }
  rmSync(dir, { recursive: true, force: true });
}

const EXPECTED_CELLS = 9;
console.log(`\nonce-exit.smoke: ${pass} passed, ${fail} failed`);
if (pass + fail !== EXPECTED_CELLS) {
  console.log(`SUITE INCOMPLETE — ran ${pass + fail} of ${EXPECTED_CELLS} cells; a partial run is not a pass`);
  process.exitCode = 1;
} else process.exitCode = fail === 0 ? 0 : 1;
