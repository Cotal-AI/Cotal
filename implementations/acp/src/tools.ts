/**
 * How a harness's tool call reads in an ACP client: its kind, title, file locations and edits, from
 * the call's name and arguments, and its plan when the tool is the harness's todo list.
 *
 * Tool names and argument shapes belong to each harness, so the tables here name them. A tool no
 * table names reads as `other`, with its arguments and result shown as given.
 */
import { isAbsolute, resolve } from "node:path";
import type { PlanEntry, ToolCallContent, ToolCallLocation, ToolKind } from "@agentclientprotocol/sdk";

export interface ToolView {
  readonly kind: ToolKind;
  readonly title: string;
  readonly locations?: ToolCallLocation[];
  /** File edits as ACP diffs. */
  readonly diffs?: ToolCallContent[];
}

type Args = Record<string, unknown>;
type Describe = (args: Args) => ToolView;

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

/** One line of a command for a title. */
function oneLine(text: string, max = 120): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

const at = (path: string | undefined, line?: unknown): ToolCallLocation[] | undefined =>
  path ? [{ path, ...(typeof line === "number" && line > 0 ? { line } : {}) }] : undefined;

const diff = (path: string, oldText: string | null, newText: string): ToolCallContent => ({ type: "diff", path, oldText, newText });

function execute(command: unknown, fallback: string): ToolView {
  const text = Array.isArray(command) ? command.filter((c) => typeof c === "string").join(" ") : str(command);
  return { kind: "execute", title: text ? oneLine(text) : fallback };
}

function read(path: string | undefined, name: string, line?: unknown): ToolView {
  return { kind: "read", title: path ? `Read ${path}` : name, ...(path ? { locations: at(path, line) } : {}) };
}

function search(what: string | undefined, name: string, path?: string): ToolView {
  return { kind: "search", title: what ? `${name} ${oneLine(what, 80)}` : name, ...(path ? { locations: at(path) } : {}) };
}

function edit(path: string | undefined, name: string, diffs: ToolCallContent[]): ToolView {
  return { kind: "edit", title: path ? `Edit ${path}` : name, ...(path ? { locations: at(path) } : {}), ...(diffs.length ? { diffs } : {}) };
}

/** A whole-file write, shown as a diff from nothing: the bridge does not read the file it replaced. */
function write(path: string | undefined, name: string, content: unknown): ToolView {
  return { ...edit(path, name, path && typeof content === "string" ? [diff(path, null, content)] : []), ...(path ? { title: `Write ${path}` } : {}) };
}

/** A `*** Begin Patch` envelope, as Codex's `apply_patch` and OpenCode's `apply_patch` take it, as one
 *  diff per file. Each hunk's context and removed lines are the old text, its context and added lines
 *  the new text. */
export function patchDiffs(patch: string): { path: string; content: ToolCallContent }[] {
  const out: { path: string; oldLines: string[]; newLines: string[]; added: boolean; deleted: boolean }[] = [];
  let cur: (typeof out)[number] | undefined;
  for (const line of patch.split("\n")) {
    const file = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (file) {
      cur = { path: file[2]!.trim(), oldLines: [], newLines: [], added: file[1] === "Add", deleted: file[1] === "Delete" };
      out.push(cur);
      continue;
    }
    if (!cur || line.startsWith("***") || line.startsWith("@@")) continue;
    if (line.startsWith("+")) cur.newLines.push(line.slice(1));
    else if (line.startsWith("-")) cur.oldLines.push(line.slice(1));
    else if (line.startsWith(" ")) {
      cur.oldLines.push(line.slice(1));
      cur.newLines.push(line.slice(1));
    }
  }
  return out.map((f) => ({ path: f.path, content: diff(f.path, f.added ? null : f.oldLines.join("\n"), f.deleted ? "" : f.newLines.join("\n")) }));
}

function patch(text: unknown, name: string): ToolView {
  const files = typeof text === "string" ? patchDiffs(text) : [];
  const paths = [...new Set(files.map((f) => f.path))];
  return {
    kind: "edit",
    title: paths.length === 1 ? `Edit ${paths[0]}` : paths.length > 1 ? `Edit ${paths.length} files` : name,
    ...(paths.length ? { locations: paths.map((path) => ({ path })) } : {}),
    ...(files.length ? { diffs: files.map((f) => f.content) } : {}),
  };
}

const fetchTool = (url: unknown, name: string): ToolView => ({ kind: "fetch", title: str(url) ? `${name} ${str(url)}` : name });

