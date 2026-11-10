/** Silent listeners stay distinct from refused ports across the shipped CLI's space reports. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const bin = join(import.meta.dirname, "../../../bin/dist/cotal.js");
process.umask(0o077);
const root = mkdtempSync(join(tmpdir(), "cotal-silent-broker-"));
const hostEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_")));
const failures: string[] = [];
function check(name: string, condition: boolean): void {
  console.log(`${condition ? "PASS" : "FAIL"}: ${name}`);
  if (!condition) failures.push(name);
}
async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return address.port;
}
async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

async function scenario(name: "silent" | "refused", port: number, connections: () => number): Promise<void> {
  const home = join(root, name);
  const project = join(home, "project");
  mkdirSync(join(home, ".cotal"), { recursive: true });
  mkdirSync(project);
  async function run(args: string[]) {
    const before = connections();
    const started = Date.now();
    const child = spawn(process.execPath, [bin, ...args], {
      cwd: home,
      env: { ...hostEnv, HOME: home, USERPROFILE: home, COTAL_HOME: join(home, "state"), XDG_CONFIG_HOME: join(home, "xdg"), XDG_DATA_HOME: join(home, "data"), COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_TELEMETRY: "off", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += String(chunk); });
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    const timer = setTimeout(() => child.kill("SIGKILL"), 45_000);
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    }).finally(() => clearTimeout(timer));
    const result = { args, code, ms: Date.now() - started, probes: connections() - before, stdout, stderr };
    console.log(JSON.stringify({ scenario: name, ...result }));
    return result;
  }
  const added = await run(["space", "add", name, "--server", `nats://127.0.0.1:${port}`, "--root", project, "--mode", "open", "--force", "--yes"]);
  assert.equal(added.code, 0, added.stderr);
  assert.equal((await run(["use", name])).code, 0);
  const expected = name === "silent" ? "slow-link" : "unreachable";
  for (const format of [[], ["--plain"], ["--json"]]) {
    const result = await run(["status", ...format]);
    check(`${name} status ${format} exits 0`, result.code === 0);
    if (name === "silent") check(`status ${format} runs one preflight (two probe attempts)`, result.probes === 2);
    if (format.includes("--json")) {
      const json = JSON.parse(result.stdout).result;
      check(`${name} selected connection`, json.selected.connection === expected);
      check(`${name} status space row`, json.meshes.items.find((item: { space: string }) => item.space === name)?.check === expected);
    } else {
      check(`${name} status label`, result.stdout.includes(name === "silent" ? "not answering" : "unreachable"));
      check(`${name} status no old timeout label`, !result.stdout.includes("connection timed out"));
    }
  }
  for (const command of [["send", "-c", "general", "x"], ["who"]]) {
    const result = await run(command);
    check(`${name} ${command[0]} refuses with exit 2`, result.code === 2);
    check(`${name} ${command[0]} diagnosis`, (result.stdout + result.stderr).includes(name === "silent" ? "not answering" : "no broker answered"));
  }
  for (const command of [["space"], ["space", "show", name]]) {
    for (const format of [[], ["--plain"], ["--json"]]) {
      const result = await run([...command, ...format]);
      check(`${name} ${command.join(" ")} ${format} exits 0`, result.code === 0);
      if (format.includes("--json")) {
        const json = JSON.parse(result.stdout).result;
        check(`${name} ${command.join(" ")} check`, (json.items?.find((item: { space: string }) => item.space === name) ?? json).check === expected);
      } else check(`${name} ${command.join(" ")} label`, result.stdout.includes(name === "silent" ? "not answering" : "unreachable"));
    }
  }
  // A silent observation must never delete the manual registration.
  assert.equal((await run(["space", "show", name, "--json"])).code, 0);
}

const sockets = new Set<Socket>();
let connections = 0;
const silent = createServer(socket => {
  connections++;
  sockets.add(socket);
  socket.on("error", () => {});
  socket.on("close", () => sockets.delete(socket));
  socket.resume();
});
try {
  const port = await listen(silent);
  await scenario("silent", port, () => connections);
} finally {
  for (const socket of sockets) socket.destroy();
  await close(silent);
}
const refused = createServer();
const port = await listen(refused);
await close(refused);
await scenario("refused", port, () => 0);
console.log(`Retained sandbox: ${root}`);
assert.deepEqual(failures, [], "silent broker regression failures");
