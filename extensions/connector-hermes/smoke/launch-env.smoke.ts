/**
 * Launch-env inheritance (no test runner) - the deliberately FLIPPED counterpart of the allow-list
 * snapshot this file used to hold.
 *
 * WHY THE OLD CELL COULD NOT SURVIVE. It pinned `HERMES_PROVIDER_KEYS` against an independently
 * written snapshot, so a key silently dropped from the production list reddened here. That list is
 * gone. Cotal no longer decides which inference vendors exist, and a spawned agent inherits the
 * operator's environment, so there is no list left to snapshot.
 *
 * WHAT REPLACES IT, AT THE OLD CELL'S STRENGTH. The old assertion enumerated three sets: 30 provider
 * keys that MUST arrive, 9 excluded credential names that MUST NOT, and one unrelated secret that
 * MUST NOT. This file reuses those exact sets and inverts the last two. That is both the strongest
 * available statement of the new behaviour and the most legible diff: every name this connector used
 * to strip now arrives, on purpose, and the reviewer reads the inversion rather than a weakened
 * assertion. A flip that quietly asserted less than its predecessor would be the failure mode.
 *
 * THE HALF THAT DID NOT FLIP, asserted harder than before. Cotal's own per-session `COTAL_*` must
 * not cross from this process into the child. A connector assigns those CONDITIONALLY - `aclEnv`
 * omits an empty ACL, `materialEnv` returns `{}` with nothing to hand over, `if (opts.role)`,
 * `if (opts.lifecycleUid)` - so an inherited value is never overwritten and would survive into a
 * child that was never granted it. The parent below sets one name from every family that exists
 * (credential, launch material, lifecycle, ACL, identity, event plane, connector-private) and none
 * may appear in the child. `COTAL_LAUNCH_MATERIAL` is the sharpest of them: it names a 0600 file
 * holding a credential and a control token, and it is exactly the variable a deny-list written
 * before it existed would have missed.
 *
 * Run: pnpm --filter @cotal-ai/connector-hermes test
 */
import { strict as assert } from "node:assert";
import { hermesConnector } from "../src/extension.js";

if (process.platform === "win32") {
  console.log("✓ launch-env smoke skipped on Windows (the Hermes connector is Unix-only; buildLaunch throws)");
  process.exit(0);
}

/** The provider keys the retired allow-list named. They must still arrive - not because Cotal
 *  forwards them, but because it no longer removes anything. */
const PROVIDER_KEYS = [
  "OPENCODE_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "NOUS_API_KEY",
  "OPENCODE_GO_API_KEY", "OPENCODE_ZEN_API_KEY", "XAI_API_KEY", "GEMINI_API_KEY", "NOVITA_API_KEY",
  "DEEPSEEK_API_KEY", "GLM_API_KEY", "ZAI_API_KEY", "Z_AI_API_KEY", "KIMI_API_KEY",
  "KIMI_CODING_API_KEY", "KIMI_CN_API_KEY", "MINIMAX_API_KEY", "MINIMAX_CN_API_KEY",
  "DASHSCOPE_API_KEY", "ALIBABA_CODING_PLAN_API_KEY", "STEPFUN_API_KEY", "ARCEEAI_API_KEY",
  "GMI_API_KEY", "NVIDIA_API_KEY", "KILOCODE_API_KEY", "XIAOMI_API_KEY", "TOKENHUB_API_KEY",
  "OLLAMA_API_KEY", "AZURE_FOUNDRY_API_KEY",
] as const;

/** The names the old cell asserted were EXCLUDED. Each now arrives. This is the flip stated at its
 *  full width: the operator's VCS token and cloud credential reach the child, because the operator's
 *  environment is what the child is being given, and pretending otherwise while forwarding HOME was
 *  the dishonesty the old boundary carried. */
