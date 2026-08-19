/**
 * Subprocess probe for the opencode cooperative-stop smoke (cooperative-stop.smoke.ts) — never run
 * standalone. Loads the REAL plugin with a tiny fake OpenCode HTTP server plus the COTAL_* identity +
 * control env the parent set, so the plugin connects its mesh agent and starts its control server. The
 * parent then sends an authenticated {op:"shutdown"} to that endpoint; the plugin leaves the mesh
 * (publishes offline presence) and exits 0 — which the parent asserts. A separate process because the
 * plugin's cooperative shutdown ends in process.exit, which would otherwise tear down the test itself.
 */
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { cotal } from "../src/plugin.js";

// The plugin calls OpenCode's HTTP API at boot to own a session. A shutdown test drives no turn, so
// only POST /session is needed.
const auth = `Basic ${Buffer.from("opencode:test-secret").toString("base64")}`;
// Set by the parent only for the teardown-join scenario; unset, this probe behaves exactly as
// it always did and the original four cells are unaffected.
const marker = process.env.COOP_MARKER?.trim() || undefined;
let reads = 0;
const oc = createServer((req, res) => {
  if (req.headers.authorization !== auth) {
    res.writeHead(401).end();
    return;
  }
  if (req.method === "POST" && req.url === "/session") {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "ses_coop" }));
    return;
  }
  // The AG-UI source reads a session's records from here. The SECOND read is answered SLOWLY and
  // writes a marker just before it answers, which is how the parent sees, from another process,
  // whether a queued drain was still allowed to finish. The first read is fast because it is the
  // fresh adopt at bind time and slowing it would only delay setup.
  if (req.method === "GET" && /^\/session\/[^/]+\/message$/.test(req.url ?? "")) {
    reads += 1;
    const answer = (): void => {
      if (marker && reads > 1) writeFileSync(marker, `read ${reads} completed\n`);
      res.writeHead(200, { "content-type": "application/json" }).end("[]");
    };
    if (marker && reads > 1) setTimeout(answer, 2_500);
    else answer();
    return;
  }
  res.writeHead(404).end();
});
oc.listen(0, "127.0.0.1");
await once(oc, "listening");
const port = (oc.address() as { port: number }).port;
process.env.COTAL_OPENCODE_SERVER_URL = `http://127.0.0.1:${port}`;
process.env.OPENCODE_SERVER_USERNAME = "opencode";
process.env.OPENCODE_SERVER_PASSWORD = "test-secret";

const hooks = await cotal();

// QUEUE REAL EVENT WORK, so the parent's shutdown lands while a drain is in flight. The first
// create binds the holder to this session; the second is NOT awaited, so it leaves a swap on the
// chain whose drain flushes the session being left, and that flush reads through the slow
// endpoint above. Un-awaited on purpose: the bus dispatches events with `void`, so this is how a
// real create arrives, and awaiting it here would drain before the stop and grade nothing.
if (marker) {
  const fire = (event: unknown): Promise<void> =>
    (hooks as unknown as { event: (a: unknown) => Promise<void> }).event({ event });
  await fire({ type: "session.created", properties: { info: { id: "ses_coop" } } });
  void fire({ type: "session.created", properties: { info: { id: "ses_next" } } });
}

// The plugin's control server keeps the event loop alive; the authenticated shutdown op calls
// process.exit(0). Backstop: never linger on CI if the parent dies before driving shutdown.
setTimeout(() => process.exit(3), 30_000);
