import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  registry,
  SpawnRefused,
  confirmWatch,
  type AgentHandle,
  type ConfirmPane,
  type LaunchSpec,
  type Pane,
  type Runtime,
  type RuntimeProvider,
  type Tab,
  type TerminalLayout,
} from "@cotal-ai/core";
import * as cmux from "./driver.js";

/** Grace window for a clean exit before a graceful stop force-closes the tab. */
const GRACE_MS = 1_500;
/** Bounds the startup-confirm watch's Enter and close, because the watch runs on the manager's event
 *  loop; the driver bounds its reads. */
const CONFIRM_CALL = { timeoutMs: 1_000 };

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** cmux can't run a command in a fresh surface directly, and panes start under a login shell
 *  (maybe nushell) before bash — so we write each pane's launch as a temp bash script and point
 *  the tab at it, sidestepping all shell quoting (callers pass argv, never shell strings). `login`
 *  runs it as a login shell (`bash -l`) so the user's PATH is present — setup's panes run further
 *  `cotal` subcommands that resolve `claude`. `exec env …` (not `exec …`): exec can't take KEY=val
 *  assignments, so `env` applies them and then execs the command. `isolate` (agent-spawn panes)
 *  adds `-i` so the pane inherits ONLY the connector-declared env, not the cmux server's (P3 — the
 *  operator's unrelated secrets don't reach a spawned agent); setup panes keep the inherited env. */
export function paneCommand(pane: Pane, login: boolean, isolate = false): { command: string; dir: string } {
  const env = Object.entries(pane.env ?? {}).map(([k, v]) => `${k}=${shellQuote(v)}`);
  const cmd = [...env, shellQuote(pane.command), ...(pane.args ?? []).map(shellQuote)].join(" ");
  const cd = pane.cwd ? `cd ${shellQuote(pane.cwd)}\n` : "";
  // The script holds the pane's env inline (the agent's creds + control token, and any provider key).
  // Write it into a fresh 0o700 temp dir as a 0o600 file: never a world-readable script, and never a
  // predictable, symlink-attackable /tmp path. cmux runs it as the same user via `bash <path>`. It
  // removes its directory before it execs, so the env stays on disk only until bash opens it, and
  // exits instead of running the agent when the removal fails; a caller whose cmux command fails
  // removes `dir` itself, since nothing will run the script.
  const dir = mkdtempSync(join(tmpdir(), "cotal-pane-"));
  const script = `#!/usr/bin/env bash\nrm -rf -- ${shellQuote(dir)} || exit\n${cd}exec env ${isolate ? "-i " : ""}${cmd}\n`;
  const scriptPath = join(dir, "launch.sh");
  writeFileSync(scriptPath, script, { mode: 0o600 });
  return { command: `bash ${login ? "-l " : ""}${shellQuote(scriptPath)}`, dir };
}

/** A single-terminal pane node in cmux's layout JSON. */
function surface(command: string): unknown {
  return { pane: { surfaces: [{ type: "terminal", command }] } };
}

/** Translate a backend-agnostic {@link Tab} into a cmux layout JSON string — the one place that
 *  knows cmux's layout shape. One pane → a bare terminal; several → a split (`direction` + `split`
 *  ratio). These panes run under a login shell. */
function cmuxLayout(label: string, tab: Tab): string {
  const nodes = tab.panes.map((p) => surface(paneCommand(p, true).command));
  if (nodes.length === 1 && !tab.split) return JSON.stringify(nodes[0]);
  if (!tab.split)
    throw new Error(`cmux layout "${label}": ${nodes.length} panes need a split (direction + ratio)`);
  return JSON.stringify({ direction: tab.split.direction, split: tab.split.ratio, children: nodes });
}

/**
 * Spawns each agent into its own new cmux tab (workspace), so spawned teammates get
 * room instead of crowding the spawner. The launch goes through {@link paneCommand}
 * (a temp bash script) — non-login, since the agent's command is an absolute path.
 * Opened unfocused so the human stays put; switch to the new tab to watch the worker.
 * Like tmux, you watch it natively, so `attach()` throws — but teardown is real: we
 * keep the tab's workspace + surface ids to drive and close it.
 */
export class CmuxRuntime implements Runtime {
  readonly kind = "cmux";

