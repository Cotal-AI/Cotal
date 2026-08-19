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
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** An ephemeral, collision-safe loopback port (ask the OS for a free one, then release it). */
const freePort = (): Promise<number> =>
  new Promise((res, rej) => {
    const s = createServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => res(p));
    });
  });
/** Resolve once the child has actually exited (or immediately if it already has); bounded by ms. */
const awaitExit = (p: ChildProcess, ms = 5000): Promise<void> =>
  new Promise((r) => {
    if (p.exitCode !== null || p.signalCode !== null) return r();
    p.once("exit", () => r());
    setTimeout(r, ms).unref?.();
  });

const home = mkdtempSync(join(tmpdir(), "cotal-readiness-home-"));
process.env.COTAL_HOME = home;

const { probeConnect, registry, CotalEndpoint } = await import("@cotal-ai/core");
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

const PORT = await freePort();
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
  "const ep=new CotalEndpoint({space:process.env.COTAL_SPACE,servers:process.env.COTAL_SERVERS,lifecycleUid:process.env.COTAL_LIFECYCLE_UID||undefined,channels:[],consume:false,registerPresence:true,watchPresence:false,card:{id:process.env.COTAL_ID||undefined,name:process.env.COTAL_NAME,kind:'agent'}});",
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
      COTAL_LIFECYCLE_UID: o.lifecycleUid ?? "",
      COTAL_NAME: o.name,
    },
  }),
};
registry.register(slowCon);

// The GHOST connector: a real child that stays alive and NEVER registers presence. This is the
// shape a connector whose boot outruns the readiness window presents to the manager (#605), and it
// is the only way to drive the `uncertain` backstop rather than the join or the exit.
const ghostCon: Connector = {
  kind: "connector",
  name: "ghost-e2e",
  requires: ["node"],
  buildLaunch: () => ({ command: "node", args: ["-e", "setInterval(()=>{},1000)"], env: { PATH: process.env.PATH ?? "" } }),
};
registry.register(ghostCon);

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
  driver = new MeshAgent({
    space: SPACE, name: "driver", servers: SERVER, kind: "agent", tls: false,
    subscribe: [], allowSubscribe: [], allowPublish: [],
  });
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

  // C. the UNCERTAIN backstop carries the MANAGER's guidance, not core's generic line (#605).
  //
  // WHY THIS CELL EXISTS. The backstop's operational value is entirely in its WORDS: it names the
  // agent and says INSPECT RATHER THAN RE-ISSUE. Before the fix the manager built exactly that
  // string and then dropped it: `onOutcome({kind:"uncertain"})` carried no payload and
  // `settleGoalUncertain` had no parameter to carry one, so the terminal committed core's generic
  // "the success signal did not arrive within the readiness deadline". That reads as a plain
  // failure, which is what teaches an operator to retry, and a retry after a launch that actually
  // SUCCEEDED mints a duplicate agent (#605 records one, driving a shared working tree).
  //
  // WHAT IT WOULD HAVE CAUGHT, AND WHAT IT WOULD NOT. The verdict was always DELIVERED and always
  // on time, measured here, and it is why the assertion below on elapsed time is a real check and
  // not decoration. The defect was never a lost message; it was a lost SENTENCE. A cell that only
  // asserted "a non-ok reply arrives" passes on the broken code, which is precisely why this one
  // asserts the guidance text.
  {
    const restore = (mgr as unknown as { readinessTimeoutMs: number }).readinessTimeoutMs;
    const SHORT_MS = 2_000;      // the window under test, shortened so the suite is not 30s long
    const CLIENT_MS = 12_000;    // the caller's own budget, deliberately well ABOVE the window, so
                                 // "returned near the window" cannot be satisfied by a client timeout
    (mgr as unknown as { readinessTimeoutMs: number }).readinessTimeoutMs = SHORT_MS;
    try {
      const ghostRun = "readiness02";
      writeFileSync(
        join(workspaceRoot, ".cotal", "run", `${ghostRun}.json`),
        JSON.stringify({
          apiVersion: "cotal-launch/v1",
          space: SPACE,
          runId: ghostRun,
          agents: [{ name: "ghost", agent: "ghost-e2e", subscribe: [], allowSubscribe: [], allowPublish: [], hash: "abc123" }],
        }),
      );
      const t0 = Date.now();
      const r = await ep.invokeService("manager", "launch", { runId: ghostRun, name: "ghost" }, { deadlineMs: CLIENT_MS, follow: true });
      const elapsed = Date.now() - t0;
      const msg = r.reply.error?.message ?? "";
      ok("a child that never joins settles the goal `uncertain`", r.reply.ok === false && r.reply.error?.code === "uncertain", r.reply);
      // The delivery half: the verdict rides the terminal at the WINDOW, not at the caller's bound.
      // If this ever fails at ~CLIENT_MS the defect is delivery, which is a different bug from the
      // wording one below; keep them separable.
      ok(`...delivered at the window, not the caller's deadline (${elapsed}ms, window ${SHORT_MS}ms, caller ${CLIENT_MS}ms)`, elapsed < SHORT_MS + 6_000, elapsed);
      // The wording half: THE ASSERTION THE FIX EXISTS FOR. Both halves of the guidance are named
      // explicitly: the diagnosis ("launch status uncertain") and the instruction ("Inspect with"),
      // which is the half that stops the duplicate.
      ok("...carrying the MANAGER's diagnosis, not core's generic line", msg.includes("launch status uncertain"), msg);
      ok("...and the instruction that prevents a duplicate re-issue", msg.includes("Inspect with"), msg);
      ok("...naming the agent it is about", msg.includes("ghost"), msg);
    } finally {
      (mgr as unknown as { readinessTimeoutMs: number }).readinessTimeoutMs = restore;
    }
  }

  // Tear the spawned keepalives down through the manager (they don't exit on broker loss):
  // inspect resolves the wire target, then the targeted ep despawn (the CLI's stop shape).
  for (const name of ["slowpoke", "slowlaunch", "ghost"]) {
    const info = await ep.invokeService("manager", "inspect", { name });
    ok(`inspect resolves ${name}`, info.reply.ok === true, info.reply);
    const row = info.reply.data as { id: string; lifecycleUid: string };
    // A static/open row's `id` is the bare actor under the caller's own owner; a user-mode row's
    // is the composite `owner.actor` — split only when the dot is there (the CLI's exact guard).
    const dot = row.id.indexOf(".");
    const [tOwner, tActor] = dot > 0 ? [row.id.slice(0, dot), row.id.slice(dot + 1)] : [ep.principal.owner, row.id];
    // Operator reach: this one-shot client is NOT the spawner, so owner-mode's spawner-bound
    // privileged semantics refuse it — the instrument rides ANY-mode (the CLI's non-bearer
    // `reach: "any"` shape; on an open mesh the serve side admits it as the old single-trusted-host).
    const stop = await ep.invokeService("manager", "despawn", { graceful: false }, {
      target: { mode: "any", owner: tOwner, actor: tActor, lifecycleUid: row.lifecycleUid },
    });
    ok(`stop ${name} ok`, stop.reply.ok === true, stop.reply);
  }

  console.log(`\nreadiness-window live e2e: ${pass} checks passed`);
} finally {
  await ep?.stop().catch(() => {});
  await driver?.stop().catch(() => {});
  await mgr?.stop().catch(() => {});
  await Promise.all(kids.map((k) => {
    k.kill("SIGKILL");
    return awaitExit(k);
  }));
}
