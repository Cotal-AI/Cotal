/**
 * A managed `spawn --dry-run` on an open mesh refuses a `--on` value that cannot be a manager
 * instance id, as the real launch does, instead of previewing it and failing only at launch.
 *
 * LIVE: a real nats-server, a real `space add` registration in mode `open`, and the real CLI
 * through the built binary. The broker only has to answer liveness; no manager ever runs, and
 * nothing is launched: the valid-pin preview still reports `allocated: false, launched: false`.
 * The bundled reference and both preview routes distinguish persona source from launch placement.
 *
 * COTAL_HOME and the project root are sandboxed. Needs `nats-server` on PATH and a built tree.
 * Run: pnpm build, then pnpm smoke:spawn-preview-pin
 */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countedAssert, emitSentinel, killAndAwaitExit, teardownOnSignal, SMOKE_BROKER_TOKEN } from "@cotal-ai/smoke-kit";

const counted = countedAssert(assert);
const check: typeof assert = counted.assert;
const root = mkdtempSync(join(tmpdir(), "cotal-spawn-preview-pin-"));
const env: NodeJS.ProcessEnv = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith("COTAL_")) delete env[key];
for (const name of ["home", "state", "config", "runtime", "tmp", "project"]) mkdirSync(join(root, name), { mode: 0o700 });
mkdirSync(join(root, "project", ".cotal"), { mode: 0o700 });
Object.assign(env, { HOME: join(root, "home"), COTAL_HOME: join(root, "state"), XDG_CONFIG_HOME: join(root, "config"), XDG_RUNTIME_DIR: join(root, "runtime"), TMPDIR: join(root, "tmp"), DO_NOT_TRACK: "1", COTAL_TELEMETRY: "off", COTAL_SKIP_CONNECTOR_SEED: "1" });
for (const key of Object.keys(process.env)) if (key.startsWith("COTAL_")) delete process.env[key];
Object.assign(process.env, env);
process.chdir(join(root, "project"));

const entry = join(import.meta.dirname, "../../../bin/dist/cotal.js");
const children: ChildProcess[] = [];
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type Envelope = {
  outcome?: string;
  target?: { space?: string; path?: string };
  result?: { kind?: string; persona?: { source?: string }; requested?: { instanceId?: string | null; source?: string; restarts?: number; restartWindowMs?: number }; cwd?: string; allocated?: boolean; launched?: boolean };
  error?: { code?: string; message?: string; remedy?: string };
};

const cli = (args: string[]) => spawnSync(process.execPath, [entry, ...args], { cwd: join(root, "project"), env, encoding: "utf8", timeout: 60_000 });
const preview = (args: string[]): { status: number | null; envelope: Envelope } => {
  const run = cli(args);
  check.equal(run.error, undefined, run.stderr);
  let envelope: Envelope;
  try { envelope = JSON.parse(run.stdout) as Envelope; } catch { check.fail(`preview printed no JSON envelope: ${run.stdout}${run.stderr}`); }
  return { status: run.status, envelope: envelope! };
};

