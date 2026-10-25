import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { assertSmokeSandboxDown, freePort, recordSmokeSandbox } from "@cotal-ai/smoke-kit";

// Run the built CLI with its bundled broker, without the operator's home, credentials or PATH tools.
// Retain command output and roots for inspection. Teardown uses only the sandbox's own CLI route.
// The agent route spawns a seat through the manager. Its `claude` is a stand-in first on PATH: a
// mesh endpoint that joins presence with the credentials the manager minted, so no model runs.
process.umask(0o077);
const windows = process.platform === "win32";
const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
if (windows) assert.ok(systemRoot, "the Windows runner must provide its system directory");
const systemDirectories = windows ? [join(systemRoot!, "System32"), systemRoot!] : ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
const source = resolve(import.meta.dirname, "../..");
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim();
const root = realpathSync(mkdtempSync(join(tmpdir(), "cotal-startup-native-")));
const receipt = process.env.COTAL_STARTUP_RESULTS ?? join(root, "result.json");
const logs = `${receipt}.logs`;
mkdirSync(logs, { mode: 0o700 });
writeFileSync(receipt, "", { flag: "wx", mode: 0o600 });
const results: { scenario: string; root: string; commands: { args: string[]; status: number | null; signal: string | null }[]; error?: string; stopped?: boolean }[] = [];
const save = () => writeFileSync(receipt, JSON.stringify({ platform: process.platform, arch: process.arch, node: process.version, source, commit, results }, null, 2) + "\n");
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; } };
const until = async (condition: () => boolean, ms: number) => {
  for (const deadline = Date.now() + ms; Date.now() < deadline; await new Promise((done) => setTimeout(done, 200))) if (condition()) return true;
  return condition();
};
const reachable = (port: number) => new Promise<boolean>((done) => {
  const socket = createConnection({ host: "127.0.0.1", port });
  socket.once("connect", () => { socket.destroy(); done(true); });
  socket.once("error", () => done(false));
  socket.setTimeout(500, () => { socket.destroy(); done(false); });
});

