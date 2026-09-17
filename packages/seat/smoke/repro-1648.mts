/**
 * Reproduce #1648: a custodian whose child has exited stays resident while an UNAUTHENTICATED
 * socket is connected, holding ~65 MB for nothing. Stray dials accumulate one survivor each.
 *
 *   node --import tsx packages/seat/smoke/repro-1648.mts
 *
 * Exit status IS the verdict, so this fails a CI job when the defect is live:
 *   2 = DEFECT PRESENT (the custodian never settled)
 *   0 = defect absent
 *   1 = inconclusive (the scenario never armed; no claim either way)
 *
 * The suite's own status cannot carry this signal: every seat smoke stayed green throughout the
 * life of the bug, which is why it went unnoticed until the host ran out of memory.
 *
 * Run it from the repo root. Paths resolve from this file, not from the caller's cwd.
 */
import { connect } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchSeat } from "../src/index.js";

if (process.platform !== "linux") {
  console.log(`INCONCLUSIVE: custody transport is Linux-only; nothing to reproduce on ${process.platform}`);
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const root = mkdtempSync(join(tmpdir(), "repro-1648-"));
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const state = (pid: number): string => {
  try {
    const s = readFileSync(`/proc/${pid}/stat`, "utf8");
    return s.slice(s.lastIndexOf(") ") + 2).split(" ")[0] ?? "?";
  } catch {
    return "gone";
  }
};
const gone = (pid: number): boolean => state(pid) === "gone" || state(pid) === "Z";
const until = async (p: () => boolean, ms: number): Promise<boolean> => {
  const deadline = Date.now() + ms;
  while (!p() && Date.now() < deadline) await wait(100);
  return p();
};
const frame = (v: unknown): Buffer => {
  const b = Buffer.from(JSON.stringify(v));
  const h = Buffer.allocUnsafe(4);
  h.writeUInt32BE(b.length, 0);
  return Buffer.concat([h, b]);
};

let verdict = 1;
const rec = launchSeat({
  root,
  name: "repro-1648",
  spec: { command: process.execPath, args: ["-e", "setTimeout(()=>process.exit(0), 2000)"], env: { PATH: process.env.PATH ?? "" } },
  cwd: here,
});
try {
  // An adopter authenticates and leaves, so the seat is past its launch handoff and this exercises
  // the ordinary post-adoption settle rather than the unobserved-launch path.
  const adopter = connect(rec.socket);
  adopter.on("error", () => {});
  await new Promise<void>((r) => adopter.once("connect", () => r()));
  adopter.write(frame({ id: 1, op: "hello", token: rec.token }));
  await wait(400);
  adopter.destroy();

  // The peer under test: connected, never authenticated. It holds no session, no output
  // subscription and no wait, so a settle owes it nothing.
  const mute = connect(rec.socket);
  mute.on("error", () => {});
  await new Promise<void>((r) => mute.once("connect", () => r()));

  if (!(await until(() => gone(rec.childPid), 15_000))) {
    console.log("INCONCLUSIVE: the child never exited, so the settle path was never reached");
  } else {
    const settled = await until(() => gone(rec.custodianPid), 30_000);
    console.log(`custodian settled within 30s of its child exiting: ${settled}`);
    mute.destroy();
    const afterDrop = await until(() => gone(rec.custodianPid), 10_000);
    console.log(`control: once the unauthenticated socket drops, it settles: ${afterDrop}`);
    if (settled) {
      console.log("OK: an unauthenticated peer does not keep a custodian alive");
      verdict = 0;
    } else if (afterDrop) {
      // The control proves the custodian was healthy and waiting on that socket alone.
      console.log("DEFECT PRESENT (#1648): an unauthenticated peer kept a custodian resident after its child exited");
      verdict = 2;
    } else {
      console.log("INCONCLUSIVE: the custodian did not settle even after the socket dropped");
    }
  }
} finally {
  try { process.kill(rec.childPid, "SIGKILL"); } catch { /* already gone */ }
  try { process.kill(rec.custodianPid, "SIGKILL"); } catch { /* already gone */ }
  rmSync(root, { recursive: true, force: true });
}
process.exit(verdict);
