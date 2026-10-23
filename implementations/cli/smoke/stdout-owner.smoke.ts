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
 *   - owned, an EIO reaches the owner; unowned, an EIO is rethrown and exits 1;
 *   - the views that must finish their own shutdown, and `down`, which must finish its stops, own
 *     stdout's errors and attach no listener of their own to process.stdout.
 * The views themselves (chat, watch, service logs, the service journal) and `down` are not driven here.
 *
 * Run: pnpm smoke:stdout-owner
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSuite } from "@cotal-ai/smoke-kit";
import { ownStdoutErrors, stdoutError } from "../src/lib/stdout-owner.js";

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
      process.exitCode = 3;
      release();
    });
    process.stdout.emit("error", eio());
  },
  "unowned-eio": () => {
    setTimeout(() => process.stdout.emit("error", eio()), 0);
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
    check("owned, an EIO reaches the owner and is not rethrown", owned.code === 3 && owned.stderr.includes("owner saw EIO") && !owned.stderr.includes("synthetic EIO"), owned);
    const unowned = await run("unowned-eio", false);
    check("unowned, an EIO is rethrown and exits 1", unowned.code === 1 && unowned.stderr.includes("synthetic EIO"), unowned);
  }

  console.log("4. the views and the command that close their own work own stdout's errors");
  {
    const src = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
    const direct = /process\.stdout\.(?:on|once|prependListener|prependOnceListener|addListener)\(\s*"error"/;
    for (const file of ["chat/frontend.ts", "watch-json.ts", "commands/service-log-follow.ts", "lib/service-journal.ts", "commands/down.ts"]) {
      const text = readFileSync(join(src, file), "utf8");
      check(`${file} owns stdout's errors and adds no listener of its own`, /\bownStdoutErrors\(/.test(text) && !direct.test(text));
    }
  }

  finish();
}
