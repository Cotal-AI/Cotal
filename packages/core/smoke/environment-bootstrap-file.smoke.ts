import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs, { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { takeEnvironmentManagerBootstrapFile } from "../src/index.js";
import { emitSentinel } from "@cotal-ai/smoke-kit";

if (process.argv[2] === "entry") {
  console.log(`ENTRY_PID=${process.pid}`);
  const barrier = process.argv[4];
  if (barrier) {
    const original = fs.openSync;
    fs.openSync = ((...args: Parameters<typeof fs.openSync>) => {
      const fd = original(...args);
      if (String(args[0]).startsWith("/proc/self/fd/") && String(args[0]).endsWith("/input")) {
        writeFileSync(join(barrier, `ready-${process.pid}`), "opened");
        const until = Date.now() + 10_000;
        while (!existsSync(join(barrier, "go"))) {
          if (Date.now() > until) throw new Error("take barrier timed out");
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
      }
      return fd;
    }) as typeof fs.openSync;
    syncBuiltinESMExports();
  }
  try {
    const text = takeEnvironmentManagerBootstrapFile(process.argv[3]!);
    assert.equal(text, "dummy-bootstrap-no-authority");
    console.log("TAKEN");
  } catch { console.log("REFUSED"); process.exitCode = 1; }
} else if (process.platform !== "linux") {
  assert.throws(() => takeEnvironmentManagerBootstrapFile("/unsupported"), /requires Linux/);
  console.log("SKIP Linux native checks; unsupported platform refuses without reading");
  emitSentinel({ passed: 1, failed: 0 });
} else {
  const root = mkdtempSync(join(tmpdir(), "cotal-bootstrap-file-"));
  chmodSync(root, 0o700);
  const dummy = "dummy-bootstrap-no-authority";
  let passed = 0, failed = 0, serial = 0;
  const cell = async (name: string, run: () => void | Promise<void>) => {
    try { await run(); passed++; console.log(`  ✓ ${name}`); }
    catch (error) { failed++; console.error(`  ✗ ${name}: ${error instanceof Error ? error.message : String(error)}`); }
  };
  const file = (bytes: string | Buffer = dummy, mode = 0o600) => {
    const parent = join(root, `case-${serial++}`); mkdirSync(parent, { mode: 0o700 });
    const path = join(parent, "input"); writeFileSync(path, bytes, { mode }); chmodSync(path, mode);
    return path;
  };
  const descriptors = () => readdirSync("/proc/self/fd").length;
  const runTake = (path: string, deadline = 15_000, barrier?: string) => new Promise<{ code: number | null; output: string }>((yes, no) => {
    const self = fileURLToPath(import.meta.url);
    const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), self, "entry", path, ...(barrier ? [barrier] : [])], {
      env: { PATH: process.env.PATH, MUTATION_PROOF_RUN: process.env.MUTATION_PROOF_RUN }, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const timeout = setTimeout(() => child.kill("SIGKILL"), deadline);
    child.stdout.on("data", bytes => { output += bytes.toString(); });
    child.once("error", error => { clearTimeout(timeout); no(error); });
    child.once("close", code => {
      clearTimeout(timeout);
      if (!output.includes(`ENTRY_PID=${child.pid}\n`)) { no(new Error("owned child PID is not the actual bootstrap reader")); return; }
      yes({ code, output });
    });
  });
  try {
    await cell("private regular file returns bytes only after its name is removed", () => {
      const path = file(); assert.equal(takeEnvironmentManagerBootstrapFile(path), dummy); assert.equal(existsSync(path), false);
    });
    await cell("unlink and directory sync precede the first byte read", () => {
      const path = file(), originalSync = fs.fsyncSync, originalRead = fs.readSync;
      let synced = false, observed = false;
      fs.fsyncSync = fd => { originalSync(fd); synced = true; };
      fs.readSync = ((...args: unknown[]) => {
        assert.equal(existsSync(path), false); assert.equal(synced, true); observed = true;
        return Reflect.apply(originalRead, fs, args);
      }) as typeof fs.readSync;
      syncBuiltinESMExports();
      try { assert.equal(takeEnvironmentManagerBootstrapFile(path), dummy); assert.equal(observed, true); }
      finally { fs.fsyncSync = originalSync; fs.readSync = originalRead; syncBuiltinESMExports(); }
    });
    await cell("a repeated take cannot return material", () => {
      const path = file(); takeEnvironmentManagerBootstrapFile(path); assert.throws(() => takeEnvironmentManagerBootstrapFile(path));
    });
    await cell("relative paths refuse without consuming an unrelated file", () => {
      const path = file(); assert.throws(() => takeEnvironmentManagerBootstrapFile("./input"), /canonical and absolute/); assert.equal(readFileSync(path, "utf8"), dummy);
    });
    await cell("noncanonical absolute paths refuse before deletion", () => {
      const path = file(); assert.throws(() => takeEnvironmentManagerBootstrapFile(dirname(path) + "/../" + dirname(path).split("/").pop() + "/input"), /canonical and absolute/); assert.equal(existsSync(path), true);
    });
    await cell("shared parent directories refuse without deletion authority", () => {
      const path = file(); chmodSync(dirname(path), 0o755);
      assert.throws(() => takeEnvironmentManagerBootstrapFile(path), /parent must/); assert.equal(readFileSync(path, "utf8"), dummy);
    });
    await cell("symlinked parent directories refuse without touching the target", () => {
      const path = file(), alias = join(root, `alias-${serial++}`); symlinkSync(dirname(path), alias);
      assert.throws(() => takeEnvironmentManagerBootstrapFile(join(alias, "input")), /parent cannot/); assert.equal(existsSync(path), true);
    });
    await cell("a final symlink is removed without reading or deleting its target", () => {
      const path = file(), target = join(dirname(path), "target"); renameSync(path, target); symlinkSync(target, path);
      assert.throws(() => takeEnvironmentManagerBootstrapFile(path), /cannot be opened/); assert.equal(existsSync(path), false); assert.equal(readFileSync(target, "utf8"), dummy);
    });
    await cell("a FIFO refuses without blocking and leaves no file", async () => {
      const path = file(); rmSync(path);
      const mkfifo = spawn("mkfifo", [path], { stdio: "ignore" });
      await new Promise<void>((yes, no) => { mkfifo.once("error", no); mkfifo.once("exit", code => code === 0 ? yes() : no(new Error("mkfifo failed"))); });
      const result = await runTake(path, 8_000);
      assert.equal(result.code, 1, "the FIFO reader refuses instead of hanging");
      assert.ok(result.output.includes("REFUSED")); assert.equal(existsSync(path), false);
    });
    await cell("a directory input refuses and remains untouched", () => {
      const path = file(); rmSync(path); mkdirSync(path, { mode: 0o700 });
      assert.throws(() => takeEnvironmentManagerBootstrapFile(path), /path is a directory/); assert.equal(existsSync(path), true);
    });
    await cell("nonprivate file permissions refuse after consuming the name", () => {
      const path = file(dummy, 0o644); assert.throws(() => takeEnvironmentManagerBootstrapFile(path), /mode0600/); assert.equal(existsSync(path), false);
    });
    await cell("hard-linked input refuses and does not remove an alias", () => {
      const path = file(), alias = join(dirname(path), "alias"); linkSync(path, alias);
      assert.throws(() => takeEnvironmentManagerBootstrapFile(path), /singly linked/); assert.equal(existsSync(path), false); assert.equal(readFileSync(alias, "utf8"), dummy);
    });
    await cell("empty input refuses after consumption", () => {
      const path = file(""); assert.throws(() => takeEnvironmentManagerBootstrapFile(path), /empty or exceeds/); assert.equal(existsSync(path), false);
    });
    await cell("oversized input refuses after consumption", () => {
      const path = file(Buffer.alloc(64 * 1024 + 1, 97)); assert.throws(() => takeEnvironmentManagerBootstrapFile(path), /size limit/); assert.equal(existsSync(path), false);
    });
    await cell("the size ceiling remains an accepting positive control", () => {
      const path = file(Buffer.alloc(64 * 1024, 97)); assert.equal(takeEnvironmentManagerBootstrapFile(path).length, 64 * 1024); assert.equal(existsSync(path), false);
    });
    await cell("invalid UTF-8 refuses after consumption", () => {
      const path = file(Buffer.from([0xff, 0xfe])); assert.throws(() => takeEnvironmentManagerBootstrapFile(path), /not UTF-8/); assert.equal(existsSync(path), false);
    });
    await cell("a parent rename cannot redirect the held deletion or read", () => {
      const path = file(), parent = dirname(path), moved = parent + "-moved";
      const original = fs.openSync;
      fs.openSync = ((...args: Parameters<typeof fs.openSync>) => {
        const fd = original(...args);
        if (args[0] === parent) {
          renameSync(parent, moved); mkdirSync(parent, { mode: 0o700 }); writeFileSync(path, "other-file-no-authority", { mode: 0o600 });
        }
        return fd;
      }) as typeof fs.openSync;
      syncBuiltinESMExports();
      try {
        assert.equal(takeEnvironmentManagerBootstrapFile(path), dummy);
        assert.equal(existsSync(join(moved, "input")), false);
        assert.equal(readFileSync(path, "utf8"), "other-file-no-authority");
      } finally { fs.openSync = original; syncBuiltinESMExports(); }
    });
    await cell("refusal diagnostics expose neither file paths nor contents", () => {
      const path = file("PRIVATE_DUMMY_NEVER_ECHO", 0o644);
      let message = ""; try { takeEnvironmentManagerBootstrapFile(path); } catch (error) { message = (error as Error).message; }
      assert.ok(message); assert.equal(message.includes(path), false); assert.equal(message.includes("PRIVATE_DUMMY_NEVER_ECHO"), false);
    });
    await cell("descriptors close after accepting and refusing takes", () => {
      const before = descriptors();
      for (let n = 0; n < 20; n++) { takeEnvironmentManagerBootstrapFile(file()); assert.throws(() => takeEnvironmentManagerBootstrapFile(file(""))); }
      assert.equal(descriptors(), before);
    });
    await cell("concurrent native processes release the file to one taker only", async () => {
      const path = file(), barrier = join(root, `barrier-${serial++}`); mkdirSync(barrier, { mode: 0o700 });
      const pending = [runTake(path, 15_000, barrier), runTake(path, 15_000, barrier)];
      let ready = false;
      try {
        const end = Date.now() + 8_000;
        while (Date.now() < end) {
          if (readdirSync(barrier).filter(name => name.startsWith("ready-")).length === 2) { ready = true; break; }
          await new Promise(resolve => setTimeout(resolve, 25));
        }
      } finally { writeFileSync(join(barrier, "go"), "release"); }
      const results = await Promise.all(pending);
      assert.equal(ready, true, "both real processes opened the same file before either unlink");
      assert.equal(results.filter(row => row.code === 0 && row.output.includes("TAKEN")).length, 1);
      assert.equal(results.filter(row => row.code === 1 && row.output.includes("REFUSED")).length, 1);
      assert.equal(existsSync(path), false);
    });
    emitSentinel({ passed, failed });
    process.exitCode = failed === 0 ? 0 : 1;
  } finally { rmSync(root, { recursive: true, force: true }); }
}
