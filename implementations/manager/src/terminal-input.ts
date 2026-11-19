import { DEV_OWNER, EpEnvelopeError, mintCreds, newIdentity, rejectionText } from "@cotal-ai/core";
import type { ControlReply } from "@cotal-ai/core";
import Headless from "@xterm/headless";
import type { SessionEstablishment } from "./attach-endpoint.js";
import { MANAGER_ENDPOINT } from "./manager-service-contract.js";
import type { Manager } from "./manager.js";
import type { ManagedAgent } from "./seat-types.js";

/** How much of an `input` text is written to a seat's pty at a time. Comfortably under the 4096-byte
 * kernel input buffer, so a slice is never re-split at a boundary the manager did not choose: the
 * tail of an oversized write stays queued and swallows the submit key that follows it (issue #1649).
 * Sized in CHARS against a byte buffer on purpose — a multi-byte character can only make a slice
 * shorter in characters than in bytes, never longer, so the margin cannot be eaten from below. */
const INPUT_SLICE_CHARS = 2048;

/** Bracketed-paste delimiters (DECSET 2004). `input` wraps a seat's text in these so the return it
 * writes afterwards is a KEYSTROKE rather than the newline trailing a pasted block: a TUI that
 * classifies a fast burst as a paste consumes that trailing newline and the text sits unsubmitted
 * in the composer until the next call's return (issue #1649). Framing, never content - these bytes
 * are not counted into the receipt, so `bytes` still reports what the caller asked to deliver. */
export const PASTE_START = "\x1b[200~";

export const PASTE_END = "\x1b[201~";

/** `details[].kind` on an `attach` refusal raised because the seat's runtime opens no terminal
 * stream. The message carries that runtime's own guidance, which is operator copy and changes; this
 * marker is the contract a caller keys on so it can act without reading the wording. */
export const RUNTIME_NO_TERMINAL_DETAIL = "ai.cotal.manager.runtime-no-terminal";

/** What {@link TerminalInput} reads from the Manager. Every entry is read at use, so a field the Manager
 *  assigns after construction is always current, and a Manager method a test replaces is the one that runs. */
export interface TerminalInputDeps {
  agents: () => Manager["agents"];
  auth: () => Manager["auth"];
  managerLifecycleUid: () => Manager["managerLifecycleUid"];
  sessionPlane: () => Manager["sessionPlane"];
  wsPort: () => Manager["wsPort"];
  runtimeFor: (...args: Parameters<Manager["runtimeFor"]>) => ReturnType<Manager["runtimeFor"]>;
}

/** Typing into a seat's terminal and opening an attach or console session on it, after authorization. */
export class TerminalInput {
  constructor(private readonly deps: TerminalInputDeps) {}

  // The Manager members these bodies read, under their Manager names. Each reads through its dep at
  // use, so a field the Manager assigns later is current and a method a test replaces on the Manager
  // is the one that runs.
  private get agents() { return this.deps.agents(); }
  private get auth() { return this.deps.auth(); }
  private get managerLifecycleUid() { return this.deps.managerLifecycleUid(); }
  private get sessionPlane() { return this.deps.sessionPlane(); }
  private get wsPort() { return this.deps.wsPort(); }
  private runtimeFor(...args: Parameters<Manager["runtimeFor"]>): ReturnType<Manager["runtimeFor"]> { return this.deps.runtimeFor(...args); }

