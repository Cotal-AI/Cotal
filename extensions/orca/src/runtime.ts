import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  hardenPrivate,
  registry,
  writeSecretFile,
  type AgentHandle,
  type LaunchSpec,
  type Runtime,
  type RuntimeProvider,
} from "@cotal-ai/core";
import * as orca from "./driver.js";

const GRACE_MS = 2_000;
const CONFIRM_INTERVAL_MS = 1_000;
const MAX_CONFIRMS = 5;
const MAX_WORKTREE_CACHE = 32;

interface LauncherPayload {
  cwd: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface PrivateLauncher {
  command: string;
  dir: string;
  script: string;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function launcherSource(payload: LauncherPayload): string {
  return `import { spawn } from "node:child_process";\n` +
    `import { rmSync } from "node:fs";\n` +
    `const launch = ${JSON.stringify(payload)};\n` +
    `try { rmSync(new URL(".", import.meta.url), { recursive: true, force: true }); } catch {}\n` +
    `process.chdir(launch.cwd);\n` +
    `const child = spawn(launch.command, launch.args, { env: launch.env, stdio: "inherit", windowsHide: false });\n` +
    `let exiting = false;\n` +
    `const forward = (signal) => { if (!exiting && child.pid) child.kill(signal); };\n` +
    `process.on("SIGINT", () => forward("SIGINT"));\n` +
    `process.on("SIGTERM", () => forward("SIGTERM"));\n` +
    `child.on("error", (err) => { console.error("[cotal-orca-launch] " + launch.command + ": " + err.message); process.exit(127); });\n` +
    `child.on("exit", (code, signal) => { exiting = true; if (signal) process.exit(128); process.exit(code ?? 0); });\n`;
}

export function privateLauncher(spec: LaunchSpec, cwd: string): PrivateLauncher {
  const dir = mkdtempSync(join(tmpdir(), "cotal-orca-"));
  hardenPrivate(dir, "dir");
  const script = join(dir, "launch.mjs");
  writeSecretFile(script, launcherSource({ cwd, command: spec.command, args: spec.args, env: spec.env ?? {} }));
  // Orca types --command into an interactive shell. exec makes terminal connectivity track
  // launcher lifetime, while single-quote escaping prevents shell interpolation in temp paths.
  return { command: `exec ${shellQuote(process.execPath)} ${shellQuote(script)}`, dir, script };
}

function cleanupLauncher(launcher: PrivateLauncher): void {
  try {
    rmSync(launcher.dir, { recursive: true, force: true });
  } catch {
    /* the launcher also removes itself after loading */
  }
}

function scheduleConfirm(handle: () => string): void {
  for (let i = 1; i <= MAX_CONFIRMS; i++) {
    setTimeout(() => {
      try {
        orca.sendTerminal(handle(), { enter: true });
      } catch {
        /* terminal may already be gone */
      }
    }, i * CONFIRM_INTERVAL_MS);
  }
}

/** Spawns each managed agent into an Orca terminal in the Orca worktree enclosing the launch cwd. */
export class OrcaRuntime implements Runtime {
  readonly kind = "orca" as const;
  readonly #worktrees = new Map<string, orca.OrcaWorktree>();

  #cacheWorktree(cwd: string, worktree: orca.OrcaWorktree): void {
    this.#worktrees.delete(cwd);
    this.#worktrees.set(cwd, worktree);
    if (this.#worktrees.size > MAX_WORKTREE_CACHE) this.#worktrees.delete(this.#worktrees.keys().next().value!);
  }

  spawn(name: string, spec: LaunchSpec, cwd: string): AgentHandle {
    if (!/^[A-Za-z0-9_.-]+$/.test(name))
      throw new Error(`orca runtime: unsafe agent name ${JSON.stringify(name)} (allowed: letters, digits, _ . -)`);
    if (!orca.available()) throw new Error("orca runtime: Orca CLI/runtime is not reachable (run `orca status --json`)");

    const cwdKey = realpathSync(cwd);
    let worktree = this.#worktrees.get(cwdKey);
    const cachedWorktree = !!worktree;
    if (!worktree) {
      worktree = orca.resolveWorktree(cwd);
      this.#cacheWorktree(cwdKey, worktree);
    }
    const title = `cotal-${name}`;
    const launcher = privateLauncher(spec, cwd);
    let terminal: orca.OrcaTerminal;
    try {
      terminal = orca.createTerminal({ worktreeId: worktree.id, title, command: launcher.command });
    } catch (err) {
      if (cachedWorktree && err instanceof orca.OrcaCliError && /selector_not_found|worktree.*not_found/i.test(err.code)) {
        this.#worktrees.delete(cwdKey);
        worktree = orca.resolveWorktree(cwd);
        this.#cacheWorktree(cwdKey, worktree);
        try {
          terminal = orca.createTerminal({ worktreeId: worktree.id, title, command: launcher.command });
        } catch (retryErr) {
          cleanupLauncher(launcher);
          throw retryErr;
        }
      } else {
        cleanupLauncher(launcher);
        throw err;
      }
    }
    const current = (): orca.OrcaTerminal => {
      terminal = orca.currentTerminal(terminal) ?? terminal;
      return terminal;
    };
    if (spec.confirm) scheduleConfirm(() => current().handle);

    return {
      name,
      kind: "orca",
      status: () => (orca.terminalAlive(terminal) ? "running" : "exited"),
      stop: (opts) => {
        if (opts?.graceful === false) {
          try {
            orca.closeManagedTerminal(terminal);
          } finally {
            cleanupLauncher(launcher);
          }
          return;
        }
        try {
          orca.sendTerminal(current().handle, { text: "/exit", enter: true });
        } catch {
          /* still ensure it closes below */
        }
        setTimeout(() => {
          try {
            orca.closeManagedTerminal(terminal);
          } catch (err) {
            console.error(`orca runtime: failed to close terminal for "${name}":`, err);
          } finally {
            cleanupLauncher(launcher);
          }
        }, GRACE_MS);
      },
      waitForExit: () => orca.waitManagedTerminalExit(terminal),
      interrupt: () => {
        try {
          orca.sendTerminal(current().handle, { interrupt: true });
        } catch (err) {
          if (err instanceof orca.OrcaCliError && /not_found|stale|closed|not_writable/i.test(err.code)) return;
          throw err;
        }
      },
      attach: () => {
        throw new Error(
          `orca runtime: watch this agent in Orca terminal ${current().handle}` +
            `${worktree.displayName ? ` (${worktree.displayName})` : ""}; ` +
            `run \`orca terminal switch --terminal ${terminal.handle}\` to focus it`,
        );
      },
    };
  }
}

/** Self-registering runtime provider — `import "@cotal-ai/orca"` makes the manager's `orca`
 *  runtime available without the manager depending on this package. */
export const orcaRuntimeProvider: RuntimeProvider = {
  kind: "runtime",
  name: "orca",
  available: () => orca.available(),
  create: () => new OrcaRuntime(),
};

registry.register(orcaRuntimeProvider);
