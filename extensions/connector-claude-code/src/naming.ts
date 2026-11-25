/**
 * The Claude Code connector's naming request (SPEC 13.22, labels from the first message): one
 * `claude -p` run on the session's own login, outside its conversation. It runs with no tools, no MCP
 * server, no hook and no saved session, in an empty private directory so no project settings or
 * CLAUDE.md apply. The message goes in on stdin, never in argv.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchEnv, type AgentNaming, type NameFromMessage } from "@cotal-ai/connector-core";
import { CLAUDE_PROVIDER_KEYS } from "./provider-keys.js";

const NAME_ARGS = ["-p", "--output-format", "json", "--tools", "", "--strict-mcp-config", "--settings", '{"disableAllHooks":true}', "--no-session-persistence"];

/** The launcher's absolute `claude`, carried for a seat that labels itself, so the request runs the
 *  binary the seat runs rather than resolving PATH again. */
export const CLAUDE_RESOLVED_BIN_ENV = "COTAL_CLAUDE_RESOLVED_BIN";
/** A seat's launch prompt, carried for a seat that labels itself: the MCP server is not told the
 *  first turn `claude` was started with. */
export const CLAUDE_PROMPT_ENV = "COTAL_CLAUDE_PROMPT";

/** The naming for a session launched with `env`, on `model` when the launch pinned one. */
export function claudeNaming(env: NodeJS.ProcessEnv, model: string | undefined): AgentNaming {
  return { request: claudeNameFromMessage(env, model), launchPrompt: env[CLAUDE_PROMPT_ENV] };
}

function claudeNameFromMessage(env: NodeJS.ProcessEnv, model: string | undefined): NameFromMessage {
  const binary = env[CLAUDE_RESOLVED_BIN_ENV]?.trim() || "claude";
  const childEnv = launchEnv({ providerKeys: CLAUDE_PROVIDER_KEYS }, env);
  return async ({ system, prompt, signal }) => {
    const cwd = mkdtempSync(join(tmpdir(), "cotal-claude-name-"));
    try {
      return await new Promise<string>((resolve, reject) => {
        const args = [...NAME_ARGS, "--system-prompt", system, ...(model ? ["--model", model] : [])];
        const child = spawn(binary, args, { cwd, env: childEnv, signal, stdio: ["pipe", "pipe", "pipe"] });
        let out = "";
        let err = "";
        child.stdout.setEncoding("utf8").on("data", (d: string) => (out += d));
        child.stderr.setEncoding("utf8").on("data", (d: string) => (err = (err + d).slice(-2_000)));
        child.stdin.on("error", () => {}); // a claude that exits early is reported by `close` below
        // `close` follows a failed start and an abort too, so the directory is removed only once claude is gone.
        let failed: Error | undefined;
        child.on("error", (e) => (failed ??= e));
        child.on("close", (code) => {
          try {
            if (failed) throw failed;
            resolve(claudeAnswer(out, err, code));
          } catch (e) {
            reject(e);
          }
        });
        child.stdin.end(prompt);
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  };
}

/** The text of `claude -p --output-format json`'s one result object. Throws with claude's own error
 *  text when the run failed. */
function claudeAnswer(out: string, err: string, code: number | null): string {
  let r: { type?: unknown; is_error?: unknown; result?: unknown } | undefined;
  try {
    r = JSON.parse(out);
  } catch {
    // Not a result object: reported from stderr or the exit code below.
  }
  if (r?.type === "result" && r.is_error === false && typeof r.result === "string") return r.result;
  const why = typeof r?.result === "string" && r.result ? r.result : err.trim() || `claude exited with ${code}`;
  throw new Error(`claude did not answer: ${why}`);
}