  /** The post-authorization `input` effect (C3): type `text` into the seat's terminal as if a human
   *  had. The single call an external UI needs to deliver a harness command (`/compact`, `/clear`,
   *  `/model`) without holding a terminal open on the caller's side.
   *
   *  Why the runtime HANDLE and not an attach session: a session is a stream (backlog, subscriber
   *  set, a lifetime the session plane accounts for and caps). Opening and discarding one per
   *  keystroke line would burn a session slot for a write, and would put a capacity refusal in the
   *  path of an operation that has no capacity cost. {@link AgentHandle.write} is the one-shot
   *  sibling of `interrupt()`, which already writes into the same pty.
   *
   *  Three refusals, each for a different reason and each with its own code, so a caller can tell
   *  "never going to work" from "not right now":
   *   - the name was refilled while authorization awaited: act on the incarnation the caller was
   *     authorized for or on nothing at all (the same guard {@link attachAuthorized} carries, for
   *     the same reason: a name is a reusable slot and `authorizeNamed` can await a ledger read);
   *   - the agent is not running: there is no terminal to type into;
   *   - the runtime cannot write (tmux/cmux/orca/herdr attach to an externally-owned process, so
   *     they own no input stream for it): `unimplemented`, named by runtime kind. NOT a fallback
   *     to an attach session and NOT a silent success - a dropped keystroke would leave the caller
   *     believing a command was delivered that never was.
   *
   *  `enter` defaults to true: a harness command typed but not submitted has not been delivered.
   *  Nothing is echoed back; the caller reads the resulting turns from the event plane. */
  async inputAuthorized(a: ManagedAgent, args: Record<string, unknown>): Promise<{ name: string; bytes: number }> {
    // These three refuse before the first write, so nothing was typed (SPEC 13.3). A write the
    // runtime rejects below states no outcome: the runtime contract does not say a rejected write
    // delivered nothing, and an earlier slice may already have reached the seat.
    if (this.agents.get(a.name) !== a)
      throw new EpEnvelopeError("failed-precondition", `agent "${a.name}" was replaced during authorization - retry`, undefined, "not-executed");
    if (a.handle.status() !== "running")
      throw new EpEnvelopeError("failed-precondition", `agent "${a.name}" is not running (${a.handle.status()}); nothing to type into`, undefined, "not-executed");
    const write = a.handle.write?.bind(a.handle);
    if (!write)
      throw new EpEnvelopeError("unimplemented", `input is not supported by runtime ${a.handle.kind}`, undefined, "not-executed");
    if (a.agent === "claude") {
      // AskUserQuestion ignores bracketed text at its choice menu, but the following Enter
      // confirms the highlighted option. Refuse rather than answer a different question choice.
      const handle = a.handle;
      let selection = false;
      try {
        const session = handle.attach();
        const backlog = await session.backlog();
        const term = new Headless.Terminal({ cols: session.cols, rows: session.rows, allowProposedApi: true });
        try {
          await new Promise<void>((done) => term.write(backlog, done));
          const screen = term.buffer.active;
          const lines = Array.from({ length: term.rows }, (_, y) =>
            screen.getLine(screen.baseY + y)?.translateToString(true).trim() ?? "");
          selection = lines.some((line) => /^❯\s+\d+\./u.test(line))
            && lines.some((line) => line.includes("Enter to select") && line.includes("↑/↓ to navigate") && line.includes("Esc to cancel"));
        } finally {
          term.dispose();
        }
      } catch {
        throw new EpEnvelopeError("failed-precondition", `cannot inspect Claude input for seat "${a.name}"; use \`cotal attach --name ${a.name}\` to inspect and type directly`, undefined, "not-executed");
      }
      if (selection)
        throw new EpEnvelopeError("failed-precondition", `Claude is showing a selection menu for seat "${a.name}"; input text cannot safely select an option. Use \`cotal attach --name ${a.name}\`, then arrow keys and Enter; nothing was typed`, undefined, "not-executed");
      // Snapshot parsing awaits I/O. Keep this write bound to the authorized incarnation and handle.
      if (this.agents.get(a.name) !== a || a.handle !== handle || handle.status() !== "running")
        throw new EpEnvelopeError("failed-precondition", `agent "${a.name}" changed while inspecting its terminal; nothing was typed`, undefined, "not-executed");
    }
    // The contract validated `text` (non-empty, <= 64KiB) and `enter` (boolean) before this ran, so
    // the only decision left is the carriage return. `!== false` and not `?? true`: an ABSENT enter
    // and an explicit `true` must behave identically, and only `false` may suppress the return.
    //
    // THE TEXT IS DELIVERED AS A BRACKETED PASTE AND THE RETURN FOLLOWS IT AS ITS OWN WRITE, and
    // that is the whole of issue #1649. A TUI harness reads keystrokes, so a return fused onto the
    // tail of the text (`${text}\r`) is the text's last character rather than the submit key: the
    // line waits in the composer and the NEXT call's return submits the PREVIOUS call's text, so
    // every delivery runs one call behind while the op still reports the full byte count.
    //
    // Separating the return is necessary and NOT sufficient, which is the part that cost a second
    // round of measurement. A TUI classifies a fast burst of input as a PASTE and eats the newline
    // that trails it (Jcode spells this `paste_guard::consume_paste_trailing_enter`), so a text big
    // enough to need more than one write is still one call behind even when the return is written
    // alone. Measured on a real seat, delivering in 2048-char slices with a yield before the return:
    // 120 and 700 bytes submitted on their own call, 2500 and 3100 bytes did not - each appeared
    // only when the NEXT call's return arrived. That is the reported symptom exactly.
    //
    // Bracketed paste states the boundary instead of guessing at it. `ESC[200~ text ESC[201~`
    // delimits the pasted block, so the return after it is unambiguously a keystroke and the guard
    // has no trailing newline to consume. This is a CLASSIFIER, not a race, so a sleep would be the
    // wrong instrument: measured on a real seat, a 250ms pause before the return still lost the
    // submission while 1000ms carried it, and any margin chosen from those numbers is a guess a
    // loaded host breaks. Bracketed delivery submitted 120, 2600 and 5912 bytes (the issue's own
    // size) each on its own call. The terminal advertises support by enabling DECSET 2004, which
    // Jcode's TUI does.
    //
    // The bytes the SEAT receives as text are unchanged, and the receipt still counts the text plus
    // the return: the paste markers are framing this op adds, never content the caller asked to
    // deliver, so counting them would make `bytes` disagree with what the caller sent.
    const text = String(args.text);
    const submit = args.enter !== false;
    const intendedBytes = Buffer.byteLength(text, "utf8") + (submit ? 1 : 0);
    const parts: Array<{ data: string; counted: boolean }> = [{ data: PASTE_START, counted: false }];
    for (let i = 0; i < text.length; i += INPUT_SLICE_CHARS)
      parts.push({ data: text.slice(i, i + INPUT_SLICE_CHARS), counted: true });
    parts.push({ data: PASTE_END, counted: false });
    // `enter:false` still presses nothing: the text is delivered into the composer and left there.
    if (submit) parts.push({ data: "\r", counted: true });
    let bytes = 0;
    for (const [i, part] of parts.entries()) {
      // Yield BEFORE each write but the first, so the child drains the previous slice rather than
      // the pty buffer merging them. `setImmediate` runs after I/O, which a microtask would not.
      if (i > 0) await new Promise<void>((resolve) => setImmediate(resolve));
      let accepted: number;
      try {
        accepted = await write(part.data);
      } catch (error) {
        throw new EpEnvelopeError("unavailable", `input for seat "${a.name}" failed: ${rejectionText(error)}`);
      }
      if (!Number.isSafeInteger(accepted)) {
        throw new EpEnvelopeError("unavailable", `input for seat "${a.name}" failed: runtime accepted ${String(accepted)} of ${intendedBytes} bytes`);
      }
      // A short write on ANY part is a failed delivery, including a marker: a paste block that was
      // opened but not closed would leave the seat's composer in paste mode.
      if (accepted !== Buffer.byteLength(part.data, "utf8"))
        throw new EpEnvelopeError("unavailable", `input for seat "${a.name}" failed: runtime accepted ${accepted} of ${Buffer.byteLength(part.data, "utf8")} bytes of one write`);
      if (part.counted) bytes += accepted;
    }
    if (bytes !== intendedBytes)
      throw new EpEnvelopeError("unavailable", `input for seat "${a.name}" failed: runtime accepted ${String(bytes)} of ${intendedBytes} bytes`);
    return { name: a.name, bytes };
  }

