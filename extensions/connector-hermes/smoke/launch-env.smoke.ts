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

for (const key of HERMES_PROVIDER_KEYS) process.env[key] = `smoke-${key}`;
for (const key of EXCLUDED) process.env[key] = `smoke-${key}`;
process.env.SOME_UNRELATED_SECRET = "smoke-unrelated";

const spec = hermesConnector.buildLaunch({ space: "smoke", name: "hermes-1" });
const env = spec.env ?? {};

// Every allow-listed provider key flows — completeness, not samples.
for (const key of HERMES_PROVIDER_KEYS)
  assert.equal(env[key], `smoke-${key}`, `${key} was stripped from the launch env`);

// The P3 boundary holds: the whole exclusion set and unrelated secrets stay out.
for (const key of EXCLUDED)
  assert.ok(!(key in env), `${key} must not be forwarded to the gateway`);
assert.ok(!("SOME_UNRELATED_SECRET" in env), "unrelated env secrets must not be forwarded");

// An exclusion appearing on the allow-list is a policy contradiction, not coverage.
for (const key of EXCLUDED)
  assert.ok(!HERMES_PROVIDER_KEYS.includes(key), `${key} is both allow-listed and excluded`);

console.log(
  `launch-env smoke: ${HERMES_PROVIDER_KEYS.length} provider keys forwarded, ${EXCLUDED.length} exclusions held, P3 boundary intact`,
);
