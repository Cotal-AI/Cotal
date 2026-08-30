// A real, lightweight agent for the lifecycle e2e (lifecycle-e2e.smoke.ts): connects to the broker with
// its minted creds and registers presence under its assigned id — exactly what a connector's plugin does —
// then idles until killed. This makes the manager's presence-race resolve "started" on a REAL mesh join,
// and leaves a REAL broker footprint (dm_/dlv_ durables + ACL row) for the deprovision assertions.
// COTAL_LIFECYCLE_UID rides through exactly as a real connector forwards it — an authed registering
// endpoint REQUIRES it (fail-before-presence, SPEC 13.1); COTAL_E2E_CONSUME=1 makes the stub bind its
// DM/dlv durables like a full agent (the wrong-uid probe needs the broker's bind denial).
import { readFileSync } from "node:fs";
import { CotalEndpoint, DEV_OWNER, presenceBucket, principalKey } from "@cotal-ai/core";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";

const e = process.env;
if (e.COTAL_E2E_SURVIVE_DISCONNECT === "1") {
  // A deliberately non-reconnecting real broker connection. Delivery-admin can KICK and verify the
  // principal gone while the process remains alive, which is the exact broker-vs-OS boundary #817
  // covers. A normal CotalEndpoint rebuilds after terminal close, so it would race the verifier.
  const creds = readFileSync(e.COTAL_CREDS, "utf8");
  const nc = await connect({
    servers: e.COTAL_SERVERS,
    authenticator: credsAuthenticator(new TextEncoder().encode(creds)),
    reconnect: false,
    maxReconnectAttempts: 0,
  });
  const card = { id: principalKey(DEV_OWNER, e.COTAL_ID).key, name: e.COTAL_NAME, role: "worker", kind: "agent" };
  await (await new Kvm(nc).open(presenceBucket(e.COTAL_SPACE))).put(card.id, JSON.stringify({ card, lifecycleUid: e.COTAL_LIFECYCLE_UID, status: "idle", ts: Date.now() }));
  console.log("STUB_JOINED", e.COTAL_NAME, e.COTAL_ID);
  const keep = setInterval(() => {}, 1 << 30);
  const bye = () => { clearInterval(keep); nc.close(); process.exit(0); };
  process.on("SIGTERM", bye);
  process.on("SIGINT", bye);
  await new Promise(() => {});
}

const ep = new CotalEndpoint({
  space: e.COTAL_SPACE,
  servers: e.COTAL_SERVERS,
  creds: readFileSync(e.COTAL_CREDS, "utf8"),
  // COTAL_E2E_KIND lets the authority-bypass probe claim kind:"endpoint" (client-authored
  // metadata) to skip the library register-only proof — the manager readiness lifecycle fence
  // must still reject it. Defaults to a real agent.
  card: { id: e.COTAL_ID, name: e.COTAL_NAME, role: "worker", kind: e.COTAL_E2E_KIND || "agent" },
  lifecycleUid: e.COTAL_LIFECYCLE_UID,
  channels: [],
  consume: e.COTAL_E2E_CONSUME === "1",
  registerPresence: true,
});
ep.on("error", (err) => console.error("STUB_ERR", err?.message ?? err));
await ep.start();
if (e.COTAL_E2E_STATUS) await ep.setStatus(e.COTAL_E2E_STATUS);
console.log("STUB_JOINED", e.COTAL_NAME, e.COTAL_ID);
const keep = setInterval(() => {}, 1 << 30);
const bye = () => { clearInterval(keep); ep.stop().finally(() => process.exit(0)); };
process.on("SIGTERM", bye);
process.on("SIGINT", bye);
