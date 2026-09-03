/**
 * Focus-recall wildcard test (no test runner) — spins up its OWN nats-server and drives a MeshAgent
 * directly to verify the #977 fix: a channel reachable only through a wildcard subscription
 * (`team.>`) is not silently unrecallable. `recallAmbient` iterates `joinedChannels()`, and a
 * wildcard entry is not a concrete channel it can replay per-channel, so before the fix it was
 * `continue`d out of the loop with nothing added to `droppedChannels` — the same "recall returns
 * empty AND says nothing was dropped" shape as a replay=off channel, just from a different cause.
 *   - ambient + an @-mention on a channel joined only via `team.>`: ack-dropped at ingest like any
 *     other focus-mode channel traffic (mention still wakes);
 *   - recallAmbient: cannot return that traffic (replay is per-concrete-channel; a wildcard join has
 *     no single policy to honor it under) and now REPORTS `team.>` in `droppedChannels` instead of
 *     silently omitting it;
 *   - a concretely-joined, replay=on channel in the SAME focus session is unaffected: it recalls
 *     normally and is never named in `droppedChannels` (the fix must not become "always report
 *     everything").
 * Run: pnpm smoke:focus-recall-wildcard
 */
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CotalEndpoint, seedChannelRegistry, isReachable, mintLifecycleUid } from "@cotal-ai/core";
import { MeshAgent } from "../src/agent.js";
import type { AgentConfig } from "../src/config.js";
import type { InboxItem } from "../src/agent.js";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

const PORT = await pickFreePort();
const servers = `nats://127.0.0.1:${PORT}`;
const space = "focusrecallwild";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const awaitExit = (proc: ReturnType<typeof spawn>, timeoutMs = 3000): Promise<void> =>
  new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    proc.once("exit", () => resolve());
    setTimeout(resolve, timeoutMs);
  });

const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const srv = spawn("nats-server", ["-js", "-p", String(PORT), "-sd", join(dir, "js")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, dir);
let pass = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, `${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

const cfg: AgentConfig = {
  space,
  name: "Otto",
  role: "generalist",
  servers,
  subscribe: ["general", "team.>"], // "general": concrete, replay=on; "team.>": wildcard join
  allowSubscribe: ["general", "team.>"],
  allowPublish: ["general", "team.x", "team.y"],
  kind: "agent",
  tls: false,
  id: "otto_agent",
  lifecycleUid: mintLifecycleUid(),
};

const agent = new MeshAgent(cfg);
agent.on("error", () => {});
const mentionWake: InboxItem[] = [];
agent.on("mention-wake", (i: InboxItem) => mentionWake.push(i));

// A plain endpoint that publishes ambient/mentions at the agent.
const pub = new CotalEndpoint({
  space,
  servers,
  card: { name: "Pubby", kind: "agent", id: "pubby" },
  channels: ["general", "team.x", "team.y"],
  lifecycleUid: mintLifecycleUid(),
});
pub.on("error", () => {});

try {
  for (let i = 0; i < 50; i++) { if (await isReachable(servers)) break; await sleep(200); }

  // Replay ON everywhere — isolates the wildcard-join gap from the separate replay=off gap
  // (already covered by attention.smoke.ts).
  await seedChannelRegistry({ servers, space, file: { defaults: { replay: true }, channels: {} } });

  await pub.start();
  agent.start();
  for (let i = 0; i < 50; i++) { if (agent.connected) break; await sleep(200); }
  check("agent connected", agent.connected === true);
  await sleep(300);

  await agent.setAttention("focus");
  check("attention is focus", agent.attention === "focus");

  // ---- ambient on a concrete sub-channel of the wildcard join: ack-dropped like any focus traffic ----
  await pub.multicast("wild-ambient", { channel: "team.x" });
  await sleep(400);
  check("focus ack-drops ambient on a wildcard-joined channel (not buffered)", agent.inboxCount() === 0);

  // ---- a mention on another concrete sub-channel of the same wildcard join: wakes, still dropped ----
  await pub.multicast("wild-mention", { channel: "team.y", mentions: ["otto"] });
  await sleep(400);
  check("focus @-mention on a wildcard-joined channel still wakes", mentionWake.length === 1 && mentionWake[0].text === "wild-mention");
  check("focus @-mention on a wildcard-joined channel is not buffered", agent.inboxCount() === 0);

  // ---- a concretely-joined, replay=on channel in the same session: unaffected control ----
  await pub.multicast("general-ambient", { channel: "general" });
  await sleep(400);

  // ---- recallAmbient: cannot replay the wildcard join, must say so; the control channel is fine ----
  const r = await agent.recallAmbient();
  const texts = r.items.map((i) => i.text);
  check("recall cannot return the wildcard-joined channel's ambient", !texts.includes("wild-ambient"));
  check("recall cannot return the wildcard-joined channel's mention", !texts.includes("wild-mention"));
  check("recall REPORTS the wildcard join as dropped, not silently", r.droppedChannels.includes("team.>"));
  check("recall still returns the concretely-joined control channel's ambient", texts.includes("general-ambient"));
  check("the control channel is never named as dropped", !r.droppedChannels.includes("general"));

  console.log(`\nFOCUS RECALL WILDCARD TESTS PASSED ✅  (${pass} checks)`);
  await agent.stop();
  await pub.stop();
} finally {
  srv.kill("SIGKILL");
  await awaitExit(srv);
  rmSync(dir, { recursive: true, force: true });
  releaseBroker(); // last: ownership is held until this teardown has actually finished
}
process.exit(0);