const FORMERLY_EXCLUDED = [
  "GH_TOKEN", "GITHUB_TOKEN", "COPILOT_GITHUB_TOKEN", "HF_TOKEN", "ANTHROPIC_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN", "GOOGLE_API_KEY", "LM_API_KEY", "QWEN_API_KEY",
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

/** Machine-wide operator knobs that DO cross: no connector assigns them per spawn, so they cannot
 *  carry one agent's grant into another. */
const OPERATOR_KNOBS = ["COTAL_HOME", "COTAL_FEEDBACK_KEY", "COTAL_CODEX_BIN"] as const;

for (const k of [...PROVIDER_KEYS, ...FORMERLY_EXCLUDED]) process.env[k] = `smoke-${k}`;
for (const k of [...PER_SESSION, ...OPERATOR_KNOBS]) process.env[k] = `parent-${k}`;
process.env.SOME_UNRELATED_SECRET = "smoke-unrelated";

// ── Inherit mode (the default: no operator policy declared) ──────────────────────────────────────
const env = hermesConnector.buildLaunch({ space: "smoke", name: "hermes-1" }).env ?? {};

for (const k of PROVIDER_KEYS)
  assert.equal(env[k], `smoke-${k}`, `${k} must reach the child: Cotal no longer filters provider keys`);
for (const k of FORMERLY_EXCLUDED)
  assert.equal(env[k], `smoke-${k}`, `${k} must reach the child: the operator's environment is inherited whole`);
assert.equal(env.SOME_UNRELATED_SECRET, "smoke-unrelated", "an unrelated operator variable is inherited like any other");

// The reset. A bare buildLaunch takes no creds, no acl, no lifecycle uid and no role, so EVERY name
// below is one the connector does not assign, which is precisely when an inherited value survives.
for (const k of PER_SESSION)
  assert.ok(!(k in env), `${k} leaked from this process into the child: a per-session name must be reset, not inherited`);

// What the connector DOES assign for this child is present and is its own, not the parent's.
assert.equal(env.COTAL_SPACE, "smoke", "the connector supplies this child's space");
assert.equal(env.COTAL_NAME, "hermes-1", "the connector supplies this child's name");

for (const k of OPERATOR_KNOBS)
  assert.equal(env[k], `parent-${k}`, `${k} is a machine-wide operator knob and must cross`);

// ── Allow-list mode (the operator declared `spawn.env`) ──────────────────────────────────────────
const confined = hermesConnector.buildLaunch({ space: "smoke", name: "hermes-2", envAllow: ["NOUS_API_KEY"] }).env ?? {};

assert.equal(confined.NOUS_API_KEY, "smoke-NOUS_API_KEY", "a declared name is forwarded under containment");
assert.ok(!("GH_TOKEN" in confined), "an undeclared name is withheld under containment");
assert.ok(!("SOME_UNRELATED_SECRET" in confined), "containment means the OS allow-list plus the declared names, nothing else");
assert.ok(confined.PATH !== undefined, "the OS allow-list still carries what the child needs to run");
for (const k of PER_SESSION)
  assert.ok(!(k in confined), `${k} must be absent under containment too`);

// An empty array is a POLICY (the OS allow-list alone), not "unset". If this were read as unset the
// child would inherit everything, which is the one way the opt-in could silently fail open.
const bare = hermesConnector.buildLaunch({ space: "smoke", name: "hermes-3", envAllow: [] }).env ?? {};
assert.ok(!("NOUS_API_KEY" in bare), "an empty spawn.env is containment with nothing declared, never an absent policy");
assert.ok(bare.PATH !== undefined, "an empty spawn.env still carries the OS allow-list");

// An initial prompt has no carrier into the gateway yet: it is refused at launch, never dropped.
assert.throws(
  () => hermesConnector.buildLaunch({ space: "smoke", name: "hermes-1", prompt: "greet the operator" }),
  /initial prompt/,
  "a prompt the connector cannot submit must refuse the launch",
);

console.log(
  `launch-env smoke: ${PROVIDER_KEYS.length + FORMERLY_EXCLUDED.length + 1} operator variables inherited, ` +
    `${PER_SESSION.length} per-session names reset, ${OPERATOR_KNOBS.length} operator knobs crossed, both modes held`,
);
