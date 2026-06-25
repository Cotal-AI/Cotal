import {
  registry,
  type AgentHandle,
  type LaunchSpec,
  type Runtime,
  type RuntimeProvider,
  type Tab,
  type TerminalLayout,
} from "@cotal-ai/core";
import * as tmux from "./driver.js";

/** Grace window for a clean exit before a graceful stop force-closes the window. */
const GRACE_MS = 1_500;

/** Schedule Enter keypresses to `target` every second for 5 seconds — auto-clears a
 *  one-time confirmation prompt (e.g. Claude's dev-channels prompt) without blocking. */
function scheduleConfirm(target: string): void {
  for (let i = 1; i <= 5; i++) {
    setTimeout(() => {
      try {
        tmux.sendKey("Enter", target);
      } catch {
        /* window may be gone — ignore */
      }
    }, i * 1_000);
  }
}

/**
 * Spawns each agent into its own new tmux window in a shared per-space session, so
 * spawned teammates get room rather than crowding the spawner. Opened unfocused so the
 * human stays in their current window; switch to `session:name` to watch the worker.
 * Like cmux, you watch natively, so `attach()` throws — but teardown is real: the window
 * target is kept so it can be driven and closed.
 */
export class TmuxRuntime implements Runtime {
  readonly kind = "tmux" as const;

  constructor(private readonly session: string) {}

  spawn(name: string, spec: LaunchSpec, cwd: string): AgentHandle {
    if (!/^[A-Za-z0-9_.-]+$/.test(name))
      throw new Error(
        `tmux runtime: unsafe agent name ${JSON.stringify(name)} (allowed: letters, digits, _ . -)`,
      );
    if (!tmux.available())
      throw new Error("tmux runtime: tmux is not available — is tmux installed and on PATH?");

    tmux.ensureSession(this.session, cwd);
    // P3: env -i strips the tmux server's inherited environment; only the connector-declared
    // env reaches the spawned agent (identity, model key, OS allow-list).
    const command = tmux.isolatedCommand(spec.env ?? {}, spec.command, spec.args);
    // Key the whole lifecycle off the STABLE window ID (@N), not `session:name`. tmux can rename
    // a window (automatic-rename / a title escape), which would desync a name-based status/stop.
    const { windowId } = tmux.openWindow(this.session, name, command, cwd, { focus: false });

    if (spec.confirm) scheduleConfirm(windowId);

    return {
      name,
      kind: "tmux",
      status: () => (tmux.windowAliveRef(windowId) ? "running" : "exited"),
      stop: (opts) => {
        if (opts?.graceful === false) return tmux.closeWindow(windowId);
        // Graceful: type `/exit` so the Claude session shuts down cleanly (its SessionEnd
        // hook leaves the mesh), then close the now-idle window regardless.
        try {
          tmux.send("/exit", windowId);
          tmux.sendKey("Enter", windowId);
        } catch {
          /* window already gone — still ensure it's closed below */
        }
        // Deferred, so a throw here is uncaught in a timer and would crash the manager.
        // closeWindow already no-ops on an already-gone window; guard anyway and log a genuine
        // tmux failure rather than let teardown cleanup take the process down.
        setTimeout(() => {
          try {
            tmux.closeWindow(windowId);
          } catch (err) {
            console.error(`tmux runtime: failed to close window for "${name}":`, err);
          }
        }, GRACE_MS);
      },
      interrupt: () => {
        tmux.sendKey("C-c", windowId);
      },
      attach: () => {
        throw new Error(
          `tmux runtime: attach natively — \`tmux attach-session -t ${this.session}\`, then ` +
            `\`tmux select-window -t ${windowId}\` (window "${name}")`,
        );
      },
    };
  }
}

/** Self-registering runtime provider — `import "@cotal-ai/tmux"` makes the manager's
 *  `tmux` runtime available without the manager depending on this package. */
export const tmuxRuntimeProvider: RuntimeProvider = {
  kind: "runtime",
  name: "tmux",
  available: () => tmux.available(),
  create: (opts) => new TmuxRuntime(opts.session),
};

registry.register(tmuxRuntimeProvider);

/** Translate a backend-agnostic {@link Tab} into a sequence of tmux commands on `session`.
 *  One pane → a bare window; several → a window + splits. These panes inherit the caller's
 *  env (setup panes run further `cotal` subcommands), so no `-i` isolation here. */
function tmuxLayout(session: string, label: string, tab: Tab): string {
  const [first, ...rest] = tab.panes;
  if (!first) throw new Error(`tmux layout "${label}": tab has no panes`);

  const firstCmd = tmux.mergedCommand(first.env ?? {}, first.command, first.args ?? []);
  // Drive splits/focus/confirm off the STABLE window/pane IDs returned here — never `session:label`
  // (labels can collide or be renamed) or pane indexes `.0`/`.1` (shift under `pane-base-index`).
  const { windowId, paneId: firstPane } = tmux.openWindow(session, label, firstCmd, first.cwd ?? ".", {
    focus: false,
  });

  if (rest.length > 0 && !tab.split)
    throw new Error(
      `tmux layout "${label}": ${tab.panes.length} panes need a split (direction + ratio)`,
    );

  if (first.confirm) scheduleConfirm(firstPane);

  rest.forEach((pane) => {
    const cmd = tmux.mergedCommand(pane.env ?? {}, pane.command, pane.args ?? []);
    const newPane = tmux.splitWindow(windowId, cmd, pane.cwd ?? ".", tab.split!.direction, tab.split!.ratio);
    if (pane.confirm) scheduleConfirm(newPane);
  });

  return windowId;
}

/** Self-registering terminal-layout provider — lets a caller (e.g. `cotal setup`) open/close
 *  tmux windows by resolving `registry.resolve("terminal","tmux")`, so an implementation
 *  drives tmux without importing this package. The session is detected from the ambient `$TMUX`
 *  environment; throws if not inside tmux (per AGENTS.md: no silent fallback). */
export const tmuxTerminalProvider: TerminalLayout = {
  kind: "terminal",
  name: "tmux",
  available: () => tmux.available(),
  open: (label, tab, opts) => {
    const session = tmux.currentSession();
    const windowId = tmuxLayout(session, label, tab);
    if (opts?.focus) tmux.selectWindow(windowId);
    // Return the exact window ID we created (stable across renames) — not a label re-lookup, which
    // could resolve a different same-label window.
    return windowId;
  },
  close: (ref) => tmux.closeWindow(ref),
  refs: (label) => tmux.windowRefs(tmux.currentSession(), label),
};

registry.register(tmuxTerminalProvider);
