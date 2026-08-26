/**
 * Launch-env allow-list (no test runner).
 *
 * A spawned Hermes seat receives the OS allow-list, OPERATOR_ENV_KEEP, and this connector's
 * declared provider keys. Host-session markers and unrelated operator secrets stay out unless
 * named on spawn.env. Per-session COTAL_* never crosses from this process into the child.
 *
 * Run: pnpm --filter @cotal-ai/connector-hermes test
 */
import { strict as assert } from "node:assert";
import { hermesConnector } from "../src/extension.js";

if (process.platform === "win32") {
  console.log("✓ launch-env smoke skipped on Windows (the Hermes connector is Unix-only; buildLaunch throws)");
  process.exit(0);
}

/** The provider keys this connector declares. They must still arrive. */
const PROVIDER_KEYS = [
  "OPENCODE_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "NOUS_API_KEY",
  "OPENCODE_GO_API_KEY", "OPENCODE_ZEN_API_KEY", "XAI_API_KEY", "GEMINI_API_KEY", "NOVITA_API_KEY",
  "DEEPSEEK_API_KEY", "GLM_API_KEY", "ZAI_API_KEY", "Z_AI_API_KEY", "KIMI_API_KEY",
  "KIMI_CODING_API_KEY", "KIMI_CN_API_KEY", "MINIMAX_API_KEY", "MINIMAX_CN_API_KEY",
  "DASHSCOPE_API_KEY", "ALIBABA_CODING_PLAN_API_KEY", "STEPFUN_API_KEY", "ARCEEAI_API_KEY",
  "GMI_API_KEY", "NVIDIA_API_KEY", "KILOCODE_API_KEY", "XIAOMI_API_KEY", "TOKENHUB_API_KEY",
  "OLLAMA_API_KEY", "AZURE_FOUNDRY_API_KEY",
] as const;

/** Host / VCS / cloud names this connector does not declare. None may cross on the default path. */
const FORMERLY_EXCLUDED = [
  "GH_TOKEN", "GITHUB_TOKEN", "COPILOT_GITHUB_TOKEN", "HF_TOKEN", "ANTHROPIC_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN", "GOOGLE_API_KEY", "LM_API_KEY", "QWEN_API_KEY",
] as const;

const HOST_MARKERS = [
  "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_ENTRYPOINT", "CLAUDECODE",
] as const;

/** One name from every per-session family a connector assigns conditionally. None may cross. */
const PER_SESSION = [
  "COTAL_LAUNCH_MATERIAL", "COTAL_CREDS", "COTAL_SERVERS", "COTAL_CONTROL_TOKEN",
  "COTAL_CONTROL_SOCKET", "COTAL_OWNER", "COTAL_ACTOR", "COTAL_SENTINEL_CREDS", "COTAL_BEARER_CMD",
  "COTAL_LIFECYCLE_UID", "COTAL_ID", "COTAL_ROLE", "COTAL_MODEL", "COTAL_VARIANT",
  "COTAL_AGENT_FILE", "COTAL_LINK", "COTAL_SUBSCRIBE", "COTAL_ALLOW_SUBSCRIBE",
  "COTAL_ALLOW_PUBLISH", "COTAL_CAPABILITIES", "COTAL_EVENTS", "COTAL_WORKSPACE_ROOT",
  "COTAL_CHANNEL", "COTAL_CODEX_HOME", "COTAL_OPENCODE_PROMPT", "COTAL_TOKEN",
] as const;

/** Machine-wide operator knobs that DO cross: no connector assigns them per spawn. */
const OPERATOR_KNOBS = ["COTAL_HOME", "COTAL_FEEDBACK_KEY", "COTAL_CODEX_BIN"] as const;

for (const k of [...PROVIDER_KEYS, ...FORMERLY_EXCLUDED, ...HOST_MARKERS]) process.env[k] = `smoke-${k}`;
for (const k of [...PER_SESSION, ...OPERATOR_KNOBS]) process.env[k] = `parent-${k}`;
process.env.SOME_UNRELATED_SECRET = "smoke-unrelated";

