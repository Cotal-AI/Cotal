/*
 * One Cotal path per Claude Code session, through the shipped hook bundle (`dist/hook.cjs`, the file
 * the plugin's hooks.json runs). A session Cotal launched refuses every Cotal tool of any server other
 * than its local one, with or without a reachable control socket. A plain session keeps the hosted
 * connector, and every other event and tool passes through to the relay unchanged.
 *
 * Run: pnpm smoke:claude-one-path
 * Graded: node scripts/mutation-proof.mjs --config extensions/connector-claude-code/smoke/mutations/one-path.json
 */
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ONE_PATH_REASON } from "../src/one-path.js";

const here = dirname(fileURLToPath(import.meta.url));
const hookBundle = join(here, "..", "dist", "hook.cjs");
const dir = mkdtempSync(join(tmpdir(), "cotal-one-path-"));

// Whatever runs this suite may itself be a managed session; its COTAL_ identity must not leak in.
const clean = { ...process.env };
for (const key of Object.keys(clean)) if (key.startsWith("COTAL_")) delete clean[key];
const MANAGED = { COTAL_NAME: "otto" };
// A control endpoint that answers nothing: the refusal must not wait on, or depend on, the socket.
const DEAD_SOCKET = { ...MANAGED, COTAL_CONTROL_SOCKET: join(dir, "absent.sock"), COTAL_CONTROL_TOKEN: "t".repeat(32) };

function runHook(env: Record<string, string>, event: Record<string, unknown>): Promise<{ stdout: string; code: number | null; ms: number }> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [hookBundle], { env: { ...clean, ...env }, stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ stdout: out.trim(), code, ms: Date.now() - started }));
    child.stdin.end(JSON.stringify(event));
  });
}

const preToolUse = (tool_name: string) => ({
  hook_event_name: "PreToolUse",
  session_id: "s1",
  tool_name,
  tool_input: { name: "probe" },
  tool_use_id: "toolu_1",
});

let pass = 0;
const check = (name: string, condition: boolean, extra?: unknown): void => {
  assert.ok(condition, `${name}${extra === undefined ? "" : ` — ${JSON.stringify(extra)}`}`);
  pass++;
  console.log(`  ✓ ${name}`);
};
const denied = (stdout: string): boolean => {
  try {
    const out = JSON.parse(stdout) as { hookSpecificOutput?: Record<string, unknown> };
    return (
      out.hookSpecificOutput?.hookEventName === "PreToolUse" &&
      out.hookSpecificOutput.permissionDecision === "deny" &&
      out.hookSpecificOutput.permissionDecisionReason === ONE_PATH_REASON
    );
  } catch {
    return false;
  }
};

try {
  console.log("one-path smoke:");
  for (const tool of ["mcp__claude_ai_Cotal__cotal_connect", "mcp__claude_ai_Cotal__cotal_send", "mcp__cotal-hosted__cotal_inbox"]) {
    const r = await runHook(MANAGED, preToolUse(tool));
    check(`a launched session refuses the hosted ${tool}`, r.code === 0 && denied(r.stdout), r);
  }
  const dead = await runHook(DEAD_SOCKET, preToolUse("mcp__claude_ai_Cotal__cotal_connect"));
  check("the refusal holds with a dead control socket and does not wait on it", dead.code === 0 && denied(dead.stdout) && dead.ms < 1500, dead);

  for (const tool of ["mcp__cotal__cotal_send", "mcp__plugin_cotal_cotal__cotal_how_to_join", "Bash", "mcp__github__create_issue"]) {
    const r = await runHook(MANAGED, preToolUse(tool));
    check(`a launched session passes ${tool} through`, r.code === 0 && r.stdout === "", r);
  }
  const post = await runHook(MANAGED, { ...preToolUse("mcp__claude_ai_Cotal__cotal_connect"), hook_event_name: "PostToolUse" });
  check("only PreToolUse is refused, not another event naming the hosted tool", post.code === 0 && post.stdout === "", post);

  const plain = await runHook({}, preToolUse("mcp__claude_ai_Cotal__cotal_connect"));
  check("a session Cotal did not launch keeps the hosted connector", plain.code === 0 && plain.stdout === "", plain);

  console.log(`one-path smoke: ${pass} passed`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
