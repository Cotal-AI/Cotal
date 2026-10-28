/**
 * Smoke test for @cotal-ai/orca.
 * Run from the repo root: pnpm exec tsx extensions/orca/smoke.ts
 * Pass --live (or COTAL_ORCA_LIVE=1) to require the live Orca checks instead of skipping them.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { registry, type RuntimeProvider } from "@cotal-ai/core";
import * as orca from "./src/driver.js";
import { OrcaRuntime, orcaRuntimeProvider, privateLauncher } from "./src/runtime.js";

const LIVE_CHECK_COUNT = 13;
const requireLive = process.argv.includes("--live") || process.env.COTAL_ORCA_LIVE === "1";
let failures = 0;
function ok(label: string, cond: unknown, detail?: unknown): void {
  if (cond) console.log(`✓ ${label}`);
  else {
    failures++;
    console.error(`✗ ${label}${detail ? `\n  ${String(detail)}` : ""}`);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function rejects(label: string, fn: () => Promise<unknown>, pattern?: RegExp): Promise<void> {
  try {
    await fn();
    ok(`${label} (expected rejection)`, false);
  } catch (err) {
    ok(label, !pattern || pattern.test((err as Error).message), err);
  }
}

const secret = "leak-canary-orca-DO-NOT-LEAK";
const launcher = privateLauncher(
  {
    command: process.execPath,
    args: ["-e", "process.stdout.write(process.env.COTAL_CONTROL_TOKEN ?? '')"],
    env: { COTAL_CONTROL_TOKEN: secret },
  },
  process.cwd(),
);
ok("launcher command does not expose secret env", !launcher.command.includes(secret));
ok("launcher replaces Orca's interactive shell", launcher.command.startsWith("exec '"));
ok("launcher script is owner-only", (statSync(launcher.script).mode & 0o777) === 0o600);
ok("launcher directory is owner-only", (statSync(dirname(launcher.script)).mode & 0o777) === 0o700);
const source = readFileSync(launcher.script, "utf8");
ok("secret is confined to the private launcher", source.includes(secret));
ok("launcher removes its secret-bearing directory after loading", source.includes("rmSync"));
const launched = spawnSync(process.execPath, [launcher.script], { encoding: "utf8" });
ok("launcher passes the declared env to its child", launched.status === 0 && launched.stdout === secret);
ok("launcher removes its secret-bearing directory on execution", !existsSync(launcher.dir));
rmSync(launcher.dir, { recursive: true, force: true });

const cliEnv = orca.localCliEnv({ PATH: "/bin", ORCA_PAIRING_CODE: "pair", orca_environment: "remote" });
ok("Orca CLI preserves ordinary environment", cliEnv.PATH === "/bin");
ok("Orca CLI strips remote-runtime selectors", !Object.keys(cliEnv).some((key) => key.toUpperCase() === "ORCA_PAIRING_CODE" || key.toUpperCase() === "ORCA_ENVIRONMENT"));

if (process.platform !== "win32") {
  const stubDir = mkdtempSync(join(tmpdir(), "cotal-orca-stub-"));
  const stub = join(stubDir, "orca-stub");
  const previousBin = process.env.COTAL_ORCA_BIN;
  try {
    writeFileSync(stub, '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ ok: true, result: {} }));\n', { mode: 0o700 });
    process.env.COTAL_ORCA_BIN = stub;
    ok("available() fails closed when runtime.reachable is absent", !orca.available());

    writeFileSync(
      stub,
      '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ ok: false, error: { code: "terminal_handle_stale" } })); process.exit(1);\n',
      { mode: 0o700 },
    );
    let staleCloseThrew = false;
    try {
      orca.closeTerminal("term_stale_smoke");
    } catch {
      staleCloseThrew = true;
    }
    ok("nonzero JSON envelopes reach stale-close handling", !staleCloseThrew);

    writeFileSync(stub, '#!/usr/bin/env node\nprocess.stderr.write("Orca runtime unreachable"); process.exit(1);\n', { mode: 0o700 });
    ok(
      "terminal liveness fails safe when Orca is unreachable",
      orca.terminalAlive({ handle: "term_live_smoke", ptyId: "pty_live_smoke" }),
    );

    const countFile = join(stubDir, "calls");
    writeFileSync(
      stub,
      `#!/usr/bin/env node\nconst fs = require("node:fs"); const file = ${JSON.stringify(countFile)}; const count = Number(fs.existsSync(file) ? fs.readFileSync(file, "utf8") : 0) + 1; fs.writeFileSync(file, String(count)); process.stdout.write(JSON.stringify({ ok: true, result: { terminals: [{ handle: "term_rotated", ptyId: "pty_stable", connected: true }] } }));\n`,
      { mode: 0o700 },
    );
    const stableTerminal = { handle: "term_created", ptyId: "pty_stable" };
    ok("terminal liveness matches stable ptyId", orca.terminalAlive(stableTerminal));
    ok("terminal liveness reuses the list snapshot", orca.terminalAlive(stableTerminal) && readFileSync(countFile, "utf8") === "1");
    ok("terminal resolution follows a rotated handle by stable ptyId", orca.currentTerminal(stableTerminal)?.handle === "term_rotated");

    // Clear the short list cache before changing the stub's response contract.
    orca.closeTerminal("term_rotated");

    const stateFile = join(stubDir, "orca-state.json");
    const callLogFile = join(stubDir, "orca-calls.log");
    const fakeWorktree = join(stubDir, "worktree");
    mkdirSync(fakeWorktree, { recursive: true, mode: 0o700 });
    writeFileSync(
      stub,
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)}, "utf8"));
fs.appendFileSync(${JSON.stringify(callLogFile)}, JSON.stringify(args) + "\\n");
const sub = args.slice(0, 2).join(" ");
let env;
if (args[0] === "status") env = { ok: true, result: { runtime: { reachable: true } } };
else if (sub === "worktree current") env = { ok: true, result: { worktree: { id: "wt_smoke", path: ${JSON.stringify(fakeWorktree)} } } };
else if (sub === "terminal create") env = { ok: true, result: state.create };
else if (sub === "terminal list") env = { ok: true, result: { terminals: state.terminals } };
else if (sub === "terminal show") env = state.show;
else if (sub === "terminal wait") env = state.wait;
else if (sub === "terminal send") env = state.send ?? { ok: true, result: {} };
else if (sub === "terminal close") env = { ok: true, result: {} };
else env = { ok: false, error: { code: "unexpected", message: sub } };
process.stdout.write(JSON.stringify(env));
process.exit(env.ok === false ? 1 : 0);
`,
      { mode: 0o700 },
    );
    const drainCalls = (): string[] => {
      const text = existsSync(callLogFile) ? readFileSync(callLogFile, "utf8") : "";
      writeFileSync(callLogFile, "");
      return text
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const parsed = JSON.parse(line) as string[];
          const idx = parsed.indexOf("--terminal");
          return parsed.slice(0, 2).join(" ") + (idx >= 0 ? ` ${parsed[idx + 1]}` : "");
        });
    };
    const gone = (code: string) => ({ ok: false, error: { code, message: code } });
    const okTerminal = { ok: true, result: { terminal: { handle: "h1", ptyId: "p1", connected: true } } };
    const okNoTerminal = { ok: true, result: {} };
    const waitRunning = { ok: true, result: { wait: { condition: "exit", satisfied: false, status: "running" } } };
    const agreementCases = [
      {
        name: "listed connected terminal with non-exited wait stays running on both paths",
        create: { terminal: { handle: "h1", ptyId: "p1", connected: true } },
        terminals: [{ handle: "h1", ptyId: "p1", connected: true }],
        show: okTerminal,
        wait: waitRunning,
        statusBefore: "running",
        waitResolved: false,
        waitError: "orca terminal wait returned no authoritative exit for h1",
        statusCalls: ["terminal list"],
        waitCalls: ["terminal wait h1"],
        statusAfter: "running",
      },
      {
        name: "unlisted ptyId with not_found wait resolves exited without calling terminal show",
        create: { terminal: { handle: "h1", ptyId: "p1", connected: true } },
        terminals: [],
        show: gone("terminal_not_found"),
        wait: gone("terminal_not_found"),
        statusBefore: "exited",
        waitResolved: true,
        waitError: "",
        statusCalls: ["terminal list"],
        waitCalls: ["terminal wait h1", "terminal list"],
        statusAfter: "exited",
      },
      {
        name: "unlisted ptyId ignores stale handle show ok with terminal and agrees on exited",
        create: { terminal: { handle: "h1", ptyId: "p1", connected: true } },
        terminals: [],
        show: okTerminal,
        wait: gone("terminal_stale"),
        statusBefore: "exited",
        waitResolved: true,
        waitError: "",
        statusCalls: ["terminal list"],
        waitCalls: ["terminal wait h1", "terminal list"],
        statusAfter: "exited",
      },
      {
        name: "unlisted ptyId ignores show ok with no terminal and agrees on exited",
        create: { terminal: { handle: "h1", ptyId: "p1", connected: true } },
        terminals: [],
        show: okNoTerminal,
        wait: gone("terminal_stale"),
        statusBefore: "exited",
        waitResolved: true,
        waitError: "",
        statusCalls: ["terminal list"],
        waitCalls: ["terminal wait h1", "terminal list"],
        statusAfter: "exited",
      },
      {
        name: "handle-only terminal rejects show ok with no terminal on both lookup paths",
        create: { handle: "h1" },
        terminals: [],
        show: okNoTerminal,
        wait: gone("terminal_not_found"),
        statusBefore: "running",
        waitResolved: false,
        waitError: "orca terminal show returned no authoritative state for h1",
        statusCalls: ["terminal list", "terminal show h1"],
        waitCalls: ["terminal wait h1", "terminal list", "terminal show h1"],
        statusAfter: "running",
      },
    ];
    for (const c of agreementCases) {
      writeFileSync(
        stateFile,
        JSON.stringify({
          create: c.create,
          terminals: c.terminals,
          show: c.show,
          wait: c.wait,
        }),
      );
      orca.closeTerminal("h1");
      const spawned = new OrcaRuntime().spawn("seat_agreement", { command: process.execPath, args: ["-e", ""] }, fakeWorktree);
      drainCalls();
      const statusBefore = spawned.status();
      const statusCalls = drainCalls();
      let waitResolved = false;
      let waitError = "";
      try {
        await spawned.waitForExit!();
        waitResolved = true;
      } catch (err) {
        waitError = (err as Error).message;
      }
      const waitCalls = drainCalls();
      orca.closeTerminal("h1");
      drainCalls();
      const statusAfter = spawned.status();
      drainCalls();
      ok(
        c.name,
        statusBefore === c.statusBefore &&
          waitResolved === c.waitResolved &&
          waitError === c.waitError &&
          JSON.stringify(statusCalls) === JSON.stringify(c.statusCalls) &&
          JSON.stringify(waitCalls) === JSON.stringify(c.waitCalls) &&
          statusAfter === c.statusAfter &&
          !(waitResolved && statusAfter === "running"),
        JSON.stringify({ statusBefore, statusCalls, waitResolved, waitError, waitCalls, statusAfter }),
      );
    }
    orca.closeTerminal("h1");
    await rejects(
      "currentTerminal rejects show ok with no terminal for a handle-only terminal",
      async () => orca.currentTerminal({ handle: "h1" }),
      /orca terminal show returned no authoritative state for h1/,
    );
    writeFileSync(
      stateFile,
      JSON.stringify({
        create: { terminal: { handle: "h1", ptyId: "p1", connected: true } },
        terminals: [{ handle: "h1", ptyId: "p1", connected: true }],
        show: okTerminal,
        wait: waitRunning,
        send: gone("terminal_not_writable"),
      }),
    );
    orca.closeTerminal("h1");
    const interruptHandle = new OrcaRuntime().spawn("seat_interrupt", { command: process.execPath, args: ["-e", ""] }, fakeWorktree);
    let notWritableThrew = false;
    try {
      interruptHandle.interrupt();
    } catch {
      notWritableThrew = true;
    }
    ok("interrupt ignores not_writable alongside gone terminal codes", !notWritableThrew);

    const waitList = '{ ok: true, result: { terminals: [{ handle: "term_wait", ptyId: "pty_wait", connected: true }] } }';
    writeFileSync(
      stub,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[1] === "list") process.stdout.write(JSON.stringify(${waitList}));
else if (args[1] === "wait") process.stdout.write(JSON.stringify({ ok: true, result: { wait: { handle: "term_wait", condition: "exit", satisfied: true, status: "exited", exitCode: 0 } } }));
else process.stdout.write(JSON.stringify({ ok: false, error: { code: "terminal_not_found" } }));
`,
      { mode: 0o700 },
    );
    await orca.waitManagedTerminalExit({ handle: "term_wait", ptyId: "pty_wait" }, 100);
    ok("provider-native terminal wait accepts an authoritative normal exit", true);

    writeFileSync(
      stub,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[1] === "list") process.stdout.write(JSON.stringify(${waitList}));
else { process.stdout.write(JSON.stringify({ ok: false, error: { code: "timeout", message: "timeout" } })); process.exit(1); }
`,
      { mode: 0o700 },
    );
    await rejects(
      "provider-native terminal wait rejects timeout",
      () => orca.waitManagedTerminalExit({ handle: "term_wait", ptyId: "pty_wait" }, 1_000),
      /timeout/,
    );

    // A CLI that survives SIGTERM: the async wait must still settle at its own bound, not when the
    // child chooses to exit.
    const pidFile = join(stubDir, "wait-pid");
    const stubPids: number[] = [];
    const sigtermProofWait = (answerAfterMs: number) => {
      writeFileSync(
        stub,
        `#!/usr/bin/env node
require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.on("SIGTERM", () => {});
process.stdout.on("error", () => {});
setTimeout(() => process.stdout.write(JSON.stringify({ ok: true, result: { wait: { handle: "term_wait", condition: "exit", satisfied: true, status: "exited", exitCode: 0 } } })), ${answerAfterMs});
`,
        { mode: 0o700 },
      );
      const started = Date.now();
      return orca
        .waitManagedTerminalExit({ handle: "term_wait", ptyId: "pty_wait" }, 1_000)
        .then(
          () => ({ ok: true, ms: Date.now() - started, detail: "" }),
          (err: Error) => ({ ok: false, ms: Date.now() - started, detail: err.message }),
        )
        .finally(() => stubPids.push(Number(readFileSync(pidFile, "utf8"))));
    };
    try {
      const answered = await sigtermProofWait(200);
      ok("async terminal wait returns a prompt answer from a SIGTERM-proof CLI", answered.ok && answered.ms < 1_000, JSON.stringify(answered));
      const hung = await sigtermProofWait(8_000);
      ok("async terminal wait settles at its bound when the CLI survives SIGTERM", !hung.ok && hung.ms < 4_000, JSON.stringify(hung));
    } finally {
      for (const pid of stubPids) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* already exited */
        }
      }
    }

    writeFileSync(
      stub,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[1] === "list") process.stdout.write(JSON.stringify(${waitList}));