try {
  writeFileSync(join(root, "project", "sample.md"), "---\nname: sample\nrole: reviewer\nsubscribe: [general]\nallowSubscribe: [general]\n---\nReview this.\n");
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  const server = `nats://127.0.0.1:${port}`;
  const store = mkdtempSync(join(root, "tmp", SMOKE_BROKER_TOKEN));
  const broker = spawn("nats-server", ["-js", "-p", String(port), "-sd", store], { env, stdio: "ignore" });
  children.push(broker);
  const releaseBroker = teardownOnSignal(broker, store);
  await pause(500);
  const added = spawnSync(process.execPath, [entry, "space", "add", "samplemesh", "--server", server, "--root", ".", "--mode", "open", "--force", "--plain"], { cwd: join(root, "project"), env, encoding: "utf8" });
  check.equal(added.status, 0, added.stdout + added.stderr);

  const file = ["spawn", "--file", "./sample.md", "--no-events", "--harness", "claude", "--name", "preview-check", "--space", "samplemesh", "--server", server, "--dry-run", "--json"];
  const base = [...file, "--detach"];
  const docs = spawnSync(process.execPath, [entry, "docs", "cli-agent-views", "--plain"], { env, encoding: "utf8", timeout: 60_000 });
  check.equal(docs.status, 0, docs.stderr);
  check.match(docs.stdout, /`--file <persona-file>` selects the persona, not the launch route/);

  const bad = preview([...base, "--on", "not-a-pin"]);
  check.equal(bad.status, 1, JSON.stringify(bad.envelope));
  check.equal(bad.envelope.outcome, "refused");
  check.equal(bad.envelope.error?.code, "USAGE_INVALID");
  check.match(bad.envelope.error?.message ?? "", /instanceId "not-a-pin" is not a valid lifecycle token/);
  check.match(bad.envelope.error?.message ?? "", /A manager's name or host is taken only on a user-auth mesh/);
  const roster = `\`cotal ps --space samplemesh --server ${server}\``;
  check.ok(bad.envelope.error?.remedy?.includes(`${roster} prints each manager's instance id`));
  const ps = ["ps", "--space", "samplemesh", "--server", server];
  const jsonRoster = `\`cotal ps --json --space samplemesh --server ${server}\``;
  for (const pin of ["", "local.sample", "not-a-pin"]) {
    const read = preview([...ps, "--on", pin, "--json"]);
    check.equal(read.status, 1);
    const message = read.envelope.error?.message;
    check.ok(message?.includes(jsonRoster), message);
  }
  const textRead = cli([...ps, "--on", ""]);
  check.equal(textRead.status, 1, textRead.stderr);
  check.ok(["cotal", "pnpm cotal"].some((launcher) =>
    textRead.stderr.includes(`\`${launcher} ps --space samplemesh --server ${server}\``)), textRead.stderr);

  const empty = preview([...base, "--on", ""]);
  check.equal(empty.status, 1, JSON.stringify(empty.envelope));
  check.equal(empty.envelope.error?.code, "USAGE_INVALID");

  const pin = "a".repeat(26);
  const valid = preview([...base, "--on", pin]);
  check.equal(valid.status, 0, JSON.stringify(valid.envelope));
  check.equal(valid.envelope.outcome, "ok");
  check.equal(valid.envelope.result?.requested?.instanceId, pin);
  check.equal(valid.envelope.result?.allocated, false);
  check.equal(valid.envelope.result?.launched, false);

  const unpinned = preview(base);
  check.equal(unpinned.status, 0, JSON.stringify(unpinned.envelope));
  check.equal(unpinned.envelope.outcome, "ok");
  check.equal(unpinned.envelope.result?.requested?.instanceId, null);

  const restart = ["--restarts", "1", "--restart-window", "60000"];
  for (const [flags, advice] of [
    [[], /^add -d to keep restart supervision/],
    [["--foreground"], /^replace --foreground with -d to keep restart supervision/],
    [["--foreground", "--live-only"], /^omit --restarts and --restart-window to launch in this terminal$/],
  ] as const) {
    const refused = preview([...file, ...flags, ...restart]);
    check.deepEqual([refused.status, refused.envelope.error?.code], [1, "USAGE_INVALID"]);
    check.match(refused.envelope.error?.remedy ?? "", advice);
    check.match(refused.envelope.error?.remedy ?? "", /omit --restarts and --restart-window/);
  }
  const supervised = preview([...file, "-d", ...restart]);
  const requested = supervised.envelope.result?.requested;
  check.deepEqual([supervised.status, requested?.restarts, requested?.restartWindowMs,
    supervised.envelope.result?.allocated, supervised.envelope.result?.launched], [0, 1, 60000, false, false]);
  const foreground = preview([...file, "--foreground"]);
  check.deepEqual([foreground.status, foreground.envelope.result?.kind,
    foreground.envelope.result?.allocated, foreground.envelope.result?.launched], [0, "direct-launch-preview", false, false]);

  for (const flag of ["--subscribe", "--allow-subscribe"]) {
    const direct = preview([...file, flag, "updates"]);
    check.deepEqual([direct.status, direct.envelope.error?.code], [1, "USAGE_INVALID"]);
    check.match(direct.envelope.error?.message ?? "", /not within allowSubscribe/);
    const managed = preview([...base, flag, "updates"]);
    check.deepEqual([managed.status, managed.envelope.result?.kind], [0, "managed-launch-preview"]);
  }
  const emptySubscription = preview([...file, "--subscribe", ""]);
  check.deepEqual([emptySubscription.status, emptySubscription.envelope.result?.launched], [0, false]);

  for (const [selectors, placement] of [
    [[], "direct"], [["--foreground"], "direct"],
    [["--detach"], "managed"], [["--on", pin], "managed"], [["--detach", "--on", pin], "managed"],
  ] as const) {
    const { status, envelope } = preview([...file, ...selectors]);
    const result = envelope.result;
    check.deepEqual([status, result?.kind, result?.persona?.source ?? result?.requested?.source, result?.allocated, result?.launched],
      [0, `${placement}-launch-preview`, "file", false, false], selectors.join(" ") || "file only");
    if (placement === "managed") {
      const refused = preview([...file, ...selectors, "--foreground"]);
      check.deepEqual([refused.status, refused.envelope.error?.code], [1, "USAGE_INVALID"], selectors.join(" "));
    }
  }

  if (process.platform !== "win32" && process.getuid?.() !== 0) {
    const dir = join(realpathSync(root), "search permission");
    mkdirSync(dir, { mode: 0o600 });
    try {
      const refused = preview([...file, "--cwd", dir]);
      check.equal(refused.status, 2);
      check.equal(refused.envelope.error?.code, "PERMISSION_DENIED");
      check.deepEqual(refused.envelope.target, { space: "samplemesh", path: dir });
      const launch = cli(["spawn", "--foreground", "--harness", "missing-fixture-app", "--space", "samplemesh", "--cwd", dir]);
      check.equal(launch.status, 2);
      check.match(launch.stderr, /PERMISSION_DENIED/);
      chmodSync(dir, 0o100);
      const allowed = preview([...file, "--cwd", dir]);
      check.equal(allowed.status, 0);
      check.equal(allowed.envelope.result?.cwd, dir);
      check.equal(allowed.envelope.result?.launched, false);
    } finally { chmodSync(dir, 0o700); }
  }

  await killAndAwaitExit(broker);
  releaseBroker();
  children.splice(children.indexOf(broker), 1);

  const prepared = cli(["space", "create", "preview-cwd", "--root", join(root, "other-project"), "--plain"]);
  check.equal(prepared.status, 0, prepared.stdout + prepared.stderr);
  const direct = ["spawn", "--space", "preview-cwd", "--foreground", "--dry-run"];
  const requestedCwd = join(realpathSync(join(root, "project")), "missing folder");
  const badCwd = [...direct, "--cwd", "./missing folder"];
  const plain = cli([...badCwd, "--plain"]);
  check.equal(plain.status, 2, plain.stderr);
  check.ok(plain.stderr.includes(JSON.stringify(requestedCwd)), plain.stderr);
  check.match(plain.stderr, /Next\s+pass an existing directory to --cwd, or omit --cwd/);
  const json = preview([...badCwd, "--json"]);
  check.equal(json.status, 2);
  check.equal(json.envelope.error?.code, "TARGET_UNAVAILABLE");
  check.deepEqual(json.envelope.target, { space: "preview-cwd", path: requestedCwd });
  check.match(json.envelope.error?.remedy ?? "", /existing directory to --cwd, or omit --cwd/);
  check.equal(existsSync(requestedCwd), false);
  for (const override of [[], ["--cwd", "."]]) {
    const retry = preview([...direct, ...override, "--json"]);
    check.equal(retry.status, 0, JSON.stringify(retry.envelope));
    check.equal(retry.envelope.result?.cwd, realpathSync(join(root, "project")));
    check.equal(retry.envelope.result?.allocated, false);
    check.equal(retry.envelope.result?.launched, false);
  }
} finally {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await pause(1000);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  }
}
emitSentinel({ passed: counted.cells(), failed: 0 });
