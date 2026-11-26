/**
 * One `initialize` control request to a headless `claude`, the read behind the model catalog and the
 * command list a launcher reads before any seat exists.
 */
import { spawn, type ChildProcess } from "node:child_process";

/** With these flags `claude` reads one `initialize` control request over stream-json and answers
 *  before any user message exists, so asking starts no turn and spends no tokens. The rest keep the
 *  question from starting anything the operator configured: no MCP server (their own `cotal` server
 *  included), no hook or mod, and no saved session. */
const PROBE_ARGS = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--strict-mcp-config", "--settings", '{"disableAllHooks":true}', "--no-session-persistence"];
const REQUEST_ID = "cotal-initialize";

/** The fields of the answer the connector reads. */
export interface InitializeResponse {
  models?: unknown;
  commands?: unknown;
  claude_code_version?: unknown;
  account?: { tokenSource?: unknown; apiKeySource?: unknown };
}

interface ControlLine {
  type?: unknown;
  response?: { request_id?: unknown; subtype?: unknown; error?: unknown; response?: InitializeResponse };
}

export interface InitializeProbe {
  bin: string;
  /** Where claude runs. It applies the settings and lists the commands of the project it runs in. */
  cwd: string;
  env: Record<string, string>;
  /** The whole read, from the start to claude's exit, ends within this bound. */
  boundMs: number;
  /** What the answer is for, completing "claude did not list …", such as "its models". */
  what: string;
}

/** The answer claude gave, or why there is none. */
export type InitializeAnswer = { response: InitializeResponse } | { failed: string };

function answerOf(text: string, what: string): InitializeAnswer | undefined {
  let line: ControlLine | null;
  try {
    line = JSON.parse(text);
  } catch {
    return undefined;
  }
  const answer = line?.response;
  if (line?.type !== "control_response" || answer?.request_id !== REQUEST_ID) return undefined;
  if (answer.subtype === "error") return { failed: `claude refused to list ${what}: ${String(answer.error)}` };
  return { response: (answer.subtype === "success" ? answer.response : undefined) ?? {} };
}

export async function claudeInitialize(o: InitializeProbe): Promise<InitializeAnswer> {
  let child: ChildProcess | undefined;
  let timer: NodeJS.Timeout | undefined;
  const failed = (why: string): InitializeAnswer => ({ failed: why });
  try {
    return await new Promise<InitializeAnswer>((settle) => {
      const claude = (child = spawn(o.bin, PROBE_ARGS, { cwd: o.cwd, env: o.env, stdio: ["pipe", "pipe", "ignore"], windowsHide: true }));
      // The bound also cuts short stopClaude's grace, so the whole read ends within it.
      timer = setTimeout(() => {
        settle(failed(`claude did not list ${o.what} within ${o.boundMs / 1000}s`));
        claude.kill("SIGKILL");
      }, o.boundMs);
      claude.on("error", (e) => settle(failed(`claude could not start: ${e.message}`)));
      // `close` follows the last `data` event, so an answer written just before exit is read first.
      claude.on("close", (code, signal) => settle(failed(`claude exited (${code ?? signal}) before it listed ${o.what}`)));
      // Without this listener, writing to a child that already closed its input is an unhandled error that stops the manager.
      claude.stdin.on("error", (e) => settle(failed(`claude stopped reading before it listed ${o.what}: ${e.message}`)));
      let buf = "";
      claude.stdout.setEncoding("utf8");
      claude.stdout.on("data", (chunk: string) => {
        buf += chunk;
        for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
          const answer = answerOf(buf.slice(0, nl), o.what);
          buf = buf.slice(nl + 1);
          if (answer) settle(answer);
        }
      });
      claude.stdin.write(JSON.stringify({ type: "control_request", request_id: REQUEST_ID, request: { subtype: "initialize" } }) + "\n");
    });
  } finally {
    if (child) await stopClaude(child);
    clearTimeout(timer);
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
