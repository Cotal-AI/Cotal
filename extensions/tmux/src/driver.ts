import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  try {
    const out = execFileSync("tmux", ["list-windows", "-t", session, "-F", "#W"], {
      encoding: "utf8",
    });
    return out.split("\n").map((l) => l.trim()).includes(name);
  } catch {
    return false;
  }
}

/** True if a window with the stable ID `windowId` (`@N`) still exists. Window IDs are server-global,
 *  so we test exact membership in the full window list — surviving renames, unlike {@link windowAlive}
 *  (name match). (Don't use `display-message -t`: for a stale target it silently falls back to the
 *  current window instead of erroring, so it can't detect a closed window.) */
export function windowAliveRef(windowId: string): boolean {
  try {
    return execFileSync("tmux", ["list-windows", "-a", "-F", "#{window_id}"], { encoding: "utf8" })
      .split("\n")
      .map((l) => l.trim())
      .includes(windowId);
  } catch {
    return false;
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
  const args = ["new-window", "-t", session, "-n", name, "-c", cwd];
  if (!(opts.focus ?? false)) args.push("-d");
  // -P -F prints the new window + pane IDs before returning — stable across renames and reorders.
  args.push("-P", "-F", "#{window_id} #{pane_id}", command);
  const out = execFileSync("tmux", args, { encoding: "utf8" }).trim();
  const [windowId, paneId] = out.split(/\s+/);
  if (!windowId || !paneId)
    throw new Error(`tmux: couldn't read window/pane IDs from new-window ("${out}")`);
  return { windowId, paneId };
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
export function closeWindow(target: string): void {
  try {
    execFileSync("tmux", ["kill-window", "-t", target], { stdio: "pipe" });
  } catch (err) {
    if (isWindowGone(err)) return;
    throw err;
  }
}

/** Window names open in `session`, or `[]` if unreachable. */
export function listWindows(session: string): string[] {
  try {
    return execFileSync("tmux", ["list-windows", "-t", session, "-F", "#W"], {
      encoding: "utf8",
    })
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Stable window IDs (`@N`) of every window in `session` whose name is exactly `label`. */
export function windowRefs(session: string, label: string): string[] {
  try {
    return execFileSync(
      "tmux",
      ["list-windows", "-t", session, "-F", "#{window_id} #{window_name}"],
      { encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        const sp = line.indexOf(" ");
        const id = line.slice(0, sp);
        const name = line.slice(sp + 1).trim();
        return name === label ? [id] : [];
      });
  } catch {
    return [];
  }
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
export function sendKey(key: string, target: string): void {
  execFileSync("tmux", ["send-keys", "-t", target, "--", key], { stdio: "ignore" });
}
