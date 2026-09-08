/**
 * Length-prefixed protocol and connect-auth cells. Isolated. No fleet.
 */
import { createServer, connect, type Socket } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FrameReader, MAX_FRAME_SIZE, encodeFrame } from "../src/protocol.js";
import { peerCredentials } from "../src/peercred.js";
import { launchSeat } from "../src/index.js";

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
  const dir = mkdtempSync(join(tmpdir(), "cotal-seat-proto-"));
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

  const root = mkdtempSync(join(tmpdir(), "cotal-seat-frame-"));
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
