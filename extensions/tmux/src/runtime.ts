import {
  registry,
  SpawnRefused,
  confirmWatch,
  type AgentHandle,
  type ConfirmPane,
  type LaunchSpec,
  type Runtime,
  type RuntimeProvider,
  type RuntimeReference,
  type Tab,
  type TerminalLayout,
} from "@cotal-ai/core";
import * as tmux from "./driver.js";

/** Grace window for a clean exit before a graceful stop force-closes the window. */
const GRACE_MS = 1_500;
/** Bounds the startup-confirm watch's Enter and close, because the watch runs on the manager's event
 *  loop; the driver bounds its reads. */
const CONFIRM_CALL = { timeoutMs: 1_000 };

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
      throw new SpawnRefused(
        `tmux runtime: unsafe agent name ${JSON.stringify(name)} (allowed: letters, digits, _ . -)`,
      );
    if (!tmux.available())
      throw new SpawnRefused("tmux runtime: tmux is not available — is tmux installed and on PATH?");

    // Nothing has the spec's command until openWindow, so a failure before it (a confirm prompt that
    // cannot match, a session that will not start, a launcher script that cannot be written) is a
    // refusal.
    let command: string;
    let watch: ((pane: ConfirmPane) => void) | undefined;
    try {
      watch = spec.confirm === undefined ? undefined : confirmWatch(spec.confirm);
      tmux.ensureSession(this.session, cwd);
      // P3: env -i strips the tmux server's inherited environment; only the connector-declared
      // env reaches the spawned agent (identity, model key, OS allow-list). privateLaunch keeps those
      // values out of tmux's command line (ps-visible) — they ride a 0o600 launcher script instead.
      command = tmux.privateLaunch(tmux.isolatedCommand(spec.env ?? {}, spec.command, spec.args));
    } catch (err) {
      throw new SpawnRefused((err as Error).message);
    }
    // Key the whole lifecycle off the STABLE window ID (@N), not `session:name`. tmux can rename
    // a window (automatic-rename / a title escape), which would desync a name-based status/stop.
    const { windowId, paneId, serverPid } = tmux.openWindow(this.session, name, command, cwd, { focus: false });

    // A restarted tmux server reuses window and pane ids, so the watch and the handle act only on the one
    // that opened this window. The watch ends the seat's pane, wherever it is now: the window may hold
    // another pane by then.
    const ownServer = { server: serverPid };
    const call = { ...CONFIRM_CALL, ...ownServer };
    watch?.({
      read: () => tmux.capturePane(paneId, serverPid),
      enter: () => tmux.sendKey("Enter", paneId, call),
      fail: (message) => {
        console.error(`tmux runtime: "${name}": ${message}`);
        try {
          tmux.closePane(paneId, call);
        } catch (err) {
          console.error(`tmux runtime: failed to close pane for "${name}":`, err);
        }
      },
    });

    return {
      name,
      kind: "tmux",
      // Durable enough for a successor manager to close this window if this one dies (see reap).
      reference: { kind: "tmux", id: `${serverPid}.${windowId}.${paneId}` },
      status: () => {
        try {
          return tmux.paneState(paneId, ownServer);
        } catch {
          return "running";
        }
      },
      stop: (opts) => {
        if (opts?.graceful === false) return tmux.closeWindow(windowId, ownServer);
        // Graceful: type `/exit` so the Claude session shuts down cleanly (its SessionEnd
        // hook leaves the mesh), then close the now-idle window regardless.
        try {
          tmux.send("/exit", windowId, ownServer);
          tmux.sendKey("Enter", windowId, ownServer);
        } catch {
          /* window already gone — still ensure it's closed below */
        }
        // Deferred, so a throw here is uncaught in a timer and would crash the manager.
        // closeWindow already no-ops on an already-gone window; guard anyway and log a genuine
        // tmux failure rather than let teardown cleanup take the process down.
        setTimeout(() => {
          try {
            tmux.closeWindow(windowId, ownServer);
          } catch (err) {
            console.error(`tmux runtime: failed to close window for "${name}":`, err);
          }
        }, GRACE_MS);
      },
      waitForExit: () => tmux.waitForPaneExit(paneId, ownServer),
      interrupt: () => {
        tmux.sendKey("C-c", windowId, ownServer);
      },
      attach: () => {
        throw new Error(
          `tmux runtime: attach natively — \`tmux attach-session -t ${this.session}\`, then ` +
            `\`tmux select-window -t ${windowId}\` (window "${name}")`,
        );
      },
    };
  }

  /** Close a window an earlier manager opened, by the reference its handle carried, and prove the
   *  window and its pane gone. The window decides, not the pane: a pane that exited can leave its
   *  window open (`remain-on-exit`, or another pane split into it), so a window this runtime's
   *  session still holds is closed whatever its pane's state. A server that is gone, or a window and
   *  pane it no longer lists, means the seat is gone. A pane still listed outside that window, live or
   *  exited, or a window only other sessions hold, is `absent`: nothing here touches it or proves
   *  anything about it. tmux checks the pane and the session again in the command that closes the
   *  window, so a seat whose placement changed after these listings is `absent` too. */
  async reap(reference: RuntimeReference): Promise<{ outcome: "absent" } | { outcome: "reaped"; detail: string }> {
    if (reference.kind !== "tmux") throw new Error(`cannot reap runtime kind "${reference.kind}" with tmux`);
    // The ids reach a tmux format and command string, so only tmux's own id shapes pass.
    const match = /^(\d+)\.(@\d+)\.(%\d+)$/.exec(reference.id);
    if (!match) throw new Error(`tmux runtime: malformed reference ${JSON.stringify(reference.id)}`);
    const [, serverPid, windowId, paneId] = match;
    if (tmux.serverPid() !== serverPid) {
      // Another server answers here. The seat is gone only if the server that ran it is gone too.
      try {
        process.kill(Number(serverPid), 0);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ESRCH")
          return { outcome: "reaped", detail: `tmux server ${serverPid} that ran pane ${paneId} is gone` };
      }
      return { outcome: "absent" };
    }
    const paneAt = tmux.paneWindow(paneId);
    if (paneAt !== undefined && paneAt !== windowId) return { outcome: "absent" };
    const sessions = tmux.windowSessions(windowId);
    if (sessions.length === 0) return { outcome: "reaped", detail: `tmux window ${windowId} and pane ${paneId} were already gone` };
    if (!sessions.includes(this.session)) return { outcome: "absent" };
    if (!tmux.closeWindowIfHeld(this.session, windowId, paneId)) return { outcome: "absent" };
    if (tmux.windowSessions(windowId).length > 0) throw new Error(`tmux: window ${windowId} is still listed after kill-window`);
    await tmux.waitForPaneExit(paneId);
    return { outcome: "reaped", detail: `closed tmux window ${windowId}; pane ${paneId} exited` };
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

  const firstCmd = tmux.privateLaunch(tmux.mergedCommand(first.env ?? {}, first.command, first.args ?? []));
  // Drive splits/focus off the STABLE window ID returned here — never `session:label` (labels can
  // collide or be renamed) or pane indexes `.0`/`.1` (shift under `pane-base-index`).
  const { windowId } = tmux.openWindow(session, label, firstCmd, first.cwd ?? ".", {
    focus: false,
  });

  if (rest.length > 0 && !tab.split)
    throw new Error(
      `tmux layout "${label}": ${tab.panes.length} panes need a split (direction + ratio)`,
    );

  rest.forEach((pane) => {
    const cmd = tmux.privateLaunch(tmux.mergedCommand(pane.env ?? {}, pane.command, pane.args ?? []));
    tmux.splitWindow(windowId, cmd, pane.cwd ?? ".", tab.split!.direction, tab.split!.ratio);
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
