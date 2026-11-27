/**
 * Control requests to a headless `claude`, the reads behind the model catalog and the command list a
 * launcher reads before any seat exists.
 */
import { spawn, type ChildProcess } from "node:child_process";

/** With these flags `claude` answers control requests over stream-json before any user message
 *  exists, so asking starts no turn and spends no tokens. The rest keep the question from starting
 *  anything the operator configured: no MCP server (their own `cotal` server included), no hook or
 *  mod, and no saved session. */
const PROBE_ARGS = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--strict-mcp-config", "--no-session-persistence"];
/** claude keeps only the last `--settings` it is given, so a probe's own settings ride in the same one. */
const PROBE_SETTINGS = { disableAllHooks: true };

/** The fields of the `initialize` answer the connector reads. */
export interface InitializeResponse {
  models?: unknown;
  commands?: unknown;
  claude_code_version?: unknown;
  account?: { tokenSource?: unknown; apiKeySource?: unknown };
  fast_mode_state?: unknown;
}

interface ControlLine {
  type?: unknown;
  response?: { request_id?: unknown; subtype?: unknown; error?: unknown; response?: Record<string, unknown> };
}

/** The control response on one line of claude's output, by the request it answers. */
function replyOf(text: string): { id: string; error?: string; answer: Record<string, unknown> } | undefined {
  let line: ControlLine | null;
  try {
    line = JSON.parse(text);
  } catch {
    return undefined;
  }
  const reply = line?.response;
  if (line?.type !== "control_response" || typeof reply?.request_id !== "string") return undefined;
  if (reply.subtype === "error") return { id: reply.request_id, error: String(reply.error), answer: {} };
  return { id: reply.request_id, answer: (reply.subtype === "success" ? reply.response : undefined) ?? {} };
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
  /** Settings claude starts with, beside the hooks it never runs for a probe. */
  settings?: Record<string, unknown>;
}

/** Sends one control request and resolves with claude's answer, or rejects when claude refused it or
 *  the read failed. Requests are answered in the order they are sent. */
export type AskClaude = (request: { subtype: string } & Record<string, unknown>) => Promise<Record<string, unknown>>;

/** What a read produced, or why there is none. */
export type ControlAnswer<T> = { value: T } | { failed: string };

/** The answer claude gave, or why there is none. */
export type InitializeAnswer = { response: InitializeResponse } | { failed: string };

/** Starts a headless claude, runs `read` against it, and stops claude. A refused request, an exit, a
 *  failed start or the bound ends the read with the reason, and so does an error `read` throws. */
export async function claudeControl<T>(o: InitializeProbe, read: (ask: AskClaude) => Promise<T>): Promise<ControlAnswer<T>> {
  let child: ChildProcess | undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await new Promise<ControlAnswer<T>>((settle) => {
      const waiting = new Map<string, { resolve: (answer: Record<string, unknown>) => void; reject: (e: Error) => void }>();
      let ended: string | undefined;
      const fail = (why: string) => {
        ended ??= why;
        for (const { reject } of waiting.values()) reject(new Error(why));
        waiting.clear();
        settle({ failed: ended });
      };
      const args = [...PROBE_ARGS, "--settings", JSON.stringify({ ...PROBE_SETTINGS, ...o.settings })];
      const claude = (child = spawn(o.bin, args, { cwd: o.cwd, env: o.env, stdio: ["pipe", "pipe", "ignore"], windowsHide: true }));
      // The bound also cuts short stopClaude's grace, so the whole read ends within it.
      timer = setTimeout(() => {
        fail(`claude did not list ${o.what} within ${o.boundMs / 1000}s`);
        claude.kill("SIGKILL");
      }, o.boundMs);
      claude.on("error", (e) => fail(`claude could not start: ${e.message}`));
      // `close` follows the last `data` event, so an answer written just before exit is read first.
      claude.on("close", (code, signal) => fail(`claude exited (${code ?? signal}) before it listed ${o.what}`));
      // Without this listener, writing to a child that already closed its input is an unhandled error that stops the manager.
      claude.stdin.on("error", (e) => fail(`claude stopped reading before it listed ${o.what}: ${e.message}`));
      let buf = "";
      claude.stdout.setEncoding("utf8");
      claude.stdout.on("data", (chunk: string) => {
        buf += chunk;
        for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
          const reply = replyOf(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
          const asked = reply && waiting.get(reply.id);
          if (!reply || !asked) continue;
          waiting.delete(reply.id);
          if (reply.error !== undefined) asked.reject(new Error(`claude refused to list ${o.what}: ${reply.error}`));
          else asked.resolve(reply.answer);
        }
      });
      let sent = 0;
      const ask: AskClaude = (request) => {
        if (ended !== undefined) return Promise.reject(new Error(ended));
        const id = `cotal-${++sent}`;
        const asked = new Promise<Record<string, unknown>>((resolve, reject) => waiting.set(id, { resolve, reject }));
        claude.stdin.write(JSON.stringify({ type: "control_request", request_id: id, request }) + "\n");
        return asked;
      };
      read(ask).then(
        (value) => settle({ value }),
        (e: unknown) => fail(e instanceof Error ? e.message : String(e)),
      );
    });
  } finally {
    if (child) await stopClaude(child);
    clearTimeout(timer);
  }
}

export async function claudeInitialize(o: InitializeProbe): Promise<InitializeAnswer> {
  const answer = await claudeControl(o, (ask) => ask({ subtype: "initialize" }));
  return "failed" in answer ? answer : { response: answer.value };
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
