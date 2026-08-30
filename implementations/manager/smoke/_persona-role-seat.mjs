process.on("uncaughtException", (e) => { process.stdout.write("SEAT_FATAL: " + String(e?.message ?? e) + "\n"); process.exit(3); });

try {
const { readFileSync } = await import("node:fs");
const { CotalEndpoint } = await import(CORE_DIST_URL_PLACEHOLDER);
// The always-alive stub seat for the persona-role-capability smoke: joins the broker with its
// minted creds, registers presence under its assigned id (what a real connector's plugin does),
// and idles until killed. Registered by the smoke's `p966-stub` connector via buildLaunch env.
// Reads COTAL_LAUNCH_MATERIAL (the modern carrier) when present, else the classic COTAL_* pair.
// The smoke copies this file into its scratch dir and bakes CORE_DIST below (the copied file has
// no package context to resolve '@cotal-ai/core' from; the cwd of the launched seat is the
// manager's workspaceRoot, also outside the package tree).



const e = process.env;
let credsPath = e.COTAL_CREDS;
let servers = e.COTAL_SERVERS;
if (e.COTAL_LAUNCH_MATERIAL) {
  const m = JSON.parse(readFileSync(e.COTAL_LAUNCH_MATERIAL, "utf8"));
  credsPath = m.creds;
  servers = m.servers;
}
const ep = new CotalEndpoint({
  space: e.COTAL_SPACE,
  servers,
  creds: credsPath ? readFileSync(credsPath, "utf8") : undefined,
  card: { id: e.COTAL_ID, name: e.COTAL_NAME, role: e.COTAL_ROLE || "worker", kind: "agent" },
  lifecycleUid: e.COTAL_LIFECYCLE_UID,
  channels: [],
  consume: false,
  registerPresence: true,
});
ep.on("error", () => {});
await ep.start();
const keep = setInterval(() => {}, 1 << 30);
const bye = () => { clearInterval(keep); ep.stop().finally(() => process.exit(0)); };
process.on("SIGTERM", bye);
process.on("SIGINT", bye);
} catch (e) {
  process.stdout.write("SEAT_FATAL: " + String(e?.stack ?? e) + "\n");
  process.exit(3);
}
