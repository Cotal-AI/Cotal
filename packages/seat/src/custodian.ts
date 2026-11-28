import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { dirname } from "node:path";
import * as pty from "@lydell/node-pty";
import Headless from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import { discardSeatArtifacts } from "./artifacts.js";
import { peerCredentials } from "./peercred.js";
import { preferSeatForOomKill } from "./oom.js";
import {
  DEFAULT_COLS,
  DEFAULT_ROWS,
  FrameReader,
  GRACE_MS,
  MAX_FRAME_SIZE,
  PROTOCOL_VERSION,
  SCROLLBACK_ROWS,
  UNATTENDED_MS as UNATTENDED_DEFAULT_MS,
  encodeFrame,
  type ClientRequest,
  type SeatExit,
  type ServerMessage,
} from "./protocol.js";
import { ConnectorDiagnosticReader } from "./diagnostic.js";
import { RECORD_VERSION, appendPrivate, bootToken, exitPath, processStartToken, processStatFields, writePrivate, writeRecord, type SeatRecord } from "./record.js";
import { StartupConfirmGate } from "./startup-confirm.js";
import { SharedScreen } from "./shared-screen.js";
import { recordedProcess } from "./shared-record.js";

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
  confirm?: string;
  confirmBefore?: readonly import("./startup-confirm.js").StartupReply[];
  confirmReady?: readonly string[];
  confirmBlockers?: readonly import("./startup-confirm.js").StartupBlocker[];
  confirmNotice?: string;
  /** Who started this custodian: the launcher's run marker, carried so a census can attribute an
   *  orphan to its run without walking `/proc/*\/cwd` (#1648). */
  run?: string;
  /** How long to stay up with no authenticated controller before stopping the child and exiting.
   *  Resolved by the LAUNCHER, because the launcher scrubs the environment it hands this process
   *  (the child must not inherit the caller's), so an env override read here would never see one. */
  unattendedMs?: number;
  /** The launch's private temporary directories, copied onto the seat record. This custodian removes
   *  them once it sees its child exit, the one exit it observes directly. */
  artifacts?: string[];
  /** The launcher's temp dir, which every entry of `artifacts` must sit directly under. */
  artifactRoot?: string;
}

export interface CustodianChannel {
  readonly writable: boolean;
  readonly writableLength: number;
  send(message: ServerMessage): void;
  destroy(): void;
  authorize(): void;
}

export interface CustodianSession {
  receive(request: ClientRequest): void;
  close(): void;
}

function send(sock: CustodianChannel, msg: ServerMessage): void {
  if (!sock.writable) return;
  if (sock.writableLength > MAX_FRAME_SIZE) { sock.destroy(); return; }
  try { sock.send(msg); }
  catch { sock.destroy(); }
}

/** A shared host owns the process lifetime; each seat still owns its own socket and exit record. */
interface SharedCustodianLifetime {
  readonly settled: () => void;
  readonly record: (record: SeatRecord) => void;
  readonly listenPath?: string;
  readonly bind?: (accept: (channel: CustodianChannel) => CustodianSession) => void;
  readonly prepare?: () => Promise<PreparedPty>;
}

interface PreparedPty {
  readonly proc: pty.IPty;
  readonly ready: Promise<{ pid: number; start: string; boot: string }>;
  readonly commitAttempted: boolean;
  commit(beforeDispatch: () => void): Promise<void>;
  abort(): void;
}

async function openPty(launch: CustodianLaunch, shared: SharedCustodianLifetime | undefined): Promise<{ proc: pty.IPty; gate?: PreparedPty }> {
  if (shared?.prepare) {
    const gate = await shared.prepare();
    return { proc: gate.proc, gate };
  }
  return { proc: pty.spawn(launch.command, launch.args, {
    name: "xterm-256color", cols: DEFAULT_COLS, rows: DEFAULT_ROWS, cwd: launch.cwd, env: launch.env,
  }) };
}

