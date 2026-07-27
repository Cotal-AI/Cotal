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

// ANTHROPIC_API_KEY is NOT a claude-connector model credential: it must NOT reach a spawn by default
// (the connector forwards only CLAUDE_CRED_KEYS), so an API key in the manager shell can't override a
// spawn's login. The ONE documented exception is an operator-shared MCP server that references it via
// `${ANTHROPIC_API_KEY}` — then it rides in on the mcpKeys (shared-secret) path, by design.
const API_KEY = "sk-ant-api-SMOKE-TEST-VALUE";
process.env.ANTHROPIC_API_KEY = API_KEY;
const noApi = claudeConnector.buildLaunch({ space: "smoke", name: "worker-noapi" });
check("ANTHROPIC_API_KEY absent by default (not a claude model cred)", noApi.env.ANTHROPIC_API_KEY === undefined, noApi.env.ANTHROPIC_API_KEY);
const withApi = claudeConnector.buildLaunch({
  space: "smoke",
  name: "worker-mcp",
  mcpServers: { db: { command: "node", env: { KEY: "${ANTHROPIC_API_KEY}" } } },
});
check("ANTHROPIC_API_KEY present ONLY when a shared MCP server references it", withApi.env.ANTHROPIC_API_KEY === API_KEY, withApi.env.ANTHROPIC_API_KEY);
delete process.env.ANTHROPIC_API_KEY;

// token UNSET → absent (named-forward only; a single subscription login is unaffected).
delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
const c = claudeConnector.buildLaunch({ space: "smoke", name: "worker-c" });
check("token ABSENT when the operator has none set", c.env.CLAUDE_CODE_OAUTH_TOKEN === undefined, c.env.CLAUDE_CODE_OAUTH_TOKEN);

delete process.env[SENTINEL];
console.log(`\nCLAUDE-OAUTH FORWARD SMOKE ${failures === 0 ? "OK ✅" : "FAILED ❌"}`);
process.exit(failures === 0 ? 0 : 1);
