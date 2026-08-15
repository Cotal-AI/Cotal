/**
 * Cron heartbeat: DM the standing orchestrator so it wakes on a cadence even when no
 * manager traffic arrives. Fire-and-forget; the orchestrator's persona defines the loop.
 * Run from the Cotal checkout's bin/: pnpm exec tsx heartbeat-dm.mts
 */
import { homedir } from "node:os";
import { join } from "node:path";

const { mintCreds, mintLifecycleUid, newIdentity, provisionAgent, CotalEndpoint } = await import("@cotal-ai/core");
const { authDir, loadSpaceAuth } = await import("@cotal-ai/workspace");

const ROOT = join(homedir(), "Cotal");
const SPACE = "main";
const SERVERS = "nats://broker.cotal.ai:4222";
const TARGET = "fm-orchestrator";

const auth = loadSpaceAuth(authDir(ROOT), SPACE);
const supervisor = new CotalEndpoint({
  space: SPACE, servers: SERVERS, creds: await mintCreds(auth, newIdentity(), "provisioner"),
  card: { name: "hb-prov", kind: "endpoint" }, consume: false, watchPresence: false, registerPresence: false,
});
await supervisor.start();
const ident = newIdentity();
const uid = mintLifecycleUid();
const creds = await provisionAgent(supervisor, auth, ident, {
  subscribe: ["general"], allowSubscribe: ["general"], lifecycleUid: uid,
});
const hb = new CotalEndpoint({
  space: SPACE, servers: SERVERS, creds, lifecycleUid: uid,
  card: { name: "heartbeat", kind: "agent", id: ident.id }, channels: ["general"], watchPresence: true,
});
const seen = new Map<string, string>();
hb.on("presence", (e: { presence?: unknown }) => {
  const p = e?.presence as Record<string, unknown> | undefined;
  if (!p) return;
  const card = (p.ref ?? p.card ?? p) as Record<string, unknown>;
  const name = String(card?.name ?? "");
  const id = String(card?.id ?? "");
  if (name && id) seen.set(name, id);
});
await hb.start();
await hb.waitForPresenceSnapshot(5_000).catch(() => {});
for (let i = 0; i < 12 && !seen.has(TARGET); i++) await new Promise((r) => setTimeout(r, 250));
const targetId = seen.get(TARGET);
if (!targetId) {
  console.error(`heartbeat: ${TARGET} not present — nothing to wake`);
} else {
  await hb.unicast(
    targetId,
    "ORCHESTRATOR HEARTBEAT (cron, not David). Run your heartbeat loop per your persona: inbox, roster, nudge silent managers with incomplete lanes, respawn dead seats after investigating their worktrees, update the resume doc lane rows, finish quietly.",
  );
  console.log(`heartbeat sent to ${TARGET}`);
}
await hb.stop();
await supervisor.stop();
process.exit(0);
