/**
 * The connector's local control plane: a unix-socket server the lifecycle hooks
 * talk to. Hooks are dumb relays — they forward the raw runtime event JSON (which
 * carries `hook_event_name`) and print whatever we reply. All the logic lives here,
 * in-process, because this is where the live mesh endpoint is.
 *
 * The socket plumbing is platform-agnostic; each connector passes a {@link HookHandle}
 * that maps its runtime's events to presence changes + (for inject-capable events)
 * queued peer messages, in that runtime's own hook-output shape.
 */
import { createServer, type Server, type Socket } from "node:net";
import { existsSync, unlinkSync } from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";
import type { MeshAgent, InboxItem } from "./agent.js";

/** One lifecycle event, as the agent runtime delivers it on stdin. */
export interface HookEvent {
  hook_event_name?: string;
  [k: string]: unknown;
}

/** Maps one hook event to the JSON reply the runtime applies. */
export type HookHandle = (agent: MeshAgent, ev: HookEvent) => Promise<Record<string, unknown>>;

/** The authenticated control-plane wire frame (one newline-delimited JSON object per connection):
 *  a hook event the runtime delivered, or the manager's cooperative shutdown — both carry the
 *  endpoint `token` as their first field, validated before anything else runs. Shutdown is an
 *  explicit op, NOT a disguised hook event. */
type ControlFrame =
  | { token?: unknown; event?: unknown; handoff?: unknown; op?: undefined }
  | { token?: unknown; op?: "shutdown" };

/** One line a handoff-aware client writes back once the reply has cleared ITS output to the runtime.
 *  Content is irrelevant — arrival is the signal — but a stable token keeps a transcript readable. */
export const HANDOFF_RECEIPT = '{"handoff":"ok"}\n';
/** Backstop for a client that declared `handoff` and then neither confirmed nor closed. The relay's
 *  own stdout backstop is 1s, and a client that dies takes the socket with it (→ `close` → not
 *  delivered), so this only catches a wedged one. Un-delivered on expiry: never commit on a guess. */
const HANDOFF_DEADLINE_MS = 5_000;
/** Bound on awaiting a NON-handoff client's reply write. Such a client makes no delivery promise, so
 *  this only stops one that never reads from pinning a handler; the socket is left alone to flush. */
const LEGACY_WRITE_DEADLINE_MS = 5_000;

export interface ControlServerOpts {
  /** Fail loud on a bind we can't hold. A managed listener (the in-agent MCP server, the Hermes
   *  sidecar) MUST own its endpoint: if `listen` errors (e.g. a squatter already holds the win32
   *  pipe → `EADDRINUSE`; libuv binds with `FILE_FLAG_FIRST_PIPE_INSTANCE`), the process exits
   *  rather than running on with a hijacked or no-op control plane. Default off (an ad-hoc/test
   *  server logs and stays up). */
  fatalBind?: boolean;
  /** Cooperative shutdown: invoked on an AUTHENTICATED `{op:"shutdown"}` frame. The connector runs
   *  its own clean teardown (close the server, `agent.stop()` to leave the mesh, then exit) — the
   *  server never owns `process.exit`. Absent → shutdown frames are accepted + acked but inert. */
  onShutdown?: () => void;
  /** Called once per handled hook frame, after the reply has been written, with whether it reached a
   *  LIVE client. A hook reply is the only vehicle for the peer messages a handler injects, and it is
   *  not guaranteed to arrive: the relay abandons the exchange after its own timeout, and the runtime
   *  can kill the hook process outright. A handler that surfaced messages therefore commits them on
   *  `delivered === true` and leaves them un-acked otherwise, so the durable redelivery brings them
   *  back instead of the batch being silently consumed.
   *
   *  **Frames overlap, so correlate on `ev`.** This is the identical object passed to `handle`, and
   *  it is the only thing tying a verdict to the reply that carried a batch: each frame is its own
   *  connection, and a `PreToolUse` can land while a `UserPromptSubmit` reply is still being written.
   *  A single mutable "pending" slot will therefore commit one frame's messages on another frame's
   *  verdict. Key per event (a WeakMap, so a frame whose verdict never arrives is collected).
   *
   *  How strong `delivered` is depends on the client. A client that sets `handoff: true` (the hook
   *  relay does) confirms only after its own write to the runtime-facing pipe completed cleanly —
   *  strictly more than a socket write, and still short of proof the host read or applied the reply:
   *  a small payload can sit in a kernel buffer that nobody ever drains. For any other client it
   *  means only "written to a socket that was still open" — exact for the case that matters, a client
   *  that had already gone away when we answered, but blind to one that dies with the reply
   *  unflushed downstream. Both are why this errs toward at-least-once. */
  onReply?: (ev: HookEvent, delivered: boolean) => void;
}