else { process.stderr.write("Orca runtime unavailable"); process.exit(2); }
`,
      { mode: 0o700 },
    );
    await rejects(
      "provider-native terminal wait fails loud on unknown provider state",
      () => orca.waitManagedTerminalExit({ handle: "term_wait", ptyId: "pty_wait" }, 20),
      /runtime unavailable/,
    );

    writeFileSync(
      stub,
      '#!/usr/bin/env node\nprocess.stdout.write("not-json"); process.stderr.write("useful Orca diagnostic"); process.exit(2);\n',
      { mode: 0o700 },
    );
    let diagnostic = "";
    try {
      orca.sendTerminal("term_live_smoke", { interrupt: true });
    } catch (err) {
      diagnostic = (err as Error).message;
    }
    ok("non-envelope failures preserve stderr diagnostics", diagnostic.includes("useful Orca diagnostic"), diagnostic);
  } finally {
    if (previousBin === undefined) delete process.env.COTAL_ORCA_BIN;
    else process.env.COTAL_ORCA_BIN = previousBin;
    rmSync(stubDir, { recursive: true, force: true });
  }
}

const resolved = registry.resolve<RuntimeProvider>("runtime", "orca");
ok("orcaRuntimeProvider registered as 'runtime/orca'", resolved === orcaRuntimeProvider);
// Declared, not discovered by catching the throw from attach(): a caller reads this to decide
// whether to ask for an attach at all, so a foreground `cotal spawn` on this runtime launches the
// seat and stops there instead of failing on an attach that cannot open. Graded above the live
// gate, because what a backend declares does not depend on whether its CLI is installed here.
ok("the runtime declares that it streams no terminal", new OrcaRuntime().streamsTerminal === false);

if (!orca.available()) {
  const message = `SKIPPED (${LIVE_CHECK_COUNT} live checks not run) — Orca CLI/runtime is not reachable`;
  if (requireLive) console.error(`✗ ${message}; live coverage was required`);
  else console.log(`• ${message}`);
  process.exit(failures || requireLive ? 1 : 0);
}

const worktree = orca.resolveWorktree(process.cwd());
ok("resolveWorktree returns current Orca worktree", !!worktree.id && !!worktree.path, JSON.stringify(worktree));

const pathFixture = mkdtempSync(join(tmpdir(), "cotal-orca-path-"));
try {
  const linkedCwd = join(pathFixture, "worktree-link");
  symlinkSync(process.cwd(), linkedCwd, process.platform === "win32" ? "junction" : "dir");
  ok("resolveWorktree accepts a symlinked cwd", orca.resolveWorktree(linkedCwd).id === worktree.id);
} finally {
  rmSync(pathFixture, { recursive: true, force: true });
}

const outside = mkdtempSync(join(tmpdir(), "cotal-orca-outside-"));
let outsideError = "";
try {
  orca.resolveWorktree(outside);
} catch (err) {
  outsideError = (err as Error).message;
} finally {
  rmSync(outside, { recursive: true, force: true });
}
ok("unmanaged cwd gets the runtime guidance error", outsideError.includes("is not inside an Orca-managed worktree"), outsideError);

let staleCloseThrew = false;
try {
  orca.closeTerminal("term_deadbeef");
} catch {
  staleCloseThrew = true;
}
ok("closing a stale terminal is idempotent", !staleCloseThrew);

ok("orcaRuntimeProvider.available() returns true", orcaRuntimeProvider.available());

const runtime = new OrcaRuntime();
const handle = runtime.spawn(
  `smoke-${Date.now().toString(36)}`,
  {
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    env: { PATH: process.env.PATH ?? "" },
  },
  process.cwd(),
);

ok("spawn returns an orca handle with waitForExit", handle.kind === "orca" && typeof handle.waitForExit === "function");
ok("spawned terminal reports running", handle.status() === "running");

if (process.platform !== "win32") {
  await sleep(300);
  const stubDir = mkdtempSync(join(tmpdir(), "cotal-orca-unreachable-"));
  const stub = join(stubDir, "orca-stub");
  const previousBin = process.env.COTAL_ORCA_BIN;
  try {
    writeFileSync(stub, '#!/usr/bin/env node\nprocess.stderr.write("Orca runtime unreachable"); process.exit(1);\n', { mode: 0o700 });
    process.env.COTAL_ORCA_BIN = stub;
    ok("running handle does not become exited when Orca is unreachable", handle.status() === "running");
    let interruptThrew = false;
    try {
      handle.interrupt();
    } catch {
      interruptThrew = true;
    }
    ok("interrupt surfaces an unreachable Orca runtime", interruptThrew);
  } finally {
    if (previousBin === undefined) delete process.env.COTAL_ORCA_BIN;
    else process.env.COTAL_ORCA_BIN = previousBin;
    rmSync(stubDir, { recursive: true, force: true });
  }
}

handle.stop({ graceful: false });
await handle.waitForExit!();
ok("stop -> waitForExit proves terminal exit", handle.status() === "exited");
let staleInterruptThrew = false;
try {
  handle.interrupt();
} catch {
  staleInterruptThrew = true;
}
ok("interrupt ignores an already-gone terminal", !staleInterruptThrew);

const oddTmpRoot = mkdtempSync(join(tmpdir(), "cotal-orca-quote-"));
const oddTmp = join(oddTmpRoot, "$HOME-$(id)");
const nestedCwd = join(process.cwd(), "extensions", "orca", "src");
const cwdProof = join(oddTmpRoot, "cwd.txt");
mkdirSync(oddTmp);
const previousTmp = process.env.TMPDIR;
let shortHandle;
try {
  process.env.TMPDIR = oddTmp;
  shortHandle = runtime.spawn(
    `smoke-exit-${Date.now().toString(36)}`,
    {
      command: process.execPath,
      args: [
        "-e",
        "require('node:fs').writeFileSync(process.argv[1], process.cwd()); setTimeout(() => {}, 250)",
        cwdProof,
      ],
      env: { PATH: process.env.PATH ?? "" },
    },
    nestedCwd,
  );
} finally {
  if (previousTmp === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = previousTmp;
}
await shortHandle!.waitForExit!();
ok("waitForExit resolves after normal agent exit without stop()", shortHandle!.status() === "exited");
ok("spawned process runs from the exact nested cwd", readFileSync(cwdProof, "utf8") === realpathSync(nestedCwd));
shortHandle!.stop({ graceful: false });
rmSync(oddTmpRoot, { recursive: true, force: true });

console.log(`✓ live Orca smoke completed (${LIVE_CHECK_COUNT} checks)`);
process.exit(failures ? 1 : 0);