for (const scenario of ["fresh", "prepared", "agent"]) {
  const base = join(root, scenario);
  const home = join(base, "home");
  const cotalHome = join(home, ".cotal");
  const project = join(home, "Projects", scenario);
  const config = join(home, ".config");
  // A seat's control socket is a fixed 44-byte name in TMPDIR, and macOS allows 104 bytes in a socket
  // path, so the agent route takes a short temporary directory beside this run's root.
  const temp = scenario === "agent" ? mkdtempSync(join(tmpdir(), "s-")) : join(base, "tmp");
  if (scenario === "agent" && !windows) assert.ok(Buffer.byteLength(temp) <= 60, `the agent route needs a temporary directory of at most 60 bytes: ${temp}`);
  const stand = join(base, "stand-in");
  for (const path of [cotalHome, project, config, temp, stand]) mkdirSync(path, { recursive: true, mode: 0o700 });
  const seatPid = join(stand, "seat.pid");
  if (scenario === "agent") {
    const shim = join(stand, "seat.cjs");
    writeFileSync(shim, [
      `const fs = require("node:fs"), { pathToFileURL } = require("node:url");`,
      `fs.writeFileSync(${JSON.stringify(seatPid)}, String(process.pid));`,
      `const material = JSON.parse(fs.readFileSync(process.env.COTAL_LAUNCH_MATERIAL, "utf8"));`,
      `import(pathToFileURL(${JSON.stringify(join(source, "packages/core/dist/index.js"))}).href).then(async ({ CotalEndpoint }) => {`,
      `  const endpoint = new CotalEndpoint({ space: process.env.COTAL_SPACE, servers: material.servers, creds: material.creds ? fs.readFileSync(material.creds, "utf8") : undefined,`,
      `    lifecycleUid: process.env.COTAL_LIFECYCLE_UID || undefined, channels: [], consume: false, registerPresence: true, watchPresence: false,`,
      `    card: { id: process.env.COTAL_ID || undefined, name: process.env.COTAL_NAME, kind: "agent" } });`,
      `  endpoint.on("error", () => {});`,
      `  await endpoint.start();`,
      `  setInterval(() => {}, 1000);`,
      `});`,
    ].join("\n"), { mode: 0o600 });
    // Windows runs a .cmd shim through cmd.exe, which would expand a % in either path.
    if (windows) assert.ok(!/[%"]/.test(process.execPath + shim), "the stand-in paths must not hold % or \"");
    if (windows) writeFileSync(join(stand, "claude.cmd"), `@"${process.execPath}" "${shim}"\r\n`, { mode: 0o700 });
    else writeFileSync(join(stand, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${shim}"\n`, { mode: 0o700 });
    mkdirSync(join(project, ".cotal", "agents"), { recursive: true, mode: 0o700 });
    writeFileSync(join(project, ".cotal", "agents", "seat.md"), "---\nname: seat\nrole: worker\nsubscribe: []\nallowPublish: []\n---\nA stand-in seat for the native startup journey.\n");
  }
  const env: NodeJS.ProcessEnv = {
    PATH: [...(scenario === "agent" ? [stand] : []), dirname(process.execPath), ...systemDirectories].join(delimiter),
    HOME: home, USERPROFILE: home, COTAL_HOME: cotalHome, XDG_CONFIG_HOME: config,
    XDG_STATE_HOME: join(home, ".state"), XDG_CACHE_HOME: join(home, ".cache"),
    TMPDIR: temp, TEMP: temp, TMP: temp, DO_NOT_TRACK: "1", COTAL_TELEMETRY: "off", COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1",
    // The documented checkout opt-in for `ext seed`, which installs this checkout's connectors.
    ...(scenario === "agent" ? { COTAL_ALLOW_CHECKOUT_SEED: "1" } : {}),
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
    const result = spawnSync(process.execPath, [join(source, "bin/dist/cotal.js"), ...args], options);
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
    if (scenario === "prepared") success("space", "create", scenario);
    // The manager finds its connectors when it starts, so they are seeded before up.
    if (scenario === "agent") success("ext", "seed", "--repair");
    attempted = true;
    success("up", "-d", "--server", `nats://127.0.0.1:${port}`, "--host", "127.0.0.1");
    assert(await reachable(port), `${scenario}: broker listener is absent`);
    if (scenario === "agent") {
      const spawned = cli("spawn", "seat", "-d", "--no-events", "--name", "bard");
      assert.equal(spawned.status, 0, `agent: cotal spawn seat -d\n${spawned.stdout}\n${spawned.stderr}`);
      assert(spawned.stdout.includes("Agent joined") && /^\s*Agent:\s+bard$/m.test(spawned.stdout), `agent: the spawn did not report the seat joined\n${spawned.stdout}`);
      const pid = Number(readFileSync(seatPid, "utf8"));
      assert(Number.isSafeInteger(pid) && pid > 0 && alive(pid), `agent: the stand-in seat is not a live process (${pid})`);
      const listed = cli("ps");
      assert(listed.status === 0 && /\bbard\b/.test(listed.stdout), `agent: cotal ps does not list the seat\n${listed.stdout}\n${listed.stderr}`);
      success("stop", "bard");
      assert(await until(() => !alive(pid), 30_000), `agent: the seat process ${pid} still runs after cotal stop`);
      const after = cli("ps");
      assert(after.status === 0 && !/\bbard\b/.test(after.stdout), `agent: cotal ps still lists the stopped seat\n${after.stdout}\n${after.stderr}`);
    }
    success("ps");
    success("up", "-d");
    assert(await reachable(port), `${scenario}: refresh lost the broker listener`);
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
assert(results.every((row) => !row.error && row.stopped), "native startup did not complete every lifecycle; inspect command receipts");
