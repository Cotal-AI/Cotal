import { appendFileSync, chmodSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { dirname } from "node:path";
import * as pty from "@lydell/node-pty";
import Headless from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import { peerCredentials } from "./peercred.js";
import {
  CONFIRM_INTERVAL_MS,
  DEFAULT_COLS,
  DEFAULT_ROWS,
  FrameReader,
  GRACE_MS,
  MAX_CONFIRMS,
  MAX_FRAME_SIZE,
  PROTOCOL_VERSION,
  SCROLLBACK_ROWS,
  encodeFrame,
  type ClientRequest,
  type ServerMessage,
} from "./protocol.js";
import { RECORD_VERSION, writeRecord, type SeatRecord } from "./record.js";

export interface CustodianLaunch {
  id: string;
  name: string;
  command: string;
  args: string[] | string;
  env: Record<string, string>;
  cwd: string;
  socket: string;
  token: string;
  recordPath: string;
  logPath?: string;
  confirm?: boolean;
}

function send(sock: Socket, msg: ServerMessage): void {
  if (!sock.writable) return;
  sock.write(encodeFrame(msg));
}

export async function runCustodian(launch: CustodianLaunch): Promise<void> {
  if (process.platform !== "linux") {
    throw new Error(`custody transport unsupported on ${process.platform}`);
  }

  mkdirSync(dirname(launch.socket), { recursive: true, mode: 0o700 });
  try {
    unlinkSync(launch.socket);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }

  const proc = pty.spawn(launch.command, launch.args, {
    name: "xterm-256color",
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
    cwd: launch.cwd,
    env: launch.env,
  });

  const term = new Headless.Terminal({
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
    scrollback: SCROLLBACK_ROWS,
    allowProposedApi: true,
  });
  const serializer = new SerializeAddon();
  term.loadAddon(serializer);

  let alive = true;
  let ready = false;
  let settling = false;
  let seenClient = false;
  let cols = DEFAULT_COLS;
  let rows = DEFAULT_ROWS;
  let exit: { code?: number; signal?: number } | undefined;
  const dataSubs = new Map<number, Set<Socket>>();
  const waiters = new Map<Socket, Set<number>>();
  const controllers = new Set<Socket>();
  const clients = new Set<Socket>();
  let nextSub = 1;
  let early = "";
  let confirmTimer: ReturnType<typeof setInterval> | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let handoffTimer: ReturnType<typeof setTimeout> | undefined;
  let reap: ReturnType<typeof setInterval> | undefined;
  let server: ReturnType<typeof createServer> | undefined;
  /** Wait for the first adopter when the child has already exited at listen. */
  const LAUNCH_HANDOFF_MS = 5_000;

  if (launch.confirm) {
    let presses = 0;
    confirmTimer = setInterval(() => {
      if (!alive || presses++ >= MAX_CONFIRMS) {
        clearInterval(confirmTimer);
        confirmTimer = undefined;
        return;
      }
      proc.write("\r");
    }, CONFIRM_INTERVAL_MS);
  }

  const snapshot = (): Promise<string> =>
    new Promise((resolve) => term.write("", () => resolve(serializer.serialize())));

  const resolveWaiters = (): void => {
    for (const [sock, ids] of waiters) {
      for (const id of ids) send(sock, { id, ok: true, op: "wait-exit", exit });
    }
    waiters.clear();
  };

  const childGone = (): boolean => {
    try {
      const stat = readFileSync(`/proc/${proc.pid}/stat`, "utf8");
      return (stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[0] ?? "") === "Z";
    } catch {
      return true;
    }
  };

  const settleTerminal = (): void => {
    if (alive || settling || !ready) return;
    if (clients.size > 0) return;
    if (!seenClient) return;
    settling = true;
    if (confirmTimer) {
      clearInterval(confirmTimer);
      confirmTimer = undefined;
    }
    if (killTimer) {
      clearTimeout(killTimer);
      killTimer = undefined;
    }
    if (handoffTimer) {
      clearTimeout(handoffTimer);
      handoffTimer = undefined;
    }
    if (reap) {
      clearInterval(reap);
      reap = undefined;
    }
    try {
      term.dispose();
    } catch {
      /* already gone */
    }
    try {
      proc.kill("SIGKILL");
    } catch {
      /* already gone */
    }
    server?.close();
    for (const sock of clients) {
      try {
        sock.destroy();
      } catch {
        /* already gone */
      }
    }
    clients.clear();
    controllers.clear();
    waiters.clear();
    dataSubs.clear();
    try {
      unlinkSync(launch.socket);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    try {
      unlinkSync(launch.recordPath);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    process.exit(0);
  };

  const armUnobservedHandoff = (): void => {
    if (alive || seenClient || settling || !ready || handoffTimer) return;
    handoffTimer = setTimeout(() => {
      handoffTimer = undefined;
      seenClient = true;
      settleTerminal();
    }, LAUNCH_HANDOFF_MS);
    handoffTimer.unref();
  };

  const markExited = (info?: { code?: number; signal?: number }): void => {
    if (!alive) {
      resolveWaiters();
      settleTerminal();
      armUnobservedHandoff();
      return;
    }
    alive = false;
    exit = info ?? exit ?? {};
    if (confirmTimer) {
      clearInterval(confirmTimer);
      confirmTimer = undefined;
    }
    for (const sock of controllers) send(sock, { event: "exit" });
    resolveWaiters();
    settleTerminal();
    armUnobservedHandoff();
  };

  proc.onData((d) => {
    term.write(d);
    if (early.length < MAX_FRAME_SIZE) {
      early += early.length + d.length > MAX_FRAME_SIZE ? d.slice(0, MAX_FRAME_SIZE - early.length) : d;
    }
    const encoded = Buffer.from(d, "utf8").toString("base64");
    for (const [sub, socks] of dataSubs) {
      for (const sock of socks) send(sock, { event: "output", sub, data: encoded });
    }
  });
  proc.onExit(({ exitCode, signal }) => {
    markExited({ code: exitCode, ...(signal === undefined ? {} : { signal }) });
  });
  reap = setInterval(() => {
    if (!alive) {
      if (reap) clearInterval(reap);
      reap = undefined;
      return;
    }
    if (childGone()) markExited({});
  }, 50);
  reap.unref();

  const stopChild = (mode: "graceful" | "hard"): void => {
    if (!alive) return;
    if (mode === "hard") {
      proc.kill("SIGKILL");
      return;
    }
    proc.kill("SIGTERM");
    if (killTimer) clearTimeout(killTimer);
    killTimer = setTimeout(() => alive && proc.kill("SIGKILL"), GRACE_MS);
  };

  const record: SeatRecord = {
    version: RECORD_VERSION,
    id: launch.id,
    name: launch.name,
    socket: launch.socket,
    token: launch.token,
    custodianPid: process.pid,
    childPid: proc.pid,
  };

  server = createServer((sock) => {
    const reader = new FrameReader();
    let authed = false;
    const owned = new Set<number>();
    clients.add(sock);
    const drop = (): void => {
      clients.delete(sock);
      controllers.delete(sock);
      for (const sub of owned) {
        const socks = dataSubs.get(sub);
        if (!socks) continue;
        socks.delete(sock);
        if (socks.size === 0) dataSubs.delete(sub);
      }
      owned.clear();
      waiters.delete(sock);
      settleTerminal();
    };
    sock.on("data", (chunk) => {
      let messages: unknown[];
      try {
        messages = reader.push(chunk);
      } catch {
        sock.destroy();
        return;
      }
      for (const raw of messages) {
        void handle(sock, raw, {
          authed: () => authed,
          setAuthed: (v) => {
            authed = v;
          },
          owned,
        }).catch((err) => {
          send(sock, { id: (raw as { id?: number }).id ?? 0, ok: false, error: (err as Error).message });
        });
      }
    });
    sock.on("close", drop);
    sock.on("error", drop);
  });

  async function handle(
    sock: Socket,
    raw: unknown,
    session: { authed: () => boolean; setAuthed: (v: boolean) => void; owned: Set<number> },
  ): Promise<void> {
    const req = raw as ClientRequest;
    if (typeof req !== "object" || req === null || typeof req.id !== "number" || typeof req.op !== "string") {
      send(sock, { id: 0, ok: false, error: "malformed request" });
      return;
    }
    try {
      const cred = peerCredentials(sock);
      const uid = process.getuid?.();
      if (uid === undefined || cred.uid !== uid) {
        send(sock, { id: req.id, ok: false, error: "peer uid mismatch" });
        sock.destroy();
        return;
      }
    } catch (e) {
      send(sock, { id: req.id, ok: false, error: (e as Error).message });
      sock.destroy();
      return;
    }
    if (req.op !== "hello" && !session.authed()) {
      send(sock, { id: req.id, ok: false, error: "not authenticated" });
      sock.destroy();
      return;
    }
    switch (req.op) {
      case "hello": {
        if (req.token !== launch.token) {
          send(sock, { id: req.id, ok: false, error: "capability token mismatch" });
          sock.destroy();
          return;
        }
        session.setAuthed(true);
        seenClient = true;
        if (handoffTimer) {
          clearTimeout(handoffTimer);
          handoffTimer = undefined;
        }
        if (alive && childGone()) markExited({});
        send(sock, {
          id: req.id,
          ok: true,
          op: "hello",
          name: launch.name,
          pid: proc.pid,
          cols,
          rows,
          status: alive ? "running" : "exited",
          ...(exit ? { exit } : {}),
        });
        controllers.add(sock);
        if (!alive) send(sock, { event: "exit" });
        return;
      }
      case "snapshot": {
        const data = await snapshot();
        send(sock, { id: req.id, ok: true, op: "snapshot", data, cols, rows });
        return;
      }
      case "subscribe-output": {
        const sub = nextSub++;
        const socks = dataSubs.get(sub) ?? new Set<Socket>();
        socks.add(sock);
        dataSubs.set(sub, socks);
        session.owned.add(sub);
        send(sock, { id: req.id, ok: true, op: "subscribe-output", sub });
        if (early) send(sock, { event: "output", sub, data: Buffer.from(early, "utf8").toString("base64") });
        if (!alive) send(sock, { event: "exit", sub });
        return;
      }
      case "unsubscribe-output": {
        const socks = dataSubs.get(req.sub);
        if (socks) {
          socks.delete(sock);
          if (socks.size === 0) dataSubs.delete(req.sub);
        }
        session.owned.delete(req.sub);
        send(sock, { id: req.id, ok: true, op: "unsubscribe-output" });
        return;
      }
      case "write": {
        if (!alive) throw new Error(`seat ${launch.name} is not running; the PTY rejected the write`);
        proc.write(req.data);
        send(sock, { id: req.id, ok: true, op: "write", bytes: Buffer.byteLength(req.data, "utf8") });
        return;
      }
      case "resize": {
        if (req.cols > 0 && req.rows > 0) {
          cols = req.cols;
          rows = req.rows;
          term.resize(req.cols, req.rows);
          if (alive) proc.resize(req.cols, req.rows);
        }
        send(sock, { id: req.id, ok: true, op: "resize" });
        return;
      }
      case "interrupt": {
        if (alive) proc.write("\x03");
        send(sock, { id: req.id, ok: true, op: "interrupt" });
        return;
      }
      case "stop": {
        stopChild(req.mode);
        send(sock, { id: req.id, ok: true, op: "stop" });
        return;
      }
      case "wait-exit": {
        if (alive && childGone()) markExited({});
        if (!alive) {
          send(sock, { id: req.id, ok: true, op: "wait-exit", exit });
          return;
        }
        const ids = waiters.get(sock) ?? new Set<number>();
        ids.add(req.id);
        waiters.set(sock, ids);
        return;
      }
      case "health": {
        if (alive && childGone()) markExited({});
        send(sock, {
          id: req.id,
          ok: true,
          op: "health",
          pid: proc.pid,
          status: alive ? "running" : "exited",
          protocol: PROTOCOL_VERSION,
        });
        return;
      }
      default: {
        const id = typeof (raw as { id?: unknown }).id === "number" ? (raw as { id: number }).id : 0;
        send(sock, { id, ok: false, error: "unknown op" });
      }
    }
  }

  const listening = server;
  if (!listening) throw new Error("custodian server missing");
  await new Promise<void>((resolve, reject) => {
    listening.once("error", reject);
    listening.listen(launch.socket, () => {
      chmodSync(launch.socket, 0o600);
      writeRecord(launch.recordPath, record);
      ready = true;
      const announced = `${JSON.stringify({ ready: true, childPid: proc.pid, custodianPid: process.pid })}\n`;
      if (launch.logPath) appendFileSync(launch.logPath, announced, { mode: 0o600 });
      else process.stdout.write(announced);
      armUnobservedHandoff();
      settleTerminal();
      resolve();
    });
  });
}

function readLaunch(): CustodianLaunch {
  const raw = readFileSync(0, "utf8");
  if (!raw.trim()) throw new Error("custodian requires a JSON launch on stdin");
  return JSON.parse(raw) as CustodianLaunch;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const launch = readLaunch();
  runCustodian(launch).catch((err) => {
    const text = `${(err as Error).stack ?? (err as Error).message}\n`;
    try {
      if (launch.logPath) appendFileSync(launch.logPath, text, { mode: 0o600 });
      else process.stderr.write(text);
    } catch {
      process.stderr.write(text);
    }
    process.exit(1);
  });
}
