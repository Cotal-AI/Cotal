/**
 * Agent-driven mesh connection control: `cotal_disconnect` / `cotal_connect`, driven through the
 * REAL entry point — `cotalToolSpecs(...).run(...)`, which is exactly what `registerCotalTools`
 * dispatches an MCP call to. Nothing here calls the endpoint directly except to build the fixture.
 *
 * The assertions that matter are made at the BROKER, through an INDEPENDENT OBSERVER peer: a
 * self-view roster is a report by the thing under test about itself. What a supervisor sees is the
 * property this feature exists to provide, so that is what gets asserted.
 *
 * REFUTATION CONDITIONS, stated before any result is cited:
 *  - The observable-departure claim is REFUTED if observer-B does not see the subject go offline
 *    after a self-disconnect, or sees it go offline WITHOUT the disconnect having been called.
 *  - The stickiness claim is REFUTED if the subject is back on the mesh after the self-heal's
 *    retry window elapses (C1 proves the connection was live, so the arms can differ).
 *  - Each named refusal is REFUTED if it returns a different reason, or returns success.
 *  - The grant gate is REFUTED if the verbs are visible without `capabilities: [connection]`,
 *    or ABSENT with it (G2 is the inverse control: if the verbs were missing for both arms the
 *    gate assertion would pass for the wrong reason).
 *
 * Run: node_modules/.bin/tsx extensions/connector-core/smoke/connection-control.smoke.ts
 * Needs `nats-server` on PATH. Local-only, loopback-only.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

// ---- FIRST ACTION: never the live broker, and never anything inherited -------------------------
// A manager-hosted seat exports COTAL_SERVERS=nats://broker.cotal.ai:4222 into every child it
// spawns, so a suite that defaults its target to the environment is pointed at PRODUCTION. Delete
// the inherited connection vars, then assert on the URL this suite ACTUALLY DIALS — asserting on an
// env var would be over-broad (it refuses on a variable it never reads) and under-powered (it would
// not catch a hardcoded live host).
for (const k of Object.keys(process.env)) if (/^COTAL_(SERVERS|CREDS|SPACE|NAME|ID|CONTROL_|LIFECYCLE)/.test(k)) delete process.env[k];

const pickFreePort = (): Promise<number> =>
  new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
  });

const PORT = await pickFreePort();
const SERVER = `nats://127.0.0.1:${PORT}`;
const LIVE = "broker.cotal.ai";
if (SERVER.includes(LIVE)) throw new Error(`REFUSING: ${SERVER} is the live broker`);
if (!/^nats:\/\/127\.0\.0\.1:\d+$/.test(SERVER)) throw new Error(`REFUSING: ${SERVER} is not loopback`);
console.log(`[safety] dialling ${SERVER} — asserted not ${LIVE}, loopback only; inherited COTAL_* deleted`);

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};

const store = mkdtempSync(join(tmpdir(), "meshctl-conn-"));
writeFileSync(join(store, "nats.conf"), `port: ${PORT}\njetstream { store_dir: "${store}/js" }\n`);
const nats = spawn("nats-server", ["-c", join(store, "nats.conf")], { stdio: "ignore", detached: true });
const pgid = nats.pid!;

const mk = (name: string, role: string) => ({
  space: "meshctl-conn", name, role, kind: "agent" as const, servers: SERVER,
  subscribe: ["general"], allowSubscribe: ["general"], allowPublish: ["general"], tls: false,
});

/** What an INDEPENDENT observer sees for `name` — never the subject's own view of itself. */
const seenBy = (B: any, name: string): { status?: string; activity?: string } | undefined => {
  const row = B.roster().find((p: any) => (p.name ?? p.card?.name) === name);
  return row ? { status: row.status, activity: row.activity } : undefined;
};

