/** Native broker logging, failed detached startup and preserved-launch regression checks. */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { emitSentinel, freePort, recordSmokeSandbox, assertSmokeSandboxDown } from "@cotal-ai/smoke-kit";
import { makeScratch, assertScratchHeld } from "../../../bin/smoke/_scratch.js";

const scratch = makeScratch("cotal-broker-logging-");
const root = join(scratch, "mesh");
const home = join(scratch, "home");
mkdirSync(join(root, ".cotal"), { recursive: true });
mkdirSync(home);
const oldCwd = process.cwd();
const ambient = { ...process.env };
for (const key of Object.keys(process.env)) if (key.startsWith("COTAL_")) delete process.env[key];
process.env.COTAL_HOME = home;
process.env.XDG_CONFIG_HOME = join(home, "xdg");
process.env.COTAL_SKIP_CONNECTOR_SEED = "1";
process.chdir(root);
assertScratchHeld(root, "broker logging fixture");
const sandbox = recordSmokeSandbox({ root, cotalHome: home, xdgConfigHome: process.env.XDG_CONFIG_HOME });
const repo = resolve(import.meta.dirname, "../../..");
const cli = join(repo, "bin/cotal.ts");
const tsx = import.meta.resolve("tsx");
const { openServerConfig } = await import("@cotal-ai/core");
const { loadMeshes, readMaintenanceJournal, readMaintenanceResumeDocument } = await import("@cotal-ai/workspace");
const { resolveManifest } = await import("../src/lib/manifest/resolve.js");
const { startMeshDetached } = await import("../src/commands/up.js");
const children: ChildProcess[] = [];
let passed = 0;
let failed = 0;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function cell(name: string, body: () => unknown | Promise<unknown>) {
  try { await body(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}: ${(error as Error).message}`); }
}
async function command(args: string[], timeout = 90_000): Promise<{ code: number | null; text: string }> {
  const options = { cwd: root, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"] };
  assertSmokeSandboxDown(sandbox, args, options);
  const cp = spawn(process.execPath, ["--import", tsx, cli, ...args], options);
  children.push(cp);
  let text = "";
  cp.stdout!.on("data", (b: Buffer) => { text += b.toString(); });
  cp.stderr!.on("data", (b: Buffer) => { text += b.toString(); });
  return await new Promise((done, reject) => {
    const timer = setTimeout(() => { cp.kill("SIGTERM"); reject(new Error(`command ${args[0]} exceeded deadline`)); }, timeout);
    cp.once("error", (e) => { clearTimeout(timer); reject(e); });
    cp.once("exit", (code) => { clearTimeout(timer); done({ code, text }); });
  });
}
const storeDir = join(root, ".cotal/nats");
const transport = { kind: "plaintext" } as const;
const logFile = join(root, "broker.log");
const bounds = { logfileSizeLimit: 4096, logfileMaxNum: 3 };
try {
  // Use the real parser for every accepted benign spelling. Delimiters stay inside the quoted path.
  for (const [name, path] of [["plain", logFile], ["quoted-delimiters", join(root, 'quote"} # include text.log')]] as const) {
    await cell(`native-parser-${name}`, () => {
      const conf = join(root, `${name}.conf`);
      writeFileSync(conf, openServerConfig({ storeDir, transport, logFile: path, ...bounds }));
      const r = spawnSync("nats-server", ["-t", "-c", conf], { encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
    });
  }
  for (const [name, control] of [["backspace", "\b"], ["form-feed", "\f"], ["control-one", "\x01"], ["tab", "\t"], ["delete", "\x7f"]] as const) {
    // Test the stock parser even when the input guard refuses the path. This is an observation,
    // not a second renderer: replace only the known-safe quoted path in shipped generated config.
    const path = join(root, `${name}${control}.log`);
    const conf = join(root, `${name}.conf`);
    const text = openServerConfig({ storeDir, transport, logFile }).replace(JSON.stringify(logFile), JSON.stringify(path));
    writeFileSync(conf, text);
    const parsed = spawnSync("nats-server", ["-t", "-c", conf], { encoding: "utf8" });
    console.log(`NATIVE-PARSER ${name} exit=${parsed.status}`);
    await cell(`F2-core-reject-${name}`, () => assert.throws(() => openServerConfig({ storeDir, transport, logFile: path }), /logFile/));
    await cell(`F2-manifest-reject-${name}`, () => assert.throws(() => resolveManifest(`apiVersion: cotal/v1\nkind: Mesh\nchannels: {}\nspace: fixture\nbroker:\n  logFile: ${JSON.stringify(path)}\n`, join(root, "cotal.yaml")), /logFile/));
    await cell(`F2-cli-reject-${name}`, async () => {
      const r = await command(["up", "--log-file", path, "--server", "nats://127.0.0.1:1", "--store-dir", join(root, "bad\bstore"), "--open", "--no-manager"]);
      assert.notEqual(r.code, 0);
      assert.match(r.text, /--log-file must/);
    });
  }
  await cell("F3-core-refuses-bounds-without-file", () => assert.throws(() => openServerConfig({ storeDir, transport, ...bounds }), /logFile/));
  await cell("F3-foreground-refuses-bounds-without-file", async () => {
    const r = await command(["up", "--open", "--no-manager", "--server", "nats://127.0.0.1:1", "--store-dir", join(root, "bad\bstore"), "--logfile-size-limit", "4096"]);
    assert.notEqual(r.code, 0);
    assert.match(r.text, /require.*--log-file/);
  });
  await cell("F3-detached-refuses-bounds-without-file", async () => {
    const r = await command(["up", "--detach", "--open", "--no-manager", "--server", "nats://127.0.0.1:1", "--store-dir", join(root, "bad\bstore"), "--logfile-max-num", "3"]);
    assert.notEqual(r.code, 0);
    assert.match(r.text, /require.*--log-file/);
  });
  await cell("F3-manifest-refuses-bounds-without-file", () => assert.throws(() => resolveManifest("apiVersion: cotal/v1\nkind: Mesh\nchannels: {}\nspace: fixture\nbroker:\n  logfileMaxNum: 3\n", join(root, "cotal.yaml")), /logFile/));
  await cell("F4-minor-changeset", () => {
    const feature = readdirSync(join(repo, ".changeset")).filter((f) => f.endsWith(".md")).map((f) => readFileSync(join(repo, ".changeset", f), "utf8"));
    assert.ok(feature.some((s) => /["']?@cotal-ai\/core["']?: minor/.test(s) && /["']?@cotal-ai\/cli["']?: minor/.test(s) && /log.*rotat/i.test(s)), "new logging options need core and CLI minor release metadata");
  });
  for (const kind of ["config", "log-open"] as const) {
    await cell(`F1-detached-native-${kind}-diagnostic`, async () => {
      const badLog = join(root, `${kind}-log`);
      if (kind === "log-open") mkdirSync(badLog);
      const badStore = kind === "config" ? join(root, "bad\bstore") : storeDir;
      const lines: string[] = [];
      let error = "";
      try { await startMeshDetached({ transport, server: "nats://127.0.0.1:1", space: "logging-failure", open: true, noManager: true, logFile: badLog, storeDir: badStore, onLine: (line) => lines.push(line) }); }
      catch (e) { error = (e as Error).message; }
      assert.ok(error, "native failure must refuse readiness");
      assert.equal(existsSync(join(root, ".cotal/nats.pid")), false, "failed child is unrecorded");
      const diagnostic = error + "\n" + lines.join("\n");
      assert.match(diagnostic, kind === "config" ? /[Ii]nvalid escape/ : /[Ii]s a directory/);
    });
  }
  await cell("R433-existing-startup-log-is-private", async () => {
    const startup = join(root, ".cotal/nats-startup.log");
    writeFileSync(startup, "prior log"); chmodSync(startup, 0o644);
    try { await startMeshDetached({ transport, server: "nats://127.0.0.1:1", space: "logging-failure", open: true, noManager: true,
      logFile, storeDir: join(root, "bad\bstore") }); } catch {}
    assert.equal(statSync(startup).mode & 0o777, 0o600);
  });
  await cell("R433-startup-path-cannot-be-native-log", async () => {
    await assert.rejects(() => startMeshDetached({ transport, server: "nats://127.0.0.1:1", space: "logging-failure", open: true, noManager: true,
      logFile: join(root, ".cotal/nats-startup.log"), storeDir: join(root, "bad\bstore") }), /log-file.*startup/);
  });
  // Real registry -> preservation document -> ordinary resume. No supplied log flags on resume.
  const port = await freePort();
  const server = `nats://127.0.0.1:${port}`;
  const first = await command(["up", "--detach", "--server", server, "--space", "logging-resume", "--log-file", logFile, "--logfile-size-limit", "4096", "--logfile-max-num", "3"], 150_000);
  await cell("resume-fixture-starts", () => assert.equal(first.code, 0, first.text));
  if (first.code === 0) {
    await cell("F5-launch-registry-retains-log-options", () => {
      const mesh = loadMeshes().find((m) => m.root === root) as unknown as Record<string, unknown>;
      assert.equal(mesh.logFile, logFile);
      assert.equal(mesh.logfileSizeLimit, 4096);
      assert.equal(mesh.logfileMaxNum, 3);
    });
    let ready = false;
    for (let i = 0; i < 15 && !ready; i++) {
      const r = await command(["channels", "set", "fixture", "--desc", "fixture", "--space", "logging-resume"], 20_000);
      ready = r.code === 0;
      if (!ready) await sleep(1000);
    }
    await cell("resume-manager-ready", () => assert.ok(ready));
    const cut = await command(["down", "--preserve-state"], 150_000);
    await cell("resume-preservation-succeeds", () => assert.equal(cut.code, 0, cut.text));
    if (cut.code === 0) {
      await cell("F5-preserved-launch-retains-log-options", () => {
        const j = readMaintenanceJournal(root)!;
        const launch = readMaintenanceResumeDocument(root, j.resume).launch as Record<string, unknown>;
        assert.equal(launch.logFile, logFile);
        assert.equal(launch.logfileSizeLimit, 4096);
        assert.equal(launch.logfileMaxNum, 3);
      });
      const resumed = await command(["up", "--detach"], 150_000);
      await cell("resume-without-log-flags-succeeds", () => assert.equal(resumed.code, 0, resumed.text));
      await cell("F5-resume-config-retains-log-options", () => {
        const conf = readFileSync(join(root, ".cotal/auth/server.conf"), "utf8");
        assert.ok(conf.includes(`log_file: ${JSON.stringify(logFile)}`));
        assert.ok(conf.includes("logfile_size_limit: 4096"));
        assert.ok(conf.includes("logfile_max_num: 3"));
      });
    }
  }
} finally {
  // The smoke-kit verifies cwd, home and root before allowing the owned scoped down.
  const down = await command(["down"], 60_000).catch((e) => ({ code: -1, text: String(e) }));
  console.log(`CLEANUP scoped-down exit=${down.code}`);
  for (const cp of children) if (cp.exitCode === null && cp.signalCode === null) cp.kill("SIGTERM");
  // Only a failed test's recorded broker can remain. Kill its PID, never search argv or other roots.
  const pidFile = join(root, ".cotal/nats.pid");
  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    if (Number.isSafeInteger(pid) && pid > 1) { try { process.kill(pid, "SIGTERM"); } catch {} }
  }
  process.chdir(oldCwd);
  for (const key of Object.keys(process.env)) if (!(key in ambient)) delete process.env[key];
  Object.assign(process.env, ambient);
  rmSync(scratch, { recursive: true, force: true });
}
console.log(`BROKER_LOGGING cells=${passed + failed} passed=${passed} failed=${failed}`);
emitSentinel({ passed, failed });
assert.equal(failed, 0, "broker logging regression cells");
