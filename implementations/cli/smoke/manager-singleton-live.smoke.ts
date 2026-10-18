/**
 * LIVE e2e for the MANAGER SINGLETON LEASE — the guarantee that exactly one manager serves a space.
 * The hermetic smokes can't reach this: it needs a real broker + two real `supervise` processes racing
 * for the same space. Asserts: (1) the manager `up` starts ACQUIRES the per-space lease and answers
 * control, (2) a SECOND `supervise` on that space REFUSES to start (fail loud, non-zero) instead of
 * becoming a co-manager that queue-splits control, (3) the incumbent is undisturbed by the refusal,
 * (4) a stop signalled while start is still running releases the lease even when that start fails.
 *
 * Open mode so no creds are needed (auth-mode manager + lease is covered by smoke:control-auth).
 * Sandboxes COTAL_HOME + a temp root; tears down via `cotal down` (never pkill). Needs `nats-server`
 * on PATH. Run: pnpm smoke:manager-singleton:live
 */
import { spawn, spawnSync } from "node:child_process";
import { createConnection, createServer, type AddressInfo, type Socket } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DiscardPolicy, jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import { connect } from "@nats-io/transport-node";
import { assertSmokeSandboxDown, recordSmokeSandbox } from "@cotal-ai/smoke-kit";

const PORT = 14322; // distinct from the other live smokes' fixed ports
const SERVER = `nats://127.0.0.1:${PORT}`;
const SPACE = "singleton-live";
const WT = resolve(import.meta.dirname, "..", "..", "..");
const CLI = join(WT, "bin", "cotal.ts");
const TSX = join(WT, "node_modules", ".bin", "tsx");
const TSX_LOADER = join(WT, "node_modules", "tsx", "dist", "loader.mjs");

const home = mkdtempSync(join(tmpdir(), "cotal-singleton-home-"));
const root = mkdtempSync(join(tmpdir(), "cotal-singleton-root-"));
const driftRoot = mkdtempSync(join(tmpdir(), "cotal-singleton-drift-"));
const configDir = join(home, "xdg");
const sandbox = recordSmokeSandbox({ root, cotalHome: home, xdgConfigHome: configDir });
const env = { ...process.env, COTAL_HOME: home, XDG_CONFIG_HOME: configDir, COTAL_SKIP_CONNECTOR_SEED: "1" };

