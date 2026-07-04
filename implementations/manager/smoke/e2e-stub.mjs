// A real, lightweight agent for the lifecycle e2e (lifecycle-e2e.smoke.ts): connects to the broker with
// its minted creds and registers presence under its assigned id — exactly what a connector's plugin does —
// then idles until killed. This makes the manager's presence-race resolve "started" on a REAL mesh join,
// and leaves a REAL broker footprint (dm_/dlv_ durables + ACL row) for the deprovision assertions.
import { readFileSync } from "node:fs";
import { CotalEndpoint } from "@cotal-ai/core";

const e = process.env;
const ep = new CotalEndpoint({
  space: e.COTAL_SPACE,
  servers: e.COTAL_SERVERS,
  creds: readFileSync(e.COTAL_CREDS, "utf8"),
  card: { id: e.COTAL_ID, name: e.COTAL_NAME, role: "worker", kind: "agent" },
  channels: [],
  consume: false,
  registerPresence: true,
});
ep.on("error", (err) => console.error("STUB_ERR", err?.message ?? err));
await ep.start();
console.log("STUB_JOINED", e.COTAL_NAME, e.COTAL_ID);
const keep = setInterval(() => {}, 1 << 30);
const bye = () => { clearInterval(keep); ep.stop().finally(() => process.exit(0)); };
process.on("SIGTERM", bye);
process.on("SIGINT", bye);
