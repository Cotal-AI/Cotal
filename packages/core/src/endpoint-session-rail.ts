/**
 * The §13.6 SESSION RAILS: the framed protocol + bounded credit window over the two epoch-pinned
 * eps subjects (cast-in / watch-out). SPLIT out of endpoint-session.ts (P2 item 6) so it carries
 * ZERO node-only dependencies (no node:crypto) and can be BUNDLED into the browser console session
 * client — the SAME core flow-control code runs in-browser. The grant mint/verify/redeem + the KV
 * ledger (node:crypto, KV) stay in endpoint-session.ts, which RE-EXPORTS this module so no
 * consumer's import path changes. Pure mechanical split: zero signature/behavior change.
 */
import type { NatsConnection, Subscription } from "@nats-io/transport-node";
import { EpEnvelopeError } from "./endpoint-error.js";
import { epsSubject, type EpSessionDir } from "./endpoint-subjects.js";
import type { SessionGrant } from "./endpoint-session.js";

const isRec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
function invalid(what: string): never {
  throw new EpEnvelopeError("contract-invalid", `${what} (SPEC 13.6 session)`);
}

/** The bounded flow window (§13.6: declared in the grant; overflow is `resource-exhausted`). */
export const SESSION_WINDOW_DEFAULT = 64;
export const SESSION_WINDOW_MAX = 1024;

/** Validate a flow window (1..MAX). Exported so the grant mint/verify in endpoint-session.ts share
 *  the single definition (it lives here, the browser-safe module). */
export function assertWindow(v: unknown): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1 || v > SESSION_WINDOW_MAX)
    invalid(`window ${String(v)} is not an integer in 1..${SESSION_WINDOW_MAX}`);
  return v;
}

// ---- the rails: framed protocol + bounded credit window --------------------------------------

/** The composite's own tiny framed protocol; `data` is OPAQUE (any JSON value — binary rides
 *  the application's own encoding). `credit`/`close` are CONTROL frames, EXEMPT from the data
 *  window (a full data window must never block the credits that reopen it, else instant
 *  deadlock). `ack` is an ABSOLUTE cumulative watermark (the sender's contiguous-received count
 *  on the OTHER rail): a data frame PIGGYBACKS it, so a lost dedicated credit self-heals on the
 *  next reverse data frame, and any deeper loss recovers on the keepalive re-emit; absolute
 *  (not delta) so any single credit re-advertises the whole position and a duplicate is
 *  harmless. The in-band `close` is advisory (§13.6): revocation authority is the ledger,
 *  never this frame. */
export type SessionFrame =
  | { t: "f"; seq: number; data: unknown; ack?: number }
  | { t: "credit"; ack: number }
  | { t: "close" };

export function encodeSessionFrame(frame: SessionFrame): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(frame));
}

/** Fail-loud frame parse (closed schema): a garbled frame is a PROTOCOL error the rail
 *  surfaces via `onProtocolError` — never silently skipped, never a crash. */
export function parseSessionFrame(bytes: Uint8Array): SessionFrame {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    invalid("session frame is not UTF-8 JSON");
  }
  if (!isRec(raw)) invalid("session frame is not an object");
  const o = raw as Record<string, unknown>;
  if (o.t === "f") {
    for (const k of Object.keys(o)) if (k !== "t" && k !== "seq" && k !== "data" && k !== "ack") invalid(`data frame carries unknown field "${k}"`);
    if (typeof o.seq !== "number" || !Number.isSafeInteger(o.seq) || o.seq < 1) invalid("data frame seq is not a positive integer");
    if (!("data" in o)) invalid("data frame carries no data");
    if (o.ack !== undefined && (typeof o.ack !== "number" || !Number.isSafeInteger(o.ack) || o.ack < 0)) invalid("data frame ack is not a non-negative integer");
    return { t: "f", seq: o.seq, data: o.data, ...(o.ack !== undefined ? { ack: o.ack } : {}) };
  }
  if (o.t === "credit") {
    for (const k of Object.keys(o)) if (k !== "t" && k !== "ack") invalid(`credit frame carries unknown field "${k}"`);
    if (typeof o.ack !== "number" || !Number.isSafeInteger(o.ack) || o.ack < 0) invalid("credit frame ack is not a non-negative integer");
    return { t: "credit", ack: o.ack };
  }
  if (o.t === "close") {
    for (const k of Object.keys(o)) if (k !== "t") invalid(`close frame carries unknown field "${k}"`);
    return { t: "close" };
  }
  invalid(`unknown session frame type ${String((o as { t?: unknown }).t)}`);
}

