/**
 * #260 regression: the claude connector forwards CLAUDE_CODE_OAUTH_TOKEN (a non-rotating
 * `setup-token` bearer) to every spawn so concurrent claude agents share ONE credential instead of
 * racing the rotating subscription refresh token in the shared credential store (the cascading-
 * logout bug). Asserts the named-forward contract from `launchEnv`:
 *   - token SET in the manager env  → present in the spawn env (both spawns get the SAME value);
 *   - token UNSET                    → absent (single-agent subscription login is unaffected);
 *   - it is env-only, never in argv  → no token in the rendered CLI args (token hygiene);
 *   - an unrelated operator secret never bleeds in (P3 allow-list still holds).
 * No NATS, no runtime — buildLaunch is a pure function of opts + process.env.
 * Run: pnpm smoke:claude-oauth
 */
import { claudeConnector } from "../src/extension.js";

let failures = 0;
function check(label: string, cond: boolean, extra?: unknown): void {
  console.log(`${cond ? "✓" : "✗"} ${label}${cond ? "" : ` — ${extra ?? ""}`}`);
  if (!cond) failures++;
}

const TOKEN = "sk-ant-oat01-SMOKE-TEST-VALUE";
const SENTINEL = "COTAL_260_UNRELATED_SECRET";
const SENTINEL_VALUE = "must-not-bleed";
process.env[SENTINEL] = SENTINEL_VALUE; // an operator secret sitting in the manager shell

// token SET → forwarded, to distinct agents, as the same value.
process.env.CLAUDE_CODE_OAUTH_TOKEN = TOKEN;
const a = claudeConnector.buildLaunch({ space: "smoke", name: "worker-a" });
const b = claudeConnector.buildLaunch({ space: "smoke", name: "worker-b" });
check("token forwarded to worker-a", a.env.CLAUDE_CODE_OAUTH_TOKEN === TOKEN, a.env.CLAUDE_CODE_OAUTH_TOKEN);
check("token forwarded to worker-b", b.env.CLAUDE_CODE_OAUTH_TOKEN === TOKEN, b.env.CLAUDE_CODE_OAUTH_TOKEN);
check("both spawns share the SAME token (no per-agent divergence)", a.env.CLAUDE_CODE_OAUTH_TOKEN === b.env.CLAUDE_CODE_OAUTH_TOKEN);
check("token is env-only, never in argv (token hygiene)", !a.args.some((x) => x.includes(TOKEN)));
check("unrelated operator secret does NOT bleed into the spawn (P3)", a.env[SENTINEL] === undefined);
check("HOME still forwarded (OS allow-list intact)", typeof a.env.HOME === "string" || typeof a.env.USERPROFILE === "string");

// token UNSET → absent (named-forward only; a single subscription login is unaffected).
delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
const c = claudeConnector.buildLaunch({ space: "smoke", name: "worker-c" });
check("token ABSENT when the operator has none set", c.env.CLAUDE_CODE_OAUTH_TOKEN === undefined, c.env.CLAUDE_CODE_OAUTH_TOKEN);

delete process.env[SENTINEL];
console.log(`\nCLAUDE-OAUTH FORWARD SMOKE ${failures === 0 ? "OK ✅" : "FAILED ❌"}`);
process.exit(failures === 0 ? 0 : 1);
