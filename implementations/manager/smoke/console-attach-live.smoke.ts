/**
 * Console attach live smoke — run with: pnpm smoke:console-attach:live (needs nats-server + node;
 * the script chains `pnpm build` first because the console under test runs the BUILT dists).
 *
 * attach-control-live.smoke.ts guards the control-op half (admin mint → {ws}); this drives the
 * REAL console TUI under a pty through the risky half — the in-place Ink suspend/resume
 * (console/app.tsx): `:attach` must hand the terminal to the agent's live PTY (App→null releases
 * stdin so typed bytes reach the child), Ctrl-] must detach and repaint the console, and an
 * invalid COTAL_DETACH_KEY must stay a notice — never exit the console (the standalone-CLI
 * `process.exit` regression this file pins down).
 *
 * The tmux harness can't deliver the raw 0x1d detach byte; node-pty (already the pty runtime's
 * dependency) can, which is what makes this automatable at all.
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn as ptySpawn, type IPty } from "@lydell/node-pty";
import { isReachable, setupSpaceStreams, registry, type Connector, type LaunchSpec } from "@cotal-ai/core";
import { Manager } from "../src/manager.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const TSX = join(repoRoot, "node_modules", ".bin", "tsx");
const COTAL = join(repoRoot, "bin", "cotal.ts");
const PORT = 20000 + Math.floor(Math.random() * 40000);
const SERVERS = `nats://127.0.0.1:${PORT}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n: string, c: boolean, extra?: unknown) => { c ? (pass++, console.log("  ✓ " + n)) : (fail++, console.log("  ✗ FAIL: " + n, extra ?? "")); };

// A trivial pty child: prints a banner, then echoes stdin — a visible, typeable terminal. It never
// joins the mesh, so startAgent reports "uncertain" readiness but keeps it managed (attachable).
const CHILD =
  "process.stdout.write('ATTACH-ECHO-READY\\r\\n'); process.stdin.setRawMode?.(true); " +
  "process.stdin.on('data', d => process.stdout.write(d)); setInterval(() => {}, 1e9);";
const echoCon: Connector = {
  kind: "connector",
  name: "echo",
  requires: ["node"],
  buildLaunch: (): LaunchSpec => ({ command: "node", args: ["-e", CHILD], env: { PATH: process.env.PATH ?? "" } }),
};
registry.register(echoCon);

/** One console session under a real pty: cumulative output capture + a marker poll. */
class ConsoleSession {
  out = "";
  exited: { code: number } | undefined;
  private p: IPty;
  constructor(space: string, home: string, extraEnv: Record<string, string> = {}) {
    this.p = ptySpawn(TSX, [COTAL, "console", "--space", space, "--server", SERVERS], {
      name: "xterm-256color",
      cols: 120,
      rows: 32,
      cwd: repoRoot,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        TERM: "xterm-256color",
        COTAL_HOME: home,
        ...extraEnv,
      },
    });
    this.p.onData((d) => (this.out += d));
    this.p.onExit((e) => (this.exited = { code: e.exitCode }));
  }
  /** Poll the cumulative output (from `from`) for `marker`; false on timeout, never throws. */
  async waitFor(marker: string, timeoutMs: number, from = 0): Promise<boolean> {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (this.out.slice(from).includes(marker)) return true;
      if (this.exited) return this.out.slice(from).includes(marker);
      await wait(100);
    }
    return false;
  }
  write(s: string): void {
    this.p.write(s);
  }
  async close(): Promise<void> {
    if (this.exited) return;
    this.p.kill();
    for (let i = 0; i < 30 && !this.exited; i++) await wait(100);
  }
}

const space = `attachui-${randomUUID().slice(0, 8)}`;
const dir = mkdtempSync(join(tmpdir(), "cotal-console-attach-"));
const workspaceRoot = join(dir, "ws");
const home = join(dir, "home");
mkdirSync(join(workspaceRoot, ".cotal", "agents"), { recursive: true });
writeFileSync(join(workspaceRoot, ".cotal", "agents", "echo.md"), "---\nname: echo\nrole: worker\n---\n");
// Sandboxed registry (COTAL_HOME): the console resolves `--space` through it — an open-mode entry
// pointing at our broker, exactly what `cotal up` would have recorded. Never touches ~/.cotal.
mkdirSync(join(home, "meshes"), { recursive: true });
writeFileSync(
  join(home, "meshes", `${space}.json`),
  JSON.stringify({ space, server: SERVERS, root: workspaceRoot, mode: "open", ts: new Date().toISOString() }),
);
const srv = spawn("nats-server", ["-js", "-p", String(PORT), "-sd", join(dir, "js")], { stdio: "ignore" });

