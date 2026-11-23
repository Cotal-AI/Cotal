/**
 * Codex's code mode on the event plane.
 *
 * With code mode, the model makes every tool call from one `exec` script. app-server reports no
 * item for the script, only for the calls it makes, so T3 Code's own Codex provider shows those
 * calls and not the script. The rollout records each such call once it ends, as an
 * `event_msg item_completed`. A direct call writes the same record after its own call record, and
 * that one is already published. app-server reports each call as `item/started` when it starts, and
 * the seat journals that as a {@link StartedRecord}, so the call is published while it runs. A plan
 * the script sets has no record at all: app-server sends it only as `turn/plan/updated`, which the
 * seat journals as a {@link PlanRecord}.
 */

/** A call the script made, as the event plane publishes it, in the names and arguments a direct
 *  call of the same tool carries. */
export interface StartedCall {
  id: string;
  name: string;
  args: unknown;
}

/** A call the script made that has ended, with its result. */
export interface NestedCall extends StartedCall {
  output: string;
  isError: boolean;
}

/** What the seat journals for each `item/started`: app-server's item, as it sent it. */
export interface StartedRecord {
  type: "started";
  item: unknown;
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

/** A command line split into words as a POSIX shell reads it, which is how app-server quotes the
 *  argv of a command it reports as started. */
function words(line: string): string[] {
  const out: string[] = [];
  let word: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === "'") {
      const close = line.indexOf("'", i + 1);
      const end = close < 0 ? line.length : close;
      word = (word ?? "") + line.slice(i + 1, end);
      i = end;
    } else if (ch === '"') {
      let j = i + 1;
      word ??= "";
      for (; j < line.length && line[j] !== '"'; j++) word += line[j] === "\\" && '"\\$`'.includes(line[j + 1] ?? "-") ? line[++j] : line[j];
      i = j;
    } else if (ch === "\\") word = (word ?? "") + (line[++i] ?? "");
    else if (/\s/.test(ch)) {
      if (word !== undefined) out.push(word);
      word = undefined;
    } else word = (word ?? "") + ch;
  }
  return word === undefined ? out : [...out, word];
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

/** What the seat journals for each `turn/plan/updated`: the plan, under an id it gives the call. */
export interface PlanRecord {
  type: "plan";
  id: string;
  explanation: string | null;
  plan: { step: string; status: string }[];
}

/** A journaled plan as the update_plan call that set it, in update_plan's own arguments, whose
 *  status for a running step is `in_progress` where app-server's is `inProgress`. */
function planCall(value: unknown): NestedCall | undefined {
  const r = asRecord(value);
  if (r?.type !== "plan" || typeof r.id !== "string" || !Array.isArray(r.plan)) return undefined;
  const plan = r.plan.flatMap((s) => {
    const step = asRecord(s);
    return typeof step?.step === "string" && typeof step.status === "string" ? [{ step: step.step, status: step.status === "inProgress" ? "in_progress" : step.status }] : [];
  });
  const explanation = asString(r.explanation);
  return { id: r.id, name: "update_plan", args: { ...(explanation ? { explanation } : {}), plan }, output: "Plan updated", isError: false };
}

/** app-server's change list as the one a file change approval carries, `{ path, kind, diff }`. */
function startedChanges(changes: unknown): { path: string; kind: { type: string }; diff: string }[] {
  if (!Array.isArray(changes)) return [];
  return changes.flatMap((c) => {
    const change = asRecord(c);
    const path = asString(change?.path);
    const type = asString(asRecord(change?.kind)?.type);
    const diff = asString(change?.diff);
    return path === undefined || type === undefined || diff === undefined ? [] : [{ path, kind: { type }, diff }];
  });
}

/** The call an `item/started` item starts, in the names and arguments its ended record gives. */
function startedCall(item: Record<string, unknown>): StartedCall | undefined {
  const id = asString(item.id);
  if (id === undefined) return undefined;
  if (item.type === "commandExecution") {
    const workdir = folder(item.cwd);
    return { id, name: "exec_command", args: { cmd: script(words(asString(item.command) ?? "")), ...(workdir ? { workdir } : {}) } };
  }
  if (item.type === "fileChange") return { id, name: "apply_patch", args: { changes: startedChanges(item.changes) } };
  const tool = asString(item.tool);
  return item.type === "mcpToolCall" && tool !== undefined ? { id, name: tool, args: item.arguments ?? {} } : undefined;
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

/** What one run of the rollout says about code mode: the scripts, which are hidden, and those still
 *  running; the direct calls, whose ended items are already published; the direct update_plan calls
 *  still running, whose plan their own record carries; and the calls published at their start. */
export function createCodeMode() {
  const scripts = new Set<string>();
  const running = new Set<string>();
  const direct = new Set<string>();
  const plans = new Set<string>();
  const started = new Set<string>();
  return {
    clear(): void {
      for (const s of [scripts, running, direct, plans, started]) s.clear();
    },
    /** Whether a tool call or output record is the script's, or a call record read after its
     *  journaled start was published. Neither is published. */
    hides(inner: string | undefined, payload: Record<string, unknown>): boolean {
      const callId = asString(payload.call_id);
      if (callId === undefined) return false;
      const call = inner === "function_call" || inner === "custom_tool_call";
      if (inner === "custom_tool_call" && payload.name === "exec") {
        scripts.add(callId);
        running.add(callId);
      } else if (call) direct.add(callId);
      if (inner === "custom_tool_call_output") running.delete(callId);
      if (inner === "function_call" && payload.name === "update_plan") plans.add(callId);
      if (inner === "function_call_output") plans.delete(callId);
      return (call && started.has(callId)) || (scripts.has(callId) && (call || inner === "custom_tool_call_output"));
    },
    /**
     * The call a journaled record stands for, and whether it has ended. A plan is the update_plan
     * call that set it, unless a direct update_plan call is running, as it is when the model called
     * the tool itself. A start is published while a script runs and the call is not a direct one.
     */
    journaled(value: unknown): { call: NestedCall; ended: true } | { call: StartedCall; ended: false } | undefined {
      const r = asRecord(value);
      if (r?.type === "plan") {
        const call = plans.size > 0 ? undefined : planCall(r);
        return call && { call, ended: true as const };
      }
      const call = r?.type === "started" && running.size > 0 ? startedCall(asRecord(r.item) ?? {}) : undefined;
      if (call === undefined || direct.has(call.id) || started.has(call.id)) return undefined;
      started.add(call.id);
      return { call, ended: false as const };
    },
    /** The call an `item_completed` record ends, when the script made it, and whether its start was
     *  published. */
    nested(payload: Record<string, unknown>): { call: NestedCall; opened: boolean } | undefined {
      const item = asRecord(payload.item);
      const id = asString(item?.id);
      const call = item === undefined || id === undefined || direct.has(id) ? undefined : nestedCall(item, id);
      return call && { call, opened: started.has(call.id) };
    },
  };
}
