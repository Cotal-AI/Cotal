/** THE MEASUREMENT BEHIND THE SEVERITY CLAIM in Cotal #699, kept because no cell encodes it.
 *
 *  The suite proves the refusal. It does not prove what the request COST before the refusal existed,
 *  and that cost is why this is not a cosmetic input-validation fix: a single `?limit=abc` GET was
 *  not slow, it never finished, and it kept running after its caller had gone.
 *
 *  Run it against a build WITHOUT the fix to reproduce the defect:
 *    idle, no request in flight     0.02s of CPU in 5s   (0% of one core)
 *    while limit=abc is in flight   2.90s of CPU in 5s   (58%)
 *    5s after the caller gave up    2.67s of CPU in 5s   (53%)
 *    15s after the caller gave up   2.55s of CPU in 5s   (51%)
 *    after a VALID read completed   2.29s of CPU in 5s   (46%)
 *  and /api/meta still answering 200 throughout, which is why nothing announces it.
 *
 *  THE INSTRUMENT IS PART OF THE RESULT. `ps -o %cpu` on darwin is an average over the process
 *  LIFETIME, not an instantaneous rate. Read that way the process showed a 40.9% "idle" baseline and
 *  the numbers proved nothing. Consumed CPU SECONDS sampled over a fixed window, with an idle
 *  baseline before and a valid-read control after, is what distinguishes a busy moment from a busy
 *  history.
 *
 *  Not a suite and not registered: it measures a machine, and a cell that asserted a CPU share would
 *  be asserting this laptop. */
import { spawn, execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net, { type AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { CotalEndpoint, isReachable, newIdentity, setupSpaceStreams } from "@cotal-ai/core";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const freePort = async (): Promise<number> => new Promise((res) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => res(p)); });
});
/** `ps -o %cpu` on darwin is an average over the process LIFETIME, so it cannot tell a busy moment
 *  from a busy history. Consumed CPU SECONDS, sampled as a delta over a window, can. */
const cpuSecs = (pid: number): number => {
  try {
    const t = execSync(`ps -o time= -p ${pid}`).toString().trim();          // [dd-]hh:mm:ss(.ff)
    const parts = t.replace("-", ":").split(":").map(Number);
    return parts.reduce((acc, n) => acc * 60 + n, 0);
  } catch { return -1; }
};
const burn = async (pid: number, ms: number, label: string): Promise<void> => {
  const a = cpuSecs(pid); await wait(ms); const b = cpuSecs(pid);
  console.log(`   ${label}: ${(b - a).toFixed(2)}s of CPU in ${ms / 1000}s (${(((b - a) / (ms / 1000)) * 100).toFixed(0)}% of one core)`);
};
const PORT = await freePort(); const WEBP = await freePort();
const SERVER = `nats://127.0.0.1:${PORT}`; const SPACE = "probe652";
const store = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const broker = spawn("nats-server", ["-p", String(PORT), "-js", "-sd", store, "-a", "127.0.0.1"], { stdio: "ignore" });
const release = teardownOnSignal(broker, store);
let child: ReturnType<typeof spawn> | undefined;
const peers: CotalEndpoint[] = [];
try {
  let up = false;
  for (let i = 0; i < 80; i++) { if (await isReachable(SERVER)) { up = true; break; } await wait(150); }
  if (!up) throw new Error("nats-server did not start");
  await setupSpaceStreams({ servers: SERVER, space: SPACE });

  const names = ["ch0", "ch1"];
  const seed = new CotalEndpoint({ space: SPACE, servers: SERVER, channels: names, consume: false,
    registerPresence: false, card: { id: newIdentity().id, name: "seed", kind: "endpoint" } });
  seed.on("error", () => {}); await seed.start();
  for (let i = 0; i < 40; i++) await Promise.all(names.map((c) => seed.multicast(`m${i} ${"x".repeat(200)}`, { channel: c })));
  await seed.stop();

  // Real presence, the way a seat registers it, so the roster is not empty by construction.
  for (const [name, kind, role] of [["alpha", "agent", "engineer"], ["beta", "agent", "reviewer"], ["gamma", "endpoint", "operator"]] as const) {
    const ep = new CotalEndpoint({ space: SPACE, servers: SERVER, channels: ["ch0"], consume: false,
      registerPresence: true, card: { id: newIdentity().id, name, kind, role } });
    ep.on("error", () => {}); await ep.start(); peers.push(ep);
  }
  await wait(1500);

  const runWeb = fileURLToPath(new URL("./run-web.mts", import.meta.url));
  child = spawn(process.execPath, ["--import", "tsx", runWeb, "--space", SPACE, "--server", SERVER,
    "--port", String(WEBP), "--no-open"], { stdio: ["ignore", "pipe", "pipe"] });
  const log: string[] = [];
  child.stdout?.on("data", (d: Buffer) => log.push(d.toString()));
  child.stderr?.on("data", (d: Buffer) => log.push(d.toString()));
  const base = `http://127.0.0.1:${WEBP}`;
  for (let i = 0; i < 200; i++) { const r = await fetch(`${base}/api/meta`).catch(() => undefined); if (r?.ok) break; await wait(250); }
  const pid = child.pid!;

  console.log(`1. IS THE NaN READ UNBOUNDED, OR ONLY SLOW?`);
  await burn(pid, 5000, "idle, no request in flight   ");
  const ac = new AbortController();
  const t0 = Date.now();
  const inflight = fetch(`${base}/api/channels/ch0/history?limit=abc`, { signal: ac.signal })
    .then(() => `answered in ${Date.now() - t0}ms`).catch((e) => `${(e as Error).name} after ${Date.now() - t0}ms`);
  await burn(pid, 5000, "while limit=abc is in flight  ");
  ac.abort();
  console.log(`   caller gone: ${await inflight}`);
  await burn(pid, 5000, "5s after the caller gave up   ");
  await burn(pid, 5000, "15s after the caller gave up  ");
  // A control: the SAME route with a valid limit, so "busy" is attributable to NaN and not to the route.
  await fetch(`${base}/api/channels/ch0/history?limit=5`).then((r) => r.text());
  await burn(pid, 5000, "after a VALID read completed  ");
  const still = await fetch(`${base}/api/meta`).then((r) => r.status).catch(() => 0);
  console.log(`   server still serving other routes: /api/meta -> ${still}`);

} finally {
  for (const p of peers) await p.stop().catch(() => {});
  child?.kill("SIGKILL"); release(); broker.kill("SIGKILL"); rmSync(store, { recursive: true, force: true });
}
