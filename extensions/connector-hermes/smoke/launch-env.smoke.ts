/**
 * Launch-env key forwarding (no test runner) — the connector must forward EVERY key in
 * HERMES_PROVIDER_KEYS into the launcher env (a single missing name silently locks a
 * provider out of managed/containerized spawns), and ONLY named keys (P3): the full
 * documented exclusion set — generic cross-tool credentials, cloud-wide keys, and unused
 * profile metadata — must never reach the gateway child.
 * Run: pnpm --filter @cotal-ai/connector-hermes test
 */
import { strict as assert } from "node:assert";
import { hermesConnector, HERMES_PROVIDER_KEYS } from "../src/extension.js";

if (process.platform === "win32") {
  console.log("✓ launch-env smoke skipped on Windows (the Hermes connector is Unix-only; buildLaunch throws)");
  process.exit(0);
}

/** Independent snapshot of the complete allow-list (shared MODEL_PROVIDER_KEYS + the
 *  hermes 0.16 registry's dedicated key names). Deliberately NOT derived from the
 *  production export: set-equality against it below is what catches a key silently
 *  dropped from (or smuggled into) HERMES_PROVIDER_KEYS — the exact escape path of the
 *  original NOVITA_API_KEY regression. A legitimate list change edits both places. */
const EXPECTED_KEYS = [
  // shared MODEL_PROVIDER_KEYS
  "OPENCODE_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "NOUS_API_KEY",
  "NEBIUS_API_KEY",
  // hermes-registry dedicated keys
  "OPENCODE_GO_API_KEY",
  "OPENCODE_ZEN_API_KEY",
  "XAI_API_KEY",
  "GEMINI_API_KEY",
  "NOVITA_API_KEY",
  "DEEPSEEK_API_KEY",
  "GLM_API_KEY",
  "ZAI_API_KEY",
  "Z_AI_API_KEY",
  "KIMI_API_KEY",
  "KIMI_CODING_API_KEY",
  "KIMI_CN_API_KEY",
  "MINIMAX_API_KEY",
  "MINIMAX_CN_API_KEY",
  "DASHSCOPE_API_KEY",
  "ALIBABA_CODING_PLAN_API_KEY",
  "STEPFUN_API_KEY",
  "ARCEEAI_API_KEY",
  "GMI_API_KEY",
  "NVIDIA_API_KEY",
  "KILOCODE_API_KEY",
  "XIAOMI_API_KEY",
  "TOKENHUB_API_KEY",
  "OLLAMA_API_KEY",
  "AZURE_FOUNDRY_API_KEY",
] as const;

/** The full exclusion boundary the extension documents — names Hermes can read but the
 *  connector must NOT forward. Keep in sync with the HERMES_PROVIDER_KEYS doc comment. */
const EXCLUDED = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "COPILOT_GITHUB_TOKEN",
  "HF_TOKEN",
  "ANTHROPIC_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "GOOGLE_API_KEY",
  "LM_API_KEY",
  "QWEN_API_KEY",
] as const;

// The production list must match the snapshot exactly — both directions.
assert.deepEqual(
  [...HERMES_PROVIDER_KEYS].sort(),
  [...EXPECTED_KEYS].sort(),
  "HERMES_PROVIDER_KEYS drifted from the smoke's expected-key snapshot — a dropped or added key must be a deliberate two-place change",
);

for (const key of EXPECTED_KEYS) process.env[key] = `smoke-${key}`;
for (const key of EXCLUDED) process.env[key] = `smoke-${key}`;
process.env.SOME_UNRELATED_SECRET = "smoke-unrelated";

const spec = hermesConnector.buildLaunch({ space: "smoke", name: "hermes-1" });
const env = spec.env ?? {};

// Every expected provider key flows — completeness against the snapshot, not samples.
for (const key of EXPECTED_KEYS)
  assert.equal(env[key], `smoke-${key}`, `${key} was stripped from the launch env`);

// The P3 boundary holds: the whole exclusion set and unrelated secrets stay out.
for (const key of EXCLUDED)
  assert.ok(!(key in env), `${key} must not be forwarded to the gateway`);
assert.ok(!("SOME_UNRELATED_SECRET" in env), "unrelated env secrets must not be forwarded");

// An exclusion appearing on the allow-list is a policy contradiction, not coverage.
for (const key of EXCLUDED)
  assert.ok(!HERMES_PROVIDER_KEYS.includes(key), `${key} is both allow-listed and excluded`);

// An initial prompt has no carrier into the gateway yet: it is refused at launch, never dropped.
assert.throws(
  () => hermesConnector.buildLaunch({ space: "smoke", name: "hermes-1", prompt: "greet the operator" }),
  /initial prompt/,
  "a prompt the connector cannot submit must refuse the launch",
);

console.log(
  `launch-env smoke: ${HERMES_PROVIDER_KEYS.length} provider keys forwarded, ${EXCLUDED.length} exclusions held, P3 boundary intact`,
);
