/**
 * Auth-mode per-channel attention e2e (no test runner) — the open `per-channel-attention.smoke.ts`
 * flow under JWT auth, the real deployment stack. Spins up its OWN JWT-auth nats-server, mints scoped
 * creds for the agent (Otto) and a peer (Pubby), and proves quiet/muted hold for an agent holding ONLY
 * the minted "agent" grants — AND that the per-channel modes + global attention round-trip through
 * presence over the wire so a *separate* peer sees them (the mesh-visibility contract):
 *   - boot seed from the agent's quiet/muted config;
 *   - muted: channel ambient AND @-mentions ack-dropped; a DM still pierces;
 *   - quiet: buffered + readable, not wake-eligible; a quiet @-mention IS wake-eligible;
 *   - precedence: quiet buffers even under global focus;
 *   - recall skips overridden channels (no muted resurface / quiet duplicate);
 *   - presence mirror: Pubby (separate creds) reads Otto's attention + channelModes over the wire;
 *   - reset on restart: a fresh agent seeds from config only.
 * Run: pnpm smoke:channel-attention:auth
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
const space = "chanattnsmoke-auth";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const awaitExit = (proc: ReturnType<typeof spawn>, timeoutMs = 3000): Promise<void> =>
  new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    proc.once("exit", () => resolve());
    setTimeout(resolve, timeoutMs);
  });

const dir = mkdtempSync(join(tmpdir(), "cotal-chanattn-auth-"));
const auth = await createSpaceAuth(space);
writeFileSync(join(dir, "server.conf"), serverConfig(auth, { port: PORT, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
let pass = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, `${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

const channels = ["normal-ch", "quiet-ch", "muted-ch"];

try {
  for (let i = 0; i < 50; i++) { if (await isReachable(servers)) break; await sleep(200); }

  // Privileged setup: streams + presence KV, channel registry (replay ON so recall has data to skip),
  // and the two peers' bind-only durables + scoped "agent" creds.
  const mgrCreds = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers, space, creds: mgrCreds });
  await seedChannelRegistry({ servers, space, creds: mgrCreds, file: { defaults: { replay: true }, channels: {} } });
  const mgr = new CotalEndpoint({ space, servers, creds: mgrCreds, card: { name: "mgr", kind: "endpoint" }, consume: false, registerPresence: false, watchPresence: false });
  mgr.on("error", () => {});
  await mgr.start();

  const ottoId = newIdentity();
  const pubbyId = newIdentity();
  const chACL = { subscribe: channels, allowSubscribe: channels, allowPublish: channels };
  const ottoCreds = await provisionAgent(mgr, auth, ottoId, { ...chACL, role: "generalist" });
  const pubbyCreds = await provisionAgent(mgr, auth, pubbyId, { ...chACL });

  const cfg: AgentConfig = {
    space,
    name: "Otto",
    role: "generalist",
    servers,
    creds: ottoCreds,
    subscribe: channels,
    allowSubscribe: channels,
    allowPublish: channels,
    quiet: ["quiet-ch"], // operator file default (not an ACL — rides the agent config)
    muted: ["muted-ch"],
    kind: "agent",
    tls: false,
    id: ottoId.id,
  };

  // ---- boot seed from config (before connecting) ----
  const agent = new MeshAgent(cfg);
  agent.on("error", () => {});
  check("boot seeds quiet/muted from config under auth", agent.channelMode("quiet-ch") === "quiet" && agent.channelMode("muted-ch") === "muted");

  const incoming: InboxItem[] = [];
  const mentionWake: InboxItem[] = [];
  agent.on("incoming", (i: InboxItem) => incoming.push(i));
  agent.on("mention-wake", (i: InboxItem) => mentionWake.push(i));

  const pub = new CotalEndpoint({ space, servers, creds: pubbyCreds, card: { name: "Pubby", kind: "agent", id: pubbyId.id }, channels });
  pub.on("error", () => {});

  await pub.start();
  agent.start();
  for (let i = 0; i < 50; i++) { if (agent.connected) break; await sleep(200); }
  check("agent connected (scoped creds)", agent.connected === true);
  await sleep(300);

  // ---- file-default modes are visible in presence at BOOT over the auth wire, before any toggle ----
  const bootSeen = pub.getRoster().find((p) => p.card.id === ottoId.id);
  check("file-default channelModes visible in presence at boot under auth (no toggle yet)",
    bootSeen?.channelModes?.["quiet-ch"] === "quiet" && bootSeen?.channelModes?.["muted-ch"] === "muted");

  // ---- muted: ack-dropped (incl. @mention); DM pierces ----
  await pub.multicast("muted-ambient", { channel: "muted-ch" });
  await pub.multicast("muted-mention", { channel: "muted-ch", mentions: ["otto"] });
  await sleep(450);
  check("muted ambient + @-mention NOT buffered (over the wire, auth)", agent.inboxCount() === 0 && mentionWake.length === 0 && incoming.length === 0);
  await pub.unicast(agent.id, "dm-1");
  await sleep(400);
  check("a DM still pierces (kind=dm)", agent.inboxCount() === 1 && incoming.at(-1)?.kind === "dm");

  // ---- quiet: buffered, not wake-eligible; mention IS ----
  agent.drainInbox();
  incoming.length = 0;
  await pub.multicast("quiet-ambient", { channel: "quiet-ch" });
  await sleep(400);
  check("quiet ambient buffered but NOT wake-eligible", agent.inboxCount() === 1 && agent.pendingWake() === 0);
  await pub.multicast("quiet-mention", { channel: "quiet-ch", mentions: ["otto"] });
  await sleep(400);
  check("quiet @-mention is wake-eligible", agent.inboxCount() === 2 && agent.pendingWake() === 1);

  // ---- precedence: quiet buffers even under global focus; normal/muted drop ----
  agent.drainInbox();
  incoming.length = 0;
  await agent.setAttention("focus");
  await pub.multicast("quiet-focus", { channel: "quiet-ch" });
  await pub.multicast("normal-focus", { channel: "normal-ch" });
  await pub.multicast("muted-focus", { channel: "muted-ch" });
  await sleep(450);
  check("quiet overrides focus (buffered); normal+muted drop", agent.inboxCount() === 1 && incoming.at(-1)?.text === "quiet-focus");

  // ---- recall skips overridden channels (no resurface / duplicate) ----
  const recall = await agent.recallAmbient();
  const rtexts = recall.items.map((i) => i.text);
  check("recall surfaces NORMAL focus-dropped ambient", rtexts.includes("normal-focus"));
  check("recall SKIPS muted + quiet channels", !rtexts.includes("muted-focus") && !rtexts.includes("quiet-focus"));
  await agent.setAttention("open");

  // ---- presence mirror over the wire: a SEPARATE peer sees attention + channelModes ----
  await agent.setAttention("dnd");
  await agent.setChannelMode("normal-ch", "muted"); // runtime override on top of file defaults
  await sleep(500);
  const seen = pub.getRoster().find((p) => p.card.id === ottoId.id);
  check("peer reads Otto's global attention from presence (auth wire)", seen?.attention === "dnd");
  check("peer reads Otto's channelModes from presence (auth wire)",
    seen?.channelModes?.["normal-ch"] === "muted" && seen?.channelModes?.["quiet-ch"] === "quiet" && seen?.channelModes?.["muted-ch"] === "muted");
  await agent.setChannelMode("normal-ch", "normal");
  await sleep(400);
  check("clearing a mode removes the key for the peer", pub.getRoster().find((p) => p.card.id === ottoId.id)?.channelModes?.["normal-ch"] === undefined);

  // ---- reset on restart ----
  const fresh = new MeshAgent(cfg);
  check("restart drops runtime override, keeps file defaults",
    fresh.channelMode("normal-ch") === undefined && fresh.channelMode("quiet-ch") === "quiet" && fresh.channelMode("muted-ch") === "muted");

  console.log(`\nAUTH PER-CHANNEL ATTENTION E2E PASSED ✅  (${pass} checks)`);
  await agent.stop();
  await pub.stop();
  await mgr.stop();
} finally {
  srv.kill("SIGKILL");
  await awaitExit(srv);
  rmSync(dir, { recursive: true, force: true });
}
process.exit(0);
