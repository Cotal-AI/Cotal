/**
 * M5 drive: what an agent HOLDS at the moment it disconnects — the two items fm-orchestrator ruled
 * must be measured before the design note, because a named refusal cannot be specified for a
 * condition never observed.
 *
 *   Q1 IN-FLIGHT REPLY. `CotalEndpoint.requestControl` (endpoint.ts:1333-1344) issues
 *      `nc.request(..., {noMux: true, reply})` — a CONNECTION-SCOPED reply subject. What happens to
 *      an in-flight request when the connection is rebuilt underneath it?
 *   Q2 THE PRESENCE LEASE. `stop()` (endpoint.ts:1140-1147) sets status "offline" and publishes,
 *      inside a try/catch, as a best-effort graceful leave. Is the entry DELETED or merely marked?
 *      And what does an observer see when the marker never gets to publish (the crash case)?
 *
 * This measures the MECHANISM beneath any tool that awaits a manager reply (cotal_spawn's
 * askManager path), not the tool path itself — there is no manager in this probe, and I am not
 * claiming otherwise.
 *
 * REFUTATION CONDITIONS, stated before any result is cited:
 *   Q1 "a reconnect orphans an in-flight reply" is REFUTED if the request still resolves with the
 *      responder's answer after the rebuild. CONFIRMED if it rejects (timeout / no responders).
 *   Q2 "stop marks rather than deletes" is REFUTED if the observer's roster loses the entry
 *      entirely rather than showing it offline.
 * INVERSE CONTROL for Q1: the SAME request, same responder, same path, WITHOUT the reconnect must
 *   resolve — otherwise a rejection proves only that my responder is broken.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 34814;
const SERVER = `nats://127.0.0.1:${PORT}`;
if (SERVER.includes("broker.cotal.ai")) throw new Error("REFUSING: live broker");
if (!/^nats:\/\/127\.0\.0\.1:/.test(SERVER)) throw new Error("REFUSING: not loopback");
console.log(`[safety] target=${SERVER} — asserted not broker.cotal.ai, loopback only`);

const store = mkdtempSync(join(tmpdir(), "meshctl-m5-"));
writeFileSync(join(store, "nats.conf"), `port: ${PORT}\njetstream { store_dir: "${store}/js" }\n`);
const nats = spawn("nats-server", ["-c", join(store, "nats.conf")], { stdio: "ignore", detached: true });
const pgid = nats.pid!;

async function main() {
  const core = await import("@cotal-ai/core");
  const { isReachable, CotalEndpoint } = core as any;
  for (let i = 0; i < 60; i++) { if (await isReachable(SERVER)) break; await sleep(150); }

  const { MeshAgent } = await import("../../extensions/connector-core/src/agent.js");

  // ---- a responder that answers SLOWLY, on a plain connection (a test double, open mode) -------
  // NARROW subject on purpose: `ctl.delivery.<...>` shares the `ctl.` namespace
  // (subjects.ts:516-522), so a `cotal.>` responder hijacks the endpoint's own Plane-3 probes and
  // wedges startup. Found the hard way — the first run of this probe hung for three minutes.
  const { connect } = await import("@nats-io/transport-node");
  const responder = await connect({ servers: SERVER });
  let replyDelayMs = 0;
  void (async () => {
    const sub = responder.subscribe("cotal.meshctl-m5.ctl.probe-svc.>");
    for await (const m of sub) {
      if (!m.reply) continue;
      const d = replyDelayMs;
      void (async () => {
        await sleep(d);
        try { m.respond(JSON.stringify({ ok: true, answeredAfterMs: d })); } catch { /* conn gone */ }
      })();
    }
  })().catch(() => {});

  const cfg: any = {
    space: "meshctl-m5", name: "holder", role: "probe", kind: "agent", servers: SERVER,
    subscribe: ["general"], allowSubscribe: ["general"], allowPublish: ["general"], tls: false,
  };
  const agent = new MeshAgent(cfg);
  agent.start(300);
  for (let i = 0; i < 80 && !agent.connected; i++) await sleep(150);
  if (!agent.connected) throw new Error("did not connect");
  const ep: any = (agent as any).ep;

  // ---- Q1 INVERSE CONTROL: the same request, no reconnect --------------------------------------
  console.log("\n=== Q1 INVERSE CONTROL: in-flight request with NO reconnect ===");
  replyDelayMs = 600;
  let controlOk = false;
  try {
    const r = await ep.requestControl("probe-svc", { op: "noop" }, 5000);
    controlOk = true;
    console.log(`control request RESOLVED: ${JSON.stringify(r)}`);
  } catch (e) {
    console.log(`control request REJECTED: ${(e as Error).message}`);
  }
  console.log(`control arm ${controlOk ? "OK — the path works, so a rejection below means something" : "BROKEN — stop here, Q1 proves nothing"}`);

  // ---- Q1 THE MEASUREMENT: rebuild the connection while a request is in flight -----------------
  console.log("\n=== Q1: in-flight request, connection rebuilt underneath it ===");
  replyDelayMs = 1500;
  let outcome = "";
  const inFlight = ep.requestControl("probe-svc", { op: "noop" }, 5000)
    .then((r: any) => { outcome = `RESOLVED ${JSON.stringify(r)}`; })
    .catch((e: Error) => { outcome = `REJECTED ${e.message}`; });
  await sleep(300); // let the request go out and the reply sub bind
  console.log("triggering reconnect mid-flight…");
  const rr = await agent.reconnect();
  console.log(`reconnect -> ok=${rr.ok} :: ${rr.message}`);
  // Bounded observation. The request carried a 5000ms timeout, so 20s is 4x its own deadline: if it
  // has not settled by then it is not "slow", it is orphaned. Racing rather than awaiting, so the
  // result is an OBSERVATION with a stated bound and not an inference from a hung process.
  const WATCH_MS = 20_000;
  const watchdog = sleep(WATCH_MS).then(() => "WATCHDOG");
  const who = await Promise.race([inFlight.then(() => "SETTLED"), watchdog]);
  console.log(`in-flight request after ${WATCH_MS}ms: ${who}${who === "SETTLED" ? ` -> ${outcome}` : ""}`);
  console.log(`Q1 VERDICT: ${who === "WATCHDOG"
    ? `CONFIRMED, and WORSE than a rejection — the request neither resolved nor rejected within ${WATCH_MS}ms despite carrying its own 5000ms timeout. A rebuild tears down the connection the request's timeout timer lives on, so the caller HANGS FOREVER rather than getting a failure it could act on.`
    : outcome.startsWith("REJECTED")
      ? "CONFIRMED — a rebuild orphans the reply and the caller gets a failure it can act on"
      : "REFUTED — the reply survived the rebuild"}`);

  // ---- Q2 the presence lease ---------------------------------------------------------------
  console.log("\n=== Q2: what does the presence entry do on a graceful stop? ===");
  const obsCfg: any = { ...cfg, name: "observer", role: "supervisor" };
  const obs = new MeshAgent(obsCfg);
  obs.start(300);
  for (let i = 0; i < 80 && !obs.connected; i++) await sleep(150);
  await sleep(1200);
  const view = (tag: string) => {
    const r = obs.roster();
    console.log(`${tag} ${JSON.stringify(r.map((p: any) => ({ name: p.name ?? p.card?.name ?? p.id, status: p.status })))}`);
    return r;
  };
  view("[before-stop]");
  await agent.stop();
  await sleep(1500);
  const after = view("[after-stop]");
  const entry = after.find((p: any) => (p.name ?? p.card?.name) === "holder");
  console.log(`Q2 VERDICT: ${entry
    ? `MARKED not deleted — the entry survives with status="${entry.status}". The graceful marker is best-effort (endpoint.ts:1140-1147, inside try/catch): an agent that CRASHES never publishes it, so it stays at its last status until TTL.`
    : "DELETED — the entry is gone from the observer's view"}`);

  await obs.stop();
  await responder.drain().catch(() => {});
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