/** Which rail each role sends on (§13.6: `in` = caller → endpoint; `out` = the reverse). */
export type SessionRole = "caller" | "serving";

export interface SessionRailOpts {
  nc: NatsConnection;
  grant: Pick<SessionGrant, "space" | "endpoint" | "sessionId" | "window"> & { serving: { epoch: number } };
  role: SessionRole;
  /** Delivered in-order for CONTIGUOUS frames, and the application accepts FIRST: the handler
   *  may be async — it is AWAITED, and the watermark advances and credit emits only after it
   *  RESOLVES, so credit means the receiver's buffer actually freed (back-pressure) and a
   *  rejection refuses the frame exactly like a synchronous throw: the rail breaks (`handler`)
   *  and the refused frame is neither counted delivered nor credited. Acceptance is SERIALIZED
   *  in seq order (one handler in flight; NATS does not serialize callback promises); frames
   *  arriving while a handler is pending queue up to the grant WINDOW — past it the rail breaks
   *  (`flood`), never an unbounded backlog. A handler wedged forever stalls credit, so the
   *  SENDER's window fills and its stall watchdog surfaces the fault. A gap surfaces via
   *  onProtocolError("gap"). */
  onData(data: unknown, seq: number): void | Promise<void>;
  /** The peer's advisory close frame arrived (authoritative close is the ledger's). The local
   *  subscription and timer are torn down before this fires. */
  onClose?(): void;
  /** The session is broken — close and re-establish. `reason` is one of `garbled-frame` |
   *  `gap` | `credit-overrun` | `flood` | `subscription` | `stall` | `handler` | `publish` |
   *  `seq-exhausted`. The rail's subscription and timer are torn down before this fires (a
   *  broken rail holds no resources). */
  onProtocolError?(reason: string, detail?: unknown): void;
  /** Broker payload ceiling for the SEND preflight (like assertFactFits). Default 1 MiB. */
  maxPayloadBytes?: number;
  /** Keepalive credit re-emit interval (ms): while this side has delivered ANY data and the
   *  peer has gone quiet, re-advertise the absolute watermark every tick — including
   *  watermarks already advertised, because this side cannot observe whether an emitted
   *  credit ARRIVED (gating on "newer than last emitted" turns loss of the advertisement
   *  itself into a permanent stall). Absolute acks are idempotent, so the honest recovery is
   *  repetition; the cost is one control frame per quiet tick. 0 disables. Default 1000. */
  idleCreditMs?: number;
  /** Sender stall watchdog (ms): if the data window stays full this long with NO ack advance
   *  (sustained credit loss or a dead peer), the rail breaks with a DETECTABLE `stall` fault —
   *  TIMER-driven, so a sender that stops calling send() still learns its peer is gone; the
   *  send path double-checks as a belt. 0 disables. Default 30000. */
  stallTimeoutMs?: number;
  /** Injectable clock (testability); default Date.now. */
  now?: () => number;
  /** Injectable interval timer (testability); defaults to Node setInterval/clearInterval. */
  setIntervalFn?: (fn: () => void, ms: number) => { unref?: () => void };
  clearIntervalFn?: (h: unknown) => void;
}

export interface SessionRail {
  /** Send one opaque data frame (piggybacking this side's absolute reverse-rail watermark).
   *  Throws `resource-exhausted` when the window is full (no buffering, §13.6), `contract-invalid`
   *  when the encoded frame exceeds the payload ceiling, and `failed-precondition` once the rail
   *  is closed/broken (including a detected stall or a failed publish). Returns the frame's seq. */
  send(data: unknown): number;
  /** Send the advisory close frame and stop the rail locally. Idempotent. */
  close(): void;
  /** In-memory window state (observability + smoke assertions). */
  stats(): { sent: number; ackedThrough: number; delivered: number; inFlight: number };
}

