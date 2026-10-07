import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EXIT_WAIT_MS = 8_000;
const EXIT_POLL_MS = 100;
const EXIT_PROBE_MS = 1_000;

/** True if tmux is installed and reachable on PATH. */
export function available(): boolean {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Session name from the surrounding tmux environment. Throws if not inside tmux. */
export function currentSession(): string {
  if (!process.env.TMUX)
    throw new Error("tmux: not inside a tmux session ($TMUX is not set)");
  try {
    return execFileSync("tmux", ["display-message", "-p", "#S"], { encoding: "utf8" }).trim();
  } catch (err) {
    throw new Error(`tmux: couldn't read current session name: ${err}`);
  }
}

function hasSession(session: string): boolean {
  try {
    execFileSync("tmux", ["has-session", "-t", session], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Ensure a detached tmux session exists; creates it if absent. A detached session has no client
 *  to size it, and some tmux builds then treat its window as sizeless — so `split-window` fails
 *  with "size missing". Give it an explicit initial size; tmux resizes to the real client on attach. */
export function ensureSession(session: string, cwd: string): void {
  if (!hasSession(session))
    execFileSync("tmux", ["new-session", "-d", "-s", session, "-x", "200", "-y", "50", "-c", cwd], {
      stdio: "ignore",
    });
}

/** True if a window named `name` exists in `session`. Name-based — fragile under renames; prefer
 *  {@link windowAliveRef} when you hold a stable `@N` ID. Kept for name-based discovery/cleanup. */
export function windowAlive(session: string, name: string): boolean {
  return listWindows(session).includes(name);
}

/** True if a window with the stable ID `windowId` (`@N`) still exists. Window IDs are server-global,
 *  so we test exact membership in the full window list — surviving renames, unlike {@link windowAlive}
 *  (name match). (Don't use `display-message -t`: for a stale target it silently falls back to the
 *  current window instead of erroring, so it can't detect a closed window.) */
export function windowAliveRef(windowId: string): boolean {
  return windowLines("#{window_id}").includes(windowId);
}

/** True when a tmux call failed because no server is listening on its socket. tmux reports that
 *  as `no server running on <socket>`, and the socket path may itself hold those words, so only the
 *  start of stderr counts. A missing socket or an unsafe socket directory is a failed call. */
function noServer(err: unknown): boolean {
  return String((err as { stderr?: unknown }).stderr ?? "").startsWith("no server running on ");
}

/** The running tmux server's pid, or undefined when no server is running. */
export function serverPid(): string | undefined {
  try {
    return execFileSync("tmux", ["display-message", "-p", "#{pid}"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (err) {
    if (noServer(err)) return undefined;
    throw err;
  }
}

/** Sessions holding window `windowId` (a window can be linked into more than one), or none once its
 *  server no longer lists it. Like {@link paneState}, a failed listing throws instead of reading as
 *  gone. */
export function windowSessions(windowId: string): string[] {
  return windowLines("#{window_id} #{session_name}")
    .filter((l) => l.startsWith(`${windowId} `))
    .map((l) => l.slice(windowId.length + 1));
}

/** Every window on the server in `format`, one line for each session holding it, or none when no
 *  server is running. A failed listing throws instead of reading as no windows. */
function windowLines(format: string): string[] {
  try {
    return execFileSync("tmux", ["list-windows", "-a", "-F", format], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: EXIT_PROBE_MS,
    })
      .split("\n")
      .filter(Boolean);
  } catch (err) {
    const e = err as { stderr?: unknown; message?: unknown };
    const message = `${String(e.stderr ?? "")} ${String(e.message ?? "")}`;
    if (noServer(err)) return [];
    throw new Error(`tmux: couldn't list windows: ${message.trim()}`, { cause: err });
  }
}

/** The window holding pane `paneId`, or undefined once its server no longer lists the pane. A pane
 *  that exited under `remain-on-exit` is still listed, so it still has a window. Like
 *  {@link paneState}, a failed listing throws instead of reading as gone. */
export function paneWindow(paneId: string): string | undefined {
  try {
    return execFileSync("tmux", ["list-panes", "-a", "-F", "#{pane_id} #{window_id}"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: EXIT_PROBE_MS,
    })
      .split("\n")
      .find((l) => l.startsWith(`${paneId} `))
      ?.slice(paneId.length + 1);
  } catch (err) {
    const e = err as { stderr?: unknown; message?: unknown };
    const message = `${String(e.stderr ?? "")} ${String(e.message ?? "")}`;
    if (noServer(err)) return undefined;
    throw new Error(`tmux: couldn't list the window holding pane ${paneId}: ${message.trim()}`, { cause: err });
  }
}

export type PaneState = "running" | "exited";

/** Authoritative process state for a stable pane ID. A successful full-server listing that no
 * longer contains the pane proves exit; `pane_dead=1` also handles `remain-on-exit` configurations.
 * Provider/permission failures throw instead of turning uncertainty into a false exit. */
export function paneState(paneId: string): PaneState {
  try {
    const panes = execFileSync("tmux", ["list-panes", "-a", "-F", "#{pane_id} #{pane_dead}"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: EXIT_PROBE_MS,
    });
    for (const line of panes.split("\n")) {
      const [id, dead] = line.trim().split(/\s+/);
      if (id === paneId) return dead === "1" ? "exited" : "running";
    }
    return "exited";
  } catch (err) {
    const e = err as { stderr?: unknown; message?: unknown };
    const message = `${String(e.stderr ?? "")} ${String(e.message ?? "")}`;
    // No tmux server means no pane can still exist. Other failures (including permission/socket
    // errors) are unknown and must fail the preservation cut closed.
    if (noServer(err)) return "exited";
    throw new Error(`tmux: couldn't prove pane ${paneId} exited: ${message.trim()}`, { cause: err });
  }
}

/** The text pane `paneId` (`%N`) shows now, or undefined once it has exited. */
export function capturePane(paneId: string): string | undefined {
  let screen: string;
  try {
    screen = execFileSync("tmux", ["capture-pane", "-p", "-t", paneId], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: EXIT_PROBE_MS,
    });
  } catch (err) {
    if (paneState(paneId) === "exited") return undefined;
    throw err;
  }
  // capture-pane also reads a pane kept after its process exited (`remain-on-exit`); a pane still
  // running after the capture was running during it.
  return paneState(paneId) === "exited" ? undefined : screen;
}

/** Bounded polling over tmux's authoritative pane inventory. */
export async function waitForPaneExit(
  paneId: string,
  opts: {
    timeoutMs?: number;
    pollMs?: number;
  } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? EXIT_WAIT_MS;
  const pollMs = opts.pollMs ?? EXIT_POLL_MS;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (paneState(paneId) === "exited") return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`tmux: pane ${paneId} did not exit within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, remaining)));
  }
}

function isWindowGone(err: unknown): boolean {
  // Use both stderr (captured when stdio:"pipe") and message (contains the command + code).
  const e = err as { stderr?: unknown; message?: unknown };
  const msg = `${String(e.stderr ?? "")}${String(e.message ?? "")}`;
  return /can't find window|can't find session|no current window|session not found/i.test(msg);
}

/** The stable refs for a freshly-opened window: its window ID (`@N`) and the ID of its initial
 *  (only) pane (`%N`). Both survive renames/reorders — drive later close/split/send/refs calls off
 *  these, not the mutable `session:name` target or pane indexes. */
export interface WindowRefs {
  windowId: string;
  paneId: string;
  /** The tmux server's pid. Window and pane IDs restart with a new server, so a reference that
   *  outlives this server must carry it. */
  serverPid: string;
}

/** Open a new tmux window `name` in `session` running `command` (a shell string).
 *  Created detached (unfocused) by default; pass `focus: true` to switch to it.
 *  Returns the stable window ID (`@N`) and its initial pane ID (`%N`). */
export function openWindow(
  session: string,
  name: string,
  command: string,
  cwd: string,
  opts: { focus?: boolean } = {},
): WindowRefs {
  // Trailing `:` forces a target-*session* + next free index. A bare numeric session name (the
  // default `tmux new` session is "0") would otherwise be read as window-index 0 → "index 0 in use".
  const args = ["new-window", "-t", `${session}:`, "-n", name, "-c", cwd];
  if (!(opts.focus ?? false)) args.push("-d");
  // -P -F prints the new window + pane IDs before returning — stable across renames and reorders.
  args.push("-P", "-F", "#{window_id} #{pane_id} #{pid}", command);
  const out = execFileSync("tmux", args, { encoding: "utf8" }).trim();
  const [windowId, paneId, serverPid] = out.split(/\s+/);
  if (!windowId || !paneId || !serverPid)
    throw new Error(`tmux: couldn't read window/pane IDs from new-window ("${out}")`);
  return { windowId, paneId, serverPid };
}

/** Split `target` (a window ID `@N`, or session:window) creating a new pane running `command`.
 *  Returns the new pane's stable ID (`%N`). Direction convention matches {@link Tab.split.direction}:
 *  `"horizontal"` → stacked top/bottom rows (tmux `-v`, the default);
 *  `"vertical"` → side-by-side columns (tmux `-h`).
 *  `ratio` is the first pane's fraction — the new pane gets `(1 - ratio)`. */
export function splitWindow(
  target: string,
  command: string,
  cwd: string,
  direction: "vertical" | "horizontal",
  ratio?: number,
): string {
  const args = ["split-window", "-t", target, "-c", cwd];
  if (direction === "vertical") args.push("-h"); // side-by-side columns = tmux -h
  // `-l <n>%` is the modern size syntax; the old `-p <n>` is deprecated and errors "size missing"
  // on tmux 3.4. The new pane gets (1 - ratio); the first keeps `ratio`.
  if (ratio !== undefined) args.push("-l", `${Math.round((1 - ratio) * 100)}%`);
  // -P -F prints the new pane's ID — use it as a stable target (pane indexes shift under
  // `pane-base-index` and renumber on close).
  args.push("-P", "-F", "#{pane_id}", command);
  return execFileSync("tmux", args, { encoding: "utf8" }).trim();
}

/** Focus a window by target (`session:name` or window ID). */
export function selectWindow(target: string): void {
  execFileSync("tmux", ["select-window", "-t", target], { stdio: "ignore" });
}

/** Kill a tmux window by target (window ID `@N`, or `session:name`). Idempotent: already-gone is a no-op. */
export function closeWindow(target: string, opts: { timeoutMs?: number } = {}): void {
  try {
    execFileSync("tmux", ["kill-window", "-t", target], { stdio: "pipe", timeout: opts.timeoutMs });
  } catch (err) {
    if (isWindowGone(err)) return;
    throw err;
  }
}

/** Kill window `windowId` (`@N`) only while `session` holds it and pane `paneId` (`%N`) is in it or
 *  gone, and report whether it was killed. tmux checks and kills in one command, so a pane or window
 *  that moves after the caller's own listing cannot pass a stale check and lose its window. */
export function closeWindowIfHeld(session: string, windowId: string, paneId: string): boolean {
  // Non-empty while any session lists the pane in another window.
  const paneElsewhere = `#{S:#{W:#{P:#{?#{==:#{pane_id},${paneId}},#{?#{==:#{window_id},${windowId}},,1},}}}}`;
  // kill-window's own exact (`=`) target checks the session: if-shell runs its command even when its
  // `-t` names no window. tmux quotes a command string as sh does.
  const kill = `kill-window -t ${shellQuote(`=${session}:${windowId}`)}`;
  try {
    const out = execFileSync("tmux", ["if-shell", "-F", `#{?${paneElsewhere},0,1}`, kill, "display-message -p refused"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return out.trim() !== "refused";
  } catch (err) {
    if (isWindowGone(err)) return false;
    throw err;
  }
}

/** Window names open in `session`, or none once no server is running. */
export function listWindows(session: string): string[] {
  // tmux escapes a tab in a session name, so the first tab ends it; a window name can hold one.
  const prefix = `${session}\t`;
  return windowLines("#{session_name}\t#{window_name}")
    .filter((l) => l.startsWith(prefix))
    .map((l) => l.slice(prefix.length));
}

/** Stable window IDs (`@N`) of every window in `session` whose name is exactly `label`. */
export function windowRefs(session: string, label: string): string[] {
  return windowLines("#{window_id}\t#{session_name}\t#{window_name}").flatMap((l) => {
    const tab = l.indexOf("\t");
    return l.slice(tab + 1) === `${session}\t${label}` ? [l.slice(0, tab)] : [];
  });
}

/** Render `env` as shell-safe `KEY='value'` pairs. tmux (like cmux) shell-renders env into the
 *  command line — pty passes it structurally — so reject any KEY that isn't a valid env identifier
 *  before rendering, rather than splice an attacker-influenced name into the command. Shipped
 *  connectors only generate safe names today; this is defense-in-depth. */
function envPairs(env: Record<string, string>): string[] {
  return Object.entries(env).map(([k, v]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
      throw new Error(`tmux: refusing to render unsafe env var name ${JSON.stringify(k)}`);
    return `${k}=${shellQuote(v)}`;
  });
}

/** Shell command string that runs `command args` with `env -i` isolation — only the given
 *  `env` entries reach the process (the tmux server's inherited env is stripped). */
export function isolatedCommand(
  env: Record<string, string>,
  command: string,
  args: string[],
): string {
  return ["env", "-i", ...envPairs(env), shellQuote(command), ...args.map(shellQuote)].join(" ");
}

/** Shell command string that runs `command args` with extra `env` merged into the inherited env. */
export function mergedCommand(
  env: Record<string, string>,
  command: string,
  args: string[],
): string {
  return ["env", ...envPairs(env), shellQuote(command), ...args.map(shellQuote)].join(" ");
}

/** Wrap a secret-bearing command body (e.g. an {@link isolatedCommand} `env -i KEY='val' … cmd`) in a
 *  private launcher script and return a `bash` invocation of it. tmux runs the command we hand it as a
 *  process argument — visible to any local `ps`/`tmux list-panes` — so passing the rendered `env`
 *  inline would leak the agent's creds + control token (and any model-provider key). Instead the body
 *  lives in a fresh 0o700 temp dir as a 0o600 (owner-only) script; tmux only ever sees `bash <path>`,
 *  and the secrets are read from the file, never the command line. */
export function privateLaunch(commandBody: string): string {
  const dir = mkdtempSync(join(tmpdir(), "cotal-tmux-"));
  const scriptPath = join(dir, "launch.sh");
  writeFileSync(scriptPath, `#!/usr/bin/env bash\nexec ${commandBody}\n`, { mode: 0o600 });
  return `bash ${shellQuote(scriptPath)}`;
}

/** Type literal text into a tmux target.
 *  `-l` bypasses tmux's key-name lookup; `--` guards against text starting with `-`. */
export function send(text: string, target: string): void {
  execFileSync("tmux", ["send-keys", "-l", "-t", target, "--", text], { stdio: "ignore" });
}

/** Send a named key sequence (e.g. `"Enter"`, `"C-c"`) to a tmux target.
 *  `--` guards against key names starting with `-`. */
export function sendKey(key: string, target: string, opts: { timeoutMs?: number } = {}): void {
  execFileSync("tmux", ["send-keys", "-t", target, "--", key], { stdio: "ignore", timeout: opts.timeoutMs });
}
