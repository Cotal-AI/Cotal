import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (process.platform !== "linux") {
  console.log("LEGACY PTY CUSTODY skipped (M1 residual is /proc state after SIGKILL; Windows unit tests are not that oracle)");
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
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (predicate: () => boolean, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await wait(25);
  return predicate();
};
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

const root = mkdtempSync(join(tmpdir(), "cotal-legacy-pty-custody-"));
const owner = join(root, "owner.mjs");
const ready = join(root, "ready.json");
const pidfile = join(root, "counter.pid");
const managerRoot = join(import.meta.dirname, "..");
const repo = join(managerRoot, "..", "..");
const childProgram = "const fs=require('node:fs');fs.writeFileSync(process.env.PIDFILE,String(process.pid));let n=0;setInterval(()=>process.stdout.write(String(++n)+'\\n'),50)";
writeFileSync(
  owner,
  `import { PtyRuntime } from ${JSON.stringify(join(managerRoot, "dist", "runtime", "pty.js"))};\n` +
    `import { writeFileSync } from "node:fs";\n` +
    `const handle = new PtyRuntime().spawn("counter", { command: process.execPath, args: ["-e", ${JSON.stringify(childProgram)}], env: { PATH: process.env.PATH ?? "", PIDFILE: process.env.PIDFILE ?? "" } }, ${JSON.stringify(repo)});\n` +
    `writeFileSync(process.env.READY ?? "", JSON.stringify({ managerPid: process.pid, childPid: handle.pid, hasReference: handle.reference !== undefined }));\n` +
    `setInterval(() => {}, 1_000);\n`,
);

let ownerProcess: ChildProcess | undefined;
try {
  ownerProcess = spawn(process.execPath, [owner], {
    env: { PATH: process.env.PATH ?? "", READY: ready, PIDFILE: pidfile },
    stdio: "ignore",
  });
  const armed = await until(() => {
    try {
      return JSON.parse(readFileSync(ready, "utf8")).childPid !== undefined;
    } catch {
      return false;
    }
  }, 10_000);
  check("isolated manager fixture armed", armed);
  if (!armed) throw new Error("fixture did not write its ownership record");
  const ids = JSON.parse(readFileSync(ready, "utf8")) as { managerPid: number; childPid: number; hasReference: boolean };
  check("counter child is live before manager death", state(ids.childPid) !== "gone" && state(ids.childPid) !== "Z", { childPid: ids.childPid, state: state(ids.childPid) });
  check("legacy PTY exposes no durable reference a successor can adopt", ids.hasReference === false, ids);
  process.kill(ids.managerPid, "SIGKILL");
  check("the fixture killed its actual manager process", await until(() => state(ids.managerPid) === "gone", 5_000), { managerPid: ids.managerPid, state: state(ids.managerPid) });
  check("M1 red: legacy manager death ends the manager-owned counter PTY", await until(() => state(ids.childPid) === "gone" || state(ids.childPid) === "Z", 5_000), { childPid: ids.childPid, state: state(ids.childPid) });
} finally {
  try {
    const ids = JSON.parse(readFileSync(ready, "utf8")) as { childPid: number };
    if (state(ids.childPid) !== "gone") process.kill(ids.childPid, "SIGKILL");
  } catch {
    // The fixture did not arm, so it owns no child PID to clean up.
  }
  if (ownerProcess?.exitCode === null) ownerProcess.kill("SIGKILL");
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nLEGACY PTY CUSTODY ${fail === 0 ? "OK" : "FAILED"} (${pass} passed, ${fail} failed)`);
process.exitCode = fail === 0 ? 0 : 1;
