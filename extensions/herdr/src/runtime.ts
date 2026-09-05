import { mkdtempSync, rmSync, statSync } from "node:fs";
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
import * as herdr from "./driver.js";

const GRACE_MS = 2_000;
const CONFIRM_INTERVAL_MS = 1_000;
const MAX_CONFIRMS = 5;

interface LauncherPayload {
  cwd: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface PrivateLauncher {
  argv: string[];
  dir: string;
  script: string;
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
    `child.on("error", (err) => { console.error("[cotal-herdr-launch] " + launch.command + ": " + err.message); process.exit(127); });\n` +
    `child.on("exit", (code, signal) => { exiting = true; if (signal) process.exit(128); process.exit(code ?? 0); });\n`;
}

/** The connector-declared env (identity, creds, control token) must never appear on herdr's
 *  command line or in the server's pane records, so it rides an owner-only (0o600) launcher
 *  script in a private temp dir; herdr only ever sees `node <script>`. The script removes its
 *  own directory as soon as it has loaded. */
export function privateLauncher(spec: LaunchSpec, cwd: string): PrivateLauncher {
  // Prefix is specifically `cotal-herdr-launch-`, not `cotal-herdr-`: the smoke counts launcher
  // dirs to prove failed spawns clean up after themselves, and a shorter prefix would also match
  // the driver's own `cotal-herdr-srv-` scratch, making that count wider than the claim it tests.
  const dir = mkdtempSync(join(tmpdir(), "cotal-herdr-launch-"));
  hardenPrivate(dir, "dir");
  const script = join(dir, "launch.mjs");
  writeSecretFile(script, launcherSource({ cwd, command: spec.command, args: spec.args, env: spec.env ?? {} }));
  return { argv: [process.execPath, script], dir, script };
}

/** How spawned agents are laid out in the session: `tab` (default) gives each agent its own
 *  name-labeled tab; `split` shares one tab, splitting it per agent.
 *  Selected per manager process via COTAL_HERDR_LAYOUT; an unknown value fails loud. */
function layoutFromEnv(): "tab" | "split" {
  const raw = process.env.COTAL_HERDR_LAYOUT ?? "tab";
  if (raw === "tab" || raw === "split") return raw;
  throw new Error(
    `herdr runtime: unknown COTAL_HERDR_LAYOUT ${JSON.stringify(raw)} (expected "tab" or "split")`,
  );
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function cleanupLauncher(launcher: PrivateLauncher): void {
  try {
    rmSync(launcher.dir, { recursive: true, force: true });
  } catch {
    /* the launcher also removes itself after loading */
  }
}

/**
 * Spawns each managed agent into a pane of a DEDICATED named herdr session (`cotal-<space>`,
 * from the manager) with its own server and socket — never the operator's default session, so
 * no Cotal operation can inspect or kill unrelated panes. Panes are owned by the herdr server,
 * so agents survive the manager's terminal going away; watch them with
 * `herdr session attach <session>`. Lifecycle is keyed off the globally-unique `terminal_id`;
 * the workspace-scoped public `pane_id` is re-resolved before every pane-scoped call (a pane
 * move changes it) and never trusted from cache.
 */
export class HerdrRuntime implements Runtime {
  readonly kind = "herdr" as const;

  constructor(private readonly session: string) {}

  spawn(name: string, spec: LaunchSpec, cwd: string): AgentHandle {
    if (!/^[A-Za-z0-9_.-]+$/.test(name))
      throw new Error(`herdr runtime: unsafe agent name ${JSON.stringify(name)} (allowed: letters, digits, _ . -)`);
    if (!herdr.available()) {
      const found = herdr.versionText();
      throw new Error(
        `herdr runtime: no usable herdr on PATH - needs >= ${herdr.MIN_HERDR.join(".")}` +
          (found ? ` (found "${found}")` : " (herdr not installed or not on PATH)"),
      );
    }
    // herdr silently substitutes $HOME for a bad --cwd; validate here so a bad workspace
    // fails loud at spawn instead of the agent starting somewhere else entirely (a non-directory
    // would otherwise die later, invisibly, at the launcher's chdir).
    if (!isDirectory(cwd)) throw new Error(`herdr runtime: cwd ${JSON.stringify(cwd)} is not a directory`);
    const layout = layoutFromEnv(); // before any side effects, so a bad value spawns nothing
    herdr.ensureServer(this.session);

    // `split` shares a tab, so the tab set has to be sampled BEFORE this agent adds its own.
    const tabsBefore = layout === "split" ? herdr.tabIds(this.session) : [];

    const launcher = privateLauncher(spec, cwd);
    let agent: herdr.HerdrAgent | undefined;
    let startedTerminalId: string | undefined;
    try {
      // agentStart lands the agent in its own workspace + name-labeled tab, so the default
      // layout needs no move at all.
      agent = herdr.agentStart(this.session, name, cwd, launcher.argv);
      startedTerminalId = agent.terminalId;
      // `split`: fold this agent into a pre-existing tab. With none (the first agent) there is
      // nothing to share and it stays where it is — that is the layout's meaning, not a fallback.
      // The move changes the public pane id — keep the returned, terminal-pinned record.
      if (layout === "split" && tabsBefore.length > 0)
        agent = herdr.paneMoveIntoTab(this.session, agent.paneId, tabsBefore[0]!, startedTerminalId);
      // Cosmetic but part of the spawn contract: fail loud, and don't leave the started pane behind.
      herdr.reportMetadata(this.session, agent.paneId, "cotal", { cotal: this.session });
    } catch (err) {
      if (startedTerminalId) {
        // A move may have already changed the public pane id when the failure hit — never
        // close whichever pane record happened to assign; re-resolve off the stable terminal.
        try {
          const current = herdr.agentInfo(this.session, startedTerminalId);
          if (current) herdr.closePane(this.session, current.paneId);
        } catch {
          /* best-effort teardown of the half-spawned pane */
        }
      }
      cleanupLauncher(launcher);
      throw err;
    }
    const { terminalId } = agent;
    const session = this.session;

    /** The CURRENT pane id for this terminal — resolved fresh for every pane-scoped op, never
     *  the (possibly stale) id from spawn time. Gone terminal → HerdrCliError(pane_not_found). */
    const currentPane = (): string => {
      const info = herdr.agentInfo(session, terminalId);
      if (!info) throw new herdr.HerdrCliError("pane_not_found", `terminal ${terminalId} is gone`);
      return info.paneId;
    };

    if (spec.confirm) {
      for (let i = 1; i <= MAX_CONFIRMS; i++) {
        setTimeout(() => {
          try {
            herdr.sendKeys(session, currentPane(), "enter");
          } catch {
            /* pane may already be gone */
          }
        }, i * CONFIRM_INTERVAL_MS);
      }
    }

    return {
      name,
      kind: "herdr",
      // terminalState throws on any failed inventory (fail closed); for the status probe that
      // uncertainty must read as "running" — preserving, like tmux — never as a false exit.
      status: () => {
        try {
          return herdr.terminalState(session, terminalId);
        } catch {
          return "running";
        }
      },
      stop: (opts) => {
        if (opts?.graceful === false) {
          try {
            herdr.closePane(session, currentPane());
          } catch (err) {
            if (!(err instanceof herdr.HerdrCliError && err.code === "pane_not_found")) throw err;
          } finally {
            cleanupLauncher(launcher);
          }
          return;
        }
        // Graceful: type `/exit` so the agent session shuts down cleanly (its lifecycle hook
        // leaves the mesh), then close the now-idle pane regardless. Both calls are pane-scoped,
        // so resolve the pane ONCE — re-resolving between them would let the id move underneath.
        try {
          const pane = currentPane();
          herdr.sendText(session, pane, "/exit");
          herdr.sendKeys(session, pane, "enter");
        } catch {
          /* terminal already gone — still ensure the pane closes below */
        }
        // Deferred: a throw here would be uncaught in a timer and crash the manager — guard it.
        setTimeout(() => {
          try {
            herdr.closePane(session, currentPane());
          } catch (err) {
            if (err instanceof herdr.HerdrCliError && err.code === "pane_not_found") return;
            console.error(`herdr runtime: failed to close pane for "${name}":`, err);
          } finally {
            cleanupLauncher(launcher);
          }
        }, GRACE_MS);
      },
      waitForExit: () => herdr.waitForTerminalExit(session, terminalId),
      interrupt: () => {
        try {
          herdr.sendKeys(session, currentPane(), "ctrl+c");
        } catch (err) {
          if (err instanceof herdr.HerdrCliError && err.code === "pane_not_found") return;
          throw err;
        }
      },
      attach: () => {
        // NOT `agent attach`: herdr reserves its agent registry for recognized kinds, and a pane
        // started by this runtime never joins it — that command would report the agent as missing.
        throw new Error(
          `herdr runtime: attach natively - \`herdr session attach ${session}\`, ` +
            `then select the "${name}" tab (terminal ${terminalId})`,
        );
      },
    };
  }
}

/** Self-registering runtime provider — `import "@cotal-ai/herdr"` makes the manager's `herdr`
 *  runtime available without the manager depending on this package. */
export const herdrRuntimeProvider: RuntimeProvider = {
  kind: "runtime",
  name: "herdr",
  available: () => herdr.available(),
  create: (opts) => new HerdrRuntime(opts.session),
};

registry.register(herdrRuntimeProvider);
