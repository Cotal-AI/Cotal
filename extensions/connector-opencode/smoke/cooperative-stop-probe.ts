/**
 * Subprocess probe for the opencode cooperative-stop smoke (cooperative-stop.smoke.ts) — never run
 * standalone. Loads the REAL plugin with a fake opencode client plus the COTAL_* identity + control
 * env the parent set, so the plugin connects its mesh agent and starts its control server. The parent
 * then sends an authenticated {op:"shutdown"} to that endpoint; the plugin leaves the mesh (publishes
 * offline presence) and exits 0 — which the parent asserts. A separate process because the plugin's
 * cooperative shutdown ends in process.exit, which would otherwise tear down the test itself.
 */
import { cotal } from "../src/plugin.js";

// The plugin only calls session.create at boot (to own a session) and session.promptAsync to drive a
// turn; a shutdown test drives neither a model nor a turn, so a minimal fake satisfies it.
const fakeClient = {
  session: {
    create: async () => ({ data: { id: "ses_coop" } }),
    promptAsync: async () => ({ data: {} }),
  },
};

await cotal({ client: fakeClient } as never);

// The plugin's control server keeps the event loop alive; the authenticated shutdown op calls
// process.exit(0). Backstop: never linger on CI if the parent dies before driving shutdown.
setTimeout(() => process.exit(3), 30_000);