/** Hard cap on the first (only) frame: a control request is a token + one small lifecycle event —
 *  kilobytes at most. Generous headroom for a legit event, tiny next to the ~512MB string limit an
 *  unauthenticated spewer would otherwise drive `buf` toward to crash the process. */
const MAX_FRAME_BYTES = 1 << 20; // 1 MiB
/** ABSOLUTE deadline (not an idle timeout — a slow-loris dribbling one byte at a time would keep
 *  resetting an idle timer) for a connection to deliver its complete auth frame. Past it, an
 *  unauthenticated connection is dropped so a local process can't camp on a finite pipe instance.
 *  Cleared the instant a full frame is in hand (the token-bearing client then owns the connection). */
const AUTH_DEADLINE_MS = 5_000;

/** Constant-time match of a presented token against the endpoint's. Both sides are SHA-256'd first
 *  so the compare is fixed-length (and length-independent) regardless of the presented value — a
 *  non-string or wrong-length token can never throw `timingSafeEqual` or leak length via timing. */
function tokenMatches(presented: unknown, digest: Buffer): boolean {
  if (typeof presented !== "string") return false;
  return timingSafeEqual(createHash("sha256").update(presented).digest(), digest);
}

function who(i: InboxItem): string {
  return i.fromRole ? `${i.fromName}/${i.fromRole}` : i.fromName;
}

function fmtItem(i: InboxItem): string {
  const h = i.historical ? " (history)" : ""; // backfilled on join — pre-dates you, not live
  if (i.kind === "dm") return `• DM from ${who(i)}${h}: ${i.text}`;
  if (i.kind === "anycast") return `• @${i.service} (from ${who(i)})${h}: ${i.text}`;
  return `• #${i.channel} ${who(i)}${h}: ${i.text}`;
}

/** The context block injected into a turn when peer messages are waiting (else undefined). */
export function formatInjection(items: InboxItem[]): string | undefined {
  if (!items.length) return undefined;
  const head = `📨 Cotal — ${items.length} new message${items.length === 1 ? "" : "s"} from peers:`;
  const tail = `(Reply with cotal_send / cotal_dm, or cotal_roster to see who's here.)`;
  return `${head}\n${items.map(fmtItem).join("\n")}\n${tail}`;
}

/** Write one reply frame and report whether it actually reached the runtime.
 *
 *  Two strengths, chosen by the client:
 *
 *  - **Socket write** (default). Resolves `false` when the socket had already gone (the relay timed
 *    out and destroyed it, or the hook process was killed). This is as far as we can see on our own,
 *    and it is NOT the whole journey: the reply still has to cross the client's own output to the
 *    runtime, and a client that dies with it unflushed reads as delivered here.
 *  - **Confirmed handoff** (`handoff: true` in the request frame). We hold the connection open until
 *    the client writes {@link HANDOFF_RECEIPT} back, which it does only once the reply has cleared
 *    its output. A close, an error, or the deadline without that receipt is NOT delivered. This is
 *    what closes the large-reply hole: a 6 MiB injection that the relay's 1s stdout backstop kills
 *    mid-flush leaves the batch un-acked, so JetStream redelivers it. */
function writeReply(sock: Socket, reply: Record<string, unknown>, awaitHandoff: boolean): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    // A destroyed/half-closed peer surfaces as an error or a close before the write ever finishes;
    // `finish` (the end callback) precedes `close` on the success path, so the first signal wins.
    sock.once("error", () => done(false));
    sock.once("close", () => done(false));
    if (!awaitHandoff) {
      // This write used to be fire-and-forget; awaiting it means a peer that never reads can hold the
      // handler open for as long as it likes (`end()`'s callback waits for the flush). Bound the WAIT
      // rather than the socket: resolving early reports what we honestly know — not confirmed — while
      // the kernel finishes the write in the background, so a merely slow reader is never truncated.
      const stall = setTimeout(() => done(false), LEGACY_WRITE_DEADLINE_MS);
      stall.unref?.();
      try {
        sock.end(JSON.stringify(reply) + "\n", ((err?: Error | null) => {
          clearTimeout(stall);
          done(!err);
        }) as () => void);
      } catch {
        clearTimeout(stall);
        done(false); // already destroyed — end() throws rather than calling back
      }
      return;
    }
    const deadline = setTimeout(() => {
      sock.destroy(); // wedged client: stop waiting, and do NOT credit a handoff we never saw
      done(false);
    }, HANDOFF_DEADLINE_MS);
    deadline.unref?.();
    let receipt = "";
    sock.on("data", (d: string) => {
      receipt += d;
      if (!receipt.includes("\n")) return;
      clearTimeout(deadline);
      try {
        sock.end();
      } catch {
        /* client already gone; the receipt is what mattered and we have it */
      }
      done(true);
    });
    try {
      // write, not end: the client cannot send its receipt down a connection we have half-closed.
      sock.write(JSON.stringify(reply) + "\n", (err?: Error | null) => {
        if (!err) return;
        clearTimeout(deadline);
        done(false);
      });
    } catch {
      clearTimeout(deadline);
      done(false);
    }
  });
}

