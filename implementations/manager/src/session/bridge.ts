/**
 * The serving-side PTY ↔ session-rail bridge (P2 item 6). Given an authenticated §13.6 session
 * (its verified grant + a connection scoped to the two eps rails) and a live pty {@link
 * AttachSession}, it speaks the {@link TerminalFrame} framing over `openSessionRail(role:"serving")`:
 *
 *  - the RECONSTRUCTION handshake (PR #158 preserved over the mesh): the caller opens its rail,
 *    then sends `ready`; the bridge replays the pty's byte-exact backlog snapshot (which can rebuild
 *    a full-screen TUI's alternate-screen buffer) and only then streams live output — so a late or
 *    third attach paints correctly without the child having to repaint. Live output that arrives
 *    while the snapshot is being built is buffered and flushed after it, in order (no chunk slips
 *    ahead of, or is lost before, the image);
 *  - duplex byte flow: pty output → `b` frames (serving → caller); caller `b` frames → pty
 *    keystrokes; `resize` frames → pty geometry;
 *  - BACKPRESSURE (item-6 pin: never silent loss): the core rail's window is bounded and refuses
 *    (`resource-exhausted`) rather than buffer; on refusal the bridge DROPS the chunk, accumulates
 *    the dropped-byte count, and prepends an explicit `drop` notice to the next frame the reopened
 *    window accepts — the caller always learns output was lost;
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
}

export interface SessionBridge {
  /** Terminate the session with a distinct reason (target despawn / manager restart / expiry): the
   *  `end` frame is sent best-effort, then the rail closes and the pty is unsubscribed. Idempotent. */
  end(reason: AttachEndReason): void;
  /** In-memory observability (smoke assertions): the rail's window stats plus the dropped-byte
   *  count and whether the reconstruction handshake has gone live. */
  stats(): { sent: number; ackedThrough: number; delivered: number; inFlight: number; droppedBytes: number; live: boolean };
}

export function serveSessionBridge(opts: ServeSessionBridgeOpts): SessionBridge {
  const { session } = opts;
  let live = false; // has `ready` been received (backlog replayed, streaming live)?
  let ended = false;
  let droppedBytes = 0;
  const preReadyBuffer: Buffer[] = [];
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

  // Forward one pty output chunk, honoring backpressure with an explicit drop-notice. A pending
  // drop count is flushed FIRST (the caller must learn output was lost before the resumed stream),
  // and only if that notice lands does the actual chunk go — otherwise the chunk's bytes join the
  // drop count. Nothing is ever buffered unboundedly: a chunk the window can't take is DROPPED,
  // counted, and surfaced, never queued.
  const forwardOutput = (chunk: Buffer): void => {
    if (ended) return;
    if (droppedBytes > 0) {
      if (railSend({ k: "drop", bytes: droppedBytes })) droppedBytes = 0;
      else { droppedBytes += chunk.length; return; }
    }
    if (!railSend(encodeTerminalData(chunk))) droppedBytes += chunk.length;
  };

  const offData = session.onData((chunk) => {
    if (ended) return;
    if (live) forwardOutput(chunk);
    else preReadyBuffer.push(chunk); // hold until the snapshot is replayed, then flush in order
  });
  const offExit = session.onExit(() => end("process-exit"));

  // The reconstruction handshake: replay the byte-exact backlog snapshot, then flush anything the
  // pty emitted while we built it, then stream live. Subscribing to output BEFORE this (above)
  // means no chunk is lost between the snapshot and going live. A repeat `ready` (an explicit
  // repaint) re-sends a fresh snapshot without re-flushing the already-drained pre-ready buffer.
  const goLive = async (): Promise<void> => {
    let snapshot: Buffer;
    try {
      snapshot = await session.backlog();
    } catch (e) {
      end("closed");
      void e;
      return;
    }
    if (ended) return;
    if (snapshot.length) forwardOutput(snapshot);
    if (!live) {
      for (const chunk of preReadyBuffer.splice(0)) forwardOutput(chunk);
      live = true;
    }
  };

  const onCallerFrame = (data: unknown): void => {
    const p = decodeTerminalFrame(data); // throws on a garbled frame → the rail surfaces it, breaks
    switch (p.k) {
      case "ready":
        void goLive();
        return;
      case "data":
        session.write(new TextDecoder().decode(terminalFrameBytes(p)));
        return;
      case "resize":
        session.resize(p.cols, p.rows);
        return;
      // `end`/`drop` are serving → caller only; a caller sending one is out of protocol — ignore it
      // (harmless: it drives no pty effect), rather than tear down a session on a stray frame.
      case "end":
      case "drop":
        return;
    }
  };

  function end(reason: AttachEndReason): void {
    if (ended) return;
    ended = true;
    offData();
    offExit();
    try {
      rail.send({ k: "end", reason }); // best-effort distinct end-state notice (advisory; may window out)
    } catch {
      /* the ledger close/expiry is the authority; the notice is advisory (§13.6) */
    }
    rail.close();
    opts.onEnd?.(reason);
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
    stats: () => ({ ...rail.stats(), droppedBytes, live }),
  };
}
