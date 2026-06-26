import { parseArgs } from "node:util";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isReachable } from "@cotal-ai/core";
import { observe } from "./observe.js";

/**
 * `pnpm demo --n 5000` — the whole showcase in one command:
 *   1. a bare nats-server (JetStream on for presence KV, but NO message streams → zero persistence)
 *   2. the scale-safe observer + galaxy web page
 *   3. the swarm of N real endpoints, all communicating
 * Then prints the URL. Live-only, nothing touches disk except the throwaway store. Ctrl-C tears it all down.
 */

const here = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const { values } = parseArgs({ args: process.argv.slice(2).filter((a) => a !== "--"), options: {
    n: { type: "string" }, workers: { type: "string" }, rate: { type: "string" }, conc: { type: "string" },
    heartbeat: { type: "string" }, port: { type: "string" }, web: { type: "string" }, space: { type: "string" },
  } });
  const n = values.n ? Number(values.n) : 2000;
  const workers = values.workers ? Number(values.workers) : (n > 2500 ? Math.min(8, Math.ceil(n / 1500)) : 1);
  const rate = values.rate ? Number(values.rate) : 0.2; // per-agent msg rate (the observer handles it fine with a single viewer)
  const heartbeat = values.heartbeat ? Number(values.heartbeat) : (n >= 12000 ? 12000 : 4000); // longer heartbeats at huge n → far less presence churn on the broker + observer
  // keep total concurrent connects (conc × workers) well under the OS listen backlog (somaxconn ~128)
  const conc = values.conc ? Number(values.conc) : Math.max(16, Math.floor(256 / workers));
  const brokerPort = values.port ? Number(values.port) : 4733;
  const monPort = brokerPort + 1; // NATS HTTP monitoring (/varz) — the observer polls it for broker cpu/mem
  const webPort = values.web ? Number(values.web) : 7900;
  const space = values.space ?? "galaxy";
  const server = `nats://127.0.0.1:${brokerPort}`;

  // 1) bare broker — JetStream for presence KV only; no chat/dm/task streams are created, so messages
  //    are pure core pub/sub (fire-and-forget). Nothing is persisted. `-m` enables HTTP monitoring.
  const store = mkdtempSync(join(tmpdir(), "cotal-galaxy-"));
  const broker = spawn("nats-server", ["-js", "-sd", store, "-p", String(brokerPort), "-m", String(monPort), "-a", "127.0.0.1"], { stdio: "ignore" });
  broker.on("error", (e: NodeJS.ErrnoException) => {
    console.error(e.code === "ENOENT" ? "✗ nats-server not found on PATH (brew install nats-server)" : `✗ broker: ${e.message}`);
    process.exit(1);
  });
  for (let i = 0; i < 50 && !(await isReachable(server)); i++) await new Promise((r) => setTimeout(r, 200));
  if (!(await isReachable(server))) { console.error(`✗ broker never came up at ${server}`); process.exit(1); }
  console.log(`✓ broker at ${server} (live-only, no persistence)`);

  // 2) observer + galaxy page (in-process)
  await observe({ server, space, port: webPort, monUrl: `http://127.0.0.1:${monPort}` });

  // 3) swarm as a child process (keeps cluster sharding isolated from this orchestrator)
  const swarm = spawn(process.execPath, [
    ...process.execArgv, join(here, "swarm.ts"),
    "--server", server, "--space", space, "--n", String(n), "--workers", String(workers), "--rate", String(rate), "--conc", String(conc), "--heartbeat", String(heartbeat),
  ], { stdio: "inherit" });

  console.log(`\n  ★  ${n} endpoints (${workers} worker${workers > 1 ? "s" : ""}) → open  http://127.0.0.1:${webPort}/\n`);

  const stop = () => { try { swarm.kill("SIGTERM"); } catch {} try { broker.kill("SIGTERM"); } catch {} rmSync(store, { recursive: true, force: true }); process.exit(0); };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
}

void main();
