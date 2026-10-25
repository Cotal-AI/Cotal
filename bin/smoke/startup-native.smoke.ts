import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { assertSmokeSandboxDown, freePort, recordSmokeSandbox } from "@cotal-ai/smoke-kit";

// Run the built CLI with its bundled broker, without the operator's home, credentials or PATH tools.
// Retain command output and roots for inspection. Teardown uses only the sandbox's own CLI route.
const source = resolve(import.meta.dirname, "../..");
const root = mkdtempSync(join(tmpdir(), "cotal-startup-native-"));
const receipt = process.env.COTAL_STARTUP_RESULTS ?? join(root, "result.json");
const logs = `${receipt}.logs`;
mkdirSync(logs, { mode: 0o700 });
writeFileSync(receipt, "", { flag: "wx", mode: 0o600 });
const results: { scenario: string; root: string; commands: { args: string[]; status: number | null; signal: string | null }[]; error?: string; stopped?: boolean }[] = [];
const save = () => writeFileSync(receipt, JSON.stringify({ platform: process.platform, arch: process.arch, node: process.version, source, results }, null, 2) + "\n");
const reachable = (port: number) => new Promise<boolean>((done) => {
  const socket = createConnection({ host: "127.0.0.1", port });
  socket.once("connect", () => { socket.destroy(); done(true); });
  socket.once("error", () => done(false));
  socket.setTimeout(500, () => { socket.destroy(); done(false); });
});

for (const scenario of ["fresh", "prepared"]) {
  const base = join(root, scenario);
  const home = join(base, "home");
  const cotalHome = join(home, ".cotal");
  const project = join(home, "Projects", scenario);
  const config = join(home, ".config");
  const temp = join(base, "tmp");
  for (const path of [cotalHome, project, config, temp]) mkdirSync(path, { recursive: true, mode: 0o700 });
  const env: NodeJS.ProcessEnv = {
    PATH: [dirname(process.execPath), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
    HOME: home, USERPROFILE: home, COTAL_HOME: cotalHome, XDG_CONFIG_HOME: config,
    XDG_STATE_HOME: join(home, ".state"), XDG_CACHE_HOME: join(home, ".cache"),
    TMPDIR: temp, DO_NOT_TRACK: "1", COTAL_TELEMETRY: "off", COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1",
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
    attempted = true;
    success("up", "-d", "--server", `nats://127.0.0.1:${port}`, "--host", "127.0.0.1");
    assert(await reachable(port), `${scenario}: broker listener is absent`);
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
assert(results.every((row) => !row.error && row.stopped), "native startup did not complete both fresh and prepared lifecycles; inspect command receipts");
