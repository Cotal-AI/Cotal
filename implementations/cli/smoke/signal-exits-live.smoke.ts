/**
 * LIVE e2e for how a long-running command ends on a signal, on a running static-auth stack. Each
 * command starts, runs until it shows it is up, and gets SIGINT or SIGTERM:
 *
 *  A. through pipes: `watch --json`, `history --follow --json`, `history --follow`,
 *     `channel members general --follow --json`, `join` and `console --plain` exit 130 on SIGINT and
 *     143 on SIGTERM, and a JSON stream's last record is `end` with reason `interrupted` or
 *     `terminated`.
 *  B. on a terminal: the `watch`, `chat` and `console` views exit 130 on SIGINT, after the view has
 *     stopped, rather than dying by the signal. The chat view closes its session first. The watch
 *     view exits 143 on SIGTERM.
 *
 * COTAL_HOME is sandboxed, the child environment carries no `COTAL_` variable of the runner, and the
 * stack stops with `cotal down --yes`. Needs `nats-server` on PATH. Run: pnpm smoke:signal-exits:live
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSmokeSandboxDown, createSuite, freePort, recordSmokeSandbox } from "@cotal-ai/smoke-kit";
import { clean, cotalPty, COTAL, repoRoot } from "./_console-pty.js";

const TSX = join(repoRoot, "node_modules", ".bin", "tsx");
const SERVER = `nats://127.0.0.1:${await freePort()}`;
const SPACE = `signal-exits-${process.pid}`;
const base = mkdtempSync(join(tmpdir(), "cotal-signal-exits-"));
const home = join(base, "home"), configDir = join(base, "xdg"), s = join(base, "s");
// The product refuses a local-record store that is not private, so every folder here is 0700.
for (const dir of [home, configDir, s]) mkdirSync(dir, { mode: 0o700 });
const sandbox = recordSmokeSandbox({ root: s, cotalHome: home, xdgConfigHome: configDir });
const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !key.startsWith("COTAL_") && key !== "FORCE_COLOR") env[key] = value;
Object.assign(env, { HOME: home, COTAL_HOME: home, XDG_CONFIG_HOME: configDir, COTAL_SKIP_CONNECTOR_SEED: "1" });

const { check, finish } = createSuite();
const cotal = (...args: string[]) => {
  const options = { cwd: s, env, encoding: "utf8" as const, timeout: 180_000 };
  assertSmokeSandboxDown(sandbox, args, options);
  const run = spawnSync(TSX, [COTAL, ...args], options);
  return { status: run.status, out: `${run.stdout}${run.stderr}` };
};

/** Start `args` on pipes, send `signal` once `ready` shows on stdout (or after 15 s), and resolve
 *  with how it ended and the last JSON record it wrote. */
const piped = (args: string[], signal: NodeJS.Signals, ready: string) => new Promise<{ code: number | null; signal: string | null; sent: boolean; end?: { reason?: string; data?: { reason?: string } }; out: string }>((done) => {
  const child = spawn(TSX, [COTAL, ...args], { cwd: s, env, stdio: ["pipe", "pipe", "pipe"] });
  let out = "", sent = false;
  const fire = () => { if (sent) return; sent = true; child.kill(signal); };
  const fallback = setTimeout(fire, 15_000);
  child.stdout.on("data", (chunk: Buffer) => { out += chunk; if (out.includes(ready)) setTimeout(fire, 500); });
  child.stderr.on("data", (chunk: Buffer) => { out += chunk; });
  child.on("close", (code, killed) => {
    clearTimeout(fallback);
    const last = out.trim().split("\n").reverse().find((line) => line.startsWith("{"));
    let end: { reason?: string; data?: { reason?: string } } | undefined;
    try { end = last ? JSON.parse(last) : undefined; } catch { end = undefined; }
    done({ code, signal: killed, sent, end, out: out.slice(-600) });
  });
});

