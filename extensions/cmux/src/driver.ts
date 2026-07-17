import { execFileSync } from "node:child_process";

const EXIT_WAIT_MS = 8_000;
const EXIT_POLL_MS = 100;
const EXIT_PROBE_MS = 1_000;

// Inside a cmux surface the CLI isn't on $PATH; cmux exports its absolute path here.
// Fall back to "cmux" for non-bundled installs (e.g. a Homebrew cmux on PATH).
function cmuxBin(): string {
  return process.env.CMUX_BUNDLED_CLI_PATH ?? "cmux";
}

/**
 * The one place that knows the cmux CLI. Thin wrappers over `cmux <subcommand>`
 * (the CLI talks to the running cmux app over its Unix socket). Used by the
 * manager's cmux runtime and by example launchers — so no raw `cmux` calls live
 * anywhere else.
 */
function cmux(args: string[], opts: { timeoutMs?: number } = {}): string {
  return execFileSync(cmuxBin(), args, { encoding: "utf8", timeout: opts.timeoutMs }).trim();
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const WORKSPACE_REF = /workspace:\d+/g;

/** A terminal target — a workspace (tab) or a specific surface, by id/ref. */
export interface Target {
  workspace?: string;
  surface?: string;
}

function targetArgs(t?: Target): string[] {
  const a: string[] = [];
  if (t?.workspace) a.push("--workspace", t.workspace);
  if (t?.surface) a.push("--surface", t.surface);
  return a;
}

/** True if a cmux app is reachable (`cmux ping`). */
export function available(): boolean {
  try {
    execFileSync(cmuxBin(), ["ping"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Open a new workspace (tab) with a declarative split layout (JSON). Returns the
 *  new workspace's stable UUID so callers can later target or close it. */
export function openWorkspace(name: string, layout: string, opts: { focus?: boolean } = {}): string {
  const focus = opts.focus ?? true;
  const out = cmux([
    "--id-format",
    "uuids",
    "new-workspace",
    "--name",
    name,
    "--focus",
    String(focus),
    "--layout",
    layout,
  ]);
  // cmux prints a UUID under `--id-format uuids`, but write ops like new-workspace
  // confirm with `OK workspace:<n>` (a short ref) — accept either.
  const id = UUID.exec(out)?.[0] ?? /workspace:\d+/.exec(out)?.[0];
  if (!id) throw new Error(`cmux new-workspace: couldn't read the new workspace id from "${out}"`);
  return id;
}

/** cmux exits non-zero with `not_found: Workspace not found` once the tab is already gone. */
function isWorkspaceNotFound(err: unknown): boolean {
  const e = err as { stderr?: unknown; message?: unknown };
  return /not_found: Workspace not found/i.test(`${String(e?.stderr ?? "")}${String(e?.message ?? "")}`);
}

/** Close a workspace (tab) by id/ref. Idempotent: closing an already-gone tab is a no-op, not an
 *  error — both runtime teardown and stale-ref cleanup mean "ensure it's closed". Only cmux's
 *  workspace-not-found is swallowed; other CLI/socket failures still throw. */
export function closeWorkspace(workspace: string): void {
  try {
    cmux(["close-workspace", "--workspace", workspace]);
  } catch (err) {
    if (isWorkspaceNotFound(err)) return;
    throw err;
  }
}

/** All open workspace lines (name + ref), or `[]` if cmux can't be reached. */
export function listWorkspaces(): string[] {
  try {
    return cmux(["list-workspaces"]).split("\n").map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

export type WorkspaceState = "running" | "exited";

/** Authoritative workspace state from a successful cmux inventory query. The workspace is the
 * lifecycle boundary cmux owns: closing it tears down its terminal surface and child process.
 * Socket/provider failures throw rather than masquerading as an empty inventory. */
export function workspaceState(workspace: string): WorkspaceState {
  let output: string;
  try {
    output = cmux(["--id-format", "both", "list-workspaces"], { timeoutMs: EXIT_PROBE_MS });
  } catch (err) {
    throw new Error(`cmux: couldn't prove workspace ${workspace} exited: ${(err as Error).message}`, {
      cause: err,
    });
  }
  const ids = output
    .split("\n")
    .flatMap((line) => [line.match(UUID)?.[0], ...(line.match(WORKSPACE_REF) ?? [])]);
  return ids.includes(workspace) ? "running" : "exited";
}

/** Bounded polling over cmux's authoritative workspace inventory. */
export async function waitForWorkspaceExit(
  workspace: string,
  opts: {
    timeoutMs?: number;
    pollMs?: number;
  } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? EXIT_WAIT_MS;
  const pollMs = opts.pollMs ?? EXIT_POLL_MS;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (workspaceState(workspace) === "exited") return;
    const remaining = deadline - Date.now();
    if (remaining <= 0)
      throw new Error(`cmux: workspace ${workspace} did not close within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, remaining)));
  }
}

/** Workspace refs (e.g. "workspace:55") whose label is exactly `name`. cmux lists tabs as
 *  "[*] <ref>  [glyph] <label> [\[selected\]]"; matching the whole label keeps "cotal-main" from
 *  matching "cotal-manager". Used to close stale tabs that linger after their process exits. */
export function workspaceRefs(name: string): string[] {
  const refs: string[] = [];
  for (const line of listWorkspaces()) {
    const ref = (line.match(/workspace:\d+/) ?? line.match(UUID))?.[0];
    if (!ref) continue;
    const label = line
      .slice(line.indexOf(ref) + ref.length)
      .replace(/\s*\[selected\]\s*$/, "")
      .trim();
    if (label === name || label.endsWith(` ${name}`)) refs.push(ref);
  }
  return refs;
}

/** Split the focused pane; the new pane becomes focused. */
export function newSplit(direction: "left" | "right" | "up" | "down"): void {
  cmux(["new-split", direction]);
}

/** Type text into a terminal surface (the focused one, or a targeted background tab). */
export function send(text: string, target?: Target): void {
  cmux(["send", ...targetArgs(target), "--", text]);
}

/** Send a key press (e.g. "enter") to a terminal surface. */
export function sendKey(key: string, target?: Target): void {
  cmux(["send-key", ...targetArgs(target), "--", key]);
}
