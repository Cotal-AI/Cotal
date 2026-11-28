import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { assertSmokeSandboxDown, freePort, recordSmokeSandbox } from "@cotal-ai/smoke-kit";
import { verifyIdentityPin } from "@cotal-ai/workspace";
import { acquireWindowsSeatStoreFence } from "@cotal-ai/seat";
import { windowsDetachedSeatOccupancy } from "../daemon/manager-custody-win32.js";

// Run the built CLI with its bundled broker, without the operator's home, credentials or PATH tools.
// Retain command output and roots for inspection. Teardown uses only the sandbox's own CLI route.
process.umask(0o077);
const windows = process.platform === "win32";
const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
if (windows) assert.ok(systemRoot, "the Windows runner must provide its system directory");
const systemDirectories = windows ? [join(systemRoot!, "System32"), systemRoot!] : ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
const source = resolve(import.meta.dirname, "../..");
const cliPath = join(source, "bin/dist/cotal.js");
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim();
const root = realpathSync(mkdtempSync(join(tmpdir(), "cotal-startup-native-")));
if (windows) {
  const home = mkdtempSync(join(root, "custody-profile-"));
  const previous = process.env.LOCALAPPDATA;
  try {
    process.env.LOCALAPPDATA = join(home, "AppData", "Local");
    assert.equal(windowsDetachedSeatOccupancy(source), "empty", "a missing private LOCALAPPDATA is not a held seat");
    assert.equal(windowsDetachedSeatOccupancy(source, "retention"), "empty");
    const release = acquireWindowsSeatStoreFence(source);
    release?.();
    assert.equal(release, undefined, "there is no store to lock");
    assert.deepEqual(readdirSync(home), [], "the custody checks must not create the private profile");
    writeFileSync(join(home, "AppData"), "not a directory");
    assert.equal(windowsDetachedSeatOccupancy(source), "unknown", "an obstructed profile path is not empty");
    assert.throws(() => acquireWindowsSeatStoreFence(source));
    console.log("Windows detached custody passed missing and obstructed private profile checks");
  } finally {
    if (previous === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previous;
  }
}
const receipt = process.env.COTAL_STARTUP_RESULTS ?? join(root, "result.json");
const logs = `${receipt}.logs`;
mkdirSync(logs, { mode: 0o700 });
writeFileSync(receipt, "", { flag: "wx", mode: 0o600 });
const results: { scenario: string; root: string; commands: { args: string[]; status: number | null; signal: string | null }[]; error?: string; stopped?: boolean }[] = [];
const save = () => writeFileSync(receipt, JSON.stringify({ platform: process.platform, arch: process.arch, node: process.version, source, commit, results }, null, 2) + "\n");
const reachable = (port: number) => new Promise<boolean>((done) => {
  const socket = createConnection({ host: "127.0.0.1", port });
  socket.once("connect", () => { socket.destroy(); done(true); });
  socket.once("error", () => done(false));
  socket.setTimeout(500, () => { socket.destroy(); done(false); });
});

async function checkForeground(cli: (...args: string[]) => SpawnSyncReturns<string>, project: string, env: NodeJS.ProcessEnv, port: number, scenario: string): Promise<void> {
  const crash = scenario === "foreground-crash", auth = scenario === "foreground-auth";
  const args = ["up", "--foreground", "--no-manager", "--server", `nats://127.0.0.1:${port}`, ...(auth ? ["--space", "ux-live", "--no-input"] : ["--open"])];
  const child = spawn(process.execPath, [cliPath, ...args], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  child.stdout.setEncoding("utf8").on("data", (part: string) => { out += part; });
  child.stderr.setEncoding("utf8").on("data", (part: string) => { err += part; });
  const exited = new Promise<void>((accept) => child.once("close", () => accept()));
  child.once("error", (error) => { err += error.message; });
  try {
    for (const deadline = Date.now() + 30_000; !out.includes("automatically selected") && child.exitCode === null && Date.now() < deadline;) await delay(100);
    assert.match(out, /automatically selected/, err);
    if (crash) {
      const pin = verifyIdentityPin(join(project, ".cotal", "nats.pid"));
      assert.equal(pin.kind, "match");
      process.kill(pin.record.pid, "SIGTERM");
    } else {
      if (auth) {
        const sent = cli("send", "-c", "general", "lifecycle-probe");
        assert.equal(sent.status, 0, sent.stdout + sent.stderr);
      }
      const down = cli("down", "--yes");
      assert.equal(down.status, 0, down.stdout + down.stderr);
    }
    await Promise.race([exited, delay(30_000, undefined, { ref: false })]);
    assert.equal(child.exitCode, crash ? 5 : 0, out + err);
    if (crash) assert.match(err, /nats-server exited unexpectedly/);
    else assert.doesNotMatch(err, /nats-server exited unexpectedly/);
  } finally {
    if (child.exitCode === null) cli("down", "--yes");
    writeFileSync(join(logs, `${scenario}.stdout`), out);
    writeFileSync(join(logs, `${scenario}.stderr`), err);
  }
}

for (const scenario of ["fresh", "prepared", ...(windows ? ["foreground-down", "foreground-auth", "foreground-crash"] : [])]) {
  const base = join(root, scenario);
  const home = join(base, "home");
  const cotalHome = join(home, ".cotal");
  const project = join(home, "Projects", scenario);
  const config = join(home, ".config");
  const temp = join(base, "tmp");
  for (const path of [cotalHome, project, config, temp]) mkdirSync(path, { recursive: true, mode: 0o700 });
  const env: NodeJS.ProcessEnv = {
    PATH: [dirname(process.execPath), ...systemDirectories].join(delimiter),
    HOME: home, USERPROFILE: home, COTAL_HOME: cotalHome, XDG_CONFIG_HOME: config,
    XDG_STATE_HOME: join(home, ".state"), XDG_CACHE_HOME: join(home, ".cache"),
    TMPDIR: temp, TEMP: temp, TMP: temp, DO_NOT_TRACK: "1", COTAL_TELEMETRY: "off", COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1",
    ...(windows ? {
      SystemRoot: systemRoot, WINDIR: systemRoot, COMSPEC: join(systemRoot!, "System32", "cmd.exe"),
      PATHEXT: process.env.PATHEXT, USERNAME: process.env.USERNAME, USERDOMAIN: process.env.USERDOMAIN,
      APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local"),
    } : {}),
  };
  const anchor = recordSmokeSandbox({ root: project, cotalHome, xdgConfigHome: config });
  const row: typeof results[number] = { scenario, root: base, commands: [] };
  results.push(row);
  const port = await freePort();
  const cli = (...args: string[]) => {
    const options = { cwd: project, env, encoding: "utf8" as const, timeout: 90_000 };
    assertSmokeSandboxDown(anchor, args, options);
    const result = spawnSync(process.execPath, [cliPath, ...args], options);
    const name = `${scenario}-${row.commands.length}`;
    writeFileSync(join(logs, `${name}.stdout`), result.stdout ?? "", { flag: "wx" });
    writeFileSync(join(logs, `${name}.stderr`), result.stderr ?? "", { flag: "wx" });
    row.commands.push({ args, status: result.status, signal: result.signal });
    save();
    assert.ifError(result.error);
    return result;
  };
  const success = (...args: string[]) => {
    const result = cli(...args);
    assert.equal(result.status, 0, `${scenario}: cotal ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  };
  let attempted = false;
  try {
    if (scenario.startsWith("foreground-")) {
      await checkForeground(cli, project, env, port, scenario);
    } else {
      if (scenario === "prepared") success("space", "create", scenario);
      attempted = true;
      success("up", "-d", "--server", `nats://127.0.0.1:${port}`, "--host", "127.0.0.1");
      assert(await reachable(port), `${scenario}: broker listener is absent`);
      success("ps");
      success("up", "-d");
      assert(await reachable(port), `${scenario}: refresh lost the broker listener`);
    }
  } catch (error) {
    row.error = error instanceof Error ? error.message : String(error);
    console.error(row.error);
  } finally {
    try {
      if (attempted) success("down", "--yes");
      row.stopped = !(await reachable(port));
      assert(row.stopped, `${scenario}: sandbox broker listener remains after down`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      row.error = [row.error, message].filter(Boolean).join("\n");
      console.error(message);
    }
    save();
  }
  console.log(`${scenario}: ${row.error ? "FAIL" : "PASS"}; retained ${base}`);
}
console.log(`Startup receipts: ${receipt}`);
assert(results.every((row) => !row.error && row.stopped), "native startup did not complete both fresh and prepared lifecycles; inspect command receipts");
