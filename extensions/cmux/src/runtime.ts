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
  type Runtime,
  type RuntimeProvider,
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
 *  (maybe nushell) before bash — so we write the pane's launch as a temp bash script and point
 *  the tab at it, sidestepping all shell quoting (callers pass argv, never shell strings).
 *  `exec env -i …` (not `exec …`): exec can't take KEY=val assignments, so `env` applies them and
 *  then execs the command, and `-i` makes the pane inherit ONLY the connector-declared env, not the
 *  cmux server's (P3 — the operator's unrelated secrets don't reach a spawned agent). */
export function paneCommand(pane: { command: string; args?: string[]; cwd?: string; env?: Record<string, string> }): {
  command: string;
  dir: string;
} {
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
  const script = `#!/usr/bin/env bash\nrm -rf -- ${shellQuote(dir)} || exit\n${cd}exec env -i ${cmd}\n`;
  const scriptPath = join(dir, "launch.sh");
  writeFileSync(scriptPath, script, { mode: 0o600 });
  return { command: `bash ${shellQuote(scriptPath)}`, dir };
}

/** A single-terminal pane node in cmux's layout JSON. */
function surface(command: string): unknown {
  return { pane: { surfaces: [{ type: "terminal", command }] } };
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
      if ((spec.confirmBefore?.length || spec.confirmReady?.length) && spec.confirm === undefined) throw new Error("startup choices require a final confirmation prompt");
      watch = spec.confirm === undefined ? undefined : confirmWatch(spec.confirm, spec.confirmBefore, spec.confirmReady);
      launch = paneCommand({ command: spec.command, args: spec.args, env: spec.env, cwd });
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
      down: () => cmux.sendKey("down", { workspace }, CONFIRM_CALL),
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