/** Start `args` on a terminal, send `signal` once `ready` shows, and resolve with the exit code. */
const onTerminal = (args: string[], signal: "SIGINT" | "SIGTERM", ready: string) => new Promise<{ code: number | undefined; signal: number | undefined; out: string }>((done) => {
  const pty = cotalPty(args, { cwd: s, env: { ...env, TERM: "xterm-256color" } });
  let out = "", sent = false;
  const fire = () => { if (sent) return; sent = true; (pty.kill as (signal?: string) => void)(signal); };
  const fallback = setTimeout(fire, 20_000);
  const deadline = setTimeout(() => (pty.kill as (signal?: string) => void)("SIGKILL"), 60_000);
  pty.onData((data) => { out += data; if (clean(out).includes(ready)) setTimeout(fire, 1_000); });
  (pty.onExit as (cb: (e: { exitCode: number; signal?: number }) => void) => void)((e) => {
    clearTimeout(fallback);
    clearTimeout(deadline);
    done({ code: e.exitCode, signal: e.signal || undefined, out: clean(out).slice(-600) });
  });
});

let up = false;
try {
  check("space create prepares the folder", cotal("space", "create", SPACE).status === 0);
  up = true;
  const started = cotal("up", "--server", SERVER);
  check("up starts the static-auth stack", started.status === 0, started.out.slice(-600));
  if (started.status !== 0) throw new Error("the stack did not start; no later cell can run");
  check("a message is on #general for the follows to read", cotal("send", "-c", "general", "before the follows").status === 0);

  console.log("\nA. through pipes");
  const streams: [string, string[], string][] = [
    ["watch --json", ["watch", "--json"], '"type":"snapshot"'],
    ["history --follow --json", ["history", "--follow", "--json"], '"type":"snapshot"'],
    ["channel members --follow --json", ["channel", "members", "general", "--follow", "--json"], '"type":"snapshot"'],
  ];
  for (const [name, args, ready] of streams) for (const [signal, code, reason] of [["SIGINT", 130, "interrupted"], ["SIGTERM", 143, "terminated"]] as const) {
    const ended = await piped(args, signal, ready);
    check(`${name} exits ${code} on ${signal}, and its last record is end ${reason}`,
      ended.sent && ended.code === code && (ended.end?.data?.reason ?? ended.end?.reason) === reason && (ended.end as { type?: string } | undefined)?.type === "end", ended);
  }
  for (const [name, args, ready] of [
    ["history --follow", ["history", "--follow"], "replay to new members"],
    ["join", ["join", "--name", "signal-exits"], "holding presence"],
    ["console --plain", ["console", "--plain"], "watching space"],
  ] as [string, string[], string][]) {
    const ended = await piped(args, "SIGINT", ready);
    check(`${name} exits 130 on SIGINT`, ended.sent && ended.code === 130, ended);
  }

  console.log("\nB. on a terminal");
  for (const [name, args, ready] of [["watch", ["watch"], "q leave"], ["chat", ["chat"], "Enter send"], ["console", ["console"], "cmd"]] as [string, string[], string][]) {
    const ended = await onTerminal(args, "SIGINT", ready);
    check(`the ${name} view exits 130 on SIGINT, not by the signal`, ended.code === 130 && ended.signal === undefined, ended);
    if (name === "chat") check("the chat view closes its session before it exits", ended.out.includes("session retired"), ended.out);
  }
  const term = await onTerminal(["watch"], "SIGTERM", "q leave");
  check("the watch view exits 143 on SIGTERM, not by the signal", term.code === 143 && term.signal === undefined, term);
} finally {
  if (up) {
    const down = cotal("down", "--yes");
    check("down --yes stops the stack", down.status === 0, down.out.slice(-600));
  }
  rmSync(base, { recursive: true, force: true });
}
finish();
// A terminal child's handles can outlive the suite's own work; the verdict is already recorded.
process.exit();
