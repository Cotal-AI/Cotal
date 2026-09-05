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
  let cols = DEFAULT_COLS;
  let rows = DEFAULT_ROWS;
  let exit: { code?: number; signal?: number } | undefined;
  const dataSubs = new Map<number, Set<Socket>>();
  const waiters = new Map<Socket, Set<number>>();
  let nextSub = 1;
  let confirmTimer: ReturnType<typeof setInterval> | undefined;

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

  const markExited = (info?: { code?: number; signal?: number }): void => {
    if (!alive) {
      resolveWaiters();
      return;
    }
    alive = false;
    exit = info ?? exit ?? {};
    if (confirmTimer) {
      clearInterval(confirmTimer);
      confirmTimer = undefined;
    }
    for (const socks of dataSubs.values()) {
      for (const sock of socks) send(sock, { event: "exit" });
    }
    resolveWaiters();
  };

  proc.onData((d) => {
    term.write(d);
    const encoded = Buffer.from(d, "utf8").toString("base64");
    for (const [sub, socks] of dataSubs) {
      for (const sock of socks) send(sock, { event: "output", sub, data: encoded });
    }
  });
  proc.onExit(({ exitCode, signal }) => {
    markExited({ code: exitCode, ...(signal === undefined ? {} : { signal }) });
  });
  const reap = setInterval(() => {
    if (!alive) {
      clearInterval(reap);
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
    setTimeout(() => alive && proc.kill("SIGKILL"), GRACE_MS);
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

  const server = createServer((sock) => {
    const reader = new FrameReader();
    let authed = false;
    const owned = new Set<number>();
    const drop = (): void => {
      for (const sub of owned) {
        const socks = dataSubs.get(sub);
        if (!socks) continue;
        socks.delete(sock);
        if (socks.size === 0) dataSubs.delete(sub);
      }
      owned.clear();
      waiters.delete(sock);
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
        if (alive) proc.write(req.data);
        send(sock, { id: req.id, ok: true, op: "write" });
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

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(launch.socket, () => {
      chmodSync(launch.socket, 0o600);
      writeRecord(launch.recordPath, record);
      const ready = `${JSON.stringify({ ready: true, childPid: proc.pid, custodianPid: process.pid })}\n`;
      if (launch.logPath) appendFileSync(launch.logPath, ready, { mode: 0o600 });
      else process.stdout.write(ready);
      resolve();
    });
  });
}

function parseArgv(argv: string[]): CustodianLaunch {
  const raw = argv[0];
  if (!raw) throw new Error("custodian requires a JSON launch on argv");
  return JSON.parse(raw) as CustodianLaunch;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const launch = parseArgv(process.argv.slice(2));
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
