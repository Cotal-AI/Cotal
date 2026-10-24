// Subprocess entry for join-creds-pairing.smoke.ts: calls the SRC `join` command directly (never
// the built dist, so the gate can't green on a stale build).
// argv: <mode> [uid]  where mode ∈ { creds-flag, creds-none, creds-envonly, token-flag, token-env, open-env }
//   creds-flag   : --creds + --lifecycle-uid <uid>          (paired, should pass the gate)
//   creds-none   : --creds, no uid                          (should refuse: lifecycle-paired)
//   creds-envonly: --creds, uid via COTAL_LIFECYCLE_UID env (paired via env, should pass the gate)
//   token-flag   : --token + --lifecycle-uid <uid>          (misuse, should refuse: flag needs --creds)
//   token-env    : --token, ambient COTAL_LIFECYCLE_UID set (ignored, self-mints, proceeds to preflight)
//   open-env     : open join, ambient COTAL_LIFECYCLE_UID   (ignored, self-mints, proceeds to preflight)
//   creds-noserver / token-noserver: --creds + uid / --token, no --server, space JPAIR_SPACE
//   creds-missing: --creds naming a file that does not exist, + uid
// A refusal is reported by its classified report on stderr, with its code, and exits with the
// status the outcome table gives that code.
import { commandFailureReport, exitCode, isCommandFailure, renderReport } from "@cotal-ai/workspace";
import { join } from "../src/commands/join.js";

const [mode, uid] = process.argv.slice(2);
const CREDS = process.env.JPAIR_CREDS!;
const base = { space: "jpair", server: "nats://127.0.0.1:1" as const }; // port 1 refuses instantly
const values: Record<string, string | boolean | undefined> =
  mode === "creds-flag" ? { ...base, creds: CREDS, "lifecycle-uid": uid }
  : mode === "creds-none" ? { ...base, creds: CREDS }
  : mode === "creds-envonly" ? { ...base, creds: CREDS }
  : mode === "token-flag" ? { ...base, token: "tok", "lifecycle-uid": uid }
  : mode === "token-env" ? { ...base, token: "tok" }
  : mode === "open-env" ? { ...base }
  : mode === "creds-noserver" ? { space: process.env.JPAIR_SPACE, creds: CREDS, "lifecycle-uid": uid }
  : mode === "token-noserver" ? { space: process.env.JPAIR_SPACE, token: "tok" }
  : mode === "creds-missing" ? { ...base, creds: `${CREDS}.missing`, "lifecycle-uid": uid }
  : (() => { throw new Error(`unknown mode ${mode}`); })();

try {
  await join({ values, positionals: [], raw: [] });
} catch (e) {
  if (!isCommandFailure(e)) throw e;
  process.stderr.write(`${renderReport(commandFailureReport(e), "plain")}\n`);
  process.exit(exitCode(e.outcome, e.code));
}