/**
 * Open one side of an established session over its two core rails. The credentials the
 * redemption released confine each side to exactly its pub/sub pair; this helper only speaks
 * the framed protocol and enforces the bounded window — it grants nothing.
 *
 * FLOW CONTROL (panel-locked): the data window is bounded and per-direction; control frames
 * (`credit`, `close`) are EXEMPT (a full window never blocks the credits that reopen it).
 * RECEIVE-side acceptance is serialized and the (possibly async) handler AWAITED — credit
 * emits only for frames the application actually accepted — and the pending-frame queue is
 * bounded by the same window (`flood` past it), so neither side ever buffers unboundedly.
 * Credits carry an ABSOLUTE cumulative watermark, PIGGYBACKED on reverse data frames, so a lost
 * dedicated credit self-heals on the next reverse traffic; ANY deeper loss (including loss of
 * already-emitted threshold credits) recovers on the KEEPALIVE re-emit; sustained loss or a
 * dead peer surfaces the TIMER-driven `stall` fault (never a silent hang, even for a sender
 * that stopped calling send). A dropped DATA frame is unrecoverable at this transport (EPS is
 * at-most-once, core-only) and shows as a seq gap the app reacts to — reliability layers
 * inside `data` or uses the journal/checkpoint composites.
 */
export function openSessionRail(opts: SessionRailOpts): SessionRail {
  const { grant, role } = opts;
  const window = assertWindow(grant.window);
  const maxPayload = opts.maxPayloadBytes ?? 1024 * 1024;
  const idleCreditMs = opts.idleCreditMs ?? 1000;
  const stallTimeoutMs = opts.stallTimeoutMs ?? 30_000;
  const now = opts.now ?? (() => Date.now());
  const setIntervalFn = opts.setIntervalFn ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
  const clearIntervalFn = opts.clearIntervalFn ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>));
  const egressDir: EpSessionDir = role === "caller" ? "in" : "out";
  const ingressDir: EpSessionDir = role === "caller" ? "out" : "in";
  const egress = epsSubject(grant.space, grant.endpoint, grant.sessionId, grant.serving.epoch, egressDir);
  const ingress = epsSubject(grant.space, grant.endpoint, grant.sessionId, grant.serving.epoch, ingressDir);

  let seq = 0; // last sent
  let ackedThrough = 0; // peer's contiguous ack for OUR egress (absolute)
  let windowFullSince = 0; // when the window became full with no ack advance (0 = not blocked)
  let expected = 1; // next ingress data seq we can deliver contiguously
  let deliveredSinceCredit = 0;
  let dataSinceIdleTick = false; // did ingress data arrive since the last idle tick?
  let delivered = 0;
  let closed = false;
  let broken = false;
  let tornDown = false;
  let idleTimer: { unref?: () => void } | undefined;
  let sub: Subscription | undefined;
  const creditEvery = Math.max(1, Math.ceil(window / 2));

  // EXACTLY-ONCE local cleanup, whoever triggers it (local close, PEER close, or a protocol
  // fault): a remote peer must never be able to leave this side holding a dangling
  // subscription + interval per session (a remotely triggerable resource leak).
  const teardown = (): void => {
    if (tornDown) return;
    tornDown = true;
    if (idleTimer) clearIntervalFn(idleTimer);
    sub?.unsubscribe();
  };
  const protocolError = (reason: string, detail?: unknown): void => {
    broken = true;
    teardown(); // a broken rail holds no resources
    opts.onProtocolError?.(reason, detail);
  };
  // Absorb an absolute watermark from a credit frame OR a piggybacked data ack. Monotonic — a
  // stale/duplicated advertisement never narrows the window; an ack past what we ever sent is a
  // protocol violation (fail-loud, never silently widen).
  const applyAck = (ack: number): void => {
    if (ack > seq) {
      protocolError("credit-overrun", { ack, sent: seq });
      return;
    }
    if (ack > ackedThrough) {
      ackedThrough = ack;
      windowFullSince = 0; // progress — reset the stall watchdog
    }
  };
  const emitCredit = (): void => {
    try {
      opts.nc.publish(egress, encodeSessionFrame({ t: "credit", ack: expected - 1 }));
    } catch (e) {
      protocolError("publish", (e as Error)?.message ?? String(e));
    }
  };

  // SERIALIZED data acceptance: the application accepts FIRST and may be ASYNC — NATS does not
  // serialize callback promises, so the callback only enqueues and this single drain loop runs
  // one handler at a time in seq order. The watermark advances and credit emits only after the
  // handler RESOLVES (credit == the receiver's buffer actually freed: the §13.6 back-pressure
  // semantic), so an async rejection refuses the frame exactly like a synchronous throw. The
  // HEAD frame stays queued while its handler runs, so the window bound below counts it; a
  // handler that resolves into a rail that closed or broke meanwhile advances NOTHING.
  const ingressQueue: Array<{ seq: number; data: unknown }> = [];
  let draining = false;
  const drain = async (): Promise<void> => {
    if (draining) return;
    draining = true;
    try {
      while (!closed && !broken && ingressQueue.length > 0) {
        const head = ingressQueue[0];
        try {
          await opts.onData(head.data, head.seq);
        } catch (e) {
          // A rejection landing in a rail that closed or broke DURING the await reports
          // NOTHING: the rail is already terminal (its fault, if any, was already surfaced),
          // and a second protocolError would double-fault a dead rail.
          if (closed || broken) return;
          protocolError("handler", (e as Error)?.message ?? String(e));
          return;
        }
        if (closed || broken) return;
        ingressQueue.shift();
        expected++;
        delivered++;
        deliveredSinceCredit++;
        if (deliveredSinceCredit >= creditEvery) {
          deliveredSinceCredit = 0;
          emitCredit();
        }
      }
    } finally {
      draining = false;
    }
  };

  sub = opts.nc.subscribe(ingress, {
    callback: (err, msg) => {
      if (closed || broken) return;
      if (err) {
        protocolError("subscription", err.message);
        return;
      }
      let frame: SessionFrame;
      try {
        frame = parseSessionFrame(msg.data);
      } catch (e) {
        protocolError("garbled-frame", (e as Error).message);
        return;
      }
      if (frame.t === "credit") {
        applyAck(frame.ack);
        return;
      }
      if (frame.t === "close") {
        closed = true;
        teardown();
        opts.onClose?.();
        return;
      }
      // Data. Its piggybacked ack refreshes OUR credit first (self-heals a lost dedicated
      // credit) — and an OVERRUNNING piggyback breaks the rail BEFORE the frame's data can
      // reach the application: a protocol-invalid frame must have no application effect.
      if (frame.ack !== undefined) {
        applyAck(frame.ack);
        if (broken) return;
      }
      dataSinceIdleTick = true;
      // Contiguity is judged against the queue's tail (the head may still be in its handler):
      // a peer sending in order while an earlier handler is pending is NOT a gap.
      const nextIngress = expected + ingressQueue.length;
      if (frame.seq < nextIngress) return; // duplicate — idempotent drop
      if (frame.seq > nextIngress) {
        protocolError("gap", { expected: nextIngress, got: frame.seq });
        return;
      }
      // The ingress queue is bounded by the grant WINDOW (an honest peer can never have more
      // unacknowledged frames in flight): a peer that ignores flow control while a handler is
      // pending cannot pile promises here — the rail breaks instead (§13.6: never unbounded).
      if (ingressQueue.length >= window) {
        protocolError("flood", { queued: ingressQueue.length, window });
        return;
      }
      ingressQueue.push({ seq: frame.seq, data: frame.data });
      void drain();
    },
  });

  // One tick drives BOTH recovery legs:
  //  - the KEEPALIVE credit re-emit: while this side has delivered anything and the peer went
  //    quiet, re-advertise the absolute watermark — deliberately NOT gated on what was already
  //    advertised (see idleCreditMs docs: the double-credit-loss counterexample).
  //  - the STALL WATCHDOG: a window that stays full past stallTimeoutMs with no ack advance
  //    breaks the rail with a DETECTABLE fault even if the sender never calls send() again.
  if (idleCreditMs > 0 || stallTimeoutMs > 0) {
    idleTimer = setIntervalFn(() => {
      if (closed || broken) return;
      if (stallTimeoutMs > 0 && windowFullSince !== 0) {
        const blockedMs = now() - windowFullSince;
        if (blockedMs > stallTimeoutMs) {
          protocolError("stall", { window, ackedThrough, sent: seq, blockedMs });
          return;
        }
      }
      if (idleCreditMs > 0 && !dataSinceIdleTick && expected > 1) emitCredit();
      dataSinceIdleTick = false;
    }, idleCreditMs > 0 ? idleCreditMs : 1000);
    idleTimer.unref?.();
  }

  return {
    send(data: unknown): number {
      if (closed || broken)
        throw new EpEnvelopeError("failed-precondition", "session rail is closed/broken; establish a new session (SPEC 13.6)");
      if (seq >= Number.MAX_SAFE_INTEGER - 1) {
        protocolError("seq-exhausted", { seq });
        throw new EpEnvelopeError("failed-precondition", "session rail exhausted its sequence space; establish a new session (SPEC 13.6)");
      }
      if (seq - ackedThrough >= window) {
        // The window is full. The timer is the primary stall detector; this path double-checks
        // (belt for a caller running with timers disabled) and otherwise refuses TRANSIENTLY.
        const t = now();
        if (windowFullSince === 0) windowFullSince = t;
        else if (stallTimeoutMs > 0 && t - windowFullSince > stallTimeoutMs) {
          protocolError("stall", { window, ackedThrough, sent: seq, blockedMs: t - windowFullSince });
          throw new EpEnvelopeError("failed-precondition", `session rail stalled: the window stayed full ${t - windowFullSince}ms with no credit; the peer is unreachable, re-establish (SPEC 13.6)`);
        }
        throw new EpEnvelopeError(
          "resource-exhausted",
          `session window is full (${window} unacknowledged frames); the flow window is bounded and nothing buffers (SPEC 13.6)`,
        );
      }
      // Piggyback our absolute reverse-rail watermark so a lost dedicated credit self-heals.
      const ack = expected - 1;
      const frame = encodeSessionFrame({ t: "f", seq: seq + 1, data, ...(ack > 0 ? { ack } : {}) });
      if (frame.byteLength > maxPayload)
        throw new EpEnvelopeError("contract-invalid", `session frame is ${frame.byteLength} bytes, over the ${maxPayload}-byte payload ceiling`);
      // Publish BEFORE advancing: a synchronous publish failure must not consume the seq (the
      // peer would otherwise see a permanent gap from a frame that never left this process,
      // and the local stats would count it in flight). A failed publish breaks the rail.
      try {
        opts.nc.publish(egress, frame);
      } catch (e) {
        protocolError("publish", (e as Error)?.message ?? String(e));
        throw new EpEnvelopeError("failed-precondition", `session rail publish failed; the rail is broken, re-establish (SPEC 13.6): ${(e as Error)?.message ?? String(e)}`);
      }
      seq++;
      // Arm the watchdog the moment the window BECOMES full: a sender that now only waits
      // (never calling send again) is still covered by the timer-driven stall check.
      if (seq - ackedThrough >= window && windowFullSince === 0) windowFullSince = now();
      return seq;
    },
    close(): void {
      if (closed) {
        teardown(); // idempotent; also covers close-after-broken
        return;
      }
      closed = true;
      try {
        opts.nc.publish(egress, encodeSessionFrame({ t: "close" }));
      } catch {
        /* advisory only — the ledger is the authority */
      }
      teardown();
    },
    stats() {
      return { sent: seq, ackedThrough, delivered, inFlight: seq - ackedThrough };
    },
  };
}
