/**
 * A REFUSAL MUST REACH THE HOST AS A FAILURE — driven through OpenCode's REAL registered
 * `execute`, the exact function the host calls, not a helper this file can reach more conveniently.
 *
 * WHY THIS SUITE EXISTS. `renderOutcome` sets `isError: true` on every refusal, and this adapter
 * returns a string — so the flag had nowhere to go and was rendered as a `⚠` prefix on an ordinary,
 * RESOLVED value. Review measured it: a refusal carrying `isError: true` reached the adapter and
 * OpenCode resolved `"⚠ Refused [bind-failed]: …"`, which is a host-SUCCESS state. A caller
 * branching on tool outcome saw success, with no mistake of its own.
 *
 * REFUTATION CONDITIONS, stated before any result is cited:
 *  - The claim is REFUTED if the refusal arm RESOLVES (the adapter still flattens), or if the
 *    control arm REJECTS (this probe cannot tell a refusal from any other failure, so its
 *    rejections would mean nothing).
 *  - HR3 is the source-of-truth arm: if the shared spec did NOT flag the refusal, the adapter would
 *    be reporting faithfully and the finding would belong one layer down instead.
 *
 * Run: node_modules/.bin/tsx extensions/connector-opencode/smoke/host-refusal.smoke.ts
 * Needs `nats-server` on PATH. Local-only, loopback-only.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { isReachable } from "@cotal-ai/core";
import { MeshAgent, cotalToolSpecs } from "@cotal-ai/connector-core";
import { buildCotalTools } from "../src/tools.js";

// FIRST ACTION: never the live broker, and never anything inherited from a managed seat.
for (const k of Object.keys(process.env)) if (k.startsWith("COTAL_")) delete process.env[k];

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
if (SERVER.includes("broker.cotal.ai")) throw new Error(`REFUSING: ${SERVER} is the live broker`);
if (!/^nats:\/\/127\.0\.0\.1:\d+$/.test(SERVER)) throw new Error(`REFUSING: ${SERVER} is not loopback`);
console.log(`[safety] dialling ${SERVER} — asserted not broker.cotal.ai, loopback only; inherited COTAL_* deleted`);

let pass = 0, fail = 0;
const ran: string[] = [];
const check = (name: string, cond: boolean, extra?: unknown) => {
  ran.push(name);
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};
const DECLARED = ["HR-ctl", "HR1", "HR2", "HR3"];
const rollCall = () => {
  const hit = (ids: string[], n: string) => ids.some((id) => n === id || n.startsWith(`${id} `));
  const evaluated = DECLARED.filter((id) => ran.some((n) => n === id || n.startsWith(`${id} `)));
  const missing = DECLARED.filter((id) => !evaluated.includes(id));
  const undeclared = ran.filter((n) => !hit(DECLARED, n));
  console.log(`\n  ROLL CALL: ${DECLARED.length} declared — ${evaluated.length} EVALUATED, ${missing.length} NEVER RAN.`);
  if (missing.length) { console.log(`  ⚠ NEVER RAN: ${missing.join(", ")}`); process.exitCode = 1; }
  if (undeclared.length) { console.log(`  ⚠ UNDECLARED: ${undeclared.join(" | ")}`); process.exitCode = 1; }
  if (!missing.length && !undeclared.length) console.log(`  ✓ all ${DECLARED.length} declared cells were EVALUATED.`);
};

const store = mkdtempSync(join(tmpdir(), "cotal-hostrefusal-"));
writeFileSync(join(store, "nats.conf"), `port: ${PORT}\njetstream { store_dir: "${store}/js" }\n`);
const nats = spawn("nats-server", ["-c", join(store, "nats.conf")], { stdio: "ignore", detached: true });
const pgid = nats.pid!;

const cfg = {
  space: "ochostrefusal", name: "subject", role: "worker", kind: "agent" as const, servers: SERVER,
  subscribe: ["general"], allowSubscribe: ["general"], allowPublish: ["general"], tls: false,
  capabilities: ["connection"],
};

async function main() {
  for (let i = 0; i < 80; i++) { if (await isReachable(SERVER)) break; await sleep(150); }
  const agent = new MeshAgent(cfg as any);
  agent.start(300);
  for (let i = 0; i < 90 && !agent.connected; i++) await sleep(150);
  if (!agent.connected) throw new Error("fixture failed: the agent did not connect");

  // THE REAL ENTRY POINT: the same map `cotal()` hands OpenCode, and the same `execute` the host
  // invokes on a tool call. Nothing here calls the shared spec directly except HR3, which exists
  // precisely to show what the adapter was given.
  const tools = buildCotalTools(agent as any, cfg as any);
  const call = async (name: string, args: unknown = {}) =>
    (tools[name] as any).execute(args).then((v: string) => ({ state: "resolved" as const, value: v }),
      (e: Error) => ({ state: "rejected" as const, error: e }));

  // CONTROL FIRST, and it is a real one: the same tool, the same registered `execute`, on a session
  // where the verb SUCCEEDS. Without it a rejection below is equally explained by a probe that
  // cannot call this adapter at all.
  const first = await call("cotal_disconnect", {});
  check("HR-ctl CONTROL: a SUCCEEDING verb resolves through OpenCode's real registered execute (so HR1's arms can differ)",
    first.state === "resolved" && /Disconnected from/.test((first as any).value ?? ""), first);

  // Now a REAL refusal from the shared spec — disconnecting an already-disconnected session — with
  // nothing faked: the same agent, the same tool, the same execute.
  const second = await call("cotal_disconnect", {});
  check("HR1 a REFUSAL rejects rather than resolving — a resolved warning string is a host-SUCCESS state, and the host has no other failure channel",
    second.state === "rejected", second);
  check("HR2 and the rejection still carries the named condition, so nothing a caller could act on is lost in the throw",
    second.state === "rejected" && /\[not-connected\]/.test((second as any).error?.message ?? ""),
    (second as any).error?.message);

  // THE SOURCE-OF-TRUTH ARM. If the shared spec had not flagged this, the adapter would have been
  // reporting faithfully and the defect would live one layer down. It did flag it — so what changed
  // here is the adapter, and this cell is what makes that attributable rather than assumed.
  const spec = cotalToolSpecs(cfg as any, "opencode").find((s) => s.name === "cotal_disconnect")!;
  const raw = await spec.run(agent as any, cfg as any, {} as any);
  check("HR3 the shared spec DID flag it (isError at the boundary the adapter reads) — so the flattening was the adapter's, not the spec's",
    raw.isError === true && raw.outcome === "refused", raw);

  await agent.stop();
  if (fail) process.exitCode = 1;
}

main()
  .catch((e) => { console.error("SMOKE ERROR:", e); process.exitCode = 1; })
  .finally(async () => {
    rollCall();
    console.log(`\nOPENCODE HOST-REFUSAL ${fail === 0 && !process.exitCode ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
    try { process.kill(-pgid, "SIGTERM"); } catch { /* already gone */ }
    for (let i = 0; i < 20 && nats.exitCode === null && nats.signalCode === null; i++) await sleep(100);
    try { rmSync(store, { recursive: true, force: true }); } catch { /* best effort */ }
    process.exit(process.exitCode ?? 0);
  });