  spawn(name: string, spec: LaunchSpec, cwd: string): AgentHandle {
    // `name` becomes a temp-script key and a `cotal-<name>` tab id — keep it a bare token
    // so it can't traverse paths or break the workspace label.
    if (!/^[A-Za-z0-9_.-]+$/.test(name))
      throw new SpawnRefused(`cmux runtime: unsafe agent name ${JSON.stringify(name)} (allowed: letters, digits, _ . -)`);
    if (!cmux.available())
      throw new SpawnRefused(
        `the cmux CLI (${process.env.CMUX_BUNDLED_CLI_PATH ?? "cmux"}) couldn't reach the app — ` +
          "is cmux running, and is this process inside a cmux surface (CMUX_SOCKET_PATH set)?",
      );
    // Nothing has the spec's command until openWorkspace, so a confirm prompt that cannot match or a
    // launch script that cannot be written is a refusal.
    let launch: { command: string; dir: string };
    let watch: ((pane: ConfirmPane) => void) | undefined;
    try {
      watch = spec.confirm === undefined ? undefined : confirmWatch(spec.confirm);
      launch = paneCommand(
        { command: spec.command, args: spec.args, env: spec.env, cwd },
        false,
        true, // isolate: spawned agent gets ONLY the connector-declared env (P3)
      );
    } catch (err) {
      throw new SpawnRefused((err as Error).message);
    }
    // Keep the new tab's workspace ref so we can drive (send keys to its terminal)
    // and close it later. cmux targets the tab's single terminal surface by workspace.
    let workspace: string;
    try {
      workspace = cmux.openWorkspace(`cotal-${name}`, JSON.stringify(surface(launch.command)), { focus: false });
    } catch (err) {
      rmSync(launch.dir, { recursive: true, force: true });
      throw err;
    }

    watch?.({
      read: () => (cmux.workspaceState(workspace) === "exited" ? undefined : cmux.readScreen({ workspace })),
      enter: () => cmux.sendKey("enter", { workspace }, CONFIRM_CALL),
      fail: (message) => {
        console.error(`cmux runtime: "${name}": ${message}`);
        try {
          cmux.closeWorkspace(workspace, CONFIRM_CALL);
        } catch (err) {
          console.error(`cmux runtime: failed to close tab for "${name}":`, err);
        }
      },
    });

    return {
      name,
      kind: "cmux",
      status: () => {
        try {
          return cmux.workspaceState(workspace);
        } catch {
          return "running";
        }
      },
      stop: (opts) => {
        if (opts?.graceful === false) {
          cmux.closeWorkspace(workspace);
          return;
        }
        // Graceful: type `/exit` so the Claude session shuts down cleanly (its
        // SessionEnd hook leaves the mesh), then close the now-idle tab regardless.
        try {
          cmux.send("/exit", { workspace });
          cmux.sendKey("enter", { workspace });
        } catch {
          /* keystroke delivery failed — still ensure the tab is gone below */
        }
        // Deferred, so a throw here is uncaught in a timer and would crash the manager.
        // closeWorkspace already no-ops on an already-gone tab; guard anyway and log a genuine
        // cmux failure rather than let teardown cleanup take the process down.
        setTimeout(() => {
          try {
            cmux.closeWorkspace(workspace);
          } catch (err) {
            console.error(`cmux runtime: failed to close tab for "${name}":`, err);
          }
        }, GRACE_MS);
      },
      waitForExit: () => cmux.waitForWorkspaceExit(workspace),
      interrupt: () => {
        cmux.sendKey("ctrl+c", { workspace });
      },
      attach: () => {
        throw new Error(`cmux runtime: switch to the "cotal-${name}" cmux tab to watch it`);
      },
    };
  }
}

/** Self-registering runtime provider — `import "@cotal-ai/cmux"` makes the manager's
 *  `cmux` runtime available, without the manager depending on this package. */
export const cmuxRuntimeProvider: RuntimeProvider = {
  kind: "runtime",
  name: "cmux",
  available: () => cmux.available(),
  create: () => new CmuxRuntime(),
};

registry.register(cmuxRuntimeProvider);

/** Self-registering terminal-layout provider — lets a caller (e.g. `cotal setup`) open/close
 *  cmux tabs by resolving `registry.resolve("terminal","cmux")`, so an implementation drives cmux
 *  without importing this package. The caller passes a backend-agnostic {@link Tab};
 *  {@link cmuxLayout} turns it into cmux's native layout JSON here, so no cmux-specific shape lives
 *  in the caller. */
export const cmuxTerminalProvider: TerminalLayout = {
  kind: "terminal",
  name: "cmux",
  available: () => cmux.available(),
  open: (label, tab, opts) => cmux.openWorkspace(label, cmuxLayout(label, tab), opts),
  close: (ref) => cmux.closeWorkspace(ref),
  refs: (label) => cmux.workspaceRefs(label),
};

registry.register(cmuxTerminalProvider);
