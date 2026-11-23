import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelCatalog, ModelCatalogOpts } from "@cotal-ai/core";
import { launchEnv } from "@cotal-ai/connector-core";
import { CLAUDE_PROVIDER_KEYS } from "./provider-keys.js";

/** Flags for asking `claude` which models its login can use. With them `claude` reads one `initialize`
 *  control request over stream-json and answers before any user message exists, so asking starts no
 *  turn and spends no tokens. The rest keep the question from starting anything the operator
 *  configured: no MCP server (their own `cotal` server included), no hook and no saved session. */
const MODELS_ARGS = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--strict-mcp-config", "--settings", '{"disableAllHooks":true}', "--no-session-persistence"];
const MODELS_REQUEST_ID = "cotal-models";

interface ControlLine {
  type?: unknown;
  response?: {
    request_id?: unknown;
    subtype?: unknown;
    error?: unknown;
    response?: { models?: unknown; account?: { tokenSource?: unknown; apiKeySource?: unknown } };
  };
}

const unavailable = (why: string): ModelCatalog => ({ models: [], unavailable: why });

function isModelRow(row: unknown): row is { value: string; displayName: string } {
  const { value, displayName } = (row ?? {}) as { value?: unknown; displayName?: unknown };
  return typeof value === "string" && typeof displayName === "string";
}

function initializeAnswer(text: string): ModelCatalog | undefined {
  let line: ControlLine | null;
  try {
    line = JSON.parse(text);
  } catch {
    return undefined;
  }
  const answer = line?.response;
  if (line?.type !== "control_response" || answer?.request_id !== MODELS_REQUEST_ID) return undefined;
  if (answer.subtype === "error") return unavailable(`claude refused to list its models: ${String(answer.error)}`);
  const result = answer.subtype === "success" ? answer.response : undefined;
  // Logged out, claude still answers, with its built-in aliases, and no seat of this install can run one.
  if (result?.account?.tokenSource === "none" && !result.account.apiKeySource) return unavailable("claude is not logged in; run claude to log in");
  const rows = result?.models;
  if (!Array.isArray(rows) || !rows.every(isModelRow)) return unavailable("claude answered without a model list");
  // `default` points at claude's own default model, which a launch that names no model gets anyway.
  return { source: "claude stream-json initialize", models: rows.filter((m) => m.value !== "default").map((m) => ({ id: m.value, name: m.displayName })) };
}

export async function listClaudeModels(opts: ModelCatalogOpts = {}): Promise<ModelCatalog> {
  // claude applies the settings of the project it runs in, so it runs in an empty private directory.
  const cwd = mkdtempSync(join(tmpdir(), "cotal-claude-models-"));
  const env = launchEnv({ providerKeys: CLAUDE_PROVIDER_KEYS });
  let child: ChildProcess | undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await new Promise<ModelCatalog>((settle) => {
      const claude = (child = spawn(opts.resolvedBinaries?.claude ?? "claude", MODELS_ARGS, { cwd, env, stdio: ["pipe", "pipe", "ignore"] }));
      // The bound also cuts short stopClaude's grace, so the whole read ends within 6s.
      timer = setTimeout(() => {
        settle(unavailable("claude did not list its models within 6s"));
        claude.kill("SIGKILL");
      }, 6_000);
      claude.on("error", (e) => settle(unavailable(`claude could not start: ${e.message}`)));
      // `close` follows the last `data` event, so an answer written just before exit is read first.
      claude.on("close", (code, signal) => settle(unavailable(`claude exited (${code ?? signal}) before it listed its models`)));
      // Without this listener, writing to a child that already closed its input is an unhandled error that stops the manager.
      claude.stdin.on("error", (e) => settle(unavailable(`claude stopped reading before it listed its models: ${e.message}`)));
      let buf = "";
      claude.stdout.setEncoding("utf8");
      claude.stdout.on("data", (chunk: string) => {
        buf += chunk;
        for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
          const answer = initializeAnswer(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
          if (answer) settle(answer);
        }
      });
      claude.stdin.write(JSON.stringify({ type: "control_request", request_id: MODELS_REQUEST_ID, request: { subtype: "initialize" } }) + "\n");
    });
  } finally {
    if (child) await stopClaude(child);
    clearTimeout(timer);
    rmSync(cwd, { recursive: true, force: true });
  }
}

/** After it answers, claude still rewrites its config in the user's home, and it removes the session it
 *  registered there only as it exits. A kill skips both. Closing its input makes claude exit on its own,
 *  so it is killed only if it is still running a second later. */
async function stopClaude(claude: ChildProcess): Promise<void> {
  if (claude.exitCode !== null || claude.signalCode !== null) return;
  const exited = new Promise((done) => claude.once("exit", done));
  claude.stdin!.end();
  const force = setTimeout(() => claude.kill("SIGKILL"), 1_000);
  await exited;
  clearTimeout(force);
}
