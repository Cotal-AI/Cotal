/**
 * M4 drive: what a SUPERVISOR sees when an agent takes itself off every channel, and what
 * remains reachable. Self-view roster is not evidence — this uses an INDEPENDENT observer peer.
 *
 * Questions:
 *   Q1 Does a peer's roster still show an agent that has left every channel?  (the ghost test)
 *   Q2 Is that agent still reachable by DM?  (i.e. is "leave all channels" a disconnect at all?)
 *   Q3 What does the observer see when the agent actually STOPS?  (the control: a real departure
 *      must look different from a self-silenced one, or "went dark" is indistinguishable.)
 *
 * REFUTATION CONDITION, stated before any result is cited:
 *   The ghost claim is REFUTED if, after A leaves every channel, B's roster drops A or marks it
 *   offline/departed. It is CONFIRMED if B still reports A present with a live status.
 *   Q3 is the inverse control: if B's roster ALSO fails to drop A after a clean stop(), then the
 *   roster is simply stale and Q1 proves nothing about self-silencing specifically.
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

const PORT = 34812;
const SERVER = `nats://127.0.0.1:${PORT}`;
const LIVE = "broker.cotal.ai";
if (SERVER.includes(LIVE)) throw new Error(`REFUSING: ${SERVER} is the live broker`);
if (!/^nats:\/\/127\.0\.0\.1:/.test(SERVER)) throw new Error(`REFUSING: ${SERVER} is not loopback`);
console.log(`[safety] target=${SERVER} — asserted not ${LIVE}, loopback only`);

const store = mkdtempSync(join(tmpdir(), "meshctl-m4-"));
writeFileSync(join(store, "nats.conf"), `port: ${PORT}\njetstream { store_dir: "${store}/js" }\n`);
const nats = spawn("nats-server", ["-c", join(store, "nats.conf")], { stdio: "ignore", detached: true });
const pgid = nats.pid!;
console.log(`[broker] pgid=${pgid}`);

const mk = (name: string, role: string) => ({
  space: "meshctl-m4", name, role, kind: "agent" as const, servers: SERVER,
  subscribe: ["general"], allowSubscribe: ["general"], allowPublish: ["general"], tls: false,
});

async function main() {
  const { isReachable } = await import("@cotal-ai/core");
  for (let i = 0; i < 60; i++) { if (await isReachable(SERVER)) break; await sleep(150); }

  const { MeshAgent } = await import("./src/agent.js");
  const { cotalToolSpecs } = await import("./src/tool-specs.js");

  const cfgA = mk("subject-a", "worker");
  const cfgB = mk("observer-b", "supervisor");
  const A = new MeshAgent(cfgA as any);
  const B = new MeshAgent(cfgB as any);
  A.start(300); B.start(300);
  for (let i = 0; i < 80 && !(A.connected && B.connected); i++) await sleep(150);
  if (!(A.connected && B.connected)) throw new Error("agents did not both connect");
  await sleep(1200); // let presence propagate to the observer

  const show = (tag: string) => {
    const r = B.roster();
    console.log(`${tag} observer-B roster = ${JSON.stringify(r.map((p: any) => ({
      name: p.name ?? p.card?.name, status: p.status, channels: p.channels ?? p.card?.channels,
    })))}`);
    return r;
  };

  console.log("\n=== baseline: both present ===");
  show("[baseline]");

  console.log("\n=== Q1: A leaves its ONLY channel (through the real tool) ===");
  const specs = cotalToolSpecs(cfgA as any, "probe");
  const leave = specs.find((s: any) => s.name === "cotal_leave")!;
  const lr = await leave.run(A, cfgA as any, { channel: "general" });
  console.log(`A: leave(general) -> isError=${!!lr.isError} :: ${lr.text}`);
  console.log(`A: joinedChannels=${JSON.stringify(A.joinedChannels())}  connected=${A.connected}`);
  await sleep(1500);
  const afterLeave = show("[after-leave]");
  const stillThere = afterLeave.some((p: any) => (p.name ?? p.card?.name) === "subject-a" && p.status !== "offline");
  console.log(`Q1 VERDICT: ${stillThere
    ? "GHOST CONFIRMED — B still reports subject-a present after it silenced itself on every channel"
    : "refuted — B dropped/marked-offline subject-a"}`);

  console.log("\n=== Q2: is the self-silenced agent still reachable by DM? ===");
  const dm = specs.find((s: any) => s.name === "cotal_dm")!;
  const dr = await dm.run(B, cfgB as any, { to: "subject-a", text: "ping after you left every channel" });
  console.log(`B: dm(subject-a) -> isError=${!!dr.isError} :: ${dr.text}`);
  await sleep(1200);
  const inbox = specs.find((s: any) => s.name === "cotal_inbox")!;
  const ir = await inbox.run(A, cfgA as any, { peek: true });
  console.log(`A: inbox(peek) -> ${ir.text.slice(0, 300)}`);
  console.log(`Q2 VERDICT: ${ir.text.includes("ping after you left")
    ? "DM STILL DELIVERED — leaving every channel is NOT a disconnect; the DM plane is untouched"
    : "DM did not arrive"}`);

  console.log("\n=== Q3 (inverse control): a REAL departure — A.stop() ===");
  await A.stop();
  await sleep(2000);
  const afterStop = show("[after-stop]");
  const goneAfterStop = !afterStop.some((p: any) => (p.name ?? p.card?.name) === "subject-a" && p.status !== "offline");
  console.log(`Q3 VERDICT: ${goneAfterStop
    ? "control HOLDS — a real stop IS visible to B, so Q1's ghost is specific to self-silencing, not a stale roster"
    : "control FAILS — B does not see a real stop either; the roster is stale generally and Q1 proves nothing specific"}`);

  await B.stop();
}

main()
  .catch((e) => { console.error("PROBE ERROR:", e); process.exitCode = 1; })
  .finally(async () => {
    try { process.kill(-pgid, "SIGTERM"); } catch { /* gone */ }
    await sleep(400);
    try { rmSync(store, { recursive: true, force: true }); } catch { /* best effort */ }
    console.log("[cleanup] broker group signalled, scratch removed");
    process.exit(process.exitCode ?? 0);
  });
