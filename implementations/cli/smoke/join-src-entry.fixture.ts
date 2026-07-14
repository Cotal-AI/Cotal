// Subprocess entry for join-creds-pairing.smoke.ts: calls the SRC `join` command directly (never
// the built dist, so the gate can't green on a stale build). argv: <credsPath> [lifecycleUid]
import { join } from "../src/commands/join.js";

const [creds, uid] = process.argv.slice(2);
await join({
  values: {
    creds,
    ...(uid ? { "lifecycle-uid": uid } : {}),
    space: "jpair",
    server: "nats://127.0.0.1:1", // refuses instantly: a paired probe dies at preflight, not the gate
  },
  positionals: [],
  raw: [],
});
