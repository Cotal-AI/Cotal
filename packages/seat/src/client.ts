import { connect, type Socket } from "node:net";
import {
  FrameReader,
  encodeFrame,
  type ClientRequest,
  type ServerEvent,
  type ServerReply,
  type StopMode,
} from "./protocol.js";
import type { SeatRecord } from "./record.js";

export interface HelloInfo {
  name: string;
  pid: number;
  cols: number;
  rows: number;
  status: "running" | "exited";
  exit?: { code?: number; signal?: number };
}

interface Pending {
  resolve: (reply: ServerReply) => void;
  reject: (err: Error) => void;
}

export class SeatClient {
  private sock: Socket | undefined;
  private connecting: Socket | undefined;
  private reader = new FrameReader();
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private output = new Map<number, (data: Buffer) => void>();
  private exits = new Set<() => void>();
  private helloInfo: HelloInfo | undefined;
  private pendingExit = false;
  private closed = false;

  constructor(private readonly record: SeatRecord) {}

  async connect(): Promise<HelloInfo> {
    if (this.helloInfo) return this.helloInfo;
    if (this.closed) throw new Error("seat client is closed");
    const sock = await new Promise<Socket>((resolve, reject) => {
      const s = connect(this.record.socket);
      this.connecting = s;
      s.once("connect", () => {
        this.connecting = undefined;
        resolve(s);
      });
      s.once("error", (err) => {
        this.connecting = undefined;
        reject(err);
      });
    });
    if (this.closed) {
      sock.destroy();
      throw new Error("seat client is closed");
    }
    this.sock = sock;
    sock.on("data", (chunk) => {
      for (const raw of this.reader.push(chunk)) this.dispatch(raw);
    });
    sock.on("close", () => this.failAll(new Error("custodian socket closed")));
    sock.on("error", (err) => {
      if (this.closed && (err as NodeJS.ErrnoException).code === "ECONNRESET") return;
      this.failAll(err);
    });
    const reply = await this.request({ op: "hello", token: this.record.token });
    if (!reply.ok || reply.op !== "hello") throw new Error(reply.ok ? "unexpected hello reply" : reply.error);
    this.helloInfo = {
      name: reply.name,
      pid: reply.pid,
      cols: reply.cols,
      rows: reply.rows,
      status: this.pendingExit ? "exited" : reply.status,
      ...(reply.exit ? { exit: reply.exit } : {}),
    };
    return this.helloInfo;
  }

  info(): HelloInfo {
    if (!this.helloInfo) throw new Error("seat client is not connected");
    return this.helloInfo;
  }

  async snapshot(): Promise<{ data: string; cols: number; rows: number }> {
    const reply = await this.request({ op: "snapshot" });
    if (!reply.ok || reply.op !== "snapshot") throw new Error(reply.ok ? "unexpected snapshot reply" : reply.error);
    return { data: reply.data, cols: reply.cols, rows: reply.rows };
  }

  async subscribeOutput(fn: (data: Buffer) => void): Promise<() => void> {
    const reply = await this.request({ op: "subscribe-output" });
    if (!reply.ok || reply.op !== "subscribe-output") throw new Error(reply.ok ? "unexpected subscribe reply" : reply.error);
    this.output.set(reply.sub, fn);
    const sub = reply.sub;
    return () => {
      this.output.delete(sub);
      void this.request({ op: "unsubscribe-output", sub }).catch(() => undefined);
    };
  }

  onExit(fn: () => void): () => void {
    if (this.helloInfo?.status === "exited" || this.pendingExit) {
      queueMicrotask(fn);
      return () => {};
    }
    this.exits.add(fn);
    return () => {
      this.exits.delete(fn);
    };
  }

  async write(data: string): Promise<void> {
    const reply = await this.request({ op: "write", data });
    if (!reply.ok) throw new Error(reply.error);
  }

  async resize(cols: number, rows: number): Promise<void> {
    const reply = await this.request({ op: "resize", cols, rows });
    if (!reply.ok) throw new Error(reply.error);
    if (this.helloInfo && cols > 0 && rows > 0) {
      this.helloInfo.cols = cols;
      this.helloInfo.rows = rows;
    }
  }

  async interrupt(): Promise<void> {
    const reply = await this.request({ op: "interrupt" });
    if (!reply.ok) throw new Error(reply.error);
  }

  async stop(mode: StopMode): Promise<void> {
    const reply = await this.request({ op: "stop", mode });
    if (!reply.ok) throw new Error(reply.error);
  }

  async waitExit(): Promise<{ code?: number; signal?: number } | undefined> {
    const reply = await this.request({ op: "wait-exit" });
    if (!reply.ok || reply.op !== "wait-exit") throw new Error(reply.ok ? "unexpected wait-exit reply" : reply.error);
    if (this.helloInfo) this.helloInfo.status = "exited";
    return reply.exit;
  }

  async health(): Promise<{ pid: number; status: "running" | "exited"; protocol: number }> {
    const reply = await this.request({ op: "health" });
    if (!reply.ok || reply.op !== "health") throw new Error(reply.ok ? "unexpected health reply" : reply.error);
    return { pid: reply.pid, status: reply.status, protocol: reply.protocol };
  }

  close(): void {
    this.closed = true;
    this.connecting?.destroy();
    this.connecting = undefined;
    this.sock?.destroy();
  }

  private request<T extends Omit<ClientRequest, "id">>(body: T): Promise<ServerReply> {
    if (!this.sock || this.closed) return Promise.reject(new Error("seat client is closed"));
    const id = this.nextId++;
    const req = { ...body, id } as ClientRequest;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.sock!.write(encodeFrame(req));
    });
  }

  private dispatch(raw: unknown): void {
    const msg = raw as ServerReply | ServerEvent;
    if ("event" in msg) {
      if (msg.event === "output") {
        const fn = this.output.get(msg.sub);
        if (fn) fn(Buffer.from(msg.data, "base64"));
        return;
      }
      if (msg.event === "exit") {
        if (this.helloInfo) this.helloInfo.status = "exited";
        else this.pendingExit = true;
        for (const fn of this.exits) fn();
        this.exits.clear();
      }
      return;
    }
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    pending.resolve(msg);
  }

  private failAll(err: Error): void {
    for (const pending of this.pending.values()) pending.reject(err);
    this.pending.clear();
    if (this.helloInfo?.status !== "exited") {
      for (const fn of this.exits) fn();
      this.exits.clear();
    }
  }
}
