/**
 * A short-lived pi in RPC mode, the read behind the model catalog and the command list a launcher
 * reads before any seat exists.
 */
import { spawn, type ChildProcess } from "node:child_process";

/** pi's answer to one RPC command (docs/rpc-commands.md in the pi install). */
export interface PiRpcResponse {
  id?: unknown;
  type?: unknown;
  success?: unknown;
  error?: unknown;
  data?: { models?: unknown; commands?: unknown; levels?: unknown };
}

export interface PiRpcAsk {
  bin: string;
  /** Flags after `--mode rpc`. */
  args: readonly string[];
  cwd?: string;
  env: Record<string, string>;
  /** The bound on the whole conversation, from start to the last answer. */
  boundMs: number;
}

/** Sends pi one RPC command, such as `{ type: "get_commands" }`, and resolves with its answer. */
export type PiAsk = (command: { type: string } & Record<string, unknown>) => Promise<PiRpcResponse>;

/** What `use` resolved with, or why pi gave no answer. */
export type PiRpcAnswer<T> = { reply: T } | { failed: string };

/** Starts pi, runs `use` against it and stops pi. Once pi fails, an unanswered ask never settles and
 *  the failure is the answer. */
export async function askPi<T>(o: PiRpcAsk, use: (ask: PiAsk) => Promise<T>): Promise<PiRpcAnswer<T>> {
  const child = spawn(o.bin, ["--mode", "rpc", ...o.args], { cwd: o.cwd, env: o.env, stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
  try {
    return await new Promise<PiRpcAnswer<T>>((resolve, reject) => {
      const done = (answer: PiRpcAnswer<T>): void => {
        clearTimeout(timer);
        resolve(answer);
      };
      const failed = (why: string): void => done({ failed: why });
      const waiting = new Map<string, (reply: PiRpcResponse) => void>();
      let pending = "its first command";
      const timer = setTimeout(() => failed(`pi did not answer ${pending} within ${o.boundMs / 1000}s`), o.boundMs);
      let buf = "";
      child.stdout!.setEncoding("utf8");
      child.stdout!.on("data", (d: string) => {
        buf += d;
        let nl: number;
        // pi frames records on LF only; a JSON string may hold U+2028, so no generic line reader.
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, "");
          buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          let record: PiRpcResponse;
          try {
            record = JSON.parse(line) as PiRpcResponse;
          } catch {
            return failed("pi wrote a line that is not JSON to its RPC output");
          }
          const answered = record?.type === "response" && typeof record.id === "string" ? waiting.get(record.id) : undefined;
          answered?.(record);
        }
      });
      child.on("error", (e: NodeJS.ErrnoException) => failed(`pi could not be started (${e.code ?? e.message})`));
      // `close` follows the end of stdout, so a reply written just before exit is read first.
      child.on("close", (code, signal) => failed(`pi exited (${signal ?? code}) before ${pending} answered`));
      child.stdin!.on("error", (e) => failed(`pi closed its input before ${pending} answered (${e.message})`));
      let asked = 0;
      const ask: PiAsk = (command) =>
        new Promise((answer) => {
          const id = `cotal-${++asked}`;
          pending = command.type;
          waiting.set(id, answer);
          child.stdin!.write(JSON.stringify({ ...command, id }) + "\n");
        });
      use(ask).then((reply) => done({ reply }), (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      });
    });
  } finally {
    stopPi(child);
  }
}

/** Closing stdin and SIGTERM together start pi's orderly shutdown, which also stops the MCP
 *  servers it started. */
function stopPi(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.stdin!.end();
  child.kill("SIGTERM");
  const force = setTimeout(() => child.kill("SIGKILL"), 5_000);
  force.unref();
  child.once("exit", () => clearTimeout(force));
}
