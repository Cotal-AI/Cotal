/**
 * Launch-env key forwarding (no test runner) — the connector must forward every
 * Hermes-readable model-provider key (HERMES_PROVIDER_KEYS) into the launcher env, and
 * ONLY named keys (P3): a generic cross-tool credential or unrelated secret in the
 * operator's env must never reach the gateway child.
 * Run: pnpm --filter @cotal-ai/connector-hermes test
 */
import { strict as assert } from "node:assert";
import { hermesConnector } from "../src/extension.js";

if (process.platform === "win32") {
  console.log("✓ launch-env smoke skipped on Windows (the Hermes connector is Unix-only; buildLaunch throws)");
  process.exit(0);
}

process.env.OPENCODE_GO_API_KEY = "smoke-opencode-go";
process.env.OPENROUTER_API_KEY = "smoke-openrouter";
process.env.GH_TOKEN = "smoke-generic-vcs-token";
process.env.CLAUDE_CODE_OAUTH_TOKEN = "smoke-claude-session";
process.env.SOME_UNRELATED_SECRET = "smoke-unrelated";

const spec = hermesConnector.buildLaunch({ space: "smoke", name: "hermes-1" });
const env = spec.env ?? {};

// Hermes-specific provider key (the opencode-go regression) and a shared one both flow.
assert.equal(env.OPENCODE_GO_API_KEY, "smoke-opencode-go", "OPENCODE_GO_API_KEY was stripped from the launch env");
assert.equal(env.OPENROUTER_API_KEY, "smoke-openrouter", "OPENROUTER_API_KEY was stripped from the launch env");

// The P3 boundary holds: nothing outside the named allow-list leaks.
assert.ok(!("GH_TOKEN" in env), "GH_TOKEN (generic VCS credential) must not be forwarded");
assert.ok(!("CLAUDE_CODE_OAUTH_TOKEN" in env), "CLAUDE_CODE_OAUTH_TOKEN (Claude session) must not be forwarded");
assert.ok(!("SOME_UNRELATED_SECRET" in env), "unrelated env secrets must not be forwarded");

console.log("launch-env smoke: hermes provider keys forwarded, P3 boundary holds");
