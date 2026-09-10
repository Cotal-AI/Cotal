/**
 * CONSOLE ATTACH smoke: the real console TUI under node-pty, attaching to a real pty seat through
 * the CLI's own attach loop, run in place. pnpm --filter @cotal-ai/cli smoke:console-attach (needs
 * nats-server + node; drives `bin/cotal.ts`, so the CLI's and the manager's dist must be built).
 *
 * The risky half of the console's `a` / `:attach` is the in-place Ink suspend and resume:
 *   1. `:attach echo` hands the terminal to the seat (its banner appears), typed bytes reach the
 *      child and echo back (Ink released stdin), Ctrl-] detaches, the console re-enters its
 *      alternate screen, the verdict notice shows, the status bar repaints, and `q` still quits 0.
 *   2. An invalid COTAL_DETACH_KEY stays a notice: the console is never suspended and never exits.
 *   3. `:ps` reaches the same manager (the scatter merge, on a one-manager space) and names the seat.
 *
 * The mesh is a static-auth one (an attach redeems its session grant from the space's local seed;
 * an open mesh holds none and refuses, on the command line and here alike), registered under a
 * sandboxed COTAL_HOME so the console resolves `--space` the way `cotal up` would have recorded it.
 *
 * The seat's supervisor is the manager itself, loaded from its built package: this package does
 * not depend on the manager (the binary composes the two), and a test-only dependency on it would
 * be a lockfile entry for one smoke. The manager's `@cotal-ai/core` is this process's `@cotal-ai/core`
 * (one workspace package, one real path), so the echo connector registered here is the one it launches.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createSpaceAuth, isReachable, mintCreds, newIdentity, registry, serverConfig, setupSpaceStreams, type Connector, type LaunchSpec, type SpaceAuth } from "@cotal-ai/core";
import { authDir, recordMesh, saveSpaceAuth } from "@cotal-ai/workspace";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { spawn } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import { ConsoleSession, clean, repoRoot, wait } from "./_console-pty.js";

let pass = 0, fail = 0;
const check = (n: string, c: boolean, extra?: unknown) => { if (c) { pass++; console.log("  ✓ " + n); } else { fail++; console.log("  ✗ FAIL: " + n, extra ?? ""); } };

interface ManagerLike {
  readinessTimeoutMs: number;
  start(): Promise<void>;
  stop(): Promise<void>;
  startAgent(o: Record<string, unknown>): Promise<{ ok: boolean; error?: string }>;
}
const { Manager } = (await import(pathToFileURL(join(repoRoot, "implementations", "manager", "dist", "index.js")).href)) as {
  Manager: new (o: { space: string; servers: string; runtime: string; workspaceRoot: string }) => ManagerLike;
};

const freePort = (): Promise<number> =>
  new Promise((res, rej) => {
    const s = createServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => res(p)); });
  });

/** A JWT-auth nats-server for `auth` on a free loopback port, owned until `stop`. */
async function bootBroker(auth: SpaceAuth, dir: string): Promise<{ servers: string; stop: () => Promise<void> }> {
  const port = await freePort();
  const servers = `nats://127.0.0.1:${port}`;
  writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port, storeDir: join(dir, "js") }));
  const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
  const release = teardownOnSignal(srv, dir);
  let up = false;
  for (let i = 0; i < 25 && srv.exitCode === null; i++) {
    if (await isReachable(servers)) { up = true; break; }
    await wait(200);
  }
  if (!up || srv.exitCode !== null) {
    srv.kill("SIGKILL");
    release();
    throw new Error(`nats-server did not come up on ${port}`);
  }
  return {
    servers,
    stop: async () => {
      srv.kill("SIGTERM");
      await wait(200);
      release();
    },
  };
}

// A trivial pty child: prints a banner, then echoes stdin. It never joins the mesh, so the spawn
// settles `uncertain` and the seat stays managed (attachable), which is all this needs.
const CHILD =
  "process.stdout.write('ATTACH-ECHO-READY\\r\\n'); process.stdin.setRawMode?.(true); " +
  "process.stdin.on('data', d => process.stdout.write(d)); setInterval(() => {}, 1e9);";
const echoCon: Connector = { kind: "connector", name: "echo", requires: ["node"], buildLaunch: (): LaunchSpec => ({ command: "node", args: ["-e", CHILD], env: { PATH: process.env.PATH ?? "" } }) };
registry.register(echoCon);