/** Start the authenticated control server. One newline-delimited JSON {@link ControlFrame} → one
 *  reply per connection. The first thing every connection does is validate its `token` against the
 *  endpoint's (constant-time) — a mismatch is dropped before `handle` (or `onShutdown`) ever runs,
 *  so an unauthenticated local process that finds/guesses the path still can't drive presence,
 *  inject peer messages, or shut the agent down. */
export function startControlServer(
  agent: MeshAgent,
  endpoint: { path: string; token: string },
  handle: HookHandle,
  opts: ControlServerOpts = {},
): Server {
  const { path } = endpoint;
  const digest = createHash("sha256").update(endpoint.token).digest();
  // Stale-socket cleanup is POSIX-only: a win32 named pipe is not a filesystem entry to unlink, and
  // a live one there is a SQUATTER the fatal `EADDRINUSE` is meant to catch — never clear it. (With
  // a token-random path a stale POSIX socket from a dead predecessor is itself near-impossible, but
  // the unlink stays as cheap insurance against an exact-path leftover.)
  if (process.platform !== "win32" && existsSync(path)) {
    try {
      unlinkSync(path);
    } catch {
      /* ignore */
    }
  }
  const server = createServer((sock) => {
    let buf = "";
    let handled = false; // one frame per connection — ignore anything after the first line
    sock.setEncoding("utf8");
    // Bound an UNAUTHENTICATED peer: on Windows the named pipe's default DACL lets any local process
    // connect, so a client that streams bytes with no newline (would grow `buf` toward the ~512MB
    // string limit → crashes this long-lived process), that connects and sends nothing, OR that
    // dribbles a byte at a time (a slow-loris) to camp on a finite pipe instance must be cut off
    // BEFORE auth. MAX_FRAME_BYTES caps a spewing one; an ABSOLUTE deadline (reset-proof, unlike an
    // idle timeout) reaps a silent/slow one. A legit client sends one small line immediately.
    const deadline = setTimeout(() => sock.destroy(), AUTH_DEADLINE_MS);
    deadline.unref?.(); // never hold the process open on an unauthenticated connection
    sock.on("close", () => clearTimeout(deadline));
    sock.on("data", async (d) => {
      if (handled) return;
      buf += d;
      if (buf.length > MAX_FRAME_BYTES) {
        sock.destroy(); // oversized pre-newline — drop hard, never half-close (it keeps spewing)
        return;
      }
      const nl = buf.indexOf("\n");
      if (nl < 0) return; // wait for the full line
      handled = true;
      clearTimeout(deadline); // full frame in hand — the token-bearing client now owns the connection
      let frame: ControlFrame = {};
      try {
        frame = JSON.parse(buf.slice(0, nl) || "{}") as ControlFrame;
      } catch {
        /* malformed — fails the auth check below and is dropped */
      }
      if (!tokenMatches(frame.token, digest)) {
        sock.destroy(); // unauthenticated — drop hard before handle/onShutdown (no half-open)
        return;
      }
      if ((frame as { op?: unknown }).op === "shutdown") {
        try {
          sock.end(JSON.stringify({ ok: true }) + "\n");
        } catch {
          /* client gone */
        }
        opts.onShutdown?.();
        return;
      }
      const ev = ((frame as { event?: unknown }).event ?? {}) as HookEvent;
      const awaitHandoff = (frame as { handoff?: unknown }).handoff === true;
      const reply = await handle(agent, ev);
      // Write FIRST, then report. `opts.onReply?.(ev, await writeReply(...))` short-circuits the
      // whole call expression when `onReply` is absent — arguments included — so the reply was never
      // written at all for the callers that do not observe delivery (opencode, hermes, pi, codex).
      // Answering the client is the server's job; `onReply` only watches it.
      const delivered = await writeReply(sock, reply, awaitHandoff);
      opts.onReply?.(ev, delivered);
    });
    sock.on("error", () => {
      /* ignore client errors */
    });
  });
  let bound = false;
  server.on("error", (e) => {
    process.stderr.write(`[cotal-connector] control server error: ${(e as Error).message}\n`);
    // A bind we never held (listen errored before "listening", e.g. EADDRINUSE from a squatter) is
    // fatal for a managed listener — better to die than serve a hijacked/no-op control plane. A
    // post-bind error is just logged.
    if (opts.fatalBind && !bound) process.exit(1);
  });
  server.listen(path, () => {
    bound = true;
    process.stderr.write(`[cotal-connector] control socket: ${path}\n`); // path is leakage-safe; the token never logs
  });
  return server;
}
