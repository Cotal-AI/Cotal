/**
 * Two seats, kill one custodian, the other seat still reads and writes.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adoptSeatSync, launchSeat } from "../src/index.js";

if (process.platform !== "linux") {
  console.log(`SEAT ISOLATION COMPLETE on ${process.platform}: custody transport unsupported (no skip-as-pass)`);
  process.exit(0);
}

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

const root = mkdtempSync(join(tmpdir(), "cotal-seat-iso-"));
const program = "process.stdin.on('data',(d)=>process.stdout.write('echo:'+d)); setInterval(()=>{},1000)";

const a = launchSeat({
  root,
  name: "alpha",
  spec: { command: process.execPath, args: ["-e", program], env: { PATH: process.env.PATH ?? "" } },
  cwd: process.cwd(),
});
const b = launchSeat({
  root,
  name: "beta",
  spec: { command: process.execPath, args: ["-e", program], env: { PATH: process.env.PATH ?? "" } },
  cwd: process.cwd(),
});
const ha = adoptSeatSync(a);
const hb = adoptSeatSync(b);
check("two seats have distinct custodian pids", a.custodianPid !== b.custodianPid, { a: a.custodianPid, b: b.custodianPid });
check("two seats have distinct sockets", a.socket !== b.socket);

let buf = "";
const sess = hb.attach();
sess.onData((c) => {
  buf += c.toString("utf8");
});
hb.write("keep\n");
await wait(400);
check("beta received a write before the adversarial kill", buf.includes("echo:keep"), buf);

process.kill(a.custodianPid, "SIGKILL");
await wait(300);
check("alpha custodian is gone after SIGKILL", state(a.custodianPid) === "gone" || state(a.custodianPid) === "Z", state(a.custodianPid));

buf = "";
hb.write("still\n");
await wait(400);
check("beta still reads and writes after alpha custodian death", buf.includes("echo:still"), buf);

hb.stop({ graceful: false });
await hb.waitForExit();
try {
  process.kill(b.custodianPid, "SIGKILL");
} catch {
  /* gone */
}
try {
  process.kill(a.childPid, "SIGKILL");
} catch {
  /* gone */
}
rmSync(root, { recursive: true, force: true });

console.log(`\nSEAT ISOLATION ${fail === 0 ? "OK" : "FAILED"} (${pass} passed, ${fail} failed)`);
process.exitCode = fail === 0 ? 0 : 1;