async function main() {
  const { isReachable } = await import("@cotal-ai/core");
  for (let i = 0; i < 80; i++) { if (await isReachable(SERVER)) break; await sleep(150); }

  const { MeshAgent } = await import("../src/agent.js");
  const { cotalToolSpecs } = await import("../src/tool-specs.js");

  const cfgA = mk("subject-a", "worker");
  const cfgB = mk("observer-b", "supervisor");
  const A = new MeshAgent(cfgA as any);
  const B = new MeshAgent(cfgB as any);
  // A short retry so the "the self-heal did not undo it" arm is a real wait, not a hopeful one.
  A.start(300); B.start(300);
  for (let i = 0; i < 90 && !(A.connected && B.connected); i++) await sleep(150);
  if (!(A.connected && B.connected)) throw new Error("fixture failed: agents did not both connect");
  await sleep(1200); // presence propagation

  // The REAL entry point: the same array `registerCotalTools` renders onto MCP.
  const specs = cotalToolSpecs(cfgA as any, "smoke");
  const run = async (tool: string, agent: any, cfg: any, args?: any) => {
    const spec = specs.find((s: any) => s.name === tool);
    if (!spec) throw new Error(`fixture failed: ${tool} is not on the tool surface`);
    return spec.run(agent, cfg, args);
  };

  console.log("\n=== the grant gate (tool-surface visibility) ===");
  // `creds` set = auth mode, where the capability is the gate. Both arms differ ONLY in capabilities.
  const gated = { ...mk("gated", "worker"), creds: "/nonexistent/agent.creds", capabilities: [] as string[] };
  const granted = { ...gated, capabilities: ["connection"] };
  const names = (c: any) => cotalToolSpecs(c as any, "smoke").map((s: any) => s.name);
  const ungrantedNames = names(gated);
  const grantedNames = names(granted);
  check("G1 without `capabilities: [connection]` the verbs are ABSENT from the surface",
    !ungrantedNames.includes("cotal_disconnect") && !ungrantedNames.includes("cotal_connect"), ungrantedNames);
  check("G2 CONTROL: with the grant they ARE present (so G1's arms could differ)",
    grantedNames.includes("cotal_disconnect") && grantedNames.includes("cotal_connect"), grantedNames);

  console.log("\n=== C1 CONTROL: a granted, connected agent disconnects itself ===");
  const before = seenBy(B, "subject-a");
  check("C1a CONTROL: observer-B sees subject-a PRESENT and not offline beforehand",
    !!before && before.status !== "offline", before);
  const d1 = await run("cotal_disconnect", A, cfgA, { cause: "going quiet on purpose" });
  check("C1b disconnect through the real tool SUCCEEDS", !d1.isError, d1.text);
  check("C1c it reports the departure, not a silent no-op", /Disconnected from "meshctl-conn"/.test(d1.text), d1.text);

  console.log("\n=== A1/A2 what the SUPERVISOR sees (asserted at the broker, via observer-B) ===");
  await sleep(1500);
  const after = seenBy(B, "subject-a");
  check("A1 observer-B sees subject-a OFFLINE — a deliberate departure is visible, not inferred from silence",
    after?.status === "offline", after);
  check("A2 the CAUSE travels with it — observer-B can see WHY, not merely THAT",
    !!after?.activity && after.activity.includes("going quiet on purpose"), after);

  console.log("\n=== A3 the disconnect STICKS: the self-heal must not undo a deliberate departure ===");
  await sleep(2500); // >> the 300ms retry window used above
  const later = seenBy(B, "subject-a");
  check("A3 still offline after the self-heal's retry window elapsed", later?.status === "offline", later);
  check("A3b and the agent itself agrees it is deliberately off", A.isSelfDisconnected() === true);
  // A3 and A3b are BOTH self-reported state — the presence record this endpoint writes, and its own
  // flag. Neither can tell "stayed off the mesh" apart from "came back and still reports offline",
  // which is precisely the ghost class this lane exists to close. Mutation testing caught that:
  // removing all three self-disconnect guards left A3/A3b green. So assert the CONNECTION itself,
  // and then assert it FUNCTIONALLY — a live subscription is the thing a stale record cannot fake.
  check("A3c the connection is actually DOWN, not merely reported down", A.connected === false);
  const dmTool = specs.find((s: any) => s.name === "cotal_dm")!;
  await dmTool.run(B, cfgB as any, { to: "subject-a", text: "PROBE-WHILE-DISCONNECTED" });
  await sleep(1200);
  const inboxTool = specs.find((s: any) => s.name === "cotal_inbox")!;
  const whileOff = await inboxTool.run(A, cfgA as any, { peek: true });
  check("A3d nothing is delivered live while disconnected (the functional arm)",
    !whileOff.text.includes("PROBE-WHILE-DISCONNECTED"), whileOff.text.slice(0, 200));

  console.log("\n=== named refusals (each asserted as THAT refusal) ===");
  const d2 = await run("cotal_disconnect", A, cfgA, {});
  check("R1 disconnecting again refuses as [not-connected]", d2.isError === true && d2.text.includes("[not-connected]"), d2.text);
  let reconnectErr = "";
  try { await A.reconnect(); } catch (e) { reconnectErr = (e as Error).message; }
  const rr = await run("cotal_reconnect", A, cfgA, {});
  check("R2 the RECOVERY path refuses to silently reverse a deliberate state, and names the verb that does",
    rr.isError === true && /connect\(\)/.test(rr.text), rr.text);

  console.log("\n=== C2 CONTROL (inverse): the agent brings ITSELF back through the same surface ===");
  const c1 = await run("cotal_connect", A, cfgA, {});
  check("C2a connect through the real tool SUCCEEDS", !c1.isError, c1.text);
  check("C2b it reports the space it returned to", /Connected to "meshctl-conn"/.test(c1.text), c1.text);
  await sleep(1500);
  const back = seenBy(B, "subject-a");
  check("C2c observer-B sees subject-a BACK (so A1's offline was the disconnect, not a dead fixture)",
    !!back && back.status !== "offline", back);

  const c2 = await run("cotal_connect", A, cfgA, {});
  check("R3 connecting again refuses as [already-connected]", c2.isError === true && c2.text.includes("[already-connected]"), c2.text);

  await A.stop();
  await B.stop();
  console.log(`\nCONNECTION-CONTROL SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
  if (fail) process.exitCode = 1;
}

main()
  .catch((e) => { console.error("SMOKE ERROR:", e); process.exitCode = 1; })
  .finally(async () => {
    try { process.kill(-pgid, "SIGTERM"); } catch { /* already gone */ }
    // Await the child's exit before deleting the scratch it is still writing into.
    for (let i = 0; i < 20 && nats.exitCode === null && nats.signalCode === null; i++) await sleep(100);
    try { rmSync(store, { recursive: true, force: true }); } catch { /* best effort */ }
    process.exit(process.exitCode ?? 0);
  });