  /** The post-authorization attach effect: mint the holder-bound §13.6 offer, redeem it
   *  through the ONE session plane (one-use CAS + presenter-equality), and stand up the PTY bridge —
   *  atomically. The reply is the SIGNED grant (no ws:// URL, non-bearer, never logged); the caller
   *  redeems it over the mesh with a per-session rails-only cred it mints itself. Only streamable
   *  backends (pty/host) attach; an external runtime's attach() throws with per-runtime guidance. */
  async attachAuthorized(a: ManagedAgent, caller: { owner: string; actor: string; uid: string }): Promise<ControlReply> {
    // Every refusal before establishAttach below has opened no session, so it states that (SPEC 13.3).
    if (!this.sessionPlane) throw new EpEnvelopeError("failed-precondition", "the manager session plane is not available (the manager is not fully started)", undefined, "not-executed");
    // A name is a reusable slot and the authorization above can await (user mode reads the ledger).
    // The ep target is incarnation-pinned, so `a` cannot BE a successor — but the slot it names can
    // have been stopped and refilled while we waited, and everything below must act on the
    // incarnation this caller was actually authorized for, never on whoever holds the name now.
    if (this.agents.get(a.name) !== a)
      throw new EpEnvelopeError("failed-precondition", `agent "${a.name}" was replaced during authorization - retry`, undefined, "not-executed");
    // Never establish a session over a dead agent — a doomed session (the caller would get an
    // immediate process-exit at best, a confusing empty terminal at worst). Refuse honestly.
    if (a.handle.status() !== "running") throw new EpEnvelopeError("failed-precondition", `agent "${a.name}" is not running (${a.handle.status()}); nothing to attach`, undefined, "not-executed");
    // CLAIM the session slot BEFORE attaching the target's PTY, matching the console door: this door
    // used to attach first and check capacity inside establishAttach, so a `resource-exhausted`
    // refusal landed AFTER the attach. The claim is carried INTO establishAttach, so one reservation
    // spans the attach and the establishment, and it is released on every refusal below.
    //
    // RESIDUAL, NAMED: no shipped runtime acquires anything at attach time — pty's `attach()` returns
    // a pure view (it registers a data subscriber only when `onData` is called) and tmux/cmux/orca
    // throw — so an attach nobody bridges is a garbage-collectible object, not a held resource, and
    // ordering alone suffices. A future runtime that DOES acquire something in `attach()` reopens
    // this: it would need a release on the failure paths, and `AttachSession` has no close today.
    const slot = this.sessionPlane.claimSlot();
    let session;
    try {
      session = a.handle.attach();
    } catch (e) {
      slot.release();
      // The external runtimes refuse attach() before acquiring anything (see the residual above).
      //
      // A runtime that streams NO terminal is `unimplemented` and not a precondition: asking again
      // cannot change it, and a caller that reads this as transient retries a refusal forever. The
      // runtime's own throw is the guidance for watching the agent where it really runs, so it is
      // carried through verbatim, and the namespaced detail lets a caller act on the one fact
      // without reading the wording. This is the same answer `input` gives a runtime that cannot
      // write, for the same reason.
      if (!this.runtimeFor(a.handle.kind).streamsTerminal)
        throw new EpEnvelopeError("unimplemented", `the ${a.handle.kind} runtime streams no terminal, so agent "${a.name}" has none to attach: ${rejectionText(e)}`,
          [{ kind: RUNTIME_NO_TERMINAL_DETAIL, runtime: a.handle.kind }], "not-executed");
      throw new EpEnvelopeError("failed-precondition", rejectionText(e), undefined, "not-executed");
    }
    // establishAttach releases the claim it was handed on every exit; nothing to unwind here.
    const { grant } = await this.sessionPlane.establishAttach(caller, { name: a.name, lifecycleUid: a.lifecycleUid }, session, slot);
    const carried = a.launch.resumed?.host;
    return { ok: true, data: { grant, ...(carried ? { resumedFrom: { host: carried, source: a.launch.resumed!.source } } : {}) } };
  }

