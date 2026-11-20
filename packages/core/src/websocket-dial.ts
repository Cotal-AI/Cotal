/** How long a close waits for the peer to answer the websocket closing handshake. */
export const CLOSE_ANSWER_MS = 5_000;

type Handler = ((event: unknown) => void) | null;
interface CloseFields { wasClean: boolean; code: number; reason: string }

function duration(ms: number): string {
  if (ms < 1_000) return `${ms} ms`;
  if (ms < 120_000) return `${(ms / 1_000).toFixed(1)} s`;
  if (ms < 7_200_000) return `${Math.round(ms / 60_000)} min`;
  return `${(ms / 3_600_000).toFixed(1)} h`;
}

/** The reason an error event carries, when the runtime gives one. */
function givenReason(event: unknown): string {
  const ev = event as { message?: unknown; error?: { message?: unknown; cause?: { message?: unknown } } } | undefined;
  for (const text of [ev?.message, ev?.error?.message, ev?.error?.cause?.message])
    if (typeof text === "string" && text !== "") return text;
  return "";
}

/**
 * The socket every websocket dial hands nats-core, through its public `wsFactory` option. It wraps
 * the runtime's WebSocket for two things nats-core's websocket transport does not do.
 *
 * It names a failure. The transport builds its `ConnectionError` from the error event's `message`,
 * and Node's WebSocket leaves that empty for every cause (a refusal, a DNS failure, a connect
 * timeout, a non-101 answer), so a failed dial was reported as a bare "ConnectionError". The events
 * this socket passes on say which URL failed, whether the socket had opened, how long it had been
 * trying or open, and any reason the runtime or the server gave.
 *
 * It bounds a close. The transport closes the socket and then waits for its close event: when
 * nats-core's ping check finds the connection stale, on a requested reconnect, and on `close()`.
 * When the peer is gone without a reset, as after a sleep that outlasted the far end's and the
 * NAT's memory of the connection, nobody answers the closing handshake and the event never comes.
 * The library then neither reconnects nor finishes closing, and an endpoint stop waits on it for
 * good. After {@link CLOSE_ANSWER_MS} without that event this socket delivers an unclean close
 * itself. The runtime's socket is left to finish on its own; the operating system ends it when its
 * retransmissions give up.
 *
 * It carries only the members of a WebSocket that the transport uses.
 */
class DialedWebSocket {
  onopen: Handler = null;
  onmessage: Handler = null;
  onerror: Handler = null;
  onclose: Handler = null;
  private readonly socket: WebSocket;
  /** The URL without credentials or query, for messages. */
  private readonly target: string;
  private readonly startedAt = Date.now();
  private openedAt?: number;
  private closeTimer?: ReturnType<typeof setTimeout>;
  private finished = false;

  constructor(url: string) {
    this.socket = new WebSocket(url);
    const shown = new URL(url);
    this.target = `${shown.protocol}//${shown.host}${shown.pathname}`;
    this.socket.binaryType = "arraybuffer";
    this.socket.onopen = (event) => {
      this.openedAt = Date.now();
      this.onopen?.(event);
    };
    this.socket.onmessage = (event) => this.onmessage?.(event);
    this.socket.onerror = (event) => {
      const reason = givenReason(event) || "the runtime gave no reason";
      const message = this.openedAt === undefined
        ? `could not open a websocket to ${this.target}: it failed after ${duration(Date.now() - this.startedAt)}; ${reason}`
        : `the websocket to ${this.target} failed after ${duration(Date.now() - this.openedAt)} open; ${reason}`;
      this.onerror?.({ type: "error", message, error: (event as { error?: unknown }).error });
    };
    this.socket.onclose = (event) => {
      const { wasClean, code, reason } = event as unknown as CloseFields;
      if (wasClean) {
        this.finish({ wasClean, code, reason });
        return;
      }
      // The transport turns an unclean close into an error only when it has a reason, and with no
      // error it first waits for the send buffer to drain on a socket that has already closed.
      const when = this.openedAt === undefined ? "before it opened" : `after ${duration(Date.now() - this.openedAt)} open`;
      this.finish({ wasClean, code, reason: `the websocket to ${this.target} closed with code ${code} ${when}${reason === "" ? "" : `: ${reason}`}` });
    };
  }

  get binaryType(): WebSocket["binaryType"] {
    return this.socket.binaryType;
  }

  set binaryType(type: WebSocket["binaryType"]) {
    this.socket.binaryType = type;
  }

  get bufferedAmount(): number {
    return this.socket.bufferedAmount;
  }

  send(data: ArrayBufferLike | ArrayBufferView): void {
    this.socket.send(data as ArrayBuffer);
  }

  close(): void {
    this.socket.close();
    if (this.finished || this.closeTimer !== undefined) return;
    this.closeTimer = setTimeout(() => this.finish({
      wasClean: false,
      code: 1006,
      reason: `the websocket to ${this.target} did not answer its closing handshake within ${duration(CLOSE_ANSWER_MS)}`,
    }), CLOSE_ANSWER_MS);
    this.closeTimer.unref?.();
  }

  /** Deliver one close to the transport: the runtime's, or the one {@link close} supplies when the
   *  runtime's does not come. A later one is dropped. */
  private finish(event: CloseFields): void {
    if (this.finished) return;
    this.finished = true;
    clearTimeout(this.closeTimer);
    this.closeTimer = undefined;
    this.onclose?.({ type: "close", ...event });
  }
}

/** nats-core's `wsFactory` for a websocket dial: `url` is the server address as listed. nats-core
 *  passes its connection options as a second argument, which this does not read. */
export function dialWebSocket(url: string): Promise<{ socket: WebSocket; encrypted: boolean }> {
  return Promise.resolve({ socket: new DialedWebSocket(url) as unknown as WebSocket, encrypted: url.startsWith("wss://") });
}
