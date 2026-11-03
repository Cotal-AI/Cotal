// A seat for spawn-once-unheld.smoke.ts: it joins presence on an open mesh under the identity its
// manager assigned and stays. It ignores the hangup its pty sends when the manager dies, so it
// outlives a crashed manager as a real seat can. The space and the seat name ride argv so the suite
// can find it by its command line.
process.on("SIGHUP", () => {});
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});
const { pathToFileURL } = require("node:url");
import(pathToFileURL(process.env.CORE_DIST).href).then(async ({ CotalEndpoint }) => {
  const ep = new CotalEndpoint({
    space: process.env.COTAL_SPACE, servers: process.env.COTAL_SERVERS, lifecycleUid: process.env.COTAL_LIFECYCLE_UID || undefined,
    channels: [], consume: false, registerPresence: true, watchPresence: false,
    card: { id: process.env.COTAL_ID || undefined, name: process.env.COTAL_NAME, kind: "agent" },
  });
  ep.on("error", () => {});
  await ep.start();
  setInterval(() => {}, 1 << 30);
});
