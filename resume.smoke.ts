/**
 * Resume launch composition — argv assertions (no mesh). Verifies the claude connector folds
 * `--resume <id> --fork-session` into the launch while keeping the strict-MCP isolation and
 * dropping the auto-submitted greeting, and that the `--in-place` fork toggle drops `--fork-session`.
 * Resume is claude-only (other connectors ignore the flag, like `prompt`).
 * Run: pnpm smoke:resume
 */
import { strict as assert } from "node:assert";
import { claudeConnector } from "@cotal-ai/connector-claude-code";

let pass = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, `${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

const base = { space: "rs", name: "canary" };

// claude: resume folds in `--resume <id> --fork-session` and keeps the strict-MCP isolation.
const spec = claudeConnector.buildLaunch({ ...base, resume: "sess-123" });
const a = spec.args;
check("claude args include --resume", a.includes("--resume"), a);
check("--resume is immediately followed by the session id", a[a.indexOf("--resume") + 1] === "sess-123", a);
check("--fork-session present (original session not hijacked)", a.includes("--fork-session"), a);
check("strict-mcp isolation preserved alongside resume", a.includes("--strict-mcp-config"), a);

// The greeting prompt is skipped on resume (a resumed session already has its context); without
// resume the prompt IS the leading positional (auto-submitted).
const resumedWithPrompt = claudeConnector.buildLaunch({ ...base, resume: "sess-123", prompt: "hello there" });
check("greeting prompt is NOT auto-submitted on resume", !resumedWithPrompt.args.includes("hello there"), resumedWithPrompt.args);
const freshWithPrompt = claudeConnector.buildLaunch({ ...base, prompt: "hello there" });
check("greeting prompt IS the leading positional when not resuming", freshWithPrompt.args[0] === "hello there", freshWithPrompt.args);

// fork toggle: `cotal spawn --in-place` (fork:false) continues the SAME id — keeps --resume,
// drops --fork-session — while the default (fork undefined) still forks. Powers the late-join modes.
const inPlace = claudeConnector.buildLaunch({ ...base, resume: "sess-123", fork: false });
check("in-place resume keeps --resume", inPlace.args.includes("--resume"), inPlace.args);
check("in-place resume omits --fork-session (same id continues)", !inPlace.args.includes("--fork-session"), inPlace.args);
check("default resume still forks when fork is unset", spec.args.includes("--fork-session"), spec.args);

console.log(`\nresume smoke: ${pass} checks passed`);
process.exit(0);