export async function runCustodian(launch: CustodianLaunch, shared?: SharedCustodianLifetime): Promise<void> {
  if (process.platform !== "linux") {
    throw new Error(`custody transport unsupported on ${process.platform}`);
  }

  if (!shared?.bind) {
    mkdirSync(dirname(launch.socket), { recursive: true, mode: 0o700 });
    unlinkCustodianSocket(launch.socket);
  }

  // Removes the launch's files, logging rather than throwing: a refused path must not take down the
  // custodian of a live seat.
  const discardArtifacts = (artifacts: readonly string[] | undefined): void => {
    try {
      discardSeatArtifacts(artifacts, launch.artifactRoot);
    } catch (e) {
      note(`${(e as Error).message}\n`);
    }
  };
  const note = (line: string): void => {
    try {
      if (launch.logPath) appendPrivate(launch.logPath, line);
      else process.stderr.write(line);
    } catch {
      /* the seat directory may already be gone */
    }
  };

  let confirmGate: StartupConfirmGate | undefined;
  let proc: pty.IPty;
  let gate: PreparedPty | undefined;
  try {
    // Built before the child exists, so a prompt that cannot match starts nothing.
    if ((launch.confirmBefore?.length || launch.confirmReady?.length || launch.confirmBlockers?.length) && launch.confirm === undefined) throw new Error("startup choices require a final confirmation prompt");
    confirmGate = launch.confirm === undefined ? undefined : new StartupConfirmGate(launch.confirm, launch.confirmBefore, launch.confirmReady, launch.confirmBlockers, launch.confirmNotice);
    ({ proc, gate } = await openPty(launch, shared));
  } catch (e) {
    // No child was started, so none will read the files.
    if (!shared?.prepare) discardArtifacts(launch.artifacts);
    throw e;
  }
  const oomPref = preferSeatForOomKill(proc.pid);
  if (!oomPref.applied) note(`oom preference not applied to child ${proc.pid}: ${oomPref.reason}\n`);
  // Pin both start identities NOW, before the child can exit and be reaped: a successor that finds
  // these pids later must be able to tell this custodian and this child from an unrelated process
  // that inherited the pid. A zombie still reports its start token, a reaped pid does not: a child
  // whose exec failed can be gone already, and then the record carries no child identity, which a
  // reader takes as "exited before custody began" (its exit is observed below like any other).
  const custodianStart = processStartToken(process.pid);
  if (custodianStart === undefined) throw new Error(`cannot read the process start identity of custodian ${process.pid} from /proc`);
  const childStart = processStartToken(proc.pid);
  const bootId = bootToken();

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
  let exit: SeatExit | undefined;
  const diagnostic = new ConnectorDiagnosticReader();
  const dataSubs = new Map<number, Set<CustodianChannel>>();
  const waiters = new Map<CustodianChannel, Set<number>>();
  const controllers = new Set<CustodianChannel>();
  const clients = new Set<CustodianChannel>();
  let nextSub = 1;
  let early = "";
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let handoffTimer: ReturnType<typeof setTimeout> | undefined;
  let unattendedTimer: ReturnType<typeof setTimeout> | undefined;
  let reap: ReturnType<typeof setInterval> | undefined;
  let server: ReturnType<typeof createServer> | undefined;
  /** Wait for the first adopter when the child has already exited at listen. */
  const LAUNCH_HANDOFF_MS = 5_000;
  /** How long a child already gone from /proc may wait for node-pty to report how it ended. */
  const EXIT_STATUS_GRACE_MS = 1_000;
  const UNATTENDED_MS = launch.unattendedMs ?? UNATTENDED_DEFAULT_MS;

  const screen = shared ? new SharedScreen(term, serializer, (error, operation) => note(`screen ${operation}: ${String(error)}\n`)) : undefined;
  const writeScreen = (data: string): void => { if (screen) screen.write(data); else term.write(data); };
  const snapshot = (): Promise<string> => screen?.snapshot() ?? new Promise((resolve) => term.write("", () => resolve(serializer.serialize())));

  const resolveWaiters = (): void => {
    for (const [sock, ids] of waiters) {
      for (const id of ids) send(sock, { id, ok: true, op: "wait-exit", exit });
    }
    waiters.clear();
  };

  const childGone = (): boolean => {
    if (shared) return childStart !== undefined && bootId !== undefined && recordedProcess(proc.pid, childStart, bootId) === "gone";
    const fields = processStatFields(proc.pid);
    return fields === undefined || fields[0] === "Z" || (childStart !== undefined && fields[19] !== childStart);
  };

  /**
   * Mark a child that /proc shows gone as exited WITHOUT a status, but only once node-pty has had
   * time to report the status itself. node-pty reports an exit only when the pty closes, and when a
   * descendant still holds the pty open it forces that close 200 ms after reaping the child. The
   * exit event carries whatever is known when it is sent, so marking earlier sent no status.
   */
  let goneSince: number | undefined;
  const markGone = (): void => {
    if (!alive || !childGone()) return;
    goneSince ??= Date.now();
    if (Date.now() - goneSince >= EXIT_STATUS_GRACE_MS) markExited({});
  };

  const settleTerminal = (expired = false): void => {
    if (alive || settling || !ready) return;
    // Only an AUTHENTICATED peer holds this custodian open. A connected socket that never said
    // hello owns no session, no output subscription and no wait, so it is owed nothing by a settle,
    // and counting it kept a custodian whose child had already exited resident for nothing: one
    // unauthenticated dial (a probe, a half-open connect) pinned ~65 MB for the life of the host.
    // Every authed socket is added to `controllers` by the same `hello` that authenticates it and
    // removed by `drop`, so this is exactly "someone can still be told something".
    if (controllers.size > 0 && !expired) return;
    if (!seenClient) return;
    settling = true;
    confirmGate?.disarm();
    if (killTimer) {
      clearTimeout(killTimer);
      killTimer = undefined;
    }
    if (handoffTimer) {
      clearTimeout(handoffTimer);
      handoffTimer = undefined;
    }
    if (unattendedTimer) {
      clearTimeout(unattendedTimer);
      unattendedTimer = undefined;
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
    if (!gate) try { proc.kill("SIGKILL"); } catch { /* already gone */ }
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
    if (!shared?.bind) unlinkCustodianSocket(launch.socket);
    // The custody record is retained on disk until verified reaping can consume it;
    // reapSeat proves kernel process identities and removes the record directory.
    if (shared) shared.settled();
    else process.exit(0);
  };

  /**
   * Bound the time this custodian runs with NOBODY authenticated to it. A manager that crashed, or a
   * suite that returned without reaping, leaves a live child and a custodian that will otherwise wait
   * forever for a controller that no longer exists (#1648).
   *
   * Armed whenever the controller set is empty and disarmed the moment one authenticates, so an
   * ordinary detach-and-re-adopt never trips it: the window restarts from the last disconnect, not
   * from launch. The child is stopped rather than left behind, because this custodian owns the only
   * reader of its PTY; the settle that follows its exit is the ordinary one.
   */
  const armUnattended = (): void => {
    if (shared || settling || !ready || unattendedTimer || controllers.size > 0) return;
    unattendedTimer = setTimeout(() => {
      unattendedTimer = undefined;
      if (settling || controllers.size > 0) return;
      // An unattended custodian has nobody to tell, so record the reason where an operator reading
      // an empty seat directory can still find it.
      note(`${JSON.stringify({ unattended: true, afterMs: UNATTENDED_MS, childPid: proc.pid, custodianPid: process.pid, run: launch.run })}\n`);
      if (alive) {
        // `seenClient` gates the settle, and a custodian nobody ever adopted must still be able to
        // exit: without this the stop below kills the child and the settle refuses, which is the
        // orphan again with a dead child instead of a live one.
        seenClient = true;
        stopChild("graceful");
        // The settle runs off the child's exit. If the child ignores SIGTERM, `stopChild`'s own
        // SIGKILL escalation takes it within GRACE_MS and `markExited` follows from that.
        return;
      }
      seenClient = true;
      settleTerminal();
    }, UNATTENDED_MS);
    unattendedTimer.unref();
  };

  const disarmUnattended = (): void => {
    if (!unattendedTimer) return;
    clearTimeout(unattendedTimer);
    unattendedTimer = undefined;
  };

  const armUnobservedHandoff = (): void => {
    if (alive || (!shared?.bind && seenClient) || settling || !ready || handoffTimer) return;
    handoffTimer = setTimeout(() => {
      handoffTimer = undefined;
      seenClient = true;
      settleTerminal(shared?.bind !== undefined);
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
    const last = diagnostic.read();
    exit = { ...(info ?? exit ?? {}), ...(last ? { diagnostic: last } : {}) };
    // Kept beside the custody record so a reap that runs after every controller is gone, even in a
    // successor manager, can still say how the child ended. Renamed into place, so a reader never
    // sees half a record.
    const exitFile = exitPath(launch.recordPath);
    try {
      writePrivate(`${exitFile}.tmp`, `${JSON.stringify(exit)}\n`);
      renameSync(`${exitFile}.tmp`, exitFile);
    } catch (e) {
      // A seat directory that is already gone has nobody left to read the record. Any other failure
      // loses the only account a later reap has, so it is said where an operator can find it, and
      // the reap reports the record missing or unreadable.
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        try {
          unlinkSync(`${exitFile}.tmp`);
        } catch {
          /* never created */
        }
        note(`exit record not written: ${(e as Error).message}\n`);
      }
    }
    // The child is gone, so it has made every read it will make. Remove its files before anyone is
    // told of the exit, and drop the removed ones from the record so a later reap does not remove the
    // same names again. One that could not be removed stays listed, so the reap that proves this seat
    // gone tries it again. Losing a controller's connection is not this: only the child's exit is.
    if (record.artifacts && (!gate || gate.commitAttempted)) {
      discardArtifacts(record.artifacts);
      const left = record.artifacts.filter((dir) => existsSync(dir));
      if (left.length) record.artifacts = left;
      else {
        delete record.artifacts;
        delete record.artifactRoot;
      }
      if (ready) {
        try {
          if (shared) shared.record(record);
          else {
            const tmp = `${launch.recordPath}.tmp`;
            writeRecord(tmp, record);
            renameSync(tmp, launch.recordPath);
          }
        } catch (e) {
          note(`${(e as Error).message}\n`);
        }
      }
    }
    confirmGate?.disarm();
    for (const sock of controllers) send(sock, { event: "exit", exit });
    resolveWaiters();
    settleTerminal();
    armUnobservedHandoff();
  };

  proc.onData((d) => {
    writeScreen(d);
    diagnostic.push(d);
    if (early.length < MAX_FRAME_SIZE) {
      early += early.length + d.length > MAX_FRAME_SIZE ? d.slice(0, MAX_FRAME_SIZE - early.length) : d;
    }
    const encoded = Buffer.from(d, "utf8").toString("base64");
    for (const [sub, socks] of dataSubs) {
      for (const sock of socks) send(sock, { event: "output", sub, data: encoded });
    }
    if (confirmGate?.push(d)) proc.write("\r");
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
    markGone();
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

  confirmGate?.arm(diagnostic, {
    report: (message) => {
      const line = `\r\n${message}\r\n`;
      writeScreen(line);
      const encoded = Buffer.from(line, "utf8").toString("base64");
      for (const [sub, socks] of dataSubs) {
        for (const sock of socks) send(sock, { event: "output", sub, data: encoded });
      }
      note(`${message}\n`);
    },
    stop: () => stopChild("graceful"),
  }, {
    read: () => alive ? Array.from({ length: term.rows }, (_, row) => term.buffer.active.getLine(term.buffer.active.baseY + row)?.translateToString(true) ?? "").join("\n") : undefined,
    key: (key) => proc.write(key === "Down" ? "\x1b[B" : "\r"),
  });

  const record: SeatRecord = {
    version: RECORD_VERSION,
    id: launch.id,
    name: launch.name,
    socket: launch.socket,
    token: launch.token,
    custodianPid: process.pid,
    childPid: proc.pid,
    custodianStart,
    ...(childStart === undefined ? {} : { childStart }),
    // Bind the pids to THIS boot: their start tokens are ticks since boot and the record outlives a
    // reboot on disk, so without this a survivor could match an innocent process on the next boot.
    ...(bootId === undefined ? {} : { bootId }),
    ...(launch.artifacts?.length ? { artifacts: launch.artifacts, artifactRoot: launch.artifactRoot } : {}),
  };

  const accept = (sock: CustodianChannel): CustodianSession => {
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
      // A settle exits the process, so reaching here means this custodian is staying up. If that was
      // the last controller, it is now unattended and the bound starts from this disconnect.
      armUnattended();
    };
    return { close: drop, receive(raw) {
      void handle(sock, raw, { authed: () => authed, setAuthed: v => { authed = v; }, owned }).catch((err: unknown) => {
        const id = raw && typeof raw === "object" && typeof raw.id === "number" ? raw.id : 0;
        send(sock, { id, ok: false, error: (err as Error).message });
      });
    } };
  };

  async function handle(
    sock: CustodianChannel,
    raw: unknown,
    session: { authed: () => boolean; setAuthed: (v: boolean) => void; owned: Set<number> },
  ): Promise<void> {
    const req = raw as ClientRequest;
    if (typeof req !== "object" || req === null || typeof req.id !== "number" || typeof req.op !== "string") {
      send(sock, { id: 0, ok: false, error: "malformed request" });
      return;
    }
    try {
      sock.authorize();
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
        // Join the controller set BEFORE anything below can settle. `markExited` runs the settle,
        // and a settle with no controller tears this socket down mid-`hello`, so the peer that just
        // authenticated would see "custodian socket closed" instead of its reply.
        controllers.add(sock);
        disarmUnattended();
        if (handoffTimer && !shared?.bind) {
          clearTimeout(handoffTimer);
          handoffTimer = undefined;
        }
        markGone();
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
        if (!alive) send(sock, { event: "exit", ...(exit ? { exit } : {}) });
        return;
      }
      case "snapshot": {
        const data = await snapshot();
        send(sock, { id: req.id, ok: true, op: "snapshot", data, cols, rows });
        return;
      }
      case "subscribe-output": {
        const sub = nextSub++;
        const socks = dataSubs.get(sub) ?? new Set<CustodianChannel>();
        socks.add(sock);
        dataSubs.set(sub, socks);
        session.owned.add(sub);
        send(sock, { id: req.id, ok: true, op: "subscribe-output", sub });
        if (early) send(sock, { event: "output", sub, data: Buffer.from(early, "utf8").toString("base64") });
        if (!alive) send(sock, { event: "exit", sub, ...(exit ? { exit } : {}) });
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
          if (screen) screen.resize(req.cols, req.rows); else term.resize(req.cols, req.rows);
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
        markGone();
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
        markGone();
        send(sock, {
          id: req.id,
          ok: true,
          op: "health",
          pid: proc.pid,
          status: alive ? "running" : "exited",
          protocol: PROTOCOL_VERSION,
          ...(shared && confirmGate ? { startup: confirmGate.outcome } : {}),
        });
        return;
      }
      default: {
        const id = typeof (raw as { id?: unknown }).id === "number" ? (raw as { id: number }).id : 0;
        send(sock, { id, ok: false, error: "unknown op" });
      }
    }
  }

  try {
    if (gate) {
      const placed = await gate.ready;
      if (placed.pid !== record.childPid || placed.start !== childStart || placed.boot !== bootId) throw new Error("shared PTY placement could not be proved");
    }
    if (shared?.bind) shared.bind(accept);
    else {
      server = createServer(sock => attachCustodianSocket(sock, accept));
      await listenCustodianSocket(server, shared?.listenPath ?? launch.socket, launch.socket);
    }
    if (gate) await gate.commit(() => shared!.record(record));
    else if (shared) shared.record(record);
    else writeRecord(launch.recordPath, record);
    ready = true;
    const announced = `${JSON.stringify({ ready: true, childPid: proc.pid, custodianPid: process.pid })}\n`;
    if (launch.logPath) note(announced);
    else if (!shared) process.stdout.write(announced);
    armUnobservedHandoff();
    armUnattended();
    settleTerminal();
  } catch (e) {
    gate?.abort();
    if (gate?.commitAttempted) { ready = true; settleTerminal(); throw e; }
    confirmGate?.disarm();
    clearInterval(reap);
    if (server?.listening) server.close();
    for (const client of clients) client.destroy();
    try { if (alive && !gate) proc.kill("SIGKILL"); } catch { /* the child ended */ }
    if (shared) { ready = true; seenClient = true; settleTerminal(); }
    throw e;
  }
}

function unlinkCustodianSocket(path: string): void {
  try { unlinkSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

function attachCustodianSocket(socket: Socket, accept: (channel: CustodianChannel) => CustodianSession): void {
  const reader = new FrameReader();
  const session = accept({
    get writable() { return socket.writable; }, get writableLength() { return socket.writableLength; },
    send: message => { socket.write(encodeFrame(message)); }, destroy: () => socket.destroy(),
    authorize() { if (peerCredentials(socket).uid !== process.getuid?.()) throw new Error("peer uid mismatch"); },
  });
  socket.on("data", chunk => {
    try { for (const raw of reader.push(chunk)) session.receive(raw as ClientRequest); }
    catch { socket.destroy(); }
  });
  socket.once("close", session.close);
  socket.on("error", () => {});
}

async function listenCustodianSocket(server: ReturnType<typeof createServer>, listenPath: string, diskPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(listenPath, () => {
      try {
        const bound = server.address();
        if (typeof bound === "string" && bound !== listenPath)
          throw new Error(`custodian bound ${bound} but was asked for ${listenPath}; the path was truncated, so it would clean up a socket it never created`);
        chmodSync(diskPath, 0o600);
        resolve();
      } catch (error) { reject(error); }
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
      if (launch.logPath) appendPrivate(launch.logPath, text);
      else process.stderr.write(text);
    } catch {
      process.stderr.write(text);
    }
    process.exit(1);
  });
}
