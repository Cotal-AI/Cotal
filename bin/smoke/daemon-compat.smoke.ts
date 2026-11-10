/** Old daemon operations must fail usefully without preventing native-service uninstall. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer as httpServer } from "node:http";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CommandFailure } from "@cotal-ai/workspace";
import { killAndAwaitExit, skipSuite } from "@cotal-ai/smoke-kit";
import { managerViaDaemon } from "../daemon/client.js";
import { daemonPaths, daemonPathsFor } from "../daemon/endpoint.js";
import { holdLifetime } from "../daemon/lifetime.js";
import { createHostedManagers, daemonManagerIntentFile } from "../daemon/manager.js";

if (process.platform !== "linux") skipSuite("daemon-compat: Linux only");
const self = fileURLToPath(import.meta.url);
const repo = join(dirname(self), "..", "..");

// This is an owned process with a real kernel-held lifetime lock and socket credentials.
// It models only the old protocol refusal, not an old implementation or baseline proof.
if (process.argv[2] === "--old-endpoint") {
  const home = process.argv[3]!;
  const log = process.argv[4]!;
  const paths = home === "default" ? daemonPaths() : daemonPathsFor(home);
  mkdirSync(paths.state, { recursive: true, mode: 0o700 });
  mkdirSync(paths.dir!, { recursive: true, mode: 0o700 });
  const lock = holdLifetime(paths.lock);
  const server = createServer((socket) => {
    let text = "";
    socket.on("data", (chunk) => {
      text += String(chunk);
      if (!text.includes("\n")) return;
      const request = JSON.parse(text.split("\n")[0]!) as { id: string; op: string };
      writeFileSync(log, `${request.op}\n`, { flag: "a", mode: 0o600 });
      socket.end(`${JSON.stringify({ v: 1, id: request.id, ok: false, error: { code: "UNKNOWN_OP", message: "unknown operation" } })}\n`);
    });
  });
  server.listen(paths.socket, () => { chmodSync(paths.socket, 0o600); process.stdout.write("ready\n"); });
  process.once("SIGTERM", () => server.close(() => { lock.release(); process.exit(0); }));
} else {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dc-")));
  const home = join(root, "home"), cotal = join(root, "cotal"), recorder = join(root, "native");
  for (const dir of [home, cotal, recorder]) mkdirSync(dir, { mode: 0o700 });
  const defaultHome = process.argv.includes("--default-home");
  const stateHome = defaultHome ? cotal : home;
  const paths = defaultHome ? daemonPaths(process.env, cotal) : daemonPathsFor(home);
  const wireLog = join(root, "wire.log"), nativeLog = join(root, "native.log");
  const env = { ...process.env, HOME: root, COTAL_HOME: cotal, XDG_CONFIG_HOME: join(root, "config"), PATH: recorder, COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_TELEMETRY: "off", DO_NOT_TRACK: "1" };
  let child: ChildProcess | undefined;
  const control = httpServer(async (_request, response) => {
    try {
      assert.ok(existsSync(daemonManagerIntentFile("compat", stateHome)), "intent retained until native stop");
      await killAndAwaitExit(child!, "SIGTERM");
      response.end("stopped");
    } catch (error) { response.writeHead(500).end(String(error)); }
  });
  try {
    child = spawn(process.execPath, ["--import", "tsx", self, "--old-endpoint", defaultHome ? "default" : home, wireLog], { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr!.on("data", (chunk) => { stderr += String(chunk); });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`old endpoint did not start: ${stderr}`)), 10_000);
      child!.stdout!.once("data", () => { clearTimeout(timer); resolve(); });
      child!.once("exit", (code) => { clearTimeout(timer); reject(new Error(`old endpoint exited ${code}: ${stderr}`)); });
    });
    // Optional external artifact, never a rewritten source or reverted implementation.
    const managerRequest: typeof managerViaDaemon = process.env.COTAL_COMPAT_BASELINE_CLIENT
      ? (await import(process.env.COTAL_COMPAT_BASELINE_CLIENT) as { managerViaDaemon: typeof managerViaDaemon }).managerViaDaemon
      : managerViaDaemon;
    for (const request of [{ op: "manager-start", space: "compat" }, { op: "manager-status", space: "compat" }, { op: "managers-stop" }] as const) {
      await assert.rejects(managerRequest({ paths }, request), (error: unknown) => {
        assert.ok(error instanceof CommandFailure, `expected typed CommandFailure, received ${String(error)}`);
        assert.equal(error.code, "LIFECYCLE_BLOCKED");
        assert.equal(error.native?.code, "UNKNOWN_OP");
        assert.match(error.remedy ?? "", /restart.*daemon user service.*service manager/);
        return true;
      });
      console.log(`  ✓ ${request.op} UNKNOWN_OP becomes typed refusal with restart remedy`);
    }
    const before = readFileSync(wireLog, "utf8");
    const foreign = join(stateHome, "daemon", "foreign");
    mkdirSync(foreign, { recursive: true, mode: 0o700 });
    writeFileSync(join(foreign, "manager-host.json"), "foreign-owned-marker");
    const intent = daemonManagerIntentFile("compat", stateHome);
    mkdirSync(dirname(intent), { recursive: true, mode: 0o700 });
    writeFileSync(intent, `${JSON.stringify({ v: 1, space: "compat" })}\n`, { mode: 0o600 });
    const unit = defaultHome ? "cotal-daemon.service" : `cotal-daemon-${createHash("sha256").update(home).digest("hex").slice(0, 16)}.service`;
    const unitPath = join(root, "config", "systemd", "user", unit), bytes = "[Service]\nExecStart=/owned/fixture\n";
    mkdirSync(dirname(unitPath), { recursive: true, mode: 0o700 });
    writeFileSync(unitPath, bytes, { mode: 0o600 });
    const receipt = join(paths.state, "service-unit.json");
    writeFileSync(receipt, JSON.stringify({ v: 1, unit, ...(defaultHome ? {} : { daemonHome: home }), unitPath, unitSha256: createHash("sha256").update(bytes).digest("hex"), installedAt: new Date().toISOString() }), { mode: 0o600 });
    await new Promise<void>((resolve) => control.listen(0, "127.0.0.1", resolve));
    const port = (control.address() as AddressInfo).port;
    writeFileSync(join(recorder, "systemctl"), `#!${process.execPath}\nconst fs=require('node:fs');(async()=>{const args=process.argv.slice(2).join(' ');if(args==='--user show-environment'){console.log(${JSON.stringify(`XDG_CONFIG_HOME=${join(root, "config")}`)});process.exit(0)}fs.appendFileSync(${JSON.stringify(nativeLog)},args+'\\n');if(args==='--user --no-ask-password --no-pager stop ${unit}'){const r=await fetch('http://127.0.0.1:${port}/stop');if(!r.ok)process.exit(99);}else if(!['--user --no-ask-password --no-pager disable ${unit}','--user --no-ask-password --no-pager daemon-reload'].includes(args))process.exit(99);})().catch(()=>process.exit(99));\n`, { mode: 0o700 });
    // PATH contains only the recorder. Neither real systemctl nor loginctl can be reached.
    const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const cli = spawn(process.execPath, [join(repo, "bin/dist/cotal.js"), "daemon", "uninstall", ...(defaultHome ? [] : ["--daemon-home", home]), "--yes", "--json"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      cli.stdout.on("data", (chunk) => { output += String(chunk); });
      cli.stderr.on("data", (chunk) => { output += String(chunk); });
      const timer = setTimeout(() => { cli.kill("SIGKILL"); reject(new Error("uninstall timed out")); }, 15_000);
      cli.once("error", reject);
      cli.once("exit", (code) => { clearTimeout(timer); resolve({ code, output }); });
    });
    assert.equal(result.code, 0, result.output);
    assert.deepEqual(readFileSync(nativeLog, "utf8").trim().split("\n"), [`--user --no-ask-password --no-pager stop ${unit}`, `--user --no-ask-password --no-pager disable ${unit}`, "--user --no-ask-password --no-pager daemon-reload"]);
    assert.equal(readFileSync(wireLog, "utf8"), before, "uninstall must not send managers-stop or any old-daemon request");
    assert.ok(child.exitCode !== null || child.signalCode !== null, "native stop reaped owned endpoint");
    for (const file of [intent, receipt, unitPath]) assert.equal(existsSync(file), false, `${file} removed`);
    assert.equal(JSON.parse(result.output).result?.state, "removed", "uninstall reports Removed");
    assert.equal(readFileSync(join(foreign, "manager-host.json"), "utf8"), "foreign-owned-marker", "non-space directory retained");
    const managers = createHostedManagers(stateHome);
    await managers.resume();
    assert.equal(managers.status("compat").state, "stopped", "a later daemon starts with no hosting intent for the removed space");
    await managers.close();
    console.log(`  ✓ real ${defaultHome ? "default" : "explicit"}-home uninstall stops owned old endpoint natively, removes unit and forgets intent without managers-stop`);
    console.log("daemon-compat: passed (protocol fixture, not historical baseline proof)");
  } finally {
    if (child) await killAndAwaitExit(child, "SIGTERM");
    await new Promise<void>((resolve) => control.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
}
