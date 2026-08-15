/**
 * A REFUSAL MUST REACH THE HOST AS A FAILURE — pi adapter.
 *
 * SCOPE, AND IT IS IN EVERY CELL NAME RATHER THAN ONLY HERE: this drives the adapter's REAL
 * registered `execute` — the exact function `registerCotalTools` hands pi — captured through a
 * stub `ExtensionAPI` that records what was registered. **The pi HOST is not run.** So these cells
 * are evidence about the adapter's contract and nothing at all about how pi presents a rejection.
 * A cell named as though it measured the host, that measured the function, is a false claim someone
 * will cite without opening the file.
 *
 * WHY IT MATTERS ANYWAY: pi's pinned SDK states that `execute` must throw on failure, so this is
 * conformance rather than a change of policy. Review measured the old behaviour — a refusal
 * carrying `isError: true` resolved as ordinary `{ content: [...] }`, a host-SUCCESS state.
 *
 * REFUTATION CONDITIONS, before any result is cited:
 *  - REFUTED if the refusal arm RESOLVES, or if the control arm REJECTS (then the probe cannot tell
 *    a refusal from any other failure and its rejections mean nothing).
 *  - REFUTED if the stub registers no tool named `cotal_disconnect` — the probe would be asserting
 *    against an empty registry, which is the shape of a test that passes by measuring nothing.
 *
 * Run: node_modules/.bin/tsx extensions/pi/smoke/host-refusal.smoke.ts
 * Needs `nats-server` on PATH. Local-only, loopback-only.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { isReachable } from "@cotal-ai/core";
import { MeshAgent } from "@cotal-ai/connector-core";
import { registerCotalTools } from "../src/tools.js";

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
const DECLARED = ["PR-reg", "PR-ctl", "PR1", "PR2"];
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

const store = mkdtempSync(join(tmpdir(), "cotal-pihostrefusal-"));
writeFileSync(join(store, "nats.conf"), `port: ${PORT}\njetstream { store_dir: "${store}/js" }\n`);
const nats = spawn("nats-server", ["-c", join(store, "nats.conf")], { stdio: "ignore", detached: true });
const pgid = nats.pid!;

const cfg = {
  space: "pihostrefusal", name: "subject", role: "worker", kind: "agent" as const, servers: SERVER,
  subscribe: ["general"], allowSubscribe: ["general"], allowPublish: ["general"], tls: false,
  capabilities: ["connection"],
};

async function main() {
  for (let i = 0; i < 80; i++) { if (await isReachable(SERVER)) break; await sleep(150); }
  const agent = new MeshAgent(cfg as any);
  agent.start(300);
  for (let i = 0; i < 90 && !agent.connected; i++) await sleep(150);
  if (!agent.connected) throw new Error("fixture failed: the agent did not connect");

  // The stub records what the adapter REGISTERS. The `execute` invoked below is the one pi itself
  // would be handed — this file never reimplements it.
  const registered = new Map<string, { execute(id: string, params: unknown): Promise<unknown> }>();
  registerCotalTools({ registerTool: (t: any) => registered.set(t.name, t) } as any, agent as any, cfg as any);
  check("PR-reg the adapter registered cotal_disconnect, so the cells below are asserting against a real registration and not an empty registry",
    registered.has("cotal_disconnect"), [...registered.keys()].length);

  const call = async (name: string, params: unknown = {}) =>
    registered.get(name)!.execute("probe", params).then(
      (v: unknown) => ({ state: "resolved" as const, value: v }),
      (e: Error) => ({ state: "rejected" as const, error: e }));

  const first = await call("cotal_disconnect", {});
  check("PR-ctl CONTROL: a SUCCEEDING verb resolves through the pi adapter FUNCTION (pi host not driven) — so PR1's arms can differ",
    first.state === "resolved", first);

  const second = await call("cotal_disconnect", {});
  check("PR1 a REFUSAL rejects through the pi adapter FUNCTION (pi host not driven) — the pinned SDK requires execute to throw on failure, and it was resolving ordinary content",
    second.state === "rejected", second);
  check("PR2 the rejection carries the named condition through the pi adapter FUNCTION (pi host not driven)",
    second.state === "rejected" && /\[not-connected\]/.test((second as any).error?.message ?? ""),
    (second as any).error?.message);

  await agent.stop();
  if (fail) process.exitCode = 1;
}

main()
  .catch((e) => { console.error("SMOKE ERROR:", e); process.exitCode = 1; })
  .finally(async () => {
    rollCall();
    console.log(`\nPI HOST-REFUSAL ${fail === 0 && !process.exitCode ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
    try { process.kill(-pgid, "SIGTERM"); } catch { /* already gone */ }
    for (let i = 0; i < 20 && nats.exitCode === null && nats.signalCode === null; i++) await sleep(100);
    try { rmSync(store, { recursive: true, force: true }); } catch { /* best effort */ }
    process.exit(process.exitCode ?? 0);
  });
