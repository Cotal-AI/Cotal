/**
 * M2/M3 drive: is cotal_join's ACL check a FENCE or a courtesy? The code comment at
 * tool-specs.ts:470-471 asserts "Auth mode also enforces this server-side; this is the friendly
 * client gate." M3 proved the auth-mode half at the broker (sub.allow denies out-of-ACL).
 * This measures the OPEN-mode half, where there is no broker ACL at all.
 *
 * REFUTATION CONDITION, stated first:
 *   The "client gate is the only fence in open mode" claim is REFUTED if bypassing the tool and
 *   calling the underlying agent.joinChannel() for an out-of-ACL channel FAILS anyway (something
 *   else would be enforcing). It is CONFIRMED if the tool refuses but the bypass succeeds.
 * INVERSE CONTROL: an IN-ACL join through the tool must succeed, or the refusal is a broken probe.
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

const PORT = 34813;
const SERVER = `nats://127.0.0.1:${PORT}`;
if (SERVER.includes("broker.cotal.ai")) throw new Error("REFUSING: live broker");
if (!/^nats:\/\/127\.0\.0\.1:/.test(SERVER)) throw new Error("REFUSING: not loopback");
console.log(`[safety] target=${SERVER} — asserted not broker.cotal.ai, loopback only`);

const store = mkdtempSync(join(tmpdir(), "meshctl-m2-"));
writeFileSync(join(store, "nats.conf"), `port: ${PORT}\njetstream { store_dir: "${store}/js" }\n`);
const nats = spawn("nats-server", ["-c", join(store, "nats.conf")], { stdio: "ignore", detached: true });
const pgid = nats.pid!;

async function main() {
  const { isReachable } = await import("@cotal-ai/core");
  for (let i = 0; i < 60; i++) { if (await isReachable(SERVER)) break; await sleep(150); }

  const { MeshAgent } = await import("./src/agent.js");
  const { cotalToolSpecs } = await import("./src/tool-specs.js");

  const cfg: any = {
    space: "meshctl-m2", name: "gate-probe", role: "probe", kind: "agent", servers: SERVER,
    subscribe: ["general"], allowSubscribe: ["general"], allowPublish: ["general"], tls: false,
  };
  const agent = new MeshAgent(cfg);
  agent.start(300);
  for (let i = 0; i < 80 && !agent.connected; i++) await sleep(150);
  if (!agent.connected) throw new Error("did not connect");

  const specs = cotalToolSpecs(cfg, "probe");
  const joinTool = specs.find((s: any) => s.name === "cotal_join")!;

  console.log("\n=== INVERSE CONTROL: in-ACL join through the tool ===");
  const inAcl = await joinTool.run(agent, cfg, { channel: "general" });
  console.log(`join(general) [in ACL] -> isError=${!!inAcl.isError} :: ${inAcl.text.split("\n")[0]}`);

  console.log("\n=== the gate: out-of-ACL join THROUGH THE TOOL ===");
  const denied = await joinTool.run(agent, cfg, { channel: "secret" });
  console.log(`join(secret) [out of ACL] -> isError=${!!denied.isError} :: ${denied.text}`);
  console.log(`joinedChannels=${JSON.stringify(agent.joinedChannels())}`);

  console.log("\n=== the bypass: same channel via the underlying agent method ===");
  let bypassed = false;
  try {
    const r = await agent.joinChannel("secret");
    bypassed = true;
    console.log(`agent.joinChannel(secret) -> ${JSON.stringify(r)}`);
  } catch (e) {
    console.log(`agent.joinChannel(secret) THREW: ${(e as Error).message}`);
  }
  console.log(`joinedChannels=${JSON.stringify(agent.joinedChannels())}`);
  console.log(`VERDICT: ${denied.isError && bypassed
    ? "CONFIRMED — in OPEN mode the tool's ACL check is the ONLY fence; the layer beneath it happily joins an out-of-ACL channel"
    : denied.isError && !bypassed
      ? "refuted — something beneath the tool also refuses"
      : "the tool did not even refuse — gate absent"}`);

  await agent.stop();
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
