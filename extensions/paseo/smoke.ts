/**
 * Smoke test for @cotal-ai/paseo.
 * Run from the repo root: pnpm exec tsx extensions/paseo/smoke.ts
 * Pass --live (or COTAL_PASEO_LIVE=1) to require the live Paseo checks instead of skipping them.
 * The live checks drive the local daemon `paseo` selects (set PASEO_HOME for a sandboxed one).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { registry, SpawnRefused, type AgentHandle, type RuntimeProvider } from "@cotal-ai/core";
import * as paseo from "./src/driver.js";
import { PaseoRuntime, paseoRuntimeProvider, privateLauncher, TerminalCensus } from "./src/runtime.js";

const LIVE_CHECK_COUNT = 16;
const requireLive = process.argv.includes("--live") || process.env.COTAL_PASEO_LIVE === "1";
let checks = 0;
let failures = 0;
function ok(label: string, cond: unknown, detail?: unknown): void {
  checks++;
  if (cond) console.log(`✓ ${label}`);
  else {
    failures++;
    console.error(`✗ ${label}${detail ? `\n  ${String(detail)}` : ""}`);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await sleep(200);
  }
  return cond();
}

const secret = "leak-canary-paseo-DO-NOT-LEAK";
const launcher = privateLauncher(
  {
    command: process.execPath,
    args: ["-e", "process.stdout.write(process.env.COTAL_CONTROL_TOKEN ?? '')"],
    env: { COTAL_CONTROL_TOKEN: secret },
  },
  process.cwd(),
);
ok("launcher script is owner-only", (statSync(launcher.script).mode & 0o777) === 0o600);
ok("launcher directory is owner-only", (statSync(dirname(launcher.script)).mode & 0o777) === 0o700);
ok("secret is confined to the private launcher", readFileSync(launcher.script, "utf8").includes(secret) && !launcher.script.includes(secret));
const launched = spawnSync(process.execPath, [launcher.script], { encoding: "utf8" });
ok("launcher passes the declared env to its child", launched.status === 0 && launched.stdout === secret);
ok("launcher removes its secret-bearing directory on execution", !existsSync(launcher.dir));
rmSync(launcher.dir, { recursive: true, force: true });

const cliEnv = paseo.localCliEnv({ PATH: "/bin", PASEO_HOME: "/h", paseo_host: "remote:6767" });
ok("Paseo discovery keeps the local daemon selector", cliEnv.PATH === "/bin" && cliEnv.PASEO_HOME === "/h");
ok("Paseo discovery strips the remote daemon selector", !Object.keys(cliEnv).some((key) => key.toUpperCase() === "PASEO_HOST"));
ok("a TCP listen address becomes the SDK URL", paseo.daemonUrl("127.0.0.1:6767") === "ws://127.0.0.1:6767/ws" && paseo.daemonUrl("[::1]:6767") === "ws://[::1]:6767/ws");
let unixRefused: unknown;
try {
  paseo.daemonUrl("/run/paseo.sock");
} catch (err) {
  unixRefused = err;
}
ok("a Unix-socket listen address is refused by name", /only a TCP host:port/.test((unixRefused as Error)?.message ?? ""));
ok(
  "daemon status reads reachability and the listen address",
  JSON.stringify(paseo.parseStatus('{"connectedDaemon":"reachable","listen":"127.0.0.1:1"}')) === '{"reachable":true,"listen":"127.0.0.1:1"}' &&
    !paseo.parseStatus('{"connectedDaemon":"not_probed","listen":null}').reachable,
);

ok("the paseo runtime self-registers", registry.resolve<RuntimeProvider>("runtime", "paseo") === paseoRuntimeProvider);
let unsafe: unknown;
try {
  new PaseoRuntime().spawn("bad name", { command: "true", args: [] }, process.cwd());
} catch (err) {
  unsafe = err;
}
ok("an unsafe agent name is refused before any Paseo call", unsafe instanceof SpawnRefused);

{
  let listing: () => Promise<string[]> = async () => ["t1"];
  const census = new TerminalCensus(() => listing());
  const early = census.generation;
  await census.refresh();
  const since = census.generation;
  listing = async () => [];
  ok("a terminal is present until a listing taken after it existed", census.present("t1", since));
  await census.refresh();
  ok("a listing taken after the terminal existed and lacking it proves the exit", !census.present("t1", since));
  ok("an older listing is not counted for a newer terminal", early < since && census.present("t1", since + 1));
  listing = async () => {
    throw new Error("daemon down");
  };
  const failing = new TerminalCensus(() => listing());
  await failing.refresh().catch(() => {});
  ok("a census that cannot be taken never reports an exit", failing.present("t1", 0));
  let rejected = false;
  await failing.gone("t1", 0, 1_000).catch(() => (rejected = true));
  ok("waiting for an exit fails closed when the daemon cannot be listed", rejected);
}

if (process.platform !== "win32") {
  const stubDir = mkdtempSync(join(tmpdir(), "cotal-paseo-stub-"));
  const stub = join(stubDir, "paseo-stub");
  const previousBin = process.env.COTAL_PASEO_BIN;
  try {
    process.env.COTAL_PASEO_BIN = stub;
    writeFileSync(stub, '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ localDaemon: "stopped", connectedDaemon: "not_probed" }));\n', { mode: 0o700 });
    ok("available() is false when the daemon is not reachable", !paseo.available());
    writeFileSync(stub, '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ connectedDaemon: "reachable", listen: "127.0.0.1:1" }));\n', { mode: 0o700 });
    ok("available() is true when the daemon is reachable", paseo.available());
  } finally {
    if (previousBin === undefined) delete process.env.COTAL_PASEO_BIN;
    else process.env.COTAL_PASEO_BIN = previousBin;
    rmSync(stubDir, { recursive: true, force: true });
  }
}

const OFFLINE_CHECKS = checks;

async function live(): Promise<void> {
  const before = checks;
  const work = realpathSync(mkdtempSync(join(tmpdir(), "cotal-paseo-live-")));
  const runtime = new PaseoRuntime();
  const client = await paseo.connect();
  const terminals = async () => (await client.terminals.list()).entries;
  const handles: AgentHandle[] = [];
  const marker = (name: string) => join(work, name);
  // A stand-in agent: it reports its cwd and whether it got the declared env without printing the
  // value, shows a startup prompt that needs Enter, and records an interrupt and a typed /exit.
  const agent = `
    const fs = require("node:fs");
    const ok = process.env.COTAL_CONTROL_TOKEN === ${JSON.stringify(secret)};
    console.log("cwd=" + process.cwd() + " env=" + (ok ? "ok" : "missing"));
    process.on("SIGINT", () => { fs.writeFileSync(${JSON.stringify(marker("interrupted"))}, ""); console.log("got-sigint"); });
    console.log("Press Enter to continue");
    let confirmed = false;
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => {
      if (!confirmed) { confirmed = true; fs.writeFileSync(${JSON.stringify(marker("confirmed"))}, ""); console.log("ready"); return; }
      if (d.includes("/exit")) { fs.writeFileSync(${JSON.stringify(marker("exited"))}, ""); process.exit(0); }
    });
    setInterval(() => {}, 1000);
  `;
  const spec = { command: process.execPath, args: ["-e", agent], env: { PATH: process.env.PATH ?? "", COTAL_CONTROL_TOKEN: secret }, confirm: "Press Enter to continue" };
  try {
    ok("live: the local Paseo daemon is reachable", paseo.available());
    const name = `smoke-${process.pid}`;
    const h = runtime.spawn(name, spec, work);
    handles.push(h);
    ok("live: the startup confirm watch answers the prompt", await until(() => existsSync(marker("confirmed")), 15_000));
    const listed = (await terminals()).find((t) => t.name === `cotal-${name}`);
    ok("live: the agent runs in a Paseo terminal named for it, in the launch cwd", listed?.cwd === work, JSON.stringify(listed));
    const screen = listed ? (await client.terminals.ref(listed.id).capture({ stripAnsi: true })).lines.join("\n") : "";
    ok("live: the agent runs in the launch cwd with the declared env", screen.includes(`cwd=${work} env=ok`), screen);
    ok("live: the secret never reaches the terminal", !screen.includes(secret));
    ok("live: status reports a running agent", h.status() === "running");
    h.interrupt();
    ok("live: interrupt reaches the agent", await until(() => existsSync(marker("interrupted")), 10_000));
    h.stop();
    ok("live: a graceful stop types /exit into the agent", await until(() => existsSync(marker("exited")), 10_000));
    await h.waitForExit!();
    ok("live: waitForExit resolves once the terminal is gone", !(await terminals()).some((t) => t.id === listed?.id));
    ok("live: status reports the exit", await until(() => h.status() === "exited", 5_000));
    ok("live: an exit the runtime did not cause carries no invented detail", h.exitInfo?.() === undefined);

    const hard = runtime.spawn(`${name}-hard`, spec, work);
    handles.push(hard);
    await until(() => existsSync(marker("never")), 1_500);
    const hardTerminal = (await terminals()).find((t) => t.name === `cotal-${name}-hard`);
    ok("live: a second agent gets its own terminal", !!hardTerminal && hardTerminal.id !== listed?.id);
    hard.stop({ graceful: false });
    await hard.waitForExit!();
    ok("live: a hard stop kills the terminal", !(await terminals()).some((t) => t.id === hardTerminal?.id));

    const quick = runtime.spawn(`${name}-quick`, { command: process.execPath, args: ["-e", "setTimeout(() => {}, 1500)"], env: { PATH: process.env.PATH ?? "" } }, work);
    handles.push(quick);
    await quick.waitForExit!();
    ok("live: an agent that exits on its own is seen as exited", await until(() => quick.status() === "exited", 5_000));

    let attachErr: unknown;
    try {
      quick.attach();
    } catch (err) {
      attachErr = err;
    }
    ok("live: attach points at the Paseo terminal instead of streaming", /Paseo app/.test((attachErr as Error)?.message ?? ""));

    const previousHome = process.env.PASEO_HOME;
    process.env.PASEO_HOME = join(work, "no-daemon");
    await sleep(300);
    let down: unknown;
    try {
      new PaseoRuntime().spawn(`${name}-down`, spec, work);
    } catch (err) {
      down = err;
    } finally {
      if (previousHome === undefined) delete process.env.PASEO_HOME;
      else process.env.PASEO_HOME = previousHome;
    }
    ok("live: a spawn without a reachable daemon is refused", down instanceof SpawnRefused, down);
  } finally {
    for (const h of handles) if (h.status() === "running") h.stop({ graceful: false });
    await sleep(500);
    await client.close();
    rmSync(work, { recursive: true, force: true });
  }
  ok(`live: all ${LIVE_CHECK_COUNT} live checks ran`, checks - before === LIVE_CHECK_COUNT, checks - before);
}

const liveReady = process.platform !== "win32" && paseo.available();
if (liveReady) await live();
else if (requireLive) ok("live: the local Paseo daemon is reachable (`paseo daemon status`)", false);
else console.log("- live Paseo checks skipped: no reachable Paseo daemon (pass --live to require them)");

console.log(`\n@cotal-ai/paseo smoke: ${checks - failures}/${checks} passed (${OFFLINE_CHECKS} offline${liveReady ? `, ${checks - OFFLINE_CHECKS} live` : ""})`);
process.exit(failures === 0 ? 0 : 1);
