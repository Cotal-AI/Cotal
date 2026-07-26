/**
 * #260 — the claude connector forwards `CLAUDE_CODE_OAUTH_TOKEN` (by name, only when present) so
 * concurrent claude agents can share ONE long-lived, non-rotating `claude setup-token` bearer instead
 * of racing on the operator's single rotating subscription-OAuth credential (shared macOS Keychain /
 * ~/.claude/.credentials.json), which cascades everyone to "Not logged in".
 *
 * Pure buildLaunch check — no NATS, no runtime. Run with: pnpm smoke:claude-auth-env
 * Asserts: set → forwarded identically to distinct agents and NEVER on argv; an unrelated operator
 * secret is NOT forwarded (P3, no bleed); unset → the key is absent (behavior unchanged). Restores the
 * process env it mutates so a smoke chain after it is unaffected.
 */
import { claudeConnector } from "../src/extension.js";

let failures = 0;
function check(label: string, cond: boolean, extra?: unknown): void {
  console.log(`${cond ? "✓" : "✗"} ${label}${cond ? "" : ` — ${extra ?? ""}`}`);
  if (!cond) failures++;
}

const TOKEN = "sk-ant-oat01-SMOKE-TOKEN";
const UNRELATED = "COTAL_260_UNRELATED_SECRET";
const UNRELATED_VALUE = "must-not-forward";

// Snapshot + isolate the two vars we touch, so we assert against a known state and restore after.
const prevToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
const prevUnrelated = process.env[UNRELATED];

// (1) token PRESENT → forwarded to the spawn env, identically for two distinct agents, never on argv.
process.env.CLAUDE_CODE_OAUTH_TOKEN = TOKEN;
process.env[UNRELATED] = UNRELATED_VALUE; // an unrelated operator secret sitting in the manager env
{
  const a = claudeConnector.buildLaunch({ space: "main", name: "worker-a" });
  const b = claudeConnector.buildLaunch({ space: "main", name: "worker-b" });
  check("token forwarded to worker-a env", a.env.CLAUDE_CODE_OAUTH_TOKEN === TOKEN, a.env.CLAUDE_CODE_OAUTH_TOKEN);
  check("token forwarded to worker-b env", b.env.CLAUDE_CODE_OAUTH_TOKEN === TOKEN, b.env.CLAUDE_CODE_OAUTH_TOKEN);
  check("both agents carry the SAME non-rotating token (no refresh race)", a.env.CLAUDE_CODE_OAUTH_TOKEN === b.env.CLAUDE_CODE_OAUTH_TOKEN);
  check("token NEVER on argv (env-only — token hygiene)", !a.args.some((x) => String(x).includes(TOKEN)), JSON.stringify(a.args));
  check("unrelated operator secret NOT forwarded (P3, no bleed)", a.env[UNRELATED] === undefined, a.env[UNRELATED]);
}

// (2) token ABSENT → the key is not forwarded (forwarded only when present; behavior unchanged).
delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
{
  const c = claudeConnector.buildLaunch({ space: "main", name: "worker-c" });
  check("token unset → key ABSENT from spawn env", !("CLAUDE_CODE_OAUTH_TOKEN" in c.env), c.env.CLAUDE_CODE_OAUTH_TOKEN);
}

// Restore the process env exactly as we found it.
if (prevToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
else process.env.CLAUDE_CODE_OAUTH_TOKEN = prevToken;
if (prevUnrelated === undefined) delete process.env[UNRELATED];
else process.env[UNRELATED] = prevUnrelated;

console.log(`\nCLAUDE-AUTH-ENV SMOKE ${failures === 0 ? "OK ✅" : "FAILED ❌"}`);
process.exit(failures === 0 ? 0 : 1);