const mgr = new Manager({ space, servers: SERVERS, runtime: "pty", workspaceRoot });
(mgr as unknown as { readinessTimeoutMs: number }).readinessTimeoutMs = 2500; // echo never mesh-joins — don't wait the full window

let session: ConsoleSession | undefined;
try {
  let up = false;
  for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`nats-server did not come up on ${PORT}`);
  await setupSpaceStreams({ servers: SERVERS, space });
  await mgr.start();

  const r1 = await mgr.startAgent({ name: "echo", agent: "echo", cwd: repoRoot });
  check("spawn: echo pty agent launched (uncertain readiness, kept managed)", r1.ok === false && /uncertain/i.test(String(r1.error)), r1);

  // — Scenario 1: attach → type through → detach → repaint —
  session = new ConsoleSession(space, home);
  check("console: TUI paints the space status bar", await session.waitFor(`${space} · #`, 30_000), session.out.slice(-400));

  session.write(":");
  await wait(400); // let the palette open before typing into it (one pty chunk could outrun Ink's per-key handling)
  session.write("attach echo");
  await wait(200);
  session.write("\r");
  check("attach: console suspends and streams the agent's live screen", await session.waitFor("ATTACH-ECHO-READY", 15_000), session.out.slice(-400));

  const typedFrom = session.out.length;
  session.write("PING-4711");
  check("attach: typed input reaches the child pty and echoes back (Ink released stdin)", await session.waitFor("PING-4711", 10_000, typedFrom), session.out.slice(typedFrom).slice(-400));

  const detachFrom = session.out.length;
  session.write("\x1d"); // Ctrl-] — the detach byte tmux couldn't deliver
  const repainted = await session.waitFor("\x1b[?1049h", 10_000, detachFrom);
  check("detach: console re-enters its alt screen", repainted, session.out.slice(detachFrom).slice(-400));
  check("detach: notice confirms it", await session.waitFor("detached from echo", 10_000, detachFrom), session.out.slice(detachFrom).slice(-400));
  check("detach: status bar repaints", await session.waitFor(`${space} · #`, 10_000, detachFrom), session.out.slice(detachFrom).slice(-400));

  session.write("q");
  for (let i = 0; i < 50 && !session.exited; i++) await wait(100);
  check("quit: console exits cleanly after a full attach cycle", session.exited !== undefined && session.exited.code === 0, session.exited);
  await session.close();

  // — Scenario 2: invalid COTAL_DETACH_KEY stays a notice; the console survives —
  session = new ConsoleSession(space, home, { COTAL_DETACH_KEY: "bogus" });
  check("bad key: TUI paints", await session.waitFor(`${space} · #`, 30_000), session.out.slice(-400));

  const attach2From = session.out.length;
  session.write(":");
  await wait(400);
  session.write("attach echo");
  await wait(200);
  session.write("\r");
  check("bad key: invalid COTAL_DETACH_KEY becomes a notice", await session.waitFor("invalid COTAL_DETACH_KEY", 10_000, attach2From), session.out.slice(attach2From).slice(-400));
  check("bad key: console did NOT exit", session.exited === undefined, session.exited);
  check("bad key: never suspended into the agent", !session.out.slice(attach2From).includes("ATTACH-ECHO-READY"));

  session.write("q");
  for (let i = 0; i < 50 && !session.exited; i++) await wait(100);
  check("bad key: console still quits cleanly on q", session.exited !== undefined && session.exited.code === 0, session.exited);
} catch (e) {
  fail++;
  console.error("  ✗ scenario threw:", (e as Error).message);
} finally {
  try { await session?.close(); } catch { /* already down */ }
  try { await mgr.stop(); } catch { /* already down */ }
  srv.kill("SIGKILL");
  await new Promise<void>((res) => { if (srv.exitCode !== null || srv.signalCode !== null) return res(); srv.once("exit", () => res()); setTimeout(res, 3000); });
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? "CONSOLE-ATTACH SMOKE OK ✅" : "CONSOLE-ATTACH SMOKE FAILED ❌"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
