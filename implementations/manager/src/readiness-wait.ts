import { rejectionText } from "@cotal-ai/core";
import type { AttachSession } from "@cotal-ai/core";
import Headless from "@xterm/headless";
import type { Manager } from "./manager.js";
import { exitProof, pollProvedExit, watchProvedExit } from "./runtime/index.js";
import type { ManagedAgent } from "./seat-types.js";

/** How often the readiness race asks a runtime that streams no exit whether its child has exited, and
 *  how long it waits past the window for the proof of its last read. An operator waits on this reply,
 *  so it asks more often than the exit watch that outlives readiness. */
const READINESS_EXIT_POLL_MS = 1_000;

/** How long the process of a launch that waits for the operator ({@link Connector.waitsForOperator})
 *  must run without exiting before it is ready: long enough that a harness refusing its arguments
 *  exits first and is reported as failed. */
const OPERATOR_READINESS_MS = 3_000;

/** What {@link ReadinessWait} reads from the Manager. Every entry is read at use, so a field the Manager
 *  assigns after construction is always current, and a Manager method a test replaces is the one that runs. */
export interface ReadinessWaitDeps {
  agents: () => Manager["agents"];
  ep: () => Manager["ep"];
  shutdownReadiness: () => Manager["shutdownReadiness"];
  managedPrincipal: (...args: Parameters<Manager["managedPrincipal"]>) => ReturnType<Manager["managedPrincipal"]>;
  onAgentExit: (...args: Parameters<Manager["onAgentExit"]>) => ReturnType<Manager["onAgentExit"]>;
}

/** The launch readiness race (join, exit or the bound), the exit watch that outlives it, and the transcript tail an exit reports. */
export class ReadinessWait {
  constructor(private readonly deps: ReadinessWaitDeps) {}

  // The Manager members these bodies read, under their Manager names. Each reads through its dep at
  // use, so a field the Manager assigns later is current and a method a test replaces on the Manager
  // is the one that runs.
  private get agents() { return this.deps.agents(); }
  private get ep() { return this.deps.ep(); }
  private get shutdownReadiness() { return this.deps.shutdownReadiness(); }
  private managedPrincipal(...args: Parameters<Manager["managedPrincipal"]>): ReturnType<Manager["managedPrincipal"]> { return this.deps.managedPrincipal(...args); }
  private onAgentExit(...args: Parameters<Manager["onAgentExit"]>): ReturnType<Manager["onAgentExit"]> { return this.deps.onAgentExit(...args); }

