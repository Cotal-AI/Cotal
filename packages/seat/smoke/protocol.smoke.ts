/**
 * Length-prefixed protocol and connect-auth cells. Isolated. No fleet.
 */
import { createServer, connect } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FrameReader, encodeFrame } from "../src/protocol.js";
import { peerCredentials } from "../src/peercred.js";

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
  console.log(`\nSEAT PROTOCOL ${fail === 0 ? "OK" : "FAILED"} (${pass} passed, ${fail} failed)`);
  process.exitCode = fail === 0 ? 0 : 1;
}
