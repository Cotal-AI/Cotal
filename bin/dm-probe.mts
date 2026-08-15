/**
 * DM round-trip probe against the cloud mesh: mint a throwaway identity, DM the canary seat,
 * await its PONG. Proves broker TLS + auth + presence + connector turn end-to-end.
 * Run from the Cotal checkout's bin/: pnpm exec tsx dm-probe.mts
 */
import { homedir } from "node:os";
import { join } from "node:path";

const { mintCreds, mintLifecycleUid, newIdentity, provisionAgent, CotalEndpoint } = await import("@cotal-ai/core");
const { authDir, loadSpaceAuth } = await import("@cotal-ai/workspace");

const ROOT = process.env.MESH_ROOT ?? join(homedir(), "Cotal");
const SPACE = "main";
const SERVERS = process.env.MESH_SERVERS ?? "nats://broker.cotal.ai:4222";
const TARGET = process.env.PROBE_TARGET ?? "canary";

const auth = loadSpaceAuth(authDir(ROOT), SPACE);
const supervisor = new CotalEndpoint({
  space: SPACE, servers: SERVERS, creds: await mintCreds(auth, newIdentity(), "provisioner"),
  card: { name: "probe-prov", kind: "endpoint" }, consume: false, watchPresence: false, registerPresence: false,
});
await supervisor.start();

const ident = newIdentity();
const uid = mintLifecycleUid();
const creds = await provisionAgent(supervisor, auth, ident, {
  subscribe: ["general"], allowSubscribe: ["general"], lifecycleUid: uid,
});
const probe = new CotalEndpoint({
  space: SPACE, servers: SERVERS, creds, lifecycleUid: uid,
  card: { name: "dm-probe", kind: "agent", id: ident.id }, channels: ["general"], watchPresence: true,
});

const heard: string[] = [];
probe.on("message", (m: { parts?: Array<{ kind: string; text?: string }> }) => {
  for (const p of m?.parts ?? []) if (p.kind === "text" && p.text) heard.push(p.text);
});
// Presence arrives as events; collect every shape defensively and mine it for the target.
const seen = new Map<string, string>(); // name -> principal id
probe.on("presence", (e: { presence?: unknown }) => {
  const p = e?.presence as Record<string, unknown> | undefined;
  if (!p) return;
  const card = (p.ref ?? p.card ?? p) as Record<string, unknown>;
  const name = String(card?.name ?? "");
  const id = String(card?.id ?? "");
  if (name && id) seen.set(name, id);
});
await probe.start();
await probe.waitForPresenceSnapshot(5_000).catch(() => {});
for (let i = 0; i < 20 && !seen.has(TARGET); i++) await new Promise((r) => setTimeout(r, 250));
const targetId = seen.get(TARGET);
if (!targetId) {
  console.error(`FAIL: "${TARGET}" not in presence (saw: ${[...seen.keys()].join(", ") || "nobody"})`);
  process.exit(1);
}
await probe.unicast(targetId, "ping — reply per your persona");
const deadline = Date.now() + 90_000;
while (Date.now() < deadline && !heard.some((t) => /PONG/i.test(t))) {
  await new Promise((r) => setTimeout(r, 500));
}
await probe.stop();
await supervisor.stop();
if (heard.some((t) => /PONG/i.test(t))) {
  console.log(`ROUND-TRIP OK: ${TARGET} answered: ${heard.join(" | ").slice(0, 120)}`);
  process.exit(0);
}
console.error(`FAIL: no PONG within 90s (heard: ${heard.join(" | ").slice(0, 200) || "nothing"})`);
process.exit(1);