  /** #159 B1: wait for a detached launch to reach a REAL outcome before replying — never a liveness-
   *  inferring timer. Races three:
   *   • the assigned id joins presence (live) → **started** — the honest signal (the manager owns mesh
   *     lifecycle, not app health, so `ok:true` means "it joined the mesh", not "fully healthy");
   *   • the child process exits → **failed** — surface its last output and reap the slot;
   *   • neither within {@link readinessTimeoutMs} → **uncertain** — a non-success diagnostic that does NOT
   *     deprovision (it may still be booting; the caller keeps {@link watchExit} wired so a later death is
   *     still reaped).
   *  Presence is keyed on the EXACT freshly-minted id, never the name — a fresh id has no prior record, so
   *  any live presence for it is from THIS launch (stale/same-name records can't false-start it). The
   *  `"presence"` event is only a wake; the roster is re-read as the source of truth (subscribe-then-check
   *  catches a join/exit that landed before we subscribed). A runtime whose `attach()` throws (an external
   *  surface) streams no output or exit, so its exit leg polls the runtime's exit proof ({@link pollProvedExit}),
   *  reads it once more when the window closes, and its failure carries no last output; one that cannot prove an
   *  exit either races presence-vs-backstop only.
   *  A launch that waits for the operator at `opts.operator`, a screen its connector names, is ready once a
   *  process this runtime owns has run for {@link OPERATOR_READINESS_MS} without exiting. An uncertain verdict
   *  says whether a process this runtime owns is still running. */
  async awaitReadiness(a: ManagedAgent, readinessTimeoutMs: number, opts: { reapOnExit?: boolean; joinedAfter?: number; operator?: string } = {}): Promise<{ ok: true; operator?: string } | { ok: false; uncertain?: boolean; running?: boolean; deliberate?: boolean; detail: string }> {
    let session: AttachSession | undefined;
    try {
      session = a.handle.attach();
    } catch {
      /* external surfaces stream no output or exit; their exit is polled below */
    }
    const s = session;
    // Presence cards carry the wire PRINCIPAL dot-form (`<owner>.<actor>`), never a raw nkey — match
    // through managedPrincipal or a static launch can never be seen joining (every static spawn would
    // resolve "uncertain"; caught by the lifecycle e2e).
    const wanted = this.managedPrincipal(a);
    // READINESS LIFECYCLE FENCE (SPEC 13.1): match the exact principal AND the exact lifecycle uid
    // the manager minted for THIS spawn (presence carries it, §6). The endpoint's own
    // register-only broker proof is gated on the CLIENT-authored `card.kind`, which a managed child
    // holding a valid agent credential could set to "endpoint" to skip - so it is defense-in-depth,
    // NOT the authority boundary. This equality is: the manager (not the child) owns the expected
    // uid, so a ghost that advertises a wrong/absent uid never reports STARTED, whatever kind it
    // claims. The manager threads the uid into EVERY mode's launch (open included), so the child
    // adopts it over a self-mint and publishes it in presence; the uid is absent only from a peer
    // the manager never launched (a pure operator/daemon connection that never registers).
    // A supervised restart keeps the same principal+uid, so a SIGKILL'd child's still-live
    // presence row would otherwise satisfy this equality. `joinedAfter` is one millisecond
    // past that row's last heartbeat: only a later heartbeat counts as THIS replacement joining.
    const joined = (): boolean =>
      this.ep.getRoster().some((p) =>
        p.card.id === wanted
        && p.status !== "offline"
        && p.lifecycleUid === a.lifecycleUid
        && (opts.joinedAfter === undefined || p.ts >= opts.joinedAfter));

    return await new Promise((resolve) => {
      let done = false;
      let timer: ReturnType<typeof setTimeout>;
      let unsubExit = (): void => {};
      let joinedPoll: ReturnType<typeof setInterval> | undefined;
      let operatorTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = (r: { ok: true; operator?: string } | { ok: false; uncertain?: boolean; running?: boolean; deliberate?: boolean; detail: string }): void => {
        if (done) return;
        done = true;
        if (!r.ok && r.uncertain) {
          a.joinIssue = r.detail;
          console.error(`seat join degraded: ${r.detail}`);
        } else if (r.ok) {
          a.joinIssue = undefined;
        }
        clearTimeout(timer);
        clearTimeout(operatorTimer);
        if (joinedPoll !== undefined) clearInterval(joinedPoll);
        this.ep.off("presence", onPresence);
        this.shutdownReadiness.signal.removeEventListener("abort", onShutdown);
        unsubExit();
        resolve(r);
      };
      const onPresence = (): void => {
        if (joined()) finish({ ok: true });
      };
      // Shutdown owns the seat's stop and retirement after the lifecycle ticket drains. Do not
      // keep that ticket waiting on a connector's readiness window while shutdown waits on it.
      const onShutdown = (): void => finish({ ok: false, deliberate: true, detail: `${a.name} was stopped before it reported ready` });
      if (opts.joinedAfter !== undefined) {
        // Heartbeats bump roster.ts without emitting "presence" (same status/uid/activity).
        // A supervised restart needs that bump, so poll joined() rather than waiting on the event.
        joinedPoll = setInterval(onPresence, 50);
      }
      // Process exit → failed. Clear the backstop FIRST (synchronously) so it can't resolve UNCERTAIN while
      // the backlog reads async — the process is known dead, that's a failure, not an unknown. Reap through
      // onAgentExit so a child the launcher spawned in the window is reaped too.
      const onExit = (): void => {
        if (done) return;
        clearTimeout(timer);
        clearTimeout(operatorTimer);
        // `stopHandle` sets `terminalizing` synchronously before it kills, and `onAgentExit` sets it
        // through `freeSlot` when it retires the seat, so only a read before the await and the reap
        // tells a deliberate stop from a launch failure.
        const deliberate = a.terminalizing === true;
        void (async () => {
          // A closed stream or a reader failure must not prevent settlement, or read as empty output.
          let tail = "";
          try {
            if (s) tail = await this.tail(s);
          } catch (error) {
            console.error(`! ${a.name}: last output unavailable: ${rejectionText(error)}`);
          }
          if (opts.reapOnExit !== false) this.onAgentExit(a);
          // The despawn path owns this goal's terminal (`cancel`), and this promise still settles
          // as the `deliberate` variant so the caller commits none: the readiness timer is already
          // cleared, and the spawn's lifecycle ticket is released only on settle.
          if (deliberate) {
            finish({ ok: false, deliberate: true, detail: `${a.name} was stopped before it reported ready` });
            return;
          }
          // The screen's last row can be a dialog footer, so the exit's diagnostic is named beside it:
          // it carries the runtime's own reason when it stopped the seat. A connector that ends on its
          // diagnostic already shows it as the last row, and it is not repeated.
          let exitDetail = "";
          try {
            const diagnostic = a.handle.exitInfo?.()?.diagnostic;
            if (diagnostic && diagnostic !== tail) exitDetail = `; diagnostic: ${diagnostic}`;
          } catch (e) {
            // The backstop is already cleared, so a reader that throws must still let this settle.
            exitDetail = `; exit detail unreadable from runtime "${a.handle.kind}": ${rejectionText(e)}`;
          }
          // A runtime's text can carry a lone surrogate, which is not I-JSON, and the failed terminal
          // this detail becomes is refused with it.
          exitDetail = exitDetail.replace(/\p{Cs}/gu, "\uFFFD");
          finish({ ok: false, detail: `${a.name} exited on launch${tail ? ` - last output: ${tail}` : ""}${exitDetail}` });
        })();
      };
      // A process this runtime owns reports its own exit, so one still running here is running.
      const uncertain = (): void => {
        const running = s !== undefined && a.handle.status() === "running";
        finish({
          ok: false,
          uncertain: true,
          running,
          detail: running
            ? `${a.name} (${a.id}): launch status uncertain - its process is running but did not join the mesh within ${readinessTimeoutMs}ms; it may still be starting or waiting at a prompt. Inspect with \`cotal attach ${a.name}\` / \`cotal ps\`; do not stop it solely because this bounded wait elapsed.`
            : `${a.name} (${a.id}): launch status uncertain - no process exit and no mesh presence within ${readinessTimeoutMs}ms; it may still be booting or stuck before connector startup. Inspect with \`cotal attach ${a.name}\` / \`cotal ps\`; do not stop it solely because this bounded wait elapsed.`,
        });
      };
      if (opts.operator !== undefined && s)
        operatorTimer = setTimeout(() => { if (a.handle.status() === "running") finish({ ok: true, operator: opts.operator }); }, OPERATOR_READINESS_MS);
      // The exit poll read the runtime up to a poll ago, and a window can be shorter than a poll, so
      // the window closes on a fresh read: a child that exited by then is reported as exited. Nothing
      // bounds how long a runtime's proof takes, so it gets one more poll before the launch is uncertain.
      timer = setTimeout(() => {
        const proof = s ? undefined : exitProof(a.handle);
        if (!proof) {
          uncertain();
          return;
        }
        timer = setTimeout(uncertain, READINESS_EXIT_POLL_MS);
        proof.then(onExit, uncertain);
      }, readinessTimeoutMs);
      // The poll stops once the race is done, so it needs no unsubscribe.
      if (s) unsubExit = s.onExit(onExit);
      else pollProvedExit(a.handle, onExit, () => !done, READINESS_EXIT_POLL_MS);
      this.ep.on("presence", onPresence);
      this.shutdownReadiness.signal.addEventListener("abort", onShutdown, { once: true });
      // Subscribe-then-check (TOCTOU): a join or an exit that already landed before we subscribed.
      if (this.shutdownReadiness.signal.aborted) onShutdown();
      else if (s && a.handle.status() === "exited") onExit();
      else onPresence();
    });
  }

