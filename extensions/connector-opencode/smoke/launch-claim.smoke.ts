/**
 * One launcher of an OpenCode agent name at a time (#3040). The launcher checked the serve records,
 * then probed `opencode --version` and spawned the serve, which recorded itself only then. Two
 * launches that overlapped both passed the check and both started a serve on the agent's SQLite
 * database. The launcher now claims the agent with core's advisory lock first.
 *
 * Drives the built `dist/serve.js` against a stub `opencode` whose version probe takes 1 s (the
 * window) and whose serve announces a session and waits. Headless, so no TUI is attached.
 *
 *  1. Two launches started together: exactly one is refused as already running, and one serve runs.
 *  2. Once that launcher stops, the next launch of the name comes up: the claim was released.
 *  3. A claim left by a launcher that died does not refuse the next launch.
 *
 * Run: pnpm smoke:opencode-launch-claim   (POSIX; needs the connector built)
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emitSentinel, skipSuite } from "@cotal-ai/smoke-kit";

if (process.platform === "win32") skipSuite("launch-claim drives a POSIX stub opencode");

let passed = 0, failed = 0;
async function check(name: string, run: () => Promise<void>): Promise<void> {
  try { await run(); passed++; console.log(`  ✓ ${name}`); }
  catch (error) { failed++; console.error(`  ✗ FAIL: ${name}`, error); }
}
function expect(cond: boolean, detail: unknown): void {
  if (!cond) throw new Error(JSON.stringify(detail));
}

const root = mkdtempSync(join(tmpdir(), "cotal-oc-claim-"));
const stub = join(root, "opencode");
writeFileSync(stub, `#!/bin/sh
case "$1" in
  --version) sleep 1; echo "1.2.3" ;;
  serve) echo "[cotal-session] stub-session"; trap 'kill $! 2>/dev/null; exit 0' TERM; sleep 600 & wait ;;
  *) exit 2 ;;
esac
`, { mode: 0o700 });
const serveJs = new URL("../dist/serve.js", import.meta.url).pathname;
const agentHome = join(root, ".cotal", "opencode", "probe");
const launchers: ChildProcess[] = [];

interface Launch { child: ChildProcess; out: () => string; exited: Promise<number | null> }
function launch(): Launch {
  const child = spawn(process.execPath, [serveJs], {
    env: { PATH: process.env.PATH, HOME: root, COTAL_NAME: "probe", COTAL_OPENCODE_HOME: root, COTAL_OPENCODE_BIN: stub, COTAL_SERVE_HEADLESS: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  launchers.push(child);
  let out = "";
  child.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
  child.stderr?.on("data", (d: Buffer) => { out += d.toString(); });
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  return { child, out: () => out, exited };
}
async function until(cond: () => boolean, ms: number): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) if (cond()) return true;
  return cond();
}
function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
/** The serve records in the agent's home whose process is alive. */
function liveServes(): number {
  if (!existsSync(agentHome)) return 0;
  return readdirSync(agentHome)
    .filter((f) => /^serve(?:\.[0-9a-f]{32})?\.pid$/.test(f))
    .filter((f) => alive(Number(readFileSync(join(agentHome, f), "utf8")))).length;
}
async function stop(l: Launch): Promise<void> {
  if (l.child.exitCode === null && l.child.signalCode === null) l.child.kill("SIGTERM");
  await l.exited;
}

try {
  await check("two launches of one name started together: one is refused, one serve runs", async () => {
    const a = launch(), b = launch();
    const settled = await until(() => (a.child.exitCode !== null) !== (b.child.exitCode !== null) && /\[cotal-serve\]/.test(a.out() + b.out()), 8_000);
    const refused = [a, b].filter((l) => l.child.exitCode === 1 && /already running/.test(l.out()));
    const serves = liveServes();
    const survivor = [a, b].find((l) => l.child.exitCode === null);
    expect(settled && refused.length === 1 && serves === 1 && survivor !== undefined, { settled, refused: refused.length, serves });
    await stop(survivor!);
  });

  await check("once that launcher stops, the next launch of the name comes up", async () => {
    const c = launch();
    const up = await until(() => /\[cotal-serve\]/.test(c.out()), 8_000);
    const serves = liveServes();
    await stop(c);
    expect(up && serves === 1, { up, serves, out: c.out().slice(0, 200) });
  });

  await check("a claim left by a launcher that died does not refuse the next launch", async () => {
    const gone = spawnSync(process.execPath, ["-e", ""]).pid;
    mkdirSync(agentHome, { recursive: true });
    writeFileSync(join(agentHome, "launch.lock"), `${JSON.stringify({ pid: gone, start: "0", nonce: "gone", ts: Date.now() })}\n`);
    const d = launch();
    const up = await until(() => /\[cotal-serve\]/.test(d.out()), 8_000);
    await stop(d);
    expect(up, { up, out: d.out().slice(0, 200) });
  });
} finally {
  // A launcher stops its serve on SIGTERM. A serve whose launcher is gone, which a red first cell
  // leaves, is stopped by the pid it recorded.
  for (const l of launchers) if (l.exitCode === null && l.signalCode === null) l.kill("SIGTERM");
  await until(() => launchers.every((l) => l.exitCode !== null || l.signalCode !== null), 8_000);
  if (existsSync(agentHome))
    for (const f of readdirSync(agentHome).filter((f) => /^serve(?:\.[0-9a-f]{32})?\.pid$/.test(f))) {
      const pid = Number(readFileSync(join(agentHome, f), "utf8"));
      if (alive(pid)) process.kill(pid, "SIGTERM");
    }
  for (const l of launchers) if (l.exitCode === null && l.signalCode === null) l.kill("SIGKILL");
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nopencode-launch-claim.smoke: ${passed} passed, ${failed} failed`);
emitSentinel({ passed, failed });
if (failed > 0 || passed !== 3) process.exitCode = 1;
