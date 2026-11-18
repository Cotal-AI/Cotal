// Drives the shipped dashboard with private smoke coordinates and emits only private harness IPC.
import type { WebSession } from "@cotal-ai/workspace";
import { web } from "../src/web.js";

const [server, space, port] = process.argv.slice(2);
if (!server || !space || !port) throw new Error("Expected broker, space and dashboard port");
let session: WebSession | undefined;
await web({ values: { host: "127.0.0.1", port, "no-open": true }, positionals: [], raw: [] }, {
  connection: { server, space, tls: false },
  onSession: (value) => { session = value; },
  onReady: () => { console.log(JSON.stringify({ ready: true, launchUrl: session?.launchUrl, launchNonce: session?.launchNonce })); },
  onClosed: () => {},
});
