import { connect, type Socket } from "node:net";
import { resolve } from "node:path";
import { peerCredentials } from "./peercred.js";
import { FrameReader, MAX_FRAME_SIZE, encodeFrame, type ServerEvent, type ServerReply } from "./protocol.js";
import { isSeatId } from "./record.js";
import {
  SHARED_CONTROL_PROTOCOL, type SharedControlOutcome, type SharedControlReply, type SharedControlRequest,
  type SharedLaunchPayload, type SharedSeatRequestBody,
} from "./shared-control-protocol.js";
import { recordedProcess, sharedHostSocket, sharedScopeMatches, shortSocketPath, type SharedHostRecord } from "./shared-record.js";

const CONNECT_MS = 2_000;
const REQUEST_MS = 8_000;
const MAX_PENDING = 128;
const MAX_QUEUED_BYTES = 2 * (MAX_FRAME_SIZE + 4);

// Pin the whole tuple, not just a path that might later point at a different host.
type HostIdentity = Readonly<SharedHostRecord>;

export class SharedControlError extends Error {
  constructor(readonly outcome: SharedControlOutcome, message: string) {
    super(message);
    this.name = "SharedControlError";
  }
}

interface Pending {
  op: SharedControlRequest["op"];
  seat?: string;
  seatOp?: SharedSeatRequestBody["op"];
  accept: (reply: SharedControlReply) => void;
  reject: (error: SharedControlError) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Connection {
  socket: Socket;
  reader: FrameReader;
  pending: Map<number, Pending>;
  authenticated: boolean;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** One connection to one exact shared host incarnation, with no implicit retry of a request. */
export class SharedController {
  private readonly root: string;
  private readonly host: HostIdentity;
  private current?: Connection;
  private opening?: Promise<void>;
  private closed = false;
  private nextId = 1;
  private readonly events = new Map<string, Set<(message: ServerEvent) => void>>();
  private readonly disconnects = new Set<() => void>();

  constructor(root: string, host: HostIdentity) {
    this.root = resolve(root);
    this.host = { ...host };
  }

  connected(): boolean { return this.current?.authenticated === true && !this.current.socket.destroyed; }

  connect(): Promise<void> {
    if (this.closed) return Promise.reject(new SharedControlError("not-admitted", "shared PTY controller is closed"));
    if (this.connected()) return Promise.resolve();
    return this.opening ??= this.open().finally(() => { this.opening = undefined; });
  }

  async launch(seat: string, launch: SharedLaunchPayload): Promise<void> {
    const connection = await this.forSeat(seat);
    await this.request(connection, { id: this.nextId++, op: "launch", seat, launch });
  }

  async launchState(seat: string): Promise<"absent" | "unknown"> {
    const connection = await this.forSeat(seat);
    const reply = await this.request(connection, { id: this.nextId++, op: "launch-state", seat });
    return reply.ok && reply.op === "launch-state" && reply.state === "absent" ? "absent" : "unknown";
  }

  async seatRequest(seat: string, body: SharedSeatRequestBody): Promise<ServerReply> {
    const connection = await this.forSeat(seat);
    const id = this.nextId++;
    const reply = await this.request(connection, { id, op: "seat", seat, request: { ...body, id } });
    if (!reply.ok || reply.op !== "seat") throw new SharedControlError("unknown", "invalid shared PTY seat reply");
    return reply.reply;
  }

  /** The adapter owns subscription renewal. An event can follow its subscribe reply in the same read. */
  onSeatEvent(seat: string, listener: (message: ServerEvent) => void): () => void {
    if (this.closed) return () => {};
    const listeners = this.events.get(seat) ?? new Set();
    listeners.add(listener);
    this.events.set(seat, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size && this.events.get(seat) === listeners) this.events.delete(seat);
    };
  }

  onDisconnect(listener: () => void): () => void {
    if (this.closed) return () => {};
    this.disconnects.add(listener);
    return () => { this.disconnects.delete(listener); };
  }

  close(): void {
    this.closed = true;
    this.reconnect();
    this.events.clear();
    this.disconnects.clear();
  }

  reconnect(): void { if (this.current) this.drop(this.current); }

  private async forSeat(seat: string): Promise<Connection> {
    if (!isSeatId(seat)) throw new SharedControlError("not-admitted", "invalid shared PTY seat id");
    await this.connect();
    const connection = this.current;
    if (!connection?.authenticated || connection.socket.destroyed)
      throw new SharedControlError("not-admitted", "shared PTY controller is not connected");
    return connection;
  }

  private verifyHost(socket?: Socket): void {
    const host = this.host;
    const uid = process.getuid?.();
    if (host.protocol !== SHARED_CONTROL_PROTOCOL || uid === undefined)
      throw new Error("shared PTY host identity or protocol is not verified");
    if (socket) {
      const peer = peerCredentials(socket);
      if (peer.uid !== uid || peer.pid !== host.pid) throw new Error("shared PTY host peer does not match its record");
    }
    if (recordedProcess(host.pid, host.start, host.bootId) !== "live" || !sharedScopeMatches(host.pid, host.scope))
      throw new Error("shared PTY host identity or scope is not verified");
  }

  private async open(): Promise<void> {
    let connection: Connection | undefined;
    try {
      this.verifyHost();
      const path = shortSocketPath(sharedHostSocket(this.root));
      let socket: Socket;
      try { socket = connect(path.path); }
      catch (error) { path.close(); throw error; }
      const active: Connection = { socket, reader: new FrameReader(), pending: new Map(), authenticated: false };
      connection = this.current = active;
      socket.once("close", path.close);
      socket.on("close", () => this.drop(active));
      socket.on("error", () => this.drop(active));
      socket.on("end", () => this.drop(active));
      socket.on("data", chunk => {
        if (this.current !== active) return;
        try {
          for (const raw of active.reader.push(chunk)) {
            if (this.current !== active) break;
            this.receive(active, raw);
          }
        } catch { this.drop(active); }
      });
      await new Promise<void>((accept, reject) => {
        const timer = setTimeout(() => this.drop(active), CONNECT_MS);
        socket.once("connect", () => { clearTimeout(timer); accept(); });
        socket.once("close", () => { clearTimeout(timer); reject(new Error("host dial closed")); });
      });
      if (this.current !== active) throw new Error("host dial superseded");
      // No capability or seat data leaves the Manager until this actual socket peer is verified.
      this.verifyHost(socket);
      await this.request(active, { id: this.nextId++, op: "hello", protocol: this.host.protocol, token: this.host.token });
      if (this.current !== active || !active.authenticated)
        throw new Error("shared PTY host did not confirm its recorded identity");
    } catch (error) {
      if (connection) this.drop(connection);
      // No seat operation was sent. A possibly accepted hello is not a possibly admitted launch.
      throw new SharedControlError("not-admitted", error instanceof Error ? error.message : "shared PTY controller authentication failed");
    }
  }

  private request(connection: Connection, request: SharedControlRequest): Promise<SharedControlReply> {
    const { socket, pending } = connection;
    if (this.current !== connection || socket.destroyed || !socket.writable ||
        (request.op !== "hello" && !connection.authenticated) || pending.size >= MAX_PENDING)
      return Promise.reject(new SharedControlError("not-admitted", "shared PTY control request was not sent"));
    let bytes: Buffer;
    try { bytes = encodeFrame(request); }
    catch { return Promise.reject(new SharedControlError("not-admitted", "invalid shared PTY control request")); }
    if (socket.writableLength + bytes.length > MAX_QUEUED_BYTES)
      return Promise.reject(new SharedControlError("not-admitted", "shared PTY control queue is full"));
    return new Promise((accept, reject) => {
      const timer = setTimeout(() => {
        pending.delete(request.id);
        reject(new SharedControlError("unknown", "shared PTY host did not reply before the request deadline"));
      }, request.op === "hello" ? CONNECT_MS : REQUEST_MS);
      pending.set(request.id, { op: request.op,
        ...(request.op === "seat" ? { seat: request.seat, seatOp: request.request.op } : {}), accept, reject, timer });
      try { socket.write(bytes); }
      catch { this.drop(connection); }
    });
  }

  private receive(connection: Connection, raw: unknown): void {
    if (!object(raw)) throw new Error("invalid shared PTY control frame");
    if ("event" in raw) {
      if (!connection.authenticated || raw.event !== "seat" || typeof raw.seat !== "string" || !isSeatId(raw.seat) || !object(raw.message))
        throw new Error("invalid shared PTY seat event");
      const message = raw.message;
      if ((message.event !== "output" && message.event !== "exit") ||
          (message.event === "output" && (!positiveId(message.sub) || typeof message.data !== "string")))
        throw new Error("invalid shared PTY terminal event");
      for (const listener of [...(this.events.get(raw.seat) ?? [])]) {
        try { listener(message as ServerEvent); } catch { /* a seat callback cannot break host custody */ }
        if (this.current !== connection) break;
      }
      return;
    }
    if (!positiveId(raw.id) || typeof raw.ok !== "boolean") throw new Error("invalid shared PTY control reply");
    const pending = connection.pending.get(raw.id);
    if (!pending) return; // Late response to a request that already timed out.
    if (raw.ok) {
      if (raw.op !== pending.op || (raw.op === "seat" &&
          (raw.seat !== pending.seat || !object(raw.reply) || raw.reply.id !== raw.id ||
           (raw.reply.ok === true ? raw.reply.op !== pending.seatOp : raw.reply.ok !== false || typeof raw.reply.error !== "string"))))
        throw new Error("shared PTY reply did not match its request");
      if (raw.op === "hello") {
        if (raw.protocol !== this.host.protocol || raw.pid !== this.host.pid || raw.start !== this.host.start)
          throw new Error("shared PTY host did not confirm its recorded identity");
        connection.authenticated = true;
      }
    } else if ((raw.outcome !== "not-admitted" && raw.outcome !== "unknown") || typeof raw.error !== "string") {
      throw new Error("invalid shared PTY request outcome");
    }
    connection.pending.delete(raw.id);
    clearTimeout(pending.timer);
    if (raw.ok) pending.accept(raw as SharedControlReply);
    else pending.reject(new SharedControlError(raw.outcome as SharedControlOutcome, raw.error as string));
  }

  private drop(connection: Connection): void {
    if (this.current !== connection) return;
    this.current = undefined;
    connection.socket.destroy();
    for (const pending of connection.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new SharedControlError("unknown", "shared PTY controller disconnected before the reply"));
    }
    connection.pending.clear();
    if (connection.authenticated && !this.closed) {
      for (const listener of [...this.disconnects]) {
        try { listener(); } catch { /* a seat callback cannot break reconnection */ }
      }
    }
  }
}
