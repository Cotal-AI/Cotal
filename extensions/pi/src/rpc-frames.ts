import type { ChildProcess } from "node:child_process";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

/**
 * pi RPC protocol frames, as used by the Cotal pi connector's TUI host.
 *
 * pi in `--mode rpc` reads NDJSON commands from stdin and emits NDJSON events on
 * stdout. The agent activity events are raw {@link AgentSessionEvent}s (the
 * same type the in-process loop subscribes to); command acknowledgements are
 * `response` frames; extension UI calls (ctx.ui.confirm/select/input/editor/…)
 * arrive as `extension_ui_request` frames and are answered with
 * `extension_ui_response`. Shapes mirrored from the installed pi SDK
 * (modes/rpc/rpc-types.ts + core/agent-session.ts) so this module has no
 * dependency on pi's internal rpc-types export.
 */

/** Commands the host writes to the child's stdin. */
export type RpcCommand =
  | { type: "prompt"; message: string; id?: string }
  | { type: "steer"; message: string; id?: string }
  | { type: "follow_up"; message: string; id?: string }
  | { type: "abort"; id?: string }
  // Extension UI answers. `confirm` -> {confirmed}; `select`/`input`/`editor` -> {value};
  // a dismissed dialog -> {cancelled: true}. All keyed by the request `id`.
  | { type: "extension_ui_response"; id: string; confirmed: boolean }
  | { type: "extension_ui_response"; id: string; value: string }
  | { type: "extension_ui_response"; id: string; cancelled: true };

/** A request from a pi extension for human input (ctx.ui.*). */
export type RpcExtensionUIRequest =
  | { type: "extension_ui_request"; id: string; method: "confirm"; title: string; message: string; timeout?: number }
  | { type: "extension_ui_request"; id: string; method: "select"; title: string; options: string[]; timeout?: number }
  | { type: "extension_ui_request"; id: string; method: "input"; title: string; placeholder?: string; timeout?: number }
  | { type: "extension_ui_request"; id: string; method: "editor"; title: string; prefill?: string }
  | { type: "extension_ui_request"; id: string; method: "notify"; message: string; notifyType?: "info" | "warning" | "error" }
  | { type: "extension_ui_request"; id: string; method: "setStatus"; statusKey: string; statusText: string | undefined }
  | { type: "extension_ui_request"; id: string; method: "setWidget"; widgetKey: string; widgetLines: string[] | undefined; widgetPlacement?: "aboveEditor" | "belowEditor" }
  | { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
  | { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string };

/** A command acknowledgement. */
export type RpcResponse =
  | { type: "response"; command: string; success: true; id?: string; data?: unknown }
  | { type: "response"; command: string; success: false; id?: string; error: string };

/** Everything the host reads off the child's stdout. */
export type RpcFrame = AgentSessionEvent | RpcExtensionUIRequest | RpcResponse | { type: "extension_error"; extensionPath?: string; event?: string; error: string };

/** Write one command as an NDJSON line to the child's stdin. */
export function writeRpc(child: ChildProcess, cmd: RpcCommand): void {
  if (!child.stdin) throw new Error("rpc: child has no stdin");
  child.stdin.write(JSON.stringify(cmd) + "\n");
}

/** Read NDJSON frames from the child's stdout. Throws on a malformed line (no fallback). */
export async function* readJsonLines(stream: NodeJS.ReadableStream): AsyncGenerator<RpcFrame> {
  let buf = "";
  for await (const chunk of stream) {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let parsed: RpcFrame;
      try {
        parsed = JSON.parse(line) as RpcFrame;
      } catch (e) {
        throw new Error(`rpc: malformed stdout line: ${(e as Error).message}: ${line}`);
      }
      yield parsed;
    }
  }
}