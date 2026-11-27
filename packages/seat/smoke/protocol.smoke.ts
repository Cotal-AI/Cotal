/**
 * Length-prefixed protocol and connect-auth cells. Isolated. No fleet.
 */
import { createServer, connect, type Socket } from "node:net";
import { once } from "node:events";
import { chmodSync, lstatSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { FrameReader, MAX_FRAME_SIZE, encodeFrame } from "../src/protocol.js";
import { peerCredentials } from "../src/peercred.js";
import { launchSeat } from "../src/index.js";
import { makeSeatRoot } from "@cotal-ai/smoke-kit";
import { bootToken, capabilityToken, processStartToken, seatId } from "../src/record.js";
import { SHARED_CONTROL_PROTOCOL, type SharedControlReply, type SharedControlRequest } from "../src/shared-control-protocol.js";
import { hostControl } from "../src/shared-control-server.js";
import { publishControllerClaim, readControllerClaim, sharedGenerationAcceptsLaunch } from "../src/shared-controller-claim.js";
import { sharedHostSocket, sharedSeatRecord, type SharedHostRecord } from "../src/shared-record.js";

let pass = 0;
let fail = 0;
const check = (name: string, condition: boolean, detail?: unknown): void => {
  if (condition) {
    pass++;
    console.log(`  ✓ ${name}`);
    return;
  }
  fail++;
  console.log(`  ✗ FAIL: ${name}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`);
};

/** One outstanding request per fixture client. Undefined means the peer closed before its reply. */
function controlRequest(sock: Socket, request: SharedControlRequest): Promise<SharedControlReply | undefined> {
  return new Promise((resolve, reject) => {
    const reader = new FrameReader();
    const remove = () => {
      clearTimeout(timer);
      sock.off("data", data).off("close", close).off("error", error);
    };
    const close = () => { remove(); resolve(undefined); };
    const error = (cause: Error) => { remove(); reject(cause); };
    const data = (chunk: Buffer) => {
      try {
        for (const value of reader.push(chunk)) {
          const reply = value as SharedControlReply;
          if (reply.id === request.id) { remove(); resolve(reply); return; }
        }
      } catch (cause) { error(cause as Error); }
    };
    const timer = setTimeout(() => error(new Error("shared control fixture reply timed out")), 2_000);
    sock.on("data", data).once("close", close).once("error", error);
    sock.write(encodeFrame(request));
  });
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function sharedControlCell(): Promise<void> {
  const start = processStartToken(process.pid), bootId = bootToken();
  if (!start || !bootId) throw new Error("shared control fixture requires Linux process identity");
  const root = makeSeatRoot("cotal-seat-v2-"), path = sharedHostSocket(root);
  const generation = "a".repeat(64), next = "b".repeat(64);
  const held = seatId(), neverDispatched = seatId(), uncertain = seatId(), accepts: string[] = [];
  const reservation = (id: string) => dirname(sharedSeatRecord(root, id));
  const rendezvous = deferred<void>(), release = deferred<void>(), finished = deferred<boolean>();
  const host: SharedHostRecord = { version: 2, protocol: SHARED_CONTROL_PROTOCOL, pid: process.pid, start, bootId,
    scope: `cotal-pty-${seatId()}.service`, token: capabilityToken() };
  const handle = hostControl({
    host, authorized: () => readControllerClaim(root), acceptSeat: () => undefined, closing: () => false,
    launchState: id => lstatSync(reservation(id), { throwIfNoEntry: false }) ? "unknown" : "absent",
    async launch(id, _payload, authorize) {
      if (!sharedGenerationAcceptsLaunch(readControllerClaim(root), generation)) return "not-admitted";
      mkdirSync(reservation(id), { mode: 0o700 });
      if (id === uncertain) return "unknown";
      if (id === held) { rendezvous.resolve(); await release.promise; }
      try { authorize(); } catch {
        if (id === held) finished.resolve(false);
        return "not-admitted";
      }
      accepts.push(id);
      if (id === held) finished.resolve(true);
      return "admitted";
    },
  });
  const connections = new Set<Socket>(), clients = new Set<Socket>();
  let firstPeer: Socket | undefined;
  const server = createServer(sock => {
    firstPeer ??= sock;
    connections.add(sock);
    sock.once("close", () => connections.delete(sock));
    handle(sock);
  });
  const dial = async () => {
    const sock = connect(path);
    clients.add(sock);
    sock.on("error", () => {}); // Errors are asserted by the dial/request that owns the socket.
    await once(sock, "connect", { signal: AbortSignal.timeout(2_000) });
    return sock;
  };
  const hello: SharedControlRequest = { id: 1, op: "hello", protocol: host.protocol, token: host.token };
  const launch = (id: number, seat: string): SharedControlRequest => ({ id, op: "launch", seat,
    launch: { name: "fixture", cwd: root, artifactRoot: root, spec: { command: "/bin/false", args: [] } } });
  try {
    if (!publishControllerClaim(root, generation)) throw new Error("could not publish fixture controller claim");
    server.listen(path);
    await once(server, "listening", { signal: AbortSignal.timeout(2_000) });
    chmodSync(path, 0o600);
    const owner = await dial();
    const first = await controlRequest(owner, hello);
    check("v2 authenticates the exact live controller", first?.ok === true && first.op === "hello" && first.pid === host.pid && first.start === start);
    const contender = await dial();
    const busy = await controlRequest(contender, hello);
    check("v2 refuses a second authenticated writer even from the same PID", busy?.ok === false && busy.outcome === "not-admitted");

    const pending = controlRequest(owner, launch(2, held));
    const entered = await Promise.race([rendezvous.promise.then(() => true), pending.then(() => false)]);
    if (!entered || !firstPeer) throw new Error("fixture launch did not reach its pre-commit barrier");
    const peerClosed = once(firstPeer, "close", { signal: AbortSignal.timeout(2_000) });
    owner.destroy();
    await peerClosed;
    check("v2 disconnect after submission carries no definite launch reply", await pending === undefined);
    const successor = await controlRequest(contender, { ...hello, id: 2 });
    check("v2 writer handover succeeds after the previous socket closes", successor?.ok === true && successor.op === "hello");
    const heldState = await controlRequest(contender, { id: 3, op: "launch-state", seat: held });
    check("v2 replacement sees the still-reserved launch as unknown", heldState?.ok === true && heldState.op === "launch-state" && heldState.state === "unknown");
    const absentState = await controlRequest(contender, { id: 4, op: "launch-state", seat: neverDispatched });
    check("v2 replacement sees a never-dispatched launch as absent without reserving it", absentState?.ok === true && absentState.op === "launch-state" &&
      absentState.state === "absent" && !lstatSync(reservation(neverDispatched), { throwIfNoEntry: false }));
    release.resolve();
    check("v2 cannot commit a delayed launch from the closed epoch", !(await finished.promise) && !accepts.includes(held));

    const ambiguous = await controlRequest(contender, launch(5, uncertain));
    check("v2 preserves an explicit unknown launch outcome", ambiguous?.ok === false && ambiguous.outcome === "unknown");
    const admitted = seatId();
    const current = await controlRequest(contender, launch(6, admitted));
    check("v2 permits a new launch while the host generation is current", current?.ok === true && current.op === "launch" && accepts.includes(admitted));
    if (!publishControllerClaim(root, next)) throw new Error("could not advance fixture controller generation");
    const stale = seatId();
    const refused = await controlRequest(contender, launch(7, stale));
    check("v2 reports definite non-admission for an old-generation launch", refused?.ok === false && refused.outcome === "not-admitted" && !accepts.includes(stale));
  } finally {
    release.resolve();
    const socketCloses = [...clients].filter(sock => !sock.closed).map(sock => once(sock, "close"));
    for (const sock of [...clients, ...connections]) sock.destroy();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    await Promise.all(socketCloses);
    rmSync(root, { recursive: true, force: true });
  }
}

{
  const reader = new FrameReader();
  const msg = { id: 1, op: "hello", token: "abc" };
  const frames = reader.push(encodeFrame(msg));
  check("one length-prefixed JSON frame round-trips", frames.length === 1 && JSON.stringify(frames[0]) === JSON.stringify(msg));
  const a = encodeFrame({ n: 1 });
  const b = encodeFrame({ n: 2 });
  const split = Buffer.concat([a, b.subarray(0, 3)]);
  const first = reader.push(split);
  check("partial second frame stays buffered", first.length === 1 && (first[0] as { n: number }).n === 1);
  const rest = reader.push(b.subarray(3));
  check("remainder completes the second frame", rest.length === 1 && (rest[0] as { n: number }).n === 2);
}

{
  const reader = new FrameReader();
  const header = Buffer.alloc(4);
  header.writeUInt32BE(500 * 1024 * 1024, 0);
  let err = "";
  try {
    reader.push(Buffer.concat([header, Buffer.alloc(64)]));
  } catch (e) {
    err = (e as Error).message;
  }
  check(
    "a claimed 500MB frame is refused before the body arrives",
    err === `frame length ${500 * 1024 * 1024} exceeds ${MAX_FRAME_SIZE} bytes`,
    err,
  );
}

{
  const reader = new FrameReader();
  const header = Buffer.alloc(4);
  header.writeUInt32BE(MAX_FRAME_SIZE, 0);
  let err = "";
  let held: unknown[] = [];
  try {
    held = reader.push(Buffer.concat([header, Buffer.alloc(64)]));
  } catch (e) {
    err = (e as Error).message;
  }
  check(
    "an incomplete valid-size frame is held rather than refused",
    err === "" && held.length === 0,
    { err, count: held.length },
  );
}

{
  const reader = new FrameReader();
  const body = Buffer.from("{not json", "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  let err = "";
  try {
    reader.push(Buffer.concat([header, body]));
  } catch (e) {
    err = (e as Error).name;
  }
  check("malformed JSON in a valid-length frame still throws", err === "SyntaxError", err);
}

{
  const reader = new FrameReader();
  const maxBody = "x".repeat(MAX_FRAME_SIZE - 2);
  const maxFrame = encodeFrame(maxBody);
  const small = encodeFrame({ n: 2 });
  let decoded: unknown[] = [];
  let err = "";
  try {
    decoded = reader.push(Buffer.concat([maxFrame, small]));
  } catch (e) {
    err = (e as Error).message;
  }
  check(
    "a max-size frame plus a small frame in one chunk both decode",
    err === "" && decoded.length === 2 && decoded[0] === maxBody && (decoded[1] as { n: number }).n === 2,
    { err, count: decoded.length, maxWire: maxFrame.length, smallWire: small.length },
  );
}

{
  const snapshotJson = 1_365_109;
  let err = "";
  let wire = 0;
  try {
    wire = encodeFrame("s".repeat(snapshotJson - 2)).length;
  } catch (e) {
    err = (e as Error).message;
  }
  check(
    "a 16-color 1000-row snapshot JSON body (1_365_109) still encodes",
    err === "" && wire === snapshotJson + 4,
    { err, wire },
  );
}

{
  const snapshotJson = 4_876_998;
  let err = "";
  let wire = 0;
  try {
    wire = encodeFrame("s".repeat(snapshotJson - 2)).length;
  } catch (e) {
    err = (e as Error).message;
  }
  check(
    "a truecolor 1000-row snapshot JSON body (4_876_998) still encodes",
    err === "" && wire === snapshotJson + 4,
    { err, wire },
  );
}

if (process.platform !== "linux") {
  console.log("SEAT PROTOCOL COMPLETE off linux after frame cells");
  console.log(`\nSEAT PROTOCOL ${fail === 0 ? "OK" : "FAILED"} (${pass} passed, ${fail} failed)`);
  process.exitCode = fail === 0 ? 0 : 1;
} else {
  const dir = makeSeatRoot("cotal-seat-proto-");
  const sockPath = join(dir, "s.sock");
  const server = createServer((c) => {
    try {
      const cred = peerCredentials(c);
      check("SO_PEERCRED uid matches this process", cred.uid === process.getuid?.(), cred);
      check("SO_PEERCRED pid is a live process", cred.pid > 0, cred);
    } catch (e) {
      check("SO_PEERCRED uid matches this process", false, (e as Error).message);
    }
    c.end();
  });
  await new Promise<void>((resolve) => server.listen(sockPath, resolve));
  await new Promise<void>((resolve, reject) => {
    const c = connect(sockPath);
    c.on("connect", () => c.end());
    c.on("close", () => resolve());
    c.on("error", reject);
  });
  server.close();
  rmSync(dir, { recursive: true, force: true });
  try { await sharedControlCell(); }
  catch (error) { check("v2 shared control fixture completed", false, (error as Error).message); }

  const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  const state = (pid: number): string => {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[0] ?? "unknown";
    } catch {
      try {
        process.kill(pid, 0);
        return "live";
      } catch {
        return "gone";
      }
    }
  };
  const connectRaw = (path: string): Promise<Socket> =>
    new Promise((resolve, reject) => {
      const sock = connect(path);
      sock.once("connect", () => resolve(sock));
      sock.once("error", reject);
    });
  const closed = (sock: Socket): Promise<void> =>
    new Promise((resolve) => {
      if (sock.destroyed) {
        resolve();
        return;
      }
      sock.once("close", () => resolve());
    });

  const root = makeSeatRoot("cotal-seat-frame-");
  const seats: Array<{ rec: ReturnType<typeof launchSeat> }> = [];
  try {
    const attack = launchSeat({
      root,
      name: "attack",
      spec: { command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], env: { PATH: process.env.PATH ?? "" } },
      cwd: process.cwd(),
    });
    seats.push({ rec: attack });
    const attacker = await connectRaw(attack.socket);
    const claimed = Buffer.alloc(4);
    claimed.writeUInt32BE(500 * 1024 * 1024, 0);
    attacker.write(claimed);
    attacker.write(Buffer.alloc(64 * 1024));
    await Promise.race([closed(attacker), wait(2_000)]);
    check("oversized pre-auth frame destroys the socket", attacker.destroyed);
    check(
      "oversized pre-auth frame leaves the custodian alive",
      state(attack.custodianPid) !== "gone" && state(attack.custodianPid) !== "Z",
      { custodian: state(attack.custodianPid), child: state(attack.childPid) },
    );

    const secret = `SEAT_ARGV_MARK_${Date.now()}_${process.pid}`;
    const secretSeat = launchSeat({
      root,
      name: "argv-secret",
      spec: {
        command: process.execPath,
        args: ["-e", "setInterval(()=>{},1000)"],
        env: { PATH: process.env.PATH ?? "", SEAT_ARGV_SECRET: secret },
      },
      cwd: process.cwd(),
    });
    seats.push({ rec: secretSeat });
    const cmdline = readFileSync(`/proc/${secretSeat.custodianPid}/cmdline`, "utf8");
    check(
      "launch payload is not on the custodian cmdline",
      !cmdline.includes(secretSeat.token) && !cmdline.includes(secret),
      { tokenInArgv: cmdline.includes(secretSeat.token), secretInArgv: cmdline.includes(secret) },
    );

    const jsonSeat = launchSeat({
      root,
      name: "badjson",
      spec: { command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], env: { PATH: process.env.PATH ?? "" } },
      cwd: process.cwd(),
    });
    seats.push({ rec: jsonSeat });
    const bad = await connectRaw(jsonSeat.socket);
    const body = Buffer.from("{not json", "utf8");
    const header = Buffer.alloc(4);
    header.writeUInt32BE(body.length, 0);
    bad.write(Buffer.concat([header, body]));
    await Promise.race([closed(bad), wait(2_000)]);
    check("malformed JSON in a valid-length frame destroys the socket", bad.destroyed);
    check(
      "malformed JSON leaves the custodian alive",
      state(jsonSeat.custodianPid) !== "gone" && state(jsonSeat.custodianPid) !== "Z",
      { custodian: state(jsonSeat.custodianPid) },
    );
  } finally {
    for (const { rec } of seats) {
      try {
        process.kill(rec.custodianPid, "SIGKILL");
      } catch {
        /* gone */
      }
      try {
        process.kill(rec.childPid, "SIGKILL");
      } catch {
        /* gone */
      }
    }
    rmSync(root, { recursive: true, force: true });
  }

  console.log(`\nSEAT PROTOCOL ${fail === 0 ? "OK" : "FAILED"} (${pass} passed, ${fail} failed)`);
  process.exitCode = fail === 0 ? 0 : 1;
}
