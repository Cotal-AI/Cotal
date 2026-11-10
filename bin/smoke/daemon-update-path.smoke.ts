/** Live shipped update against an owned daemon socket and recording native service. */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { killAndAwaitExit, skipSuite } from "@cotal-ai/smoke-kit";
import { serveDaemon } from "../daemon/server.js";
import { daemonPaths } from "../daemon/endpoint.js";

if (process.platform !== "linux") skipSuite("daemon update path: Linux recording supervisor only");
const repo = join(dirname(fileURLToPath(import.meta.url)), "../..");
const root = mkdtempSync(join(tmpdir(), "dup-"));
const home = join(root, "home"), runtime = join(root, "run"), native = join(root, "native");
for (const path of [home, runtime, native, join(root, ".cotal"), join(root, "tmp")]) mkdirSync(path, { mode: 0o700 });
const env: NodeJS.ProcessEnv = {
  PATH: `${native}:${process.env.PATH}`, HOME: home, USER: "smoke", LOGNAME: "smoke",
  XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"),
  XDG_CACHE_HOME: join(root, "cache"), XDG_RUNTIME_DIR: runtime, TMPDIR: join(root, "tmp"),
  COTAL_HOME: home, COTAL_ALLOW_CHECKOUT_SEED: "1", COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_TELEMETRY: "off", DO_NOT_TRACK: "1", NO_COLOR: "1",
};
const paths = daemonPaths(env, home);
const old = await serveDaemon({ paths, version: "0.0.0", sessionDir: home });
let replacement: ChildProcess | undefined;
const calls: string[] = [];
async function status(): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = connect(paths.socket);
    let data = "";
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("status timeout")); }, 2000);
    socket.on("error", error => { clearTimeout(timer); reject(error); });
    socket.on("connect", () => socket.write('{"v":1,"id":"smoke","op":"status"}\n'));
    socket.on("data", chunk => {
      data += String(chunk);
      if (data.includes("\n")) { clearTimeout(timer); socket.destroy(); resolve(JSON.parse(data.split("\n")[0]!)); }
    });
  });
}
const control = createServer(async (request, response) => {
  try {
    calls.push(request.url!);
    if (request.url === "/stop") await old.close();
    else if (request.url === "/start") {
      replacement = spawn(process.execPath, [join(repo, "bin/dist/cotal.js"), "daemon", "serve"], { cwd: root, env, stdio: "ignore" });
      for (let i = 0; ; i++) {
        try { await status(); break; } catch { if (i >= 100) throw new Error("replacement not ready"); }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    } else throw new Error("unexpected native operation");
    response.end("ok");
  } catch (error) { response.writeHead(500).end(String(error)); }
});
const version = JSON.parse(readFileSync(join(repo, "bin/package.json"), "utf8")).version as string;
const seed = join(root, "config/cotal/seed");
mkdirSync(seed, { recursive: true, mode: 0o700 });
for (const file of ["authority.json", "authority.bak.json"]) writeFileSync(join(seed, file), JSON.stringify({ everSeeded: ["claude", "opencode", "codex", "hermes", "jcode", "pi", "web"] }));
writeFileSync(join(seed, "witness.json"), JSON.stringify({ initialized: true, firstGeneration: version }));
writeFileSync(join(seed, "stamp.json"), JSON.stringify({ generation: version }));
const registry = createServer((_request, response) => response.end(JSON.stringify({ name: "cotal-ai", "dist-tags": { latest: version }, versions: { [version]: { name: "cotal-ai", version } } })));
await new Promise<void>(resolve => control.listen(0, "127.0.0.1", resolve));
await new Promise<void>(resolve => registry.listen(0, "127.0.0.1", resolve));
const port = (control.address() as AddressInfo).port;
env.npm_config_registry = `http://127.0.0.1:${(registry.address() as AddressInfo).port}`;
writeFileSync(join(native, "systemctl"), `#!${process.execPath}\nconst op=process.argv.at(-2); if(!['stop','start'].includes(op))process.exit(99);fetch('http://127.0.0.1:${port}/'+op).then(r=>{if(!r.ok)process.exit(99)}).catch(()=>process.exit(99));\n`, { mode: 0o700 });
const bytes = `[Service]\nExecStart="${process.execPath}" "${join(repo, "bin/dist/cotal.js")}" daemon serve\nRestart=always\n`;
const unitPath = join(root, "cotal-daemon.service");
writeFileSync(unitPath, bytes, { mode: 0o600 });
writeFileSync(join(paths.state, "service-unit.json"), JSON.stringify({ v: 1, unit: "cotal-daemon.service", unitPath, unitSha256: createHash("sha256").update(bytes).digest("hex"), installedAt: new Date().toISOString() }));
try {
  const child = spawn(process.execPath, [join(repo, "bin/dist/cotal.js"), "update"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", b => output += String(b)); child.stderr.on("data", b => output += String(b));
  const code = await new Promise(resolve => child.once("exit", resolve));
  const after = await status();
  if (!calls.includes("/stop") || !calls.includes("/start") || after.result.version === "0.0.0") throw new Error(`R2-5 empty daemon not reloaded: ${JSON.stringify({ code, calls, after, output })}`);
  console.log("PASS R2-5 empty default daemon reload through shipped update");
} finally {
  await old.close();
  if (replacement) await killAndAwaitExit(replacement, "SIGTERM");
  await Promise.all([control, registry].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  if (existsSync(paths.socket) || control.listening || registry.listening) throw new Error("owned update fixture did not close");
  console.log("PASS owned daemon and loopback listeners closed");
}
