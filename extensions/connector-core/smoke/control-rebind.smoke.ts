import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startControlServer } from "../src/control.js";
import type { MeshAgent } from "../src/agent.js";

// The child uses the same startup observers as serveClaudeSession. A recoverable error
// reaching its external error listener is a startup failure even if a retry later binds.
if (process.argv.includes("--listener")) {
  const server = startControlServer(
    {} as MeshAgent,
    { path: process.env.COTAL_CONTROL_SOCKET!, token: process.env.COTAL_CONTROL_TOKEN! },
    async () => ({ ok: true }),
    { fatalBind: process.env.FIXTURE_FATAL !== "0" },
  );
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  process.stdout.write("READY\n");
  process.on("SIGTERM", () => server.close(() => process.exit(0)));
} else if (process.platform === "win32") {
  console.log("SKIP Unix crash-leftover cases on Windows");
} else {
  const root = mkdtempSync(join(tmpdir(), "ctl-rebind-"));
  const path = join(root, "control.sock");
  const token = randomBytes(32).toString("hex");
  const children: ChildProcess[] = [];
  const exits = new Map<ChildProcess, Promise<unknown>>();
  let passed = 0;
  const check = (label: string, condition: boolean): void => {
    assert.ok(condition, label);
    passed++;
    console.log(`  ✓ ${label}`);
  };
  const launch = (fatal = true) => {
    const child = spawn(process.execPath, ["--import", createRequire(import.meta.url).resolve("tsx"), fileURLToPath(import.meta.url), "--listener"], {
      cwd: root,
      env: { PATH: process.env.PATH, HOME: root, COTAL_CONTROL_SOCKET: path, COTAL_CONTROL_TOKEN: token, FIXTURE_FATAL: fatal ? "1" : "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    exits.set(child, once(child, "close"));
    let stdout = "", stderr = "";
    child.stdout!.on("data", (data: Buffer) => { stdout += data.toString(); });
    child.stderr!.on("data", (data: Buffer) => { stderr += data.toString(); });
    return { child, stdout: () => stdout, stderr: () => stderr };
  };
  const until = async (test: () => boolean): Promise<void> => {
    for (let i = 0; i < 200; i++) {
      if (test()) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    assert.fail("control child deadline");
  };
  const request = (presented: string) => new Promise<string>((resolve, reject) => {
    const socket = connect(path);
    let reply = "";
    socket.setTimeout(1_000, () => { socket.destroy(); reject(new Error("control request deadline")); });
    socket.once("error", reject);
    socket.once("connect", () => socket.write(JSON.stringify({ token: presented, event: {} }) + "\n"));
    socket.on("data", (data: Buffer) => { reply += data.toString(); });
    socket.once("close", () => resolve(reply));
  });
  try {
    const first = launch();
    await until(() => first.stdout().includes("READY"));
    check("fresh listener replies", (await request(token)).trim() === '{"ok":true}');
    const inode = lstatSync(path).ino;
    const duplicate = launch();
    await exits.get(duplicate.child);
    check("live listener refuses the duplicate with fatalBind", duplicate.child.exitCode === 1 && duplicate.stderr().includes("EADDRINUSE"));
    check("live socket was not replaced", lstatSync(path).ino === inode && (await request(token)).trim() === '{"ok":true}');
    first.child.kill("SIGKILL");
    await exits.get(first.child);
    check("crash leaves a socket file", existsSync(path) && lstatSync(path).isSocket());
    for (const fatal of [true, false]) {
      const replacement = launch(fatal);
      await until(() => replacement.stdout().includes("READY"));
      check(`stale socket recovers with fatalBind=${fatal} without an external startup error`, replacement.stderr().includes("control socket:") && !replacement.stderr().includes("control server error:"));
      check("replacement still authenticates frames", (await request("wrong-token")) === "" && (await request(token)).trim() === '{"ok":true}');
      replacement.child.kill("SIGKILL");
      await exits.get(replacement.child);
    }
    rmSync(path);
    writeFileSync(path, "keep this file");
    const blocked = launch();
    await exits.get(blocked.child);
    check("a regular file is refused and preserved", blocked.child.exitCode === 1 && readFileSync(path, "utf8") === "keep this file");
    console.log(`CONTROL-REBIND TESTS PASSED (${passed} checks)`);
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await Promise.all(exits.values());
    rmSync(root, { recursive: true, force: true });
  }
}
