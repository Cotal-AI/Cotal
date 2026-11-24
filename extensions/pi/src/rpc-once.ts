/**
 * One request to a short-lived pi in RPC mode, the read behind the model catalog and the command list
 * a launcher reads before any seat exists.
 */
import { spawn, type ChildProcess } from "node:child_process";

/** pi's answer to one RPC command (docs/rpc-commands.md in the pi install). */
export interface PiRpcResponse {
  id?: unknown;
  type?: unknown;
  success?: unknown;
  error?: unknown;
  data?: { models?: unknown; commands?: unknown };
}

export interface PiRpcAsk {
  bin: string;
  /** Flags after `--mode rpc`. */
  args: readonly string[];
  cwd?: string;
  env: Record<string, string>;
  /** The RPC command, such as `get_commands`. */
  type: string;
  boundMs: number;
}

/** pi's answer, or why there is none. */
export type PiRpcAnswer = { reply: PiRpcResponse } | { failed: string };

const REQUEST_ID = "cotal-request";

export async function askPi(o: PiRpcAsk): Promise<PiRpcAnswer> {
  const child = spawn(o.bin, ["--mode", "rpc", ...o.args], { cwd: o.cwd, env: o.env, stdio: ["pipe", "pipe", "ignore"] });
  try {
    return await new Promise<PiRpcAnswer>((resolve) => {
      const done = (answer: PiRpcAnswer): void => {
        clearTimeout(timer);
        resolve(answer);
      };
      const failed = (why: string): void => done({ failed: why });
      const timer = setTimeout(() => failed(`pi did not answer ${o.type} within ${o.boundMs / 1000}s`), o.boundMs);
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
          if (record?.type === "response" && record.id === REQUEST_ID) return done({ reply: record });
        }
      });
      child.on("error", (e: NodeJS.ErrnoException) => failed(`pi could not be started (${e.code ?? e.message})`));
      // `close` follows the end of stdout, so a reply written just before exit is read first.
      child.on("close", (code, signal) => failed(`pi exited (${signal ?? code}) before ${o.type} answered`));
      child.stdin!.on("error", (e) => failed(`pi closed its input before ${o.type} answered (${e.message})`));
      child.stdin!.write(JSON.stringify({ id: REQUEST_ID, type: o.type }) + "\n");
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
