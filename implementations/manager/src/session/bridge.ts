/**
 * The serving-side PTY ↔ session-rail bridge (P2 item 6). Given an authenticated §13.6 session
 * (its verified grant + a connection scoped to the two eps rails) and a live pty {@link
 * AttachSession}, it speaks the {@link TerminalFrame} framing over `openSessionRail(role:"serving")`:
 *
 *  - the RECONSTRUCTION handshake (PR #158 preserved over the mesh): the caller opens its rail,
 *    then sends `ready`; the bridge replays the pty's byte-exact backlog snapshot (which can rebuild
 *    a full-screen TUI's alternate-screen buffer) and only then streams live output — so a late or
 *    third attach paints correctly without the child having to repaint. Live output that arrives
 *    after the snapshot boundary is buffered within a hard cap and flushed after it, in order;
 *  - duplex byte flow: pty output → bounded, coalesced `b` frames (serving → caller); caller `b`
 *    frames → pty keystrokes; `resize` frames → pty geometry;
 *  - BACKPRESSURE (item-6 pin: never silent loss): the core rail's window is bounded and refuses
 *    (`resource-exhausted`) rather than buffer; on refusal the bridge DROPS the chunk, accumulates
 *    the dropped-byte count, retries an explicit `drop` notice when credit reopens, and the caller
 *    automatically requests a fresh canonical snapshot so a full-screen TUI cannot stay corrupt;
 *  - TERMINATION (item-6 pin 4): every teardown surfaces a DISTINCT end reason (`process-exit` /
 *    `closed` / `expired` / `target-despawn` / `manager-restart`) as an `end` frame before the rail
 *    closes, so the client can tell "the agent exited" from "you were detached" from "the manager
 *    restarted".
 */
import type { NatsConnection } from "@nats-io/transport-node";
import {
  EpEnvelopeError, openSessionRail, encodeTerminalData, terminalFrameBytes, decodeTerminalFrame,
  type SessionGrant, type SessionRail, type AttachSession, type TerminalFrame,
} from "@cotal-ai/core";

/** The reference manager's terminal-cause vocabulary (the `end.reason` tokens it surfaces — a
 *  bounded subset of the generic §13.6 terminal-session `end` reason). `process-exit` = the child
 *  exited; `closed` = a party closed the rail; `expired` = the offer/session TTL elapsed;
 *  `target-despawn` = the attached agent was despawned; `manager-restart` = the serving manager
 *  incarnation advanced its epoch (the successor refuses old-epoch sessions, §13.6). */
export type AttachEndReason = "process-exit" | "closed" | "expired" | "target-despawn" | "manager-restart";

const OUTPUT_BATCH_MS = 8;
const OUTPUT_BATCH_BYTES = 64 * 1024;
const REPAINT_BUFFER_BYTES = 256 * 1024;
const DROP_RETRY_MS = 25;
const END_ACK_GRACE_MS = 1_500;

export interface ServeSessionBridgeOpts {
  /** A connection scoped to this session's two eps rails (the serving side's per-session credential,
   *  or — static mode — the manager's instrument connection whose rows cover the subtree). */
  nc: NatsConnection;
  /** The VERIFIED session grant (subjects/window/epoch); the bridge grants nothing, it only frames. */
  grant: SessionGrant;
  /** The live pty to bridge. */
  session: AttachSession;
  /** Fires once with the distinct end reason when the session tears down (either side). */
  onEnd?(reason: AttachEndReason): void;
  /** Passthrough rail timer knobs (testability). */
  idleCreditMs?: number;
  stallTimeoutMs?: number;
  /** Output coalescing knobs. Production defaults batch one display frame up to 64 KiB; smokes use
   *  the byte ceiling to force deterministic frame-window overflow. */
  outputBatchMs?: number;
  outputBatchBytes?: number;
}

export interface SessionBridge {
  /** Terminate the session with a distinct reason (target despawn / manager restart / expiry): the
   *  `end` frame is sent best-effort, then the rail closes and the pty is unsubscribed. Idempotent. */
  end(reason: AttachEndReason): void;
  /** In-memory observability (smoke assertions): the rail's window stats, the dropped-byte count
   *  (backpressure), the dropped-FRAME count (caller frames the codec rejected), and whether the
   *  reconstruction handshake has gone live. */
  stats(): { sent: number; ackedThrough: number; delivered: number; inFlight: number; droppedBytes: number; droppedFrames: number; queuedBytes: number; live: boolean; repainting: boolean };
}