  /** Last non-empty line of the session's rendered backlog as a single trimmed snippet (≤160 chars)
   *  — a readable one-line cause for an early-exit diagnostic. The backlog repaints cells a TUI
   *  skipped with cursor moves, so it is rendered and the line is read off the terminal; stripping
   *  its escapes would glue the words those moves separate. */
  async tail(session: AttachSession): Promise<string> {
    const backlog = await session.backlog();
    // Sized after the snapshot: a custodial seat's snapshot carries the geometry it was taken at.
    // The headless build exposes `buffer` only as proposed API.
    const term = new Headless.Terminal({ cols: session.cols, rows: session.rows, allowProposedApi: true });
    await new Promise<void>((done) => term.write(backlog, done));
    const screen = term.buffer.active;
    let text = "";
    for (let y = screen.length - 1; y >= 0; y--) {
      const row = screen.getLine(y)!;
      // A line wider than the screen continues across wrapped rows, so it is read whole.
      text = row.translateToString(text === "") + text;
      if (row.isWrapped) continue;
      // Blanks a program painted survive the right trim, so a line of only blanks is skipped.
      if (text.trim()) break;
      text = "";
    }
    term.dispose();
    text = text.trim();
    // Cut on code points: half a surrogate pair is not I-JSON, and a launch terminal carrying it is refused.
    const chars = [...text];
    return chars.length > 160 ? `…${chars.slice(-160).join("")}` : text;
  }

  /** Subscribe to a managed agent's process-exit so a self-driven exit frees its slot and reaps
   *  its children (P4b/P4c). The watch is bound to the current handle: a restart swaps in a new one
   *  and watches it, so a late exit proved for the old handle must not retire the row. */
  watchExit(a: ManagedAgent): void {
    const handle = a.handle;
    const current = (): boolean => this.agents.get(a.name) === a && a.handle === handle;
    const watched = watchProvedExit(handle, () => this.onAgentExit(a), current);
    if (!watched)
      console.error(`! ${a.name}: runtime "${handle.kind}" cannot prove a child exit (AgentHandle.waitForExit is not implemented) - it stays managed after it exits, until it is stopped`);
  }
}