// ── Default allow-list (no operator extras declared) ─────────────────────────────────────────────
const env = hermesConnector.buildLaunch({ space: "smoke", name: "hermes-1" }).env ?? {};

for (const k of PROVIDER_KEYS)
  assert.equal(env[k], `smoke-${k}`, `${k} must reach the child: this connector declares it`);
for (const k of FORMERLY_EXCLUDED)
  assert.ok(!(k in env), `${k} must not reach the child: it is not on this connector's allow-list`);
assert.ok(!("SOME_UNRELATED_SECRET" in env), "an unrelated operator variable is withheld");
for (const k of HOST_MARKERS)
  assert.ok(!(k in env), `${k} leaked from this process into the child: a host-session marker must be withheld`);

for (const k of PER_SESSION)
  assert.ok(!(k in env), `${k} leaked from this process into the child: a per-session name must be reset, not inherited`);

assert.equal(env.COTAL_SPACE, "smoke", "the connector supplies this child's space");
assert.equal(env.COTAL_NAME, "hermes-1", "the connector supplies this child's name");
assert.ok(env.PATH !== undefined, "PATH is forwarded so the seat can still launch");

for (const k of OPERATOR_KNOBS)
  assert.equal(env[k], `parent-${k}`, `${k} is a machine-wide operator knob and must cross`);

// ── Allow-list extras (the operator declared `spawn.env`) ─────────────────────────────────────────
const confined = hermesConnector.buildLaunch({ space: "smoke", name: "hermes-2", envAllow: ["NOUS_API_KEY"] }).env ?? {};

assert.equal(confined.NOUS_API_KEY, "smoke-NOUS_API_KEY", "a declared name is forwarded under containment");
assert.ok(!("GH_TOKEN" in confined), "an undeclared name is withheld under containment");
assert.ok(!("SOME_UNRELATED_SECRET" in confined), "containment means the OS allow-list plus the declared names, nothing else");
assert.ok(confined.PATH !== undefined, "the OS allow-list still carries what the child needs to run");
for (const k of PER_SESSION)
  assert.ok(!(k in confined), `${k} must be absent under containment too`);
for (const k of HOST_MARKERS)
  assert.ok(!(k in confined), `${k} must stay withheld when spawn.env names something else`);

// Opt-in: a persona / operator that names a host marker gets it. The default path never does.
const opted = hermesConnector.buildLaunch({ space: "smoke", name: "hermes-4", envAllow: ["CLAUDE_CODE_CHILD_SESSION"] }).env ?? {};
assert.equal(opted.CLAUDE_CODE_CHILD_SESSION, "smoke-CLAUDE_CODE_CHILD_SESSION", "a host marker named on spawn.env is the explicit opt-in");
assert.ok(!("CLAUDECODE" in opted), "an unnamed host marker stays withheld even when a sibling is opted in");

// An empty array is a POLICY (the OS allow-list alone), not "unset". If this were read as unset the
// child would inherit everything, which is the one way the opt-in could silently fail open.
const bare = hermesConnector.buildLaunch({ space: "smoke", name: "hermes-3", envAllow: [] }).env ?? {};
assert.equal(bare.NOUS_API_KEY, "smoke-NOUS_API_KEY", "empty spawn.env does not drop connector-declared provider keys");
assert.ok(!("GH_TOKEN" in bare), "empty spawn.env still withholds undeclared names");
assert.ok(bare.PATH !== undefined, "an empty spawn.env still carries the OS allow-list");

assert.throws(
  () => hermesConnector.buildLaunch({ space: "smoke", name: "hermes-1", prompt: "greet the operator" }),
  /initial prompt/,
  "a prompt the connector cannot submit must refuse the launch",
);

console.log(
  `launch-env smoke: ${PROVIDER_KEYS.length} declared provider keys forwarded, ` +
    `${FORMERLY_EXCLUDED.length + HOST_MARKERS.length + 1} undeclared names withheld, ` +
    `${PER_SESSION.length} per-session names reset, ${OPERATOR_KNOBS.length} operator knobs crossed, both modes held`,
);