let pass = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) throw new Error(`FAIL: ${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};
const cli = (...args: string[]) => {
  const options = { cwd: root, env, encoding: "utf8" as const };
  assertSmokeSandboxDown(sandbox, args, options);
  return spawnSync(TSX, [CLI, ...args], options);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const portOpen = (port: number) =>
  new Promise<boolean>((res) => {
    const s = createConnection({ host: "127.0.0.1", port }, () => { s.destroy(); res(true); });
    s.on("error", () => res(false));
    s.setTimeout(400, () => { s.destroy(); res(false); });
  });
const reachable = (r: { stdout: string; stderr: string }) => !/no responders|no manager reachable/i.test(r.stdout + r.stderr);

const base = join(root, "base.yaml");
writeFileSync(base, `apiVersion: cotal/v1
kind: Mesh
space: ${SPACE}
agent: claude
broker: { servers: "${SERVER}", auth: false }
channels:
  lobby: { description: "base" }
`);

try {
  // 0) up → broker + manager A, which must ACQUIRE the per-space singleton lease to serve.
  const up = cli("up", "-f", base, "--server", SERVER);
  ok("mesh up (manager A started)", /mesh "singleton-live" up/.test(up.stdout), up.stdout + up.stderr);
  await sleep(2000);
  ok("broker bound", await portOpen(PORT));

  // 1) manager A answers control — i.e. it acquired the lease (a crash on acquire would 'no responders').
  ok("manager A answers control (holds the lease)", reachable(cli("ps", "--space", SPACE, "--server", SERVER)));

  // 2) a SECOND supervise on the same space must REFUSE — the singleton point. It blocks if it (wrongly)
  //    starts, so cap it: a correct refusal exits fast non-zero; a wrong success is SIGTERM'd at the cap.
  const b = spawnSync(TSX, [CLI, "supervise", "--space", SPACE, "--server", SERVER, "--runtime", "pty"], {
    cwd: root, env, encoding: "utf8", timeout: 12_000,
  });
  const bOut = (b.stdout ?? "") + (b.stderr ?? "");
  ok("second manager REFUSES (exited, not timed-out)", b.status !== null && b.signal !== "SIGTERM", { status: b.status, signal: b.signal });
  ok("...non-zero", b.status !== 0, b.status);
  ok("...with a clear 'already serves' message", /already serves space/.test(bOut), bOut);

  // 3) the refusal didn't disturb the incumbent — A is still the one manager serving the space.
  ok("manager A still serving after the refusal", reachable(cli("ps", "--space", SPACE, "--server", SERVER)));

  // 4) #3997: start() takes the lease before it provisions the stores. A byte-preserving proxy parks
  //    the first EPJ create there while SIGTERM, SIGINT and SIGTERM land, and an EPC store made with
  //    allow_direct=false then makes start refuse. The refusal must still be reported, and only after
  //    the requested stop released the lease, so an immediate restart is not refused.
  const DRIFT = "singleton-drift";
  mkdirSync(join(driftRoot, ".cotal"));
  const driftEnv = { ...env, COTAL_HOME: join(driftRoot, "home"), XDG_CONFIG_HOME: join(driftRoot, "xdg") };
  let release!: () => void;
  let parked!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const reached = new Promise<void>((r) => (parked = r));
  let held = false;
  const sockets = new Set<Socket>();
  const proxy = createServer((client) => {
    const upstream = createConnection({ host: "127.0.0.1", port: PORT });
    sockets.add(client).add(upstream);
    let queue: Buffer[] | undefined;
    client.on("data", (b: Buffer) => {
      if (!held && b.includes(`$JS.API.STREAM.CREATE.EPJ_${DRIFT}`)) {
        held = true;
        queue = [];
        parked();
        void gate.then(() => { for (const q of queue ?? []) upstream.write(q); queue = undefined; });
      }
      if (queue) queue.push(b);
      else upstream.write(b);
    });
    upstream.on("data", (b: Buffer) => client.write(b));
    for (const [a, z] of [[client, upstream], [upstream, client]]) {
      a.on("error", () => z.destroy());
      a.on("close", () => z.destroy());
    }
  });
  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
  const proxyUrl = `nats://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  // Asynchronous on purpose: the proxy shares this process, and a blocking spawnSync would starve it.
  const cotal = (...args: string[]) => {
    const child = spawn(process.execPath, ["--import", TSX_LOADER, CLI, ...args], { cwd: driftRoot, env: driftEnv });
    let out = "";
    child.stdout.on("data", (b) => (out += b));
    child.stderr.on("data", (b) => (out += b));
    const exit = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
    return { child, exit, out: () => out };
  };
  const supervise = () => cotal("supervise", "--space", DRIFT, "--server", proxyUrl);
  const within = <T>(p: Promise<T>, what: string) =>
    Promise.race([p, sleep(30_000).then(() => { throw new Error(`timed out: ${what}`); })]);
  const nc = await connect({ servers: SERVER });
  let first: ReturnType<typeof supervise> | undefined;
  let again: ReturnType<typeof supervise> | undefined;
  try {
    const leaseHeld = async () => {
      const kv = await new Kvm(nc).open(`cotal_manager_${DRIFT}`);
      for await (const key of await kv.keys()) if ((await kv.get(key))?.operation === "PUT") return true;
      return false;
    };
    const add = cotal("meshes", "add", DRIFT, "--server", proxyUrl, "--mode", "open");
    ok("drift space registered", (await within(add.exit, "meshes add")) === 0, add.out());
    const jsm = await jetstreamManager(nc);
    await jsm.streams.add({
      name: `EPC_${DRIFT}`, subjects: [`cotal.${DRIFT}.epc.>`], allow_direct: false, deny_delete: true, deny_purge: true,
      max_msgs_per_subject: 1, discard: DiscardPolicy.New, discard_new_per_subject: true,
    });
    first = supervise();
    await within(reached, "start never sent the EPJ create");
    ok("start holds the lease while parked", await leaseHeld());
    for (const signal of ["SIGTERM", "SIGINT", "SIGTERM"] as const) {
      first.child.kill(signal);
      await sleep(150);
    }
    release();
    const code = await within(first.exit, "supervise did not exit");
    ok("start refusal still reported after the signals", /drifted shape/.test(first.out()), first.out());
    ok("...exit 1 without manager up", code === 1 && !/manager up/.test(first.out()), { code });
    ok("...lease released before exit", !(await leaseHeld()), first.out());
    const info = await jsm.streams.info(`EPC_${DRIFT}`);
    await jsm.streams.update(`EPC_${DRIFT}`, { ...info.config, allow_direct: true });
    again = supervise();
    const restarted = again;
    await within((async () => { while (!/manager up/.test(restarted.out()) && restarted.child.exitCode === null) await sleep(50); })(), "restart");
    ok("immediate restart after the repair is not refused", /manager up/.test(again.out()), again.out());
  } finally {
    for (const p of [first, again]) if (p && p.child.exitCode === null) { p.child.kill("SIGTERM"); await within(p.exit, "drift supervise stop").catch(() => p.child.kill("SIGKILL")); }
    await nc.close();
    for (const s of sockets) s.destroy();
    proxy.close();
  }

  console.log(`\nMANAGER-SINGLETON LIVE SMOKE OK ✅ (${pass} checks)`);
} finally {
  cli("down");
  await sleep(500);
  // Belt-and-suspenders: `down` should stop the broker; if it didn't, free the port SURGICALLY (by
  // port, never a broad pkill — a co-running broker on another port is untouched).
  if (await portOpen(PORT)) spawnSync("sh", ["-c", `lsof -tnP -iTCP:${PORT} -sTCP:LISTEN | xargs -r kill`]);
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
  rmSync(driftRoot, { recursive: true, force: true });
}
