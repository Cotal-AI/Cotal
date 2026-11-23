/**
 * Codex's code mode on the event plane.
 *
 * With code mode, the model makes every tool call from one `exec` script. app-server reports no
 * item for the script, only for the calls it makes, so T3 Code's own Codex provider shows those
 * calls and not the script. The rollout records each such call once it ends, as an
 * `event_msg item_completed`. A direct call writes the same record after its own call record, and
 * that one is already published.
 */

/** A call the script made, as the event plane publishes it, in the names and arguments a direct
 *  call of the same tool carries. */
export interface NestedCall {
  id: string;
  name: string;
  args: unknown;
  output: string;
  isError: boolean;
}

const asString = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

/** A command's script: the text a shell's `-lc` or `-c` runs, else the argv joined. */
function script(command: unknown): string {
  if (!Array.isArray(command)) return asString(command) ?? "";
  const flag = command.length === 3 && (command[1] === "-lc" || command[1] === "-c");
  return flag ? String(command[2]) : command.map(String).join(" ");
}

/** A rollout `cwd`, which Codex writes as a `file://` URL, as a path. */
function folder(cwd: unknown): string | undefined {
  const s = asString(cwd);
  if (s === undefined || !s.startsWith("file://")) return s;
  return decodeURIComponent(new URL(s).pathname);
}

/** Codex's change map as the list a file change approval carries, `{ path, kind, diff }`. */
function changeList(changes: unknown): { path: string; kind: { type: string }; diff: string }[] {
  return Object.entries(asRecord(changes) ?? {}).flatMap(([path, c]) => {
    const change = asRecord(c);
    const type = asString(change?.type);
    const diff = asString(change?.unified_diff) ?? asString(change?.content);
    return type === undefined || diff === undefined ? [] : [{ path, kind: { type }, diff }];
  });
}

/** An MCP result's text parts, joined. */
function mcpText(result: unknown): string {
  const content = asRecord(result)?.content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((p) => (asString(asRecord(p)?.text) ?? [])).join("\n");
}

/** The call an ended item records, or undefined for an item that is not a tool call. */
function nestedCall(item: Record<string, unknown>, id: string): NestedCall | undefined {
  const status = asString(item.status);
  if (item.type === "CommandExecution") {
    const workdir = folder(item.cwd);
    const exit = item.exit_code;
    return { id, name: "exec_command", args: { cmd: script(item.command), ...(workdir ? { workdir } : {}) }, output: asString(item.aggregated_output) ?? "",
      isError: status !== "completed" || (typeof exit === "number" && exit !== 0) };
  }
  if (item.type === "FileChange")
    return { id, name: "apply_patch", args: { changes: changeList(item.changes) }, output: asString(item.stdout) || asString(item.stderr) || "", isError: status !== "completed" };
  if (item.type === "McpToolCall") {
    const tool = asString(item.tool);
    if (tool === undefined) return undefined;
    const error = asString(asRecord(item.error)?.message) ?? asString(item.error);
    return { id, name: tool, args: item.arguments ?? {}, output: error ?? mcpText(item.result), isError: status !== "completed" || asRecord(item.result)?.isError === true };
  }
  return undefined;
}

/** What one run of the rollout says about code mode: the script's calls, which are hidden, and the
 *  direct calls, whose ended items are already published. */
export function createCodeMode() {
  const scripts = new Set<string>();
  const direct = new Set<string>();
  return {
    clear(): void {
      scripts.clear();
      direct.clear();
    },
    /** Whether a tool call or output record is the script's, which is not published. */
    hides(inner: string | undefined, payload: Record<string, unknown>): boolean {
      const callId = asString(payload.call_id);
      if (callId === undefined) return false;
      if (inner === "custom_tool_call" && payload.name === "exec") scripts.add(callId);
      else if (inner === "function_call" || inner === "custom_tool_call") direct.add(callId);
      return scripts.has(callId) && (inner === "custom_tool_call" || inner === "custom_tool_call_output");
    },
    /** The call an `item_completed` record ends, when the script made it. */
    nested(payload: Record<string, unknown>): NestedCall | undefined {
      const item = asRecord(payload.item);
      const id = asString(item?.id);
      return item === undefined || id === undefined || direct.has(id) ? undefined : nestedCall(item, id);
    },
  };
}