const space = `attachui-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const workspaceRoot = join(dir, "ws");
const home = join(dir, "home");
mkdirSync(join(workspaceRoot, ".cotal", "agents"), { recursive: true });
saveSpaceAuth(authDir(workspaceRoot), auth);
writeFileSync(join(workspaceRoot, ".cotal", "agents", "echo.md"), "---\nname: echo\nrole: worker\n---\n");
// SET BEFORE recordMesh: the registry is written under COTAL_HOME, and this suite must never touch ~/.cotal.
process.env.COTAL_HOME = home;
mkdirSync(home, { recursive: true });
const broker = await bootBroker(auth, dir);
recordMesh({ space, server: broker.servers, root: workspaceRoot, mode: "auth", ts: new Date().toISOString() });

const mgr = new Manager({ space, servers: broker.servers, runtime: "pty", workspaceRoot });
mgr.readinessTimeoutMs = 2500; // echo never joins; do not wait the full window
const consoleArgs = ["--space", space, "--server", broker.servers];

let session: ConsoleSession | undefined;
try {
  await setupSpaceStreams({ servers: broker.servers, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  await mgr.start();
  const r1 = await mgr.startAgent({ name: "echo", agent: "echo", cwd: repoRoot });
  check("fixture: the echo pty seat launched (uncertain readiness, kept managed)", r1.ok === false && /uncertain/i.test(String(r1.error)), r1);

  console.log("1. attach → type through → detach → repaint");
  session = new ConsoleSession(consoleArgs, home);
  check("console: the TUI paints the space status bar", await session.waitFor(`${space} · #`, 40_000), clean(session.out).slice(-400));
  const psFrom = session.out.length;
  await session.command("ps");
  check(":ps lists the echo seat", await session.waitFor("agents: echo", 30_000, psFrom), clean(session.out.slice(psFrom)).match(/(agents: |ps: )[^│\n]*/)?.[0] ?? clean(session.out.slice(psFrom)).slice(-300));
  await session.command("attach echo");
  check("attach: the console suspends and the seat's live screen streams in", await session.waitFor("ATTACH-ECHO-READY", 30_000), clean(session.out).slice(-600));
  const typedFrom = session.out.length;
  session.write("PING-4711");
  check("attach: typed input reaches the child pty and echoes back (Ink released stdin)", await session.waitFor("PING-4711", 10_000, typedFrom), clean(session.out.slice(typedFrom)).slice(-400));
  const detachFrom = session.out.length;
  session.write("\x1d"); // Ctrl-]
  check("detach: the console re-enters its alternate screen", await session.waitFor("\x1b[?1049h", 15_000, detachFrom), clean(session.out.slice(detachFrom)).slice(-400));
  check("detach: the verdict notice confirms it", await session.waitFor("detached from echo", 15_000, detachFrom), clean(session.out.slice(detachFrom)).slice(-400));
  check("detach: the status bar repaints", await session.waitFor(`${space} · #`, 10_000, detachFrom), clean(session.out.slice(detachFrom)).slice(-400));
  check("quit: the console exits cleanly after a full attach cycle", await session.quit(), session.exited);
  await session.close();

  console.log("2. an invalid COTAL_DETACH_KEY stays a notice; the console survives");
  session = new ConsoleSession(consoleArgs, home, { COTAL_DETACH_KEY: "bogus" });
  check("bad key: the TUI paints", await session.waitFor(`${space} · #`, 40_000), clean(session.out).slice(-400));
  const attach2From = session.out.length;
  await session.command("attach echo");
  check("bad key: the invalid COTAL_DETACH_KEY becomes a notice", await session.waitFor("invalid COTAL_DETACH_KEY", 10_000, attach2From), clean(session.out.slice(attach2From)).slice(-400));
  check("bad key: the console did NOT exit", session.exited === undefined, session.exited);
  check("bad key: it never suspended into the seat", !session.out.slice(attach2From).includes("ATTACH-ECHO-READY"));
  check("bad key: the console still quits cleanly on q", await session.quit(), session.exited);
} catch (e) {
  fail++;
  console.error("  ✗ scenario threw:", (e as Error).stack ?? (e as Error).message);
} finally {
  try { await session?.close(); } catch { /* down */ }
  try { await mgr.stop(); } catch { /* down */ }
  await broker.stop();
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? "CONSOLE-ATTACH SMOKE OK ✅" : "CONSOLE-ATTACH SMOKE FAILED ❌"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
