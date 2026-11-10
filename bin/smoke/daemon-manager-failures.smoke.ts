/** Corrupt hosted Manager state must refuse a local request without killing its daemon. */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spaceSegment } from "@cotal-ai/workspace";
import { daemonPaths } from "../daemon/endpoint.js";
import { killAndAwaitExit, skipSuite } from "@cotal-ai/smoke-kit";

if (process.platform !== "linux") skipSuite("daemon-manager-failures: Linux only");
const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const root = mkdtempSync(join(tmpdir(), "dmf-"));
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
let pass = 0, fail = 0;
const check = (label: string, ok: boolean, details?: unknown) => {
  if (ok) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}`, details ?? ""); }
};
async function request(socket: string, op: string): Promise<Record<string, any> | undefined> {
  return new Promise((resolve) => {
    const client = connect(socket);
    let text = "";
    const timer = setTimeout(() => { client.destroy(); resolve(undefined); }, 1500);
    const finish = (value?: Record<string, any>) => { clearTimeout(timer); client.destroy(); resolve(value); };
    client.on("connect", () => client.write(`${JSON.stringify({ v: 1, id: "probe", op, ...(op.startsWith("manager-") ? { space: "corrupt" } : {}) })}\n`));
    client.on("error", () => finish());
    client.on("end", () => finish());
    client.on("data", (data) => { text += String(data); if (text.includes("\n")) { try { finish(JSON.parse(text.split("\n")[0]!)); } catch { finish(); } } });
  });
}
try {
  let index = 0;
  for (const name of ["manager-host.json", "manager-refusal.json"]) {
    for (const op of ["status", "manager-status", "manager-start", "managers-stop"]) {
      // A corrupt host intent is consumed by global enumeration, not per-space status.
      if (name === "manager-host.json" && op.startsWith("manager-")) continue;
      const dir = join(root, String(index++));
      const home = join(dir, "home"), runtime = join(dir, "rt");
      mkdirSync(home, { recursive: true, mode: 0o700 }); mkdirSync(runtime, { mode: 0o700 });
      const env = { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(dir, "config"), XDG_RUNTIME_DIR: runtime, TMPDIR: root, COTAL_HOME: home, COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_TELEMETRY: "off", DO_NOT_TRACK: "1" };
      const paths = daemonPaths(env, home);
      const child: ChildProcess = spawn(process.execPath, [join(repo, "bin/dist/cotal.js"), "daemon", "serve"], { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
      child.stdout!.resume();
      let stderr = "";
      child.stderr!.on("data", (chunk) => { stderr += String(chunk); });
      try {
        let ready = false;
        for (let i = 0; i < 50; i++) { if ((await request(paths.socket, "status"))?.ok) { ready = true; break; } await sleep(50); }
        if (!ready) throw new Error("owned daemon never became ready");
        const state = join(home, "daemon", spaceSegment("corrupt"));
        mkdirSync(state, { recursive: true, mode: 0o700 });
        if (name === "manager-refusal.json" && (op === "status" || op === "manager-status")) {
          writeFileSync(join(state, name), JSON.stringify({ space: "corrupt", state: "refused", restarts: 0, pid: 12345, reason: "historical fixture refusal" }), { mode: 0o600 });
          const saved = await request(paths.socket, op);
          const row = op === "status" ? saved?.result?.managers?.find((item: { space: string }) => item.space === "corrupt") : saved?.result;
          check(`${name} ${op} never emits a historical PID without a retained child`, saved?.ok === true && row?.state === "refused" && row.pid === undefined, row);
        }
        writeFileSync(join(state, name), "not-json", { mode: 0o600 });
        const frame = await request(paths.socket, op);
        const manager = op === "status" ? frame?.result?.managers?.find((row: { space: string }) => row.space === "corrupt") : frame?.result;
        check(`${name} ${op} isolates the corrupt space without failing the daemon request`, frame?.ok === true && (op === "managers-stop" || manager?.state === "refused"), { frame, exit: child.exitCode, stderr: stderr.slice(-500) });
        if (op === "status" || op === "manager-status") check(`${name} ${op} names the invalid file`, manager?.reason?.includes(join(state, name)) === true, manager);
        rmSync(join(state, name), { force: true });
        const healthy = await request(paths.socket, "status");
        check(`${name} ${op} leaves the same daemon alive`, healthy?.ok === true && healthy.result?.pid === child.pid, { healthy, exit: child.exitCode });
      } finally { await killAndAwaitExit(child, "SIGTERM"); }
    }
  }
} finally { rmSync(root, { recursive: true, force: true }); }
console.log(`daemon-manager-failures: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
