import type { HelloInfo } from "./client.js";
import type { SharedController } from "./shared-controller.js";
import type { SharedSeatRequestBody } from "./shared-control-protocol.js";
import { PROTOCOL_VERSION, type SeatExit, type ServerEvent, type StopMode } from "./protocol.js";
import type { SharedSeatRecord } from "./shared-record.js";

/** A seat view of its Manager's single host connection. A new epoch authenticates each seat again. */
export class SharedSeatClient {
  private hello?: HelloInfo;
  private opening?: Promise<HelloInfo>;
  private closed = false;
  private terminal = false;
  private exit?: SeatExit;
  private readonly exits = new Set<() => void>();
  private readonly outputs = new Set<{ listener: (data: Buffer) => void; id?: number }>();
  private pendingOutput?: (data: Buffer) => void;
  private outputTask = Promise.resolve();
  private readonly offEvent: () => void;
  private readonly offDisconnect: () => void;

  constructor(private readonly controller: SharedController, private readonly row: SharedSeatRecord) {
    this.offEvent = controller.onSeatEvent(row.id, message => this.event(message));
    this.offDisconnect = controller.onDisconnect(() => {
      this.hello = undefined;
      for (const output of this.outputs) output.id = undefined;
    });
  }

  private hasSession(): boolean { return this.controller.connected() && this.hello !== undefined; }
  connected(): boolean { return this.hasSession() && [...this.outputs].every(output => output.id !== undefined); }
  connect(): Promise<HelloInfo> {
    if (this.closed) return Promise.reject(new Error("seat client is closed"));
    if (this.hello && this.hasSession()) return Promise.resolve(this.hello);
    return this.opening ??= this.open().finally(() => { this.opening = undefined; });
  }
  private async open(): Promise<HelloInfo> {
    const reply = await this.controller.seatRequest(this.row.id, { op: "hello", token: this.row.token });
    if (!reply.ok || reply.op !== "hello" || reply.pid !== this.row.childPid || reply.name !== this.row.name)
      throw new Error("unexpected hello reply");
    if (reply.status === "exited") this.finished(reply.exit);
    return this.hello = { name: reply.name, pid: reply.pid, cols: reply.cols, rows: reply.rows,
      status: this.terminal ? "exited" : "running", ...(this.exit ? { exit: this.exit } : {}) };
  }

  private async request(body: SharedSeatRequestBody) {
    await this.connect();
    return this.controller.seatRequest(this.row.id, body);
  }
  async health() {
    const reply = await this.request({ op: "health" });
    if (!reply.ok || reply.op !== "health" || reply.pid !== this.row.childPid || reply.protocol !== PROTOCOL_VERSION) {
      this.controller.reconnect();
      throw new Error("unexpected health reply");
    }
    for (const output of this.outputs) if (output.id === undefined) await this.registerOutput(output, true);
    return { pid: reply.pid, status: reply.status, protocol: reply.protocol, startup: reply.startup };
  }
  async snapshot() {
    const reply = await this.request({ op: "snapshot" });
    if (!reply.ok || reply.op !== "snapshot") throw new Error("unexpected snapshot reply");
    return { data: reply.data, cols: reply.cols, rows: reply.rows };
  }
  async write(data: string): Promise<number> {
    const reply = await this.request({ op: "write", data });
    if (!reply.ok || reply.op !== "write") throw new Error(reply.ok ? "unexpected write reply" : reply.error);
    return reply.bytes;
  }
  async resize(cols: number, rows: number): Promise<void> { await this.command({ op: "resize", cols, rows }); }
  async interrupt(): Promise<void> { await this.command({ op: "interrupt" }); }
  async stop(mode: StopMode): Promise<void> { await this.command({ op: "stop", mode }); }
  async waitExit(): Promise<SeatExit | undefined> {
    const reply = await this.request({ op: "wait-exit" });
    if (!reply.ok || reply.op !== "wait-exit") throw new Error("unexpected wait-exit reply");
    this.finished(reply.exit);
    return reply.exit;
  }
  private async command(body: SharedSeatRequestBody): Promise<void> {
    const reply = await this.request(body);
    if (!reply.ok) throw new Error(reply.error);
  }

  exitInfo(): SeatExit | undefined { return this.exit; }
  onExit(listener: () => void): () => void {
    if (this.terminal) queueMicrotask(listener);
    else this.exits.add(listener);
    return () => { this.exits.delete(listener); };
  }
  private finished(exit?: SeatExit): void {
    this.exit ??= exit;
    if (this.terminal) return;
    this.terminal = true;
    for (const listener of this.exits) listener();
    this.exits.clear();
  }
  private event(message: ServerEvent): void {
    if (message.event === "exit") { this.finished(message.exit); return; }
    const listener = [...this.outputs].find(output => output.id === message.sub)?.listener ?? this.pendingOutput;
    listener?.(Buffer.from(message.data, "base64"));
  }

  async subscribeOutput(listener: (data: Buffer) => void): Promise<() => void> {
    const output: { listener: (data: Buffer) => void; id?: number } = { listener };
    this.outputs.add(output);
    try { await this.registerOutput(output); }
    catch (error) { this.outputs.delete(output); throw error; }
    return () => {
      this.outputs.delete(output);
      if (output.id !== undefined && this.hasSession()) void this.command({ op: "unsubscribe-output", sub: output.id }).catch(() => {});
    };
  }
  private registerOutput(output: { listener: (data: Buffer) => void; id?: number }, reconnect = false): Promise<void> {
    const task = this.outputTask.then(async () => {
      if (output.id !== undefined || !this.outputs.has(output)) return;
      this.pendingOutput = reconnect ? () => {} : output.listener;
      try {
        const reply = await this.request({ op: "subscribe-output" });
        if (!reply.ok || reply.op !== "subscribe-output") throw new Error("unexpected subscribe reply");
        if (this.hasSession() && this.outputs.has(output)) output.id = reply.sub;
      } finally { this.pendingOutput = undefined; }
    });
    this.outputTask = task.catch(() => {});
    return task;
  }

  close(): void {
    this.closed = true;
    this.offEvent();
    this.offDisconnect();
    this.exits.clear();
    this.outputs.clear();
  }
}
