/**
 * The Codex connector's naming request (SPEC 13.22, labels from the first message): one ephemeral
 * `codex exec` on the seat's own CODEX_HOME and launch config, so on the seat's login, provider and
 * model, at low reasoning and never on Codex's priority (Fast) tier. It runs in an empty private
 * directory under a read-only sandbox, without the seat's MCP servers or any config file in its
 * CODEX_HOME, with web search and every tool feature in {@link TOOL_FEATURES} off, and saves no session. The request goes in on stdin, never in argv.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentNaming, NameFromMessage } from "@cotal-ai/connector-core";

/** The codex features that give the model a tool or run a command, on by default in codex-cli 0.170.0
 *  (`codex features list`). The request turns each off with `--disable`, which wins over the seat's own
 *  `-c features…` in either order. `codex exec` refuses a feature name it does not know, so a codex
 *  without one of them fails the request and the seat shows no label. */
export const TOOL_FEATURES = [
  "apps", "browser_annotation_api", "browser_use", "browser_use_external", "browser_use_full_cdp_access", "computer_use",
  "goals", "hooks", "image_generation", "in_app_browser", "multi_agent", "plugins", "remote_plugin", "shell_snapshot",
  "shell_tool", "skill_mcp_dependency_install", "skill_search", "sleep_tool", "tool_suggest", "unified_exec", "view_image",
] as const;

export interface CodexNamingSeat {
  bin: string;
  codexHome: string;
  /** The seat's own `-c` overrides, without its MCP servers. */
  overrides: readonly (readonly [string, string])[];
  /** The model the seat's thread runs, once known. Read when the request is made. */
  model(): string | undefined;
  launchPrompt?: string;
}

/** The naming for the codex seat `seat`. */
export function codexNaming(seat: CodexNamingSeat): AgentNaming {
  return { request: codexNameFromMessage(seat), launchPrompt: seat.launchPrompt };
}

function codexNameFromMessage(seat: CodexNamingSeat): NameFromMessage {
  return async ({ system, prompt, signal }) => {
    const cwd = mkdtempSync(join(tmpdir(), "cotal-codex-name-"));
    const answer = join(cwd, "answer.txt");
    try {
      const run = await execOnce(seat, cwd, answer, `${system}\n\n${prompt}`, signal);
      if (run.code !== 0) throw new Error(`codex did not answer: ${run.failure}`);
      return readFileSync(answer, "utf8");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  };
}

function execArgs(seat: CodexNamingSeat, answer: string): string[] {
  const model = seat.model();
  const tier = seat.overrides.find(([k]) => k === "service_tier")?.[1].trim().replace(/^(["'])(.*)\1$/, "$2");
  // A later `-c` wins, so these take the seat's reasoning, sandbox, web search and a priority tier down for this one request.
  const overrides: (readonly [string, string])[] = [
    ...seat.overrides,
    ...(model && !seat.overrides.some(([k]) => k === "model") ? [["model", JSON.stringify(model)] as const] : []),
    ["model_reasoning_effort", '"low"'],
    ["sandbox_mode", '"read-only"'],
    ["web_search", '"disabled"'],
    ...(tier === "priority" ? [["service_tier", '"default"'] as const] : []),
  ];
  return [
    "exec", "--ephemeral", "--skip-git-repo-check", "--ignore-rules", "--ignore-user-config", "--json", "--output-last-message", answer,
    ...TOOL_FEATURES.flatMap((f) => ["--disable", f]),
    ...overrides.flatMap(([k, v]) => ["-c", `${k}=${v}`]),
    "-",
  ];
}

function execOnce(seat: CodexNamingSeat, cwd: string, answer: string, input: string, signal: AbortSignal): Promise<{ code: number | null; failure: string }> {
  const env: Record<string, string> = { CODEX_HOME: seat.codexHome };
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("COTAL_") && k !== "CODEX_HOME") env[k] = v;
  return new Promise((resolve, reject) => {
    const child = spawn(seat.bin, execArgs(seat, answer), { cwd, env, signal, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let failure = "";
    let err = "";
    let buf = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => {
      buf += d;
      for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
        failure = failureOf(buf.slice(0, nl)) ?? failure;
        buf = buf.slice(nl + 1);
      }
    });
    child.stderr.setEncoding("utf8").on("data", (d: string) => (err = (err + d).slice(-2_000)));
    child.stdin.on("error", () => {}); // a codex that exits early is reported by `close` below
    // `close` follows a failed start and an abort too, so the directory is removed only once codex is gone.
    let failed: Error | undefined;
    child.on("error", (e) => (failed ??= e));
    child.on("close", (code) => (failed ? reject(failed) : resolve({ code, failure: failure || err.trim() || `codex exited with ${code}` })));
    child.stdin.end(input);
  });
}

/** The reason in one `codex exec --json` line that failed the turn. */
function failureOf(line: string): string | undefined {
  try {
    const e = JSON.parse(line) as { type?: unknown; error?: { message?: unknown } };
    return e.type === "turn.failed" && typeof e.error?.message === "string" ? e.error.message : undefined;
  } catch {
    return undefined;
  }
}
