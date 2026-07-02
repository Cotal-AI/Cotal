/**
 * Auth-mode attention test (no test runner) — the open `attention.smoke.ts` flow under JWT auth.
 * Spins up its OWN JWT-auth nats-server, mints scoped creds for the focus agent (Otto) and the
 * publisher (Pubby), and proves the `focus` ingest ack-drop + replay-gated recall hold for an
 * agent holding ONLY the minted "agent" grants:
 *   - ambient on a replay channel: ack-dropped at ingest (not buffered, no "incoming");
 *   - a channel @-mention: wakes ("mention-wake") but is NOT buffered;
 *   - a DM: buffered (kind="dm") + "incoming";
 *   - recallAmbient: replays the ack-dropped ambient + mention from the replay=on channel as
 *     historical, and gates out the replay=off channel — all via the scoped agent's grants.
 * Run: pnpm smoke:attention:auth
 */
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CotalEndpoint,
  seedChannelRegistry,
  isReachable,
  createSpaceAuth,
  mintCreds,
  provisionAgent,
  serverConfig,
  newIdentity,
  setupSpaceStreams,
} from "@cotal-ai/core";
import { MeshAgent } from "../src/agent.js";
import type { AgentConfig } from "../src/config.js";
import type { InboxItem } from "../src/agent.js";

const PORT = 20000 + Math.floor(Math.random() * 40000);
const servers = `nats://127.0.0.1:${PORT}`;
const space = "attnsmoke-auth";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const awaitExit = (proc: ReturnType<typeof spawn>, timeoutMs = 3000): Promise<void> =>
  new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    proc.once("exit", () => resolve());
    setTimeout(resolve, timeoutMs);
  });

const dir = mkdtempSync(join(tmpdir(), "cotal-attn-auth-"));
const auth = await createSpaceAuth(space);
writeFileSync(join(dir, "server.conf"), serverConfig(auth, { port: PORT, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
let pass = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, `${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

try {
  for (let i = 0; i < 50; i++) {
    if (await isReachable(servers)) break;
    await sleep(200);
  }

  // Privileged setup: manager creds create streams + presence KV, seed the channel registry, and
  // provision the two peers' bind-only durables + scoped creds.
  const mgrCreds = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers, space, creds: mgrCreds });
  await seedChannelRegistry({
    servers,
    space,
    creds: mgrCreds,
    file: { defaults: { replay: false }, channels: { "open-ch": { replay: true }, "quiet-ch": { replay: false } } },
  });
  const mgr = new CotalEndpoint({
    space,
    servers,
    creds: mgrCreds,
    card: { name: "mgr", kind: "endpoint" },
    consume: false,
    registerPresence: false,
    watchPresence: false,
  });
  mgr.on("error", () => {});
  await mgr.start();

  const ottoId = newIdentity();
  const pubbyId = newIdentity();
  const chACL = { subscribe: ["open-ch", "quiet-ch"], allowSubscribe: ["open-ch", "quiet-ch"], allowPublish: ["open-ch", "quiet-ch"] };
  const ottoCreds = await provisionAgent(mgr, auth, ottoId, { ...chACL, role: "generalist" });
  const pubbyCreds = await provisionAgent(mgr, auth, pubbyId, { ...chACL });

  const cfg: AgentConfig = {
    space,
    name: "Otto",
    role: "generalist",
    servers,
    creds: ottoCreds,
    subscribe: ["open-ch", "quiet-ch"], // open-ch: replay=on; quiet-ch: replay=off
    allowSubscribe: ["open-ch", "quiet-ch"],
    allowPublish: ["open-ch", "quiet-ch"],
    kind: "agent",
    tls: false,
    id: ottoId.id,
  };

  const agent = new MeshAgent(cfg);
  agent.on("error", () => {});
  const incoming: InboxItem[] = [];
  const mentionWake: InboxItem[] = [];
  agent.on("incoming", (i: InboxItem) => incoming.push(i));
  agent.on("mention-wake", (i: InboxItem) => mentionWake.push(i));

  // A scoped endpoint that publishes ambient/mentions/DMs at the agent.
  const pub = new CotalEndpoint({
    space,
    servers,
    creds: pubbyCreds,
    card: { name: "Pubby", kind: "agent", id: pubbyId.id },
    channels: ["open-ch", "quiet-ch"],
  });
  pub.on("error", () => {});

  await pub.start();
  agent.start();
  for (let i = 0; i < 50; i++) {
    if (agent.connected) break;
    await sleep(200);
  }
  check("agent connected (scoped creds)", agent.connected === true);
  await sleep(300);

  await agent.setAttention("focus");
  check("attention is focus", agent.attention === "focus");

  // ---- ambient on a replay channel: ack-dropped, never buffered ----
  await pub.multicast("ambient-1", { channel: "open-ch" });
  await sleep(400);
  check("focus ack-drops ambient (not buffered)", agent.inboxCount() === 0);
  check("focus ambient fires no 'incoming'", incoming.length === 0);

  // ---- a channel @-mention: wakes but is NOT buffered ----
  await pub.multicast("mention-1", { channel: "open-ch", mentions: ["otto"] });
  await sleep(400);
  check("focus @-mention wakes ('mention-wake')", mentionWake.length === 1 && mentionWake[0].text === "mention-1");
  check("focus @-mention is not buffered", agent.inboxCount() === 0);
  check("focus @-mention fires no 'incoming'", incoming.length === 0);

  // ---- a DM: buffered (kind=dm) + 'incoming' ----
  await pub.unicast(agent.id, "dm-1");
  await sleep(400);
  check("focus buffers a DM", agent.inboxCount() === 1 && agent.directedPendingCount() === 1);
  check("focus DM fires 'incoming' with kind=dm", incoming.length === 1 && incoming[0].kind === "dm" && incoming[0].text === "dm-1");

  // ---- prove the replay gate: ambient on a replay=off channel ----
  await pub.multicast("quiet-1", { channel: "quiet-ch" });
  await sleep(400);
  check("focus ack-drops ambient on replay=off channel too", agent.inboxCount() === 1); // still just the DM

  // ---- recallAmbient: replay-gated catch-up since entering focus ----
  const r = await agent.recallAmbient();
  const texts = r.items.map((i) => i.text);
  check("recall returns ambient + mention from the replay=on channel", texts.includes("ambient-1") && texts.includes("mention-1"));
  check("recalled items are historical", r.items.every((i) => i.historical));
  check("recall GATES OUT the replay=off channel", !texts.includes("quiet-1"));

  console.log(`\nAUTH ATTENTION TESTS PASSED ✅  (${pass} checks)`);
  await agent.stop();
  await pub.stop();
  await mgr.stop();
} finally {
  srv.kill("SIGKILL");
  await awaitExit(srv);
  rmSync(dir, { recursive: true, force: true });
}
process.exit(0);
