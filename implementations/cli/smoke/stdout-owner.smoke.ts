/**
 * stdout ownership smoke (no broker, no mesh, no session).
 *
 * SCOPE, stated honestly: each cell runs this file again as a child process with the binary's
 * `stdoutError` listener registered, as bin/run.ts registers it, then closes the child's stdout pipe
 * for real or emits a synthetic EIO on it. It pins:
 *   - unowned, a closed pipe exits 0, or the exit status the command already set;
 *   - owned, a closed pipe reaches the owner, which can finish async work and set the status;
 *   - an error from a write made while owned still reaches the owner when the release is called
 *     between that write's callback and its error event;
 *   - after the release settles, a closed pipe exits through the binary's listener again;
 *   - an EIO, owned or not, is reported in one stderr line with no stack trace and exits 3, or with
 *     the non-zero status the command already set; owned, it also reaches the owner;
 *   - the views that must finish their own shutdown, and `down`, which must finish its stops, own
 *     stdout's errors and attach no listener of their own to process.stdout;
 *   - with stdout in a file under a file-size limit, a write cut short is reported as EFBIG and
 *     exits 3. With no limit the whole write lands. When the limit cuts a built CLI JSON refusal
 *     short, the file is restored to its prior size, the CLI keeps the refusal exit code, and it
 *     prints the EFBIG line and text refusal on stderr. The file-size-limited cells need `bash` on
 *     PATH.
 *   - a built CLI JSON refusal reaches a pipe that accepts only a few bytes per write.
 * The views themselves (chat, watch, service logs, the service journal) and `down` are not driven here.
 *
 * Run: pnpm smoke:stdout-owner
 */
import { spawn, spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSuite } from "@cotal-ai/smoke-kit";
import { completeFileWrites, ownStdoutErrors, stdoutError } from "../src/lib/stdout-owner.js";

/** Resolves when the parent ends this child's stdin, which it does after closing the stdout pipe. */
const inputEnded = (): Promise<void> => new Promise((resolve) => { process.stdin.on("end", resolve); process.stdin.resume(); });

/** Write until a write fails, then run `then`. A pipe that never fails is reported with exit 97. */
function writeUntilFailed(then: () => void): void {
  let tries = 0;
  const attempt = (): void => {
    process.stdout.write("x\n", (err) => {
      if (err) return then();
      if (++tries < 200) setTimeout(attempt, 5);
      else { process.stderr.write("writes never failed\n"); process.exitCode = 97; }
    });
  };
  attempt();
}

/** After the failing write, a process that the binary's listener did not exit says so. */
const stillRunning = (): void => { setTimeout(() => process.stderr.write("still running\n"), 200); };

const eio = (): NodeJS.ErrnoException => Object.assign(new Error("synthetic EIO"), { code: "EIO" });

const children: Record<string, () => Promise<void> | void> = {
  "unowned-epipe": async () => {
    await inputEnded();
    writeUntilFailed(stillRunning);
  },
  "unowned-epipe-status": async () => {
    await inputEnded();
    process.exitCode = 4;
    writeUntilFailed(stillRunning);
  },
  "owned-async-close": async () => {
    await inputEnded();
    let handled = false;
    const release = ownStdoutErrors(() => {
      if (handled) return;
      handled = true;
      setTimeout(() => { process.stderr.write("owner closed\n"); process.exitCode = 3; release(); }, 50);
    });
    writeUntilFailed(() => {});
  },
  "error-after-release": async () => {
    await inputEnded();
    process.exitCode = 3;
    const release = ownStdoutErrors((e) => process.stderr.write(`owner saw ${(e as NodeJS.ErrnoException).code}\n`));
    // The failed write's callback runs a turn before its error event.
    writeUntilFailed(() => release());
  },
  "after-release": async () => {
    await inputEnded();
    const release = ownStdoutErrors(() => process.stderr.write("owner saw it\n"));
    release();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    process.exitCode = 3;
    writeUntilFailed(stillRunning);
  },
  "owned-eio": () => {
    const release = ownStdoutErrors((e) => {
      process.stderr.write(`owner saw ${(e as NodeJS.ErrnoException).code}\n`);
      release();
    });
    process.stdout.emit("error", eio());
    process.stdout.emit("error", eio());
  },
  "owned-eio-then-ok": () => {
    const release = ownStdoutErrors(() => {});
    process.stdout.emit("error", eio());
    // A result written after the loss sets exit 0, as writeResult does for an ok outcome.
    setTimeout(() => { process.exitCode = 0; release(); }, 10);
  },
  "owned-eio-status": () => {
    process.exitCode = 2;
    const release = ownStdoutErrors(() => release());
    process.stdout.emit("error", eio());
  },
  "unowned-eio": () => {
    setTimeout(() => process.stdout.emit("error", eio()), 0);
  },
  "unowned-eio-status": () => {
    process.exitCode = 2;
    setTimeout(() => process.stdout.emit("error", eio()), 0);
  },
  // stdout is a file here, so Node gave it a stream that writes with one writeSync.
  "file-write": () => {
    completeFileWrites();
    process.stdout.write(`${"x".repeat(3000)}\n`);
    stillRunning();
  },
};

