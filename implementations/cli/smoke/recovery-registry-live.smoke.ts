/**
 * LIVE regression proof for #756. `supervise` and `deliver` are recovery daemons, but they used
 * DEFAULT_SERVER after parsing their flags. A hand-registered remote/open mesh therefore had two
 * contradictory routes: read verbs dialled the recorded broker while recovery hit loopback :4222.
 *
 * This smoke creates a real non-default JetStream broker and registry record, then invokes the
 * REAL CLI entry points. It proves three externally observable properties:
 *  - `supervise --space` starts on the recorded broker (the original cut dialled :4222);
 *  - `deliver --space` reaches that same broker before its dev-mint trust refusal;
 *  - an offline recorded broker is named in supervise's refusal, never replaced by loopback.
 *
 * Run: pnpm smoke:recovery-registry:live
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createConnection, createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const WT = resolve(import.meta.dirname, "..", "..", "..");
const CLI = join(WT, "bin", "cotal.ts");
const TSX = join(WT, "node_modules", ".bin", "tsx");
const scratch = mkdtempSync(join(tmpdir(), "cotal-recovery-registry-"));
const home = join(scratch, "home");
const root = join(scratch, "root");
mkdirSync(home, { recursive: true });
mkdirSync(join(root, ".cotal"), { recursive: true });
const env = { ...process.env, COTAL_HOME: home, COTAL_SKIP_CONNECTOR_SEED: "1" };
const kids: ChildProcess[] = [];

let pass = 0;
const ok = (name: string, cond: boolean, detail?: unknown) => {
  if (!cond) throw new Error(`FAIL: ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  pass++;
  console.log(`  ✓ ${name}`);
};
const freePort = () => new Promise<number>((res, rej) => {
  const s = createServer();
  s.on("error", rej);
  s.listen(0, "127.0.0.1", () => {
    const port = (s.address() as AddressInfo).port;
    s.close(() => res(port));
  });
});
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
const cli = (args: string[], opts: { timeout?: number; cwd?: string } = {}) => spawnSync(TSX, [CLI, ...args], {
  cwd: opts.cwd ?? root, env, encoding: "utf8", timeout: opts.timeout,
});
const output = (r: ReturnType<typeof cli>) => `${r.stdout ?? ""}${r.stderr ?? ""}`;

async function waitReady(port: number) {
  for (let i = 0; i < 50; i++) {
    const connected = await new Promise<boolean>((res) => {
      const socket = createConnection({ host: "127.0.0.1", port }, () => { socket.destroy(); res(true); });
      socket.on("error", () => res(false));
      socket.setTimeout(200, () => { socket.destroy(); res(false); });
    });
    if (connected) return;
    await sleep(100);
  }
  throw new Error(`broker ${port} never came up`);
}

const port = await freePort();
const server = `nats://127.0.0.1:${port}`;
const space = "recovery-registry";

try {
  const broker = spawn("nats-server", ["-js", "-a", "127.0.0.1", "-p", String(port)], { stdio: "ignore" });
  kids.push(broker);
  await waitReady(port);
  const added = cli(["meshes", "add", space, "--server", server, "--root", root, "--mode", "open", "--force"]);
  ok("fixture: a live non-default broker is hand-registered", added.status === 0, output(added));

  // The original bug: this exited at :4222. With the fix it starts (then timeout terminates it).
  const supervise = cli(["supervise", "--space", space], { timeout: 8_000 });
  const superviseOut = output(supervise);
  ok("supervise dials the registered broker", (supervise.signal === "SIGTERM" || supervise.status === null || supervise.status === 0) && /✓ manager up/.test(superviseOut), { status: supervise.status, signal: supervise.signal, superviseOut });
  ok("supervise does not fall back to loopback", !superviseOut.includes("nats://127.0.0.1:4222"), superviseOut);

  // `--dev-mint` reaches resolution first, then correctly refuses because an open mesh has no
  // signer. The named trust error proves it did not choose DEFAULT_SERVER before that boundary.
  const deliver = cli(["deliver", "--space", space, "--dev-mint"]);
  const deliverOut = output(deliver);
  ok("deliver resolves the registered broker before its dev-mint check", deliver.status === 1 && /no \.cotal\/auth here to mint from/.test(deliverOut), deliverOut);
  ok("deliver does not fall back to loopback", !deliverOut.includes("nats://127.0.0.1:4222"), deliverOut);

  broker.kill("SIGTERM");
  await once(broker, "exit");
  const offline = cli(["supervise", "--space", space]);
  const offlineOut = output(offline);
  ok("offline registered broker refuses naming its recorded URL", offline.status === 1 && offlineOut.includes(`no broker answered at ${server}`), offlineOut);
  ok("offline registered broker never redirects to loopback", !offlineOut.includes("nats://127.0.0.1:4222"), offlineOut);

  console.log(`\nRECOVERY REGISTRY LIVE SMOKE OK (${pass} checks)`);
} finally {
  for (const child of kids) child.kill("SIGKILL");
  await Promise.all(kids.map((child) => child.exitCode === null && child.signalCode === null ? once(child, "exit") : undefined));
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5 });
}
