/**
 * Subprocess probe for the opencode cooperative-stop smoke (cooperative-stop.smoke.ts) — never run
 * standalone. Loads the REAL plugin with a tiny fake OpenCode HTTP server plus the COTAL_* identity +
 * control env the parent set, so the plugin connects its mesh agent and starts its control server. The
 * parent then sends an authenticated {op:"shutdown"} to that endpoint; the plugin leaves the mesh
 * (publishes offline presence) and exits 0 — which the parent asserts. A separate process because the
 * plugin's cooperative shutdown ends in process.exit, which would otherwise tear down the test itself.
 */
import { once } from "node:events";
import { createServer } from "node:http";
import { cotal } from "../src/plugin.js";

// The plugin calls OpenCode's HTTP API at boot to own a session. A shutdown test drives no turn, so
// only POST /session is needed.
const auth = `Basic ${Buffer.from("opencode:test-secret").toString("base64")}`;
const oc = createServer((req, res) => {
  if (req.headers.authorization !== auth) {
    res.writeHead(401).end();
    return;
  }
  if (req.method === "POST" && req.url === "/session") {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "ses_coop" }));
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

await cotal();

// The plugin's control server keeps the event loop alive; the authenticated shutdown op calls
// process.exit(0). Backstop: never linger on CI if the parent dies before driving shutdown.
setTimeout(() => process.exit(3), 30_000);