const CLAUDE: Record<string, Describe> = {
  Bash: (a) => execute(a.command, "Bash"),
  Read: (a) => read(str(a.file_path), "Read", a.offset),
  Write: (a) => write(str(a.file_path), "Write", a.content),
  Edit: (a) => edit(str(a.file_path), "Edit", str(a.file_path) && typeof a.old_string === "string" && typeof a.new_string === "string" ? [diff(str(a.file_path)!, a.old_string, a.new_string)] : []),
  MultiEdit: (a) => {
    const path = str(a.file_path);
    const edits = Array.isArray(a.edits) ? (a.edits as Args[]) : [];
    return edit(path, "MultiEdit", path ? edits.filter((e) => typeof e.old_string === "string" && typeof e.new_string === "string").map((e) => diff(path, e.old_string as string, e.new_string as string)) : []);
  },
  NotebookEdit: (a) => edit(str(a.notebook_path), "NotebookEdit", []),
  Glob: (a) => search(str(a.pattern), "Glob", str(a.path)),
  Grep: (a) => search(str(a.pattern), "Grep", str(a.path)),
  LS: (a) => search(str(a.path), "LS", str(a.path)),
  WebFetch: (a) => fetchTool(a.url, "WebFetch"),
  WebSearch: (a) => ({ kind: "fetch", title: str(a.query) ? `WebSearch ${oneLine(str(a.query)!, 80)}` : "WebSearch" }),
  ExitPlanMode: () => ({ kind: "switch_mode", title: "Ready to code?" }),
};

const PI: Record<string, Describe> = {
  bash: (a) => execute(a.command, "bash"),
  read: (a) => read(str(a.path), "read", a.offset),
  write: (a) => write(str(a.path), "write", a.content),
  edit: (a) => {
    const path = str(a.path);
    const edits = Array.isArray(a.edits) ? (a.edits as Args[]) : [a];
    return edit(path, "edit", path ? edits.filter((e) => typeof e.oldText === "string" && typeof e.newText === "string").map((e) => diff(path, e.oldText as string, e.newText as string)) : []);
  },
  grep: (a) => search(str(a.pattern), "grep", str(a.path)),
  find: (a) => search(str(a.pattern), "find", str(a.path)),
  ls: (a) => search(str(a.path), "ls", str(a.path)),
};

const CODEX: Record<string, Describe> = {
  exec_command: (a) => execute(a.cmd, "exec_command"),
  shell_command: (a) => execute(a.command, "shell_command"),
  shell: (a) => execute(Array.isArray(a.command) && a.command[0] === "bash" && a.command[1] === "-lc" ? a.command[2] : a.command, "shell"),
  write_stdin: () => ({ kind: "execute", title: "Write to the running command" }),
  apply_patch: (a) => patch(a.input, "apply_patch"),
  view_image: (a) => read(str(a.path), "view_image"),
};

/** OpenCode 1.x names a file `filePath`, 2.x `path`. */
const ocPath = (a: Args): string | undefined => str(a.filePath) ?? str(a.path);

const OPENCODE: Record<string, Describe> = {
  bash: (a) => execute(a.command, "bash"),
  shell: (a) => execute(a.command, "shell"),
  execute: (a) => execute(a.code, "execute"),
  read: (a) => read(ocPath(a), "read", a.offset),
  write: (a) => write(ocPath(a), "write", a.content),
  edit: (a) => {
    const path = ocPath(a);
    return edit(path, "edit", path && typeof a.oldString === "string" && typeof a.newString === "string" ? [diff(path, a.oldString, a.newString)] : []);
  },
  apply_patch: (a) => patch(a.patchText, "apply_patch"),
  patch: (a) => patch(a.patchText, "patch"),
  glob: (a) => search(str(a.pattern), "glob", str(a.path)),
  grep: (a) => search(str(a.pattern), "grep", str(a.path)),
  list: (a) => search(str(a.path), "list", str(a.path)),
  webfetch: (a) => fetchTool(a.url, "webfetch"),
  websearch: (a) => ({ kind: "fetch", title: str(a.query) ? `websearch ${oneLine(str(a.query)!, 80)}` : "websearch" }),
};

const TABLES: Record<string, Record<string, Describe>> = { claude: CLAUDE, pi: PI, codex: CODEX, opencode: OPENCODE };

