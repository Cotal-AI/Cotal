import { EventEmitter } from "node:events";

export interface RpcMessage {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

export interface RpcSocket extends EventEmitter {
  readyState: number;
  send(data: string): void;
  close(): void;
}

interface PendingRequest {
  timer: ReturnType<typeof setTimeout>;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

const OPEN = 1;

export class AppServerRequestTimeoutError extends Error {
  constructor(method: string, timeoutMs: number) {
    super(`app-server request timed out after ${timeoutMs}ms: ${method}`);
    this.name = "AppServerRequestTimeoutError";
  }
}

/** A server response proves the request was rejected rather than accepted with an unknown outcome. */
export class AppServerResponseError extends Error {
  readonly code?: number;

  constructor(code: number | undefined, message: string) {
    super(`app-server error${code === undefined ? "" : ` ${code}`}: ${message}`);
    this.name = "AppServerResponseError";
    this.code = code;
  }
}

/**
 * Minimal app-server WebSocket peer.
 *
 * Request timeouts and transport closure reject every uncertain operation; callers decide
 * whether retry is safe rather than this layer replaying side effects.
 */
export class AppServerClient extends EventEmitter {
  private readonly socket: RpcSocket;
  private readonly requestTimeoutMs: number;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private closed = false;

  constructor(opts: {
    socket: RpcSocket;
    requestTimeoutMs?: number;
  }) {
    super();
    this.socket = opts.socket;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 15_000;
    this.socket.on("message", (data: unknown) => this.onMessage(data));
    this.socket.on("close", () =>
      this.close(new Error("app-server WebSocket closed")),
    );
    this.socket.on("error", (error: Error) => this.close(error));
  }

  request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (this.closed)
      return Promise.reject(new Error("app-server transport is closed"));
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AppServerRequestTimeoutError(method, this.requestTimeoutMs));
      }, this.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(id, { timer, resolve, reject });
      try {
        this.write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error as Error);
      }
    });
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    this.write({ method, params });
  }

  respond(id: string | number, result: unknown): void {
    this.write({ id, result });
  }

  respondError(id: string | number, code: number, message: string): void {
    this.write({ id, error: { code, message } });
  }

  close(reason = new Error("app-server transport closed")): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(reason);
    }
    this.pending.clear();
    if (this.socket.readyState === OPEN) this.socket.close();
    this.emit("closed", reason);
  }

  private write(message: RpcMessage): void {
    if (this.closed || this.socket.readyState !== OPEN)
      throw new Error("app-server transport is not writable");
    this.socket.send(JSON.stringify(message));
  }

  private onMessage(data: unknown): void {
    let message: RpcMessage;
    try {
      const text =
        typeof data === "string"
          ? data
          : Buffer.isBuffer(data)
            ? data.toString("utf8")
            : String(data);
      message = JSON.parse(text) as RpcMessage;
    } catch {
      this.emit("protocolError", new Error("app-server emitted invalid JSON"));
      return;
    }
    this.dispatch(message);
  }

  private dispatch(message: RpcMessage): void {
    if (message.id !== undefined && message.method === undefined) {
      if (typeof message.id !== "number") return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error)
        pending.reject(
          new AppServerResponseError(
            message.error.code,
            message.error.message ?? "unknown error",
          ),
        );
      else pending.resolve(message.result);
      return;
    }
    if (message.id !== undefined && message.method) {
      this.emit("serverRequest", message);
      return;
    }
    if (message.method) this.emit("notification", message);
  }
}