const mode = process.argv[2];
if (mode !== undefined) {
  process.stdout.on("error", stdoutError);
  const child = children[mode];
  if (!child) throw new Error(`unknown child mode ${mode}`);
  await child();
} else {
  const { check, finish } = createSuite();

  /** Run one child mode. `closePipe` closes its stdout read end, then ends its stdin. */
  const run = (name: string, closePipe: boolean): Promise<{ code: number | null; stderr: string }> =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), name], { stdio: ["pipe", "pipe", "pipe"] });
      let stderr = "";
      child.stderr.setEncoding("utf8").on("data", (d: string) => { stderr += d; });
      const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
      child.on("close", (code) => { clearTimeout(timer); resolve({ code, stderr }); });
      if (closePipe) child.stdout.destroy();
      else child.stdout.resume();
      child.stdin.end();
    });

  console.log("1. unowned, a closed pipe exits through the binary's listener");
  {
    const r = await run("unowned-epipe", true);
    check("a closed pipe exits 0 before any later work runs", r.code === 0 && !r.stderr.includes("still running") && !r.stderr.includes("never failed"), r);
    const s = await run("unowned-epipe-status", true);
    check("...and keeps an exit status the command already set", s.code === 4 && !s.stderr.includes("still running"), s);
  }

  console.log("2. owned, the owner finishes its own shutdown and sets the status");
  {
    const r = await run("owned-async-close", true);
    check("the owner's async close ran and its status is the exit status", r.code === 3 && r.stderr.includes("owner closed"), r);
    const late = await run("error-after-release", true);
    check("a failed owned write's error reaches the owner although the release came first", late.code === 3 && late.stderr.includes("owner saw EPIPE"), late);
    const after = await run("after-release", true);
    check("after the release settles, the binary's listener exits again and the owner hears nothing",
      after.code === 3 && !after.stderr.includes("owner saw it") && !after.stderr.includes("still running"), after);
  }

  console.log("3. an error other than EPIPE");
  {
    const owned = await run("owned-eio", false);
    check("owned, an EIO is reported in one stderr line, once, exits 3 and still reaches the owner",
      owned.code === 3 && owned.stderr.startsWith("✗ could not write to stdout: synthetic EIO\n") && owned.stderr.split("could not write").length === 2 && owned.stderr.includes("owner saw EIO") && !owned.stderr.includes("    at "), owned);
    const thenOk = await run("owned-eio-then-ok", false);
    check("...and a result that sets exit 0 after the loss still exits 3", thenOk.code === 3 && thenOk.stderr.includes("could not write to stdout"), thenOk);
    const ownedStatus = await run("owned-eio-status", false);
    check("...and keeps a non-zero exit status the command already set", ownedStatus.code === 2 && ownedStatus.stderr.includes("could not write to stdout"), ownedStatus);
    const unowned = await run("unowned-eio", false);
    check("unowned, an EIO is one stderr line with no stack trace and exits 3",
      unowned.code === 3 && unowned.stderr === "✗ could not write to stdout: synthetic EIO\n", unowned);
    const status = await run("unowned-eio-status", false);
    check("...and keeps a non-zero exit status the command already set", status.code === 2 && status.stderr.includes("could not write to stdout"), status);
  }

  console.log("4. the views and the command that close their own work own stdout's errors");
  {
    const src = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
    const direct = /process\.stdout\.(?:on|once|prependListener|prependOnceListener|addListener)\(\s*"error"/;
    for (const file of ["chat/frontend.ts", "watch-json.ts", "commands/service-log-follow.ts", "lib/service-journal.ts", "commands/down.ts", "commands/update.ts"]) {
      const text = readFileSync(join(src, file), "utf8");
      check(`${file} owns stdout's errors and adds no listener of its own`, /\bownStdoutErrors\(/.test(text) && !direct.test(text));
    }
  }

  console.log("5. a stdout that is a file writes each chunk whole or fails");
  {
    /** Run Node with stdout in a fresh file, optionally with a file-size limit and SIGXFSZ ignored. */
    const runToFile = (entry: string[], limit?: 0 | 1, prefix = ""): Promise<{ code: number | null; stderr: string; bytes: number }> => {
      const dir = mkdtempSync(join(tmpdir(), "cotal-stdout-file-"));
      const path = join(dir, "out.json");
      if (prefix) writeFileSync(path, prefix);
      const fd = openSync(path, prefix ? "a" : "w", 0o600);
      const node = [process.execPath, ...entry];
      const [cmd, ...args] = limit === undefined ? node : ["bash", "-c", `ulimit -f ${limit}; trap "" XFSZ; exec "$0" "$@"`, ...node];
      return new Promise((resolve) => {
        const child = spawn(cmd!, args, { stdio: ["ignore", fd, "pipe"] });
        closeSync(fd);
        let stderr = "";
        child.stderr!.setEncoding("utf8").on("data", (d: string) => { stderr += d; });
        const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
        child.on("close", (code) => {
          clearTimeout(timer);
          const bytes = statSync(path).size;
          rmSync(dir, { recursive: true, force: true });
          resolve({ code, stderr, bytes });
        });
      });
    };
    const entry = [...process.execArgv, fileURLToPath(import.meta.url), "file-write"];
    const short = await runToFile(entry, 1);
    check("a write the file-size limit cuts short is one stderr line naming EFBIG, exit 3, after the 1024 bytes that fit",
      short.code === 3 && short.bytes === 1024 && short.stderr === "✗ could not write to stdout: EFBIG: file too large, write\n", short);
    const whole = await runToFile(entry);
    check("with no limit the whole document is written and the process runs on", whole.code === 0 && whole.bytes === 3001 && whole.stderr.includes("still running"), whole);
    const run = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "bin", "run.ts"), "utf8");
    check("the binary makes its stdout write whole chunks to a file", /^\s*completeFileWrites\(\);$/m.test(run));

    const cli = join(import.meta.dirname, "../../../bin/dist/cotal.js");
    const refused = await runToFile([cli, "docs", "xyz-not-a-real-page", "--json"], 1);
    check("a short JSON refusal restores the file to 0 bytes, keeps exit 1 and writes the EFBIG diagnostic and text refusal to stderr",
      refused.code === 1 && refused.bytes === 0 && refused.stderr.startsWith("✗ could not write to stdout: EFBIG: file too large, write\n")
        && refused.stderr.includes('no docs page "xyz-not-a-real-page"'), refused);
    const appended = await runToFile([cli, "docs", "xyz-not-a-real-page", "--json"], 1, "keep\n");
    check("a short JSON refusal appended to a file keeps existing bytes, removes its own partial output, keeps exit 1 and writes the text refusal to stderr",
      appended.code === 1 && appended.bytes === 5 && appended.stderr.startsWith("✗ could not write to stdout: EFBIG: file too large, write\n")
        && appended.stderr.includes('no docs page "xyz-not-a-real-page"'), appended);
    const sharedDir = mkdtempSync(join(tmpdir(), "cotal-stdout-concurrent-"));
    try {
      const sharedPath = join(sharedDir, "shared.json");
      const concurrentHook = join(sharedDir, "concurrent-write.cjs");
      writeFileSync(sharedPath, "keep\n");
      writeFileSync(concurrentHook, `
const fs = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");
const writeSync = fs.writeSync;
let first = true;
fs.writeSync = (fd, chunk, ...args) => {
  if (fd !== 1) return writeSync(fd, chunk, ...args);
  if (!first) throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
  first = false;
  if (typeof chunk === "string") chunk = Buffer.from(chunk);
  const [offset = 0] = args;
  const wrote = writeSync(fd, chunk, offset, 32);
  fs.appendFileSync(${JSON.stringify(sharedPath)}, "peer\\n");
  return wrote;
};
syncBuiltinESMExports();
`);
      const sharedFd = openSync(sharedPath, "a", 0o600);
      const concurrent = spawnSync(process.execPath, ["--require", concurrentHook, cli, "docs", "xyz-not-a-real-page", "--json"],
        { stdio: ["ignore", sharedFd, "pipe"], encoding: "utf8", timeout: 20_000 });
      closeSync(sharedFd);
      const text = readFileSync(sharedPath, "utf8");
      check("when another writer appends meanwhile, ftruncateSync does not discard the other writer's bytes",
        concurrent.status === 1 && text.length === 42 && text.startsWith("keep\n") && text.endsWith("peer\n")
          && concurrent.stderr.startsWith("✗ could not write to stdout: ENOSPC: no space left on device, write\n")
          && concurrent.stderr.includes('no docs page "xyz-not-a-real-page"'), { status: concurrent.status, length: text.length, stderr: concurrent.stderr });
    } finally {
      rmSync(sharedDir, { recursive: true, force: true });
    }

    const dir = mkdtempSync(join(tmpdir(), "cotal-invalid-workflow-"));
    try {
      const file = join(dir, "invalid.cotal.js");
      writeFileSync(file, "const = ;\n");
      const invalid = await runToFile([cli, "run", "validate", file, "--json"], 0);
      check("an unwritable JSON validation refusal keeps exit 1 and prints the write error, problem and fix to stderr",
        invalid.code === 1 && invalid.bytes === 0 && invalid.stderr.includes("✗ could not write to stdout: EFBIG: file too large, write\n")
          && invalid.stderr.includes("Workflow not valid") && invalid.stderr.includes(`L1008 Invalid syntax or newline hazard (${file}:1:7)`)
          && invalid.stderr.includes("fix: Fix the syntax at the marked position."), invalid);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  console.log("6. a short-writing pipe receives the whole JSON refusal");
  {
    const dir = mkdtempSync(join(tmpdir(), "cotal-stdout-pipe-"));
    try {
      const hook = join(dir, "short-write.cjs");
      // Limit each synchronous stdout write to three bytes while sending those bytes to the real pipe.
      writeFileSync(hook, `
const fs = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");
const writeSync = fs.writeSync;
fs.writeSync = (fd, chunk, ...args) => {
  if (fd !== 1) return writeSync(fd, chunk, ...args);
  if (typeof chunk === "string") chunk = Buffer.from(chunk);
  const [offset = 0, length = chunk.length - offset] = args;
  return writeSync(fd, chunk, offset, Math.min(length, 3));
};
syncBuiltinESMExports();
`);
      const cli = join(import.meta.dirname, "../../../bin/dist/cotal.js");
      const args = [cli, "docs", "xyz-not-a-real-page-é", "--json"];
      const throughPipe = (args: string[]) => spawnSync("bash", ["-o", "pipefail", "-c", '"$@" | cat', "bash", process.execPath, ...args],
        { encoding: "utf8", timeout: 20_000 });
      const whole = throughPipe(args);
      const short = throughPipe(["--require", hook, ...args]);
      check("a normal refusal writes JSON on stdout only and exits 1",
        whole.status === 1 && whole.stderr === "" && whole.stdout.includes("xyz-not-a-real-page-é") && whole.stdout.includes('"outcome":"refused"'), whole);
      check("short writes to a pipe preserve every byte and keep stderr empty and exit 1",
        short.status === 1 && short.stderr === "" && short.stdout === whole.stdout, short);
      const closedPartway = spawnSync("bash", ["-o", "pipefail", "-c", '"$@" | head -c 6', "bash", process.execPath, "--require", hook, ...args],
        { encoding: "utf8", timeout: 20_000 });
      check("a reader that closes a short-writing pipe partway still leaves stderr empty and exits 1",
        closedPartway.status === 1 && closedPartway.stderr === "" && closedPartway.stdout === whole.stdout.slice(0, 6), closedPartway);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  console.log("7. a JSON refusal keeps its exit code when the reader closes early");
  {
    const cli = join(import.meta.dirname, "../../../bin/dist/cotal.js");
    const closed = spawnSync("bash", ["-o", "pipefail", "-c", '"$@" | head -c 0', "bash", process.execPath, cli, "config", "get", "--json"],
      { encoding: "utf8", timeout: 20_000 });
    check("a closed reader leaves the refusal at exit 1 with both streams empty",
      closed.status === 1 && closed.stdout === "" && closed.stderr === "", closed);
  }

  finish();
}
