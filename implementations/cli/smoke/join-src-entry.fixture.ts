// Subprocess entry for join-creds-pairing.smoke.ts: calls the SRC `join` command directly (never
// the built dist, so the gate can't green on a stale build).
// argv: <mode> [uid]  where mode ∈ { creds-flag, creds-none, creds-envonly, token-flag, token-env, open-env }
//   creds-flag   : --creds + --lifecycle-uid <uid>          (paired, should pass the gate)
//   creds-none   : --creds, no uid                          (should refuse: lifecycle-paired)
//   creds-envonly: --creds, uid via COTAL_LIFECYCLE_UID env (paired via env, should pass the gate)
//   token-flag   : --token + --lifecycle-uid <uid>          (misuse, should refuse: flag needs --creds)
//   token-env    : --token, ambient COTAL_LIFECYCLE_UID set (ignored, self-mints, proceeds to preflight)
//   open-env     : open join, ambient COTAL_LIFECYCLE_UID   (ignored, self-mints, proceeds to preflight)
import { join } from "../src/commands/join.js";

const [mode, uid] = process.argv.slice(2);
const CREDS = process.env.JPAIR_CREDS!;
const base = { space: "jpair", server: "nats://127.0.0.1:1" as const }; // port 1 refuses instantly
const values: Record<string, unknown> =
  mode === "creds-flag" ? { ...base, creds: CREDS, "lifecycle-uid": uid }
  : mode === "creds-none" ? { ...base, creds: CREDS }
  : mode === "creds-envonly" ? { ...base, creds: CREDS }
  : mode === "token-flag" ? { ...base, token: "tok", "lifecycle-uid": uid }
  : mode === "token-env" ? { ...base, token: "tok" }
  : mode === "open-env" ? { ...base }
  : (() => { throw new Error(`unknown mode ${mode}`); })();

await join({ values, positionals: [], raw: [] });
