/**
 * LIVE e2e for the launch readiness window (#159 B1): a REAL broker, a REAL in-process manager
 * (real pty runtime), and a spawned agent that deliberately takes ~7s to JOIN the mesh — past
 * requestControl's 5s op default, inside the manager's ~30s readiness backstop. The manager only
 * replies on the real outcome (the join), so each launch client must outlive it; before the fix
 * both doors here died client-side ("TIMEOUT") while the launch proceeded:
 *
 *  A. `MeshAgent.spawn` (connector-core — the MCP `cotal_spawn` door) → `start` op → real success
 *     reply arrives AFTER the 5s default would have given up.
 *  B. `launchAgent` (cli — `cotal spawn -f` onto a running mesh) → admin `launch` op → same.
 *
 * Open mode (authed control is covered by smoke:control-auth); COTAL_HOME sandboxed; kills only
 * the PIDs it spawns. Needs nats-server on PATH.
 * Run: pnpm smoke:readiness:live   (build first — imports @cotal-ai/* dist)
 */
import { spawn as spawnProc, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "cotal-readiness-home-"));
process.env.COTAL_HOME = home;

const { probeConnect, registry, CotalEndpoint, CONTROL_ADMIN } = await import("@cotal-ai/core");
const { recordMesh } = await import("@cotal-ai/workspace");
const { launchAgent, START_TIMEOUT_MS } = await import("@cotal-ai/cli");
const { MeshAgent, SPAWN_TIMEOUT_MS } = await import("@cotal-ai/connector-core");
const { Manager } = await import("@cotal-ai/manager");
import type { Connector } from "@cotal-ai/core";

