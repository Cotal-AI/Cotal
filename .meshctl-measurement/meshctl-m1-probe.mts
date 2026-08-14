/**
 * M1 drive: the two description claims on the connector's connection-changing verbs.
 *
 * Claim A (tool-specs.ts:503, cotal_leave description): "You can't leave your only channel."
 *   MeshAgent.leaveChannel jsdoc (agent.ts:1073) repeats it: "(refuses to leave the last one)".
 * Claim B (tool-specs.ts:728, cotal_reconnect): "Tear down and rebuild this session's mesh
 *   connection" — does it RE-RESOLVE a target (an accidental re-target primitive) or re-dial
 *   the pinned one?
 *
 * Driven through the REAL entry point: cotalToolSpecs(...).run(agent, config, args) is exactly
 * what registerCotalTools dispatches an MCP tool call to (tools.ts:29). Not the internal helper.
 *
 * REFUTATION CONDITION, stated before the result is cited:
 *   Claim A is UPHELD (and I am refuted) if the run() returns isError with a refusal naming the
 *   last-channel condition, AND joinedChannels() is unchanged afterwards.
 *   Claim A is FALSE if run() reports a successful leave and joinedChannels() goes empty.
 * INVERSE CONTROL: leaving a NON-last channel through the same path must succeed — otherwise a
 *   "refusal" I observe could just be a broken probe.
 *
 * NO BUILD-PROVENANCE REFUSAL HERE, DELIBERATELY — NOT AN OVERSIGHT. The connector suite refuses to
 * run when `packages/core/dist` is older than its source, because it is a standing suite someone
 * runs on a tired evening. This file is the RECORD OF A RUN, not a suite: it does not live where it
 * executes, and reproducing it is already a deliberate copy step (see RESULTS.md § Reproduction).
 * A guard on a file that cannot be run by accident guards nothing. Rebuild core first and record the
 * build time beside the result, as the re-derivation of `Fri Aug 14 08:53-08:55 PM UTC 2026` did.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 34811;
const SERVER = `nats://127.0.0.1:${PORT}`;

// ---- FIRST ACTION: assert we are not pointed at the live broker. -------------------------
const LIVE = "broker.cotal.ai";
if (SERVER.includes(LIVE)) throw new Error(`REFUSING: target ${SERVER} is the live broker`);
if (!/^nats:\/\/127\.0\.0\.1:/.test(SERVER)) throw new Error(`REFUSING: target ${SERVER} is not loopback`);
console.log(`[safety] target=${SERVER} — asserted not ${LIVE}, loopback only`);

const store = mkdtempSync(join(tmpdir(), "meshctl-m1-"));
const conf = join(store, "nats.conf");
writeFileSync(conf, `port: ${PORT}\njetstream { store_dir: "${store}/js" }\n`);

const nats = spawn("nats-server", ["-c", conf], { stdio: "ignore", detached: true });
const natsPgid = nats.pid!; // detached:true ⇒ child is its own process-group leader; signal -pgid.
console.log(`[broker] nats-server pid/pgid=${natsPgid} store=${store}`);

async function main() {
  // wait for listen
  for (let i = 0; i < 60; i++) {
    const { isReachable } = await import("@cotal-ai/core");
    if (await isReachable(SERVER)) break;
    await sleep(150);
  }

  const { MeshAgent } = await import("./src/agent.js");
  const { cotalToolSpecs } = await import("./src/tool-specs.js");

  const config: any = {
    space: "meshctl-probe",
    name: "probe-a",
    role: "probe",
    kind: "agent",
    servers: SERVER,
    subscribe: ["general"],
    allowSubscribe: ["general", "ops"],
    allowPublish: ["general"],
    tls: false,
  };

  const agent = new MeshAgent(config);
  agent.start(300);
  for (let i = 0; i < 80 && !agent.connected; i++) await sleep(150);
  if (!agent.connected) throw new Error("probe agent never connected");
  console.log(`[setup] connected. joinedChannels=${JSON.stringify(agent.joinedChannels())}`);

  const specs = cotalToolSpecs(config, "probe");
  const leave = specs.find((s: any) => s.name === "cotal_leave")!;
  const join = specs.find((s: any) => s.name === "cotal_join")!;
  const reconnect = specs.find((s: any) => s.name === "cotal_reconnect")!;

  // ---- INVERSE CONTROL first: the arms must be able to differ. ---------------------------
  // Join a second channel, then leave it (a NON-last leave). If this path is broken, any
  // "refusal" below is a broken probe, not a fence.
  console.log("\n=== INVERSE CONTROL: non-last leave through the same path ===");
  const jr = await join.run(agent, config, { channel: "ops" });
  console.log(`join(ops) -> isError=${!!jr.isError} :: ${jr.text.split("\n")[0]}`);
  console.log(`joinedChannels=${JSON.stringify(agent.joinedChannels())}`);
  const lr1 = await leave.run(agent, config, { channel: "ops" });
  console.log(`leave(ops) [NON-last] -> isError=${!!lr1.isError} :: ${lr1.text}`);
  console.log(`joinedChannels=${JSON.stringify(agent.joinedChannels())}`);

  // ---- THE MEASUREMENT: leave the ONLY remaining channel. --------------------------------
  console.log("\n=== CLAIM A: leave the only channel ===");
  const before = agent.joinedChannels();
  console.log(`before: joinedChannels=${JSON.stringify(before)} (count=${before.length})`);
  const lr2 = await leave.run(agent, config, { channel: "general" });
  console.log(`leave(general) [LAST] -> isError=${!!lr2.isError} :: ${lr2.text}`);
  const after = agent.joinedChannels();
  console.log(`after:  joinedChannels=${JSON.stringify(after)} (count=${after.length})`);
  console.log(
    `VERDICT-A: ${after.length === 0 && !lr2.isError
      ? "CLAIM FALSE — the agent left its only channel; description overstates a guard that does not exist"
      : "CLAIM UPHELD — refused"}`,
  );

  // ---- GHOST CHECK: is a channel-less agent still on the roster? --------------------------
  console.log("\n=== GHOST CHECK: presence after leaving everything ===");
  await sleep(800);
  const roster = agent.roster();
  console.log(`roster (self-view) = ${JSON.stringify(roster.map((p: any) => ({ name: p.name, status: p.status })))}`);
  console.log(`connected flag = ${agent.connected}`);

  // ---- CLAIM B: does reconnect re-target or re-seed channels? -----------------------------
  console.log("\n=== CLAIM B: reconnect semantics ===");
  console.log(`before reconnect: joinedChannels=${JSON.stringify(agent.joinedChannels())}`);
  const rr = await reconnect.run(agent, config, {});
  console.log(`reconnect -> isError=${!!rr.isError} :: ${rr.text}`);
  await sleep(600);
  console.log(`after reconnect:  joinedChannels=${JSON.stringify(agent.joinedChannels())}`);
  console.log(
    `VERDICT-B(re-seed): ${agent.joinedChannels().length === 0
      ? "leave SURVIVES reconnect (channel state is the mutated live array, not re-seeded from config)"
      : "reconnect RE-SEEDED channels from config — leave is undone by a reconnect"}`,
  );

  await agent.stop();
}

main()
  .catch((e) => { console.error("PROBE ERROR:", e); process.exitCode = 1; })
  .finally(async () => {
    try { process.kill(-natsPgid, "SIGTERM"); } catch { /* already gone */ }
    await sleep(400); // await the child's exit before deleting its scratch
    try { rmSync(store, { recursive: true, force: true }); } catch { /* best effort */ }
    console.log("[cleanup] broker group signalled, scratch removed");
    process.exit(process.exitCode ?? 0);
  });