/** A Codex custom tool carries its input as a bare string, which the tables read as `input`. */
function argsOf(raw: unknown): Args {
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) return raw as Args;
  return typeof raw === "string" ? { input: raw } : {};
}

/** How `name`, called with `input`, reads in a client. `input` is undefined until the arguments
 *  arrive, and then whatever they parsed to. A relative file path is the seat's folder `cwd`'s. */
export function describeTool(harness: string, name: string, input: unknown, cwd?: string): ToolView {
  const describe: Describe | undefined = Object.hasOwn(TABLES, harness) && Object.hasOwn(TABLES[harness]!, name) ? TABLES[harness]![name] : undefined;
  if (!describe || input === undefined) return { kind: describe ? kindOnly(harness, name) : "other", title: name };
  const view = describe(argsOf(input));
  if (!cwd) return view;
  const full = (path: string): string => (isAbsolute(path) ? path : resolve(cwd, path));
  const named = view.locations?.find((l) => !isAbsolute(l.path) && view.title.endsWith(` ${l.path}`));
  return {
    ...view,
    ...(named ? { title: `${view.title.slice(0, -named.path.length)}${full(named.path)}` } : {}),
    ...(view.locations ? { locations: view.locations.map((l) => ({ ...l, path: full(l.path) })) } : {}),
    ...(view.diffs ? { diffs: view.diffs.map((d) => (d.type === "diff" ? { ...d, path: full(d.path) } : d)) } : {}),
  };
}

/** A tool's kind before its arguments arrive. */
function kindOnly(harness: string, name: string): ToolKind {
  return TABLES[harness]![name]!({}).kind;
}

const PLAN_TOOLS: Record<string, readonly string[]> = {
  claude: ["TodoWrite", "TaskCreate", "TaskUpdate"],
  opencode: ["todowrite"],
  codex: ["update_plan"],
};

/** Whether `name` is one of that harness's todo tools, whose calls show as the session's plan. */
export function isPlanTool(harness: string, name: string): boolean {
  return Object.hasOwn(PLAN_TOOLS, harness) && PLAN_TOOLS[harness]!.includes(name);
}

const status = (s: unknown): PlanEntry["status"] => (s === "completed" || s === "in_progress" ? s : "pending");
const priority = (p: unknown): PlanEntry["priority"] => (p === "high" || p === "low" ? p : "medium");

/** A session's plan, as its seat's todo tools build it. A tool that writes the whole list replaces
 *  it; Claude Code's task tools add and change one task at a time, so the plan keeps them by id. */
export class Plan {
  private entries = new Map<string, PlanEntry>();

  /** Apply one todo tool call and return the whole plan, or undefined when it changed nothing. A
   *  task Claude creates is known by the call until its result names the task's number. */
  apply(harness: string, name: string, callId: string, input: unknown, result?: string): PlanEntry[] | undefined {
    const a = argsOf(input);
    if ((harness === "claude" && name === "TodoWrite") || (harness === "opencode" && name === "todowrite")) {
      const todos = Array.isArray(a.todos) ? (a.todos as Args[]) : [];
      this.entries = new Map(todos.filter((t) => typeof t.content === "string" && t.status !== "cancelled")
        .map((t, i) => [String(i), { content: t.content as string, status: status(t.status), priority: priority(t.priority) }]));
    } else if (harness === "codex" && name === "update_plan") {
      const steps = Array.isArray(a.plan) ? (a.plan as Args[]) : [];
      this.entries = new Map(steps.filter((t) => typeof t.step === "string").map((t, i) => [String(i), { content: t.step as string, status: status(t.status), priority: "medium" }]));
    } else if (harness === "claude" && name === "TaskCreate") {
      if (typeof a.subject !== "string") return undefined;
      const id = result === undefined ? undefined : /#(\d+)/.exec(result)?.[1];
      this.entries.delete(`call:${callId}`);
      this.entries.set(id ?? `call:${callId}`, { content: a.subject, status: "pending", priority: "medium" });
    } else if (harness === "claude" && name === "TaskUpdate") {
      const id = typeof a.taskId === "string" ? a.taskId : undefined;
      const entry = id === undefined ? undefined : this.entries.get(id);
      if (!id || !entry) return undefined;
      if (a.status === "deleted") this.entries.delete(id);
      else this.entries.set(id, { ...entry, ...(typeof a.subject === "string" ? { content: a.subject } : {}), ...(a.status !== undefined ? { status: status(a.status) } : {}) });
    } else return undefined;
    return [...this.entries.values()];
  }
}