export function serveSessionBridge(opts: ServeSessionBridgeOpts): SessionBridge {
  const { session } = opts;
  const outputBatchMs = Math.max(0, opts.outputBatchMs ?? OUTPUT_BATCH_MS);
  const outputBatchBytes = Math.max(1, opts.outputBatchBytes ?? OUTPUT_BATCH_BYTES);
  let live = false; // has `ready` been received (backlog replayed, streaming live)?
  let repainting = false;
  let repaintQueued = false;
  let ended = false;
  let droppedBytes = 0;
  let droppedFrames = 0; // caller frames the codec rejected (observability; NOT a silent black hole)
  let pendingOutput: Buffer[] = [];
  let pendingOutputBytes = 0;
  let outputTimer: ReturnType<typeof setTimeout> | undefined;
  let repaintBuffer: Buffer[] = [];
  let repaintBufferBytes = 0;
  let dropRetryTimer: ReturnType<typeof setTimeout> | undefined;
  let rail!: SessionRail;

  // Send an application payload down the serving rail. Returns true on success; false when the
  // window is FULL (`resource-exhausted`, the caller-must-drop signal); any OTHER failure
  // (broken/closed rail) terminates the session — a broken transport is a distinct `closed` end.
  const railSend = (p: TerminalFrame): boolean => {
    try {
      rail.send(p);
      return true;
    } catch (e) {
      if (e instanceof EpEnvelopeError && e.code === "resource-exhausted") return false;
      end("closed");
      return false;
    }
  };

  // A drop notice must not depend on the child producing one more byte. Retry the CONTROL frame
  // until caller credit reopens the bounded window; the caller responds with a repeat `ready`, whose
  // piggybacked ack gives this side room for the canonical repaint snapshot.
  const scheduleDropNotice = (): void => {
    if (ended || droppedBytes === 0 || dropRetryTimer) return;
    dropRetryTimer = setTimeout(() => {
      dropRetryTimer = undefined;
      if (ended || droppedBytes === 0) return;
      const bytes = droppedBytes;
      if (railSend({ k: "drop", bytes })) droppedBytes -= bytes;
      else scheduleDropNotice();
    }, DROP_RETRY_MS);
    dropRetryTimer.unref?.();
  };

  // Forward one bounded output frame. A pending drop count is flushed FIRST, so the caller learns
  // that its screen is stale before any resumed stream; a refused chunk is counted and discarded.
  const forwardOutput = (chunk: Buffer): boolean => {
    if (ended || chunk.length === 0) return false;
    if (droppedBytes > 0) {
      const bytes = droppedBytes;
      if (railSend({ k: "drop", bytes })) droppedBytes -= bytes;
      else {
        droppedBytes += chunk.length;
        scheduleDropNotice();
        return false;
      }
    }
    if (railSend(encodeTerminalData(chunk))) return true;
    droppedBytes += chunk.length;
    scheduleDropNotice();
    return false;
  };

  const forwardBytes = (bytes: Buffer): void => {
    for (let offset = 0; offset < bytes.length; offset += outputBatchBytes) {
      const part = bytes.subarray(offset, Math.min(bytes.length, offset + outputBatchBytes));
      if (forwardOutput(part)) continue;
      const remaining = bytes.length - offset - part.length;
      if (remaining > 0) droppedBytes += remaining;
      scheduleDropNotice();
      return;
    }
  };
  const flushOutput = (): void => {
    if (outputTimer) clearTimeout(outputTimer);
    outputTimer = undefined;
    if (pendingOutputBytes === 0) return;
    const bytes = Buffer.concat(pendingOutput, pendingOutputBytes);
    pendingOutput = [];
    pendingOutputBytes = 0;
    forwardBytes(bytes);
  };
  const discardPendingOutput = (): void => {
    if (outputTimer) clearTimeout(outputTimer);
    outputTimer = undefined;
    pendingOutput = [];
    pendingOutputBytes = 0;
  };
  const queueOutput = (chunk: Buffer): void => {
    if (ended || chunk.length === 0) return;
    if (chunk.length >= outputBatchBytes) {
      flushOutput();
      forwardBytes(chunk);
      return;
    }
    if (pendingOutputBytes + chunk.length > outputBatchBytes) flushOutput();
    pendingOutput.push(chunk);
    pendingOutputBytes += chunk.length;
    if (pendingOutputBytes >= outputBatchBytes || outputBatchMs === 0) {
      flushOutput();
      return;
    }
    if (!outputTimer) {
      outputTimer = setTimeout(flushOutput, outputBatchMs);
      outputTimer.unref?.();
    }
  };
  const bufferDuringRepaint = (chunk: Buffer): void => {
    const room = REPAINT_BUFFER_BYTES - repaintBufferBytes;
    if (room > 0) {
      const kept = chunk.length <= room ? chunk : chunk.subarray(0, room);
      repaintBuffer.push(kept);
      repaintBufferBytes += kept.length;
    }
    if (chunk.length > room) {
      droppedBytes += chunk.length - Math.max(0, room);
      scheduleDropNotice();
    }
  };

  const offData = session.onData((chunk) => {
    if (ended) return;
    if (repainting) bufferDuringRepaint(chunk);
    else if (live) queueOutput(chunk);
    // Before the first `ready`, the session's canonical backlog is the bounded source of truth. No
    // raw pre-ready byte queue is needed: goLive snapshots it, then buffers only post-boundary bytes.
  });
  // The pty exit surfaces `process-exit`, deferred through an opening/repaint snapshot so the caller
  // receives the final canonical screen before the distinct terminal reason.
  let pendingExit = false;
  const offExit = session.onExit(() => {
    if (live && !repainting) {
      flushOutput();
      end("process-exit");
    } else pendingExit = true;
  });

  // Initial `ready` and repeat repaint use the same ordered cut: discard only UNSENT coalesced bytes
  // (the terminal mirror already contains them), snapshot the canonical screen, then flush bytes that
  // arrived after the snapshot boundary. Concurrent repeat-ready requests collapse to one more pass.
  const goLive = async (): Promise<void> => {
    if (repainting) {
      repaintQueued = true;
      return;
    }
    repainting = true;
    repaintQueued = false;
    discardPendingOutput();
    repaintBuffer = [];
    repaintBufferBytes = 0;
    let snapshot: Buffer;
    try {
      snapshot = await session.backlog();
    } catch (e) {
      end("closed");
      void e;
      return;
    }
    if (ended) return;
    // A canonical snapshot is one atomic repaint frame, as before. Splitting it across the live-output
    // batch ceiling can fill a small window halfway through the image and create a repaint loop.
    if (snapshot.length) forwardOutput(snapshot);
    const afterSnapshot = Buffer.concat(repaintBuffer, repaintBufferBytes);
    repaintBuffer = [];
    repaintBufferBytes = 0;
    if (afterSnapshot.length) forwardBytes(afterSnapshot);
    live = true;
    repainting = false;
    if (droppedBytes > 0) scheduleDropNotice();
    // The pty exited before/during reconstruction: surface the reason only after the final image.
    if (pendingExit) {
      end("process-exit");
      return;
    }
    if (repaintQueued) void goLive();
  };

  const onCallerFrame = (data: unknown): void => {
    // A caller frame must NEVER wedge the serving rail. A GARBLED or DEGENERATE frame — e.g. a console
    // fitting before its pane is laid out sends a 0-dim resize, which the §13.6 codec rejects — is
    // dropped, and each pty side effect is best-effort. One bad frame crashing this handler is exactly
    // the live-e2e "zombie session" class (rail open, no echo, no honest end) that violates pin 4.
    // But a drop is NEVER a black hole: it is COUNTED + LOGGED so a silent inbound failure (a caller
    // whose frames all decode-reject) is diagnosable, not invisible.
    let p: TerminalFrame;
    try {
      p = decodeTerminalFrame(data);
    } catch (e) {
      droppedFrames++;
      console.error(`! session ${opts.grant.sessionId}: dropped an undecodable caller frame #${droppedFrames} (${(e as Error).message})`);
      return;
    }
    switch (p.k) {
      case "ready":
        void goLive();
        return;
      case "data":
        try { session.write(new TextDecoder().decode(terminalFrameBytes(p))); } catch { /* pty gone/degenerate; never wedge the rail */ }
        return;
      case "resize":
        try { session.resize(p.cols, p.rows); } catch { /* degenerate geometry; ignore, never wedge */ }
        return;
      // `end`/`drop` are serving → caller only; a caller sending one is out of protocol — ignore it.
      case "end":
      case "drop":
        return;
    }
  };

  function end(reason: AttachEndReason): void {
    if (ended) return;
    ended = true;
    if (outputTimer) clearTimeout(outputTimer);
    if (dropRetryTimer) clearTimeout(dropRetryTimer);
    outputTimer = undefined;
    dropRetryTimer = undefined;
    pendingOutput = [];
    pendingOutputBytes = 0;
    repaintBuffer = [];
    repaintBufferBytes = 0;
    offData();
    offExit();
    let endSeq: number | undefined;
    try {
      endSeq = rail.send({ k: "end", reason });
    } catch {
      /* the ledger close/expiry is the authority; the notice is advisory (§13.6) */
    }
    // `close` is an unsequenced control frame. Sending it immediately can overtake data already
    // queued in the caller's async handler and make that handler discard the preceding `end` frame.
    // Hold the serving connection until the end frame is acknowledged (stdout accepted it) or a
    // bounded grace expires; then close/release regardless, because the ledger remains authoritative.
    void (async () => {
      try { await opts.nc.flush(); } catch { /* connection already gone */ }
      if (endSeq !== undefined) {
        const deadline = Date.now() + Math.max(END_ACK_GRACE_MS, (opts.idleCreditMs ?? 1_000) + 500);
        while (rail.stats().ackedThrough < endSeq && Date.now() < deadline)
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      rail.close();
      opts.onEnd?.(reason);
    })();
  }

  rail = openSessionRail({
    nc: opts.nc,
    grant: opts.grant,
    role: "serving",
    onData: onCallerFrame,
    onClose: () => end("closed"),
    onProtocolError: () => end("closed"),
    ...(opts.idleCreditMs !== undefined ? { idleCreditMs: opts.idleCreditMs } : {}),
    ...(opts.stallTimeoutMs !== undefined ? { stallTimeoutMs: opts.stallTimeoutMs } : {}),
  });

  return {
    end,
    stats: () => ({
      ...rail.stats(),
      droppedBytes,
      droppedFrames,
      queuedBytes: pendingOutputBytes + repaintBufferBytes,
      live,
      repainting,
    }),
  };
}