  /** The console's mesh §13.6 session establisher (backing `POST /session/<name>` on the
   *  loopback face). Drives THE ONE plane — same establishAttach as the ep `attach` command — with
   *  the loopback OPERATOR as holder (same-host trust boundary), then hands the browser everything it
   *  needs to open the caller rail over the broker ws listener: the holder-bound grant, a per-session
   *  RAILS-ONLY caller cred (static mints from the seed, TTL-bound to the session; an open mesh has no
   *  credential system so the browser connects bare), and the ws URL. NO 127.0.0.1 terminal transport
   *  — the terminal rides the mesh session. Injected only when a wsPort exists (see the constructor). */
  async establishConsoleSession(name: string): Promise<SessionEstablishment> {
    if (!this.sessionPlane) throw new Error("the manager session plane is not available (the manager is not fully started)");
    if (this.wsPort === undefined) throw new Error("the broker websocket port is not configured; the console cannot open a mesh session");
    // CLAIM the session slot here, before the PTY attach and before this establisher goes on to
    // mint a seed-signed `session-caller` credential: a capacity refusal must land before anything
    // with a side effect or a cost. The claim is carried INTO establishAttach, so the reservation
    // spans the whole establishment rather than being a check that a concurrent caller can race.
    // (See attachAuthorized for why the attach itself needs no unwind on any shipped runtime.)
    const slot = this.sessionPlane.claimSlot();
    try {
      const a = this.agents.get(name);
      if (!a) throw new Error(`no managed agent "${name}"`);
      if (a.handle.status() !== "running") throw new Error(`agent "${name}" is not running (${a.handle.status()}); nothing to attach`);
      const session = a.handle.attach(); // throws for non-streamable runtimes — surfaced to the browser as a 500
      // The loopback operator is the console's holder (same-host trust boundary).
      const caller = { owner: DEV_OWNER, actor: "console", uid: this.managerLifecycleUid };
      const { grant } = await this.sessionPlane.establishAttach(caller, { name: a.name, lifecycleUid: a.lifecycleUid }, session, slot);
      // The caller credential is minted ONLY after a session is really live, so a refused or failed
      // establishment never yields a seed-signed JWT. (A failure HERE would leave a live session the
      // browser never reaches, holding its slot until the grant expires — unreachable in practice,
      // because the SERVING mint above signs from this same `this.auth` first and would have failed
      // before any session existed.)
      const creds = this.auth
        ? await mintCreds(this.auth, newIdentity(), "session-caller", {
            sessionCaller: { endpoint: MANAGER_ENDPOINT, sessionId: grant.sessionId, epoch: grant.serving.epoch },
            expiresAt: Math.floor(grant.exp / 1000), // grant.exp is ms (now+ttlMs); the JWT exp is seconds
          })
        : "";
      return { grant, wsUrl: `ws://127.0.0.1:${this.wsPort}`, creds };
    } catch (e) {
      slot.release(); // idempotent with establishAttach's own release
      throw e;
    }
  }
}