let pass = 0;
const kids: ChildProcess[] = [];
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) throw new Error(`FAIL: ${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PORT = 14487;
const SERVER = `nats://127.0.0.1:${PORT}`;
const SPACE = "readiness-e2e";
// Past the 5s op default (what the old clients died at), inside the ~30s readiness backstop with
// room for a slow CI child boot. The join is the LOWER bound on the reply time, so a slow runner
// only moves the reply further past 5s — the safe direction.
const JOIN_DELAY_MS = 7_000;

const workspaceRoot = mkdtempSync(join(tmpdir(), "cotal-readiness-ws-"));
mkdirSync(join(workspaceRoot, ".cotal", "agents"), { recursive: true });
writeFileSync(
  join(workspaceRoot, ".cotal", "agents", "slowpoke.md"),
  "---\nname: slowpoke\nrole: sleeper\n---\nYou boot slowly.\n",
);

// The slow connector: a REAL child that sleeps JOIN_DELAY_MS, then joins presence under the
// manager-assigned id as a real endpoint — the readiness wait resolves "started" on that join.
const coreDist = join(import.meta.dirname, "..", "..", "packages", "core", "dist", "index.js");
const CHILD = [
  "const{pathToFileURL}=require('node:url');",
  "setTimeout(()=>{import(pathToFileURL(process.env.CORE_DIST).href).then(async({CotalEndpoint})=>{",
  "const ep=new CotalEndpoint({space:process.env.COTAL_SPACE,servers:process.env.COTAL_SERVERS,channels:[],consume:false,registerPresence:true,watchPresence:false,card:{id:process.env.COTAL_ID||undefined,name:process.env.COTAL_NAME,kind:'agent'}});",
  "ep.on('error',()=>{});await ep.start();",
  "setInterval(()=>{},1000);});},Number(process.env.JOIN_DELAY_MS));",
].join("");
const slowCon: Connector = {
  kind: "connector",
  name: "slow-e2e",
  requires: ["node"],
  buildLaunch: (o) => ({
    command: "node",
    args: ["-e", CHILD],
    env: {
      PATH: process.env.PATH ?? "",
      CORE_DIST: coreDist,
      JOIN_DELAY_MS: String(JOIN_DELAY_MS),
      COTAL_SPACE: o.space,
      COTAL_SERVERS: o.servers ?? "",
      COTAL_ID: o.id ?? "",
      COTAL_NAME: o.name,
    },
  }),
};
registry.register(slowCon);

let mgr: InstanceType<typeof Manager> | undefined;
let driver: InstanceType<typeof MeshAgent> | undefined;
let ep: InstanceType<typeof CotalEndpoint> | undefined;
try {
  const broker = spawnProc("nats-server", ["-a", "127.0.0.1", "-p", String(PORT), "-js", "-sd", mkdtempSync(join(tmpdir(), "cotal-readiness-js-"))], { stdio: "ignore" });
  kids.push(broker);
  for (let i = 0; i < 50; i++) {
    if ((await probeConnect(SERVER, { timeoutMs: 400 })).ok) break;
    await sleep(100);
  }
  recordMesh({ space: SPACE, server: SERVER, root: workspaceRoot, mode: "open", ts: new Date().toISOString() });

  mgr = new Manager({ space: SPACE, servers: SERVER, runtime: "pty", workspaceRoot });
  await mgr.start();

  // A — the MCP spawn door: MeshAgent.spawn against the real manager, real slow join.
  driver = new MeshAgent({ space: SPACE, name: "driver", servers: SERVER, subscribe: [], allowSubscribe: [], allowPublish: [] });
  driver.start();
  for (let i = 0; i < 100 && !driver.connected; i++) await sleep(100);
  ok("driver (MeshAgent) connected", driver.connected);
  {
    const t0 = Date.now();
    const reply = await driver.spawn("slowpoke", undefined, { agent: "slow-e2e" });
    const elapsed = Date.now() - t0;
    ok("MeshAgent.spawn succeeds on the REAL join outcome", reply.ok === true, reply);
    ok(`...which arrived past the old 5s default (${elapsed}ms, window ${SPAWN_TIMEOUT_MS}ms)`, elapsed > 5_000 && elapsed < SPAWN_TIMEOUT_MS, elapsed);
    ok("...and reports the spawned identity", (reply.data as { name?: string })?.name === "slowpoke", reply.data);
  }

  // B — the manifest launch door: `spawn -f`'s launchAgent against the same manager.
  const runId = "readiness01";
  mkdirSync(join(workspaceRoot, ".cotal", "run"), { recursive: true });
  writeFileSync(
    join(workspaceRoot, ".cotal", "run", `${runId}.json`),
    JSON.stringify({
      apiVersion: "cotal-launch/v1",
      space: SPACE,
      runId,
      agents: [{ name: "slowlaunch", agent: "slow-e2e", subscribe: [], allowSubscribe: [], allowPublish: [], hash: "abc123" }],
    }),
  );
  ep = new CotalEndpoint({
    space: SPACE,
    servers: SERVER,
    channels: [],
    consume: false,
    registerPresence: false,
    watchPresence: false,
    card: { name: "e2e-cli", kind: "endpoint" },
  });
  await ep.start();
  {
    const t0 = Date.now();
    const reply = await launchAgent(ep, runId, "slowlaunch");
    const elapsed = Date.now() - t0;
    ok("launchAgent succeeds on the REAL join outcome", reply.ok === true, reply);
    ok(`...which arrived past the old 5s default (${elapsed}ms, window ${START_TIMEOUT_MS}ms)`, elapsed > 5_000 && elapsed < START_TIMEOUT_MS, elapsed);
    ok("...and reports the spawned identity", (reply.data as { name?: string })?.name === "slowlaunch", reply.data);
  }

  // Tear the spawned keepalives down through the manager (they don't exit on broker loss).
  for (const name of ["slowpoke", "slowlaunch"]) {
    const stop = await ep.requestControl(CONTROL_ADMIN, { op: "stop", args: { name, graceful: false } });
    ok(`stop ${name} ok`, stop.ok === true, stop);
  }

  console.log(`\nreadiness-window live e2e: ${pass} checks passed`);
} finally {
  await ep?.stop().catch(() => {});
  await driver?.stop().catch(() => {});
  await mgr?.stop().catch(() => {});
  for (const k of kids) k.kill("SIGKILL");
}
