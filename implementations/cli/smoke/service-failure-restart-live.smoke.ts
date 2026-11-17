/** Live service install/start/native-entry regression for #1014. The real CLI and broker run
 * under private homes. Only systemctl is a recorder: it loads the generated unit's argv and
 * failure policy, never the host user manager. This does not prove real OS restart or boot.
 * Retains logs and sandboxes. Run: pnpm smoke:service-failure-restart:live */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { assertSmokeSandboxDown, emitSentinel, freePort, recordSmokeSandbox } from "@cotal-ai/smoke-kit";
import { assertRecordIdentity, identityRecord } from "@cotal-ai/workspace";

if (process.platform !== "linux") {
  console.log("SKIP service-failure-restart: the installed per-service unit entry requires Linux");
  process.exit(0);
}
process.umask(0o077);
const tree = resolve(import.meta.dirname, "../../..");
const base = mkdtempSync(join(tmpdir(), "cotal-service-failure-restart-"));
const project = join(base, "control"), mesh = join(base, "mesh"), home = join(base, "home");
const config = join(base, "config"), machine = join(base, "machine"), native = join(base, "native"), pkg = join(base, "cli");
for (const dir of [project, mesh, home, config, machine, native, pkg, join(base, "runtime")]) mkdirSync(dir, { mode: 0o700 });
// A release-shaped entry uses the checkout's actual compiled programs and dependencies. Its
// private seed is installed through public service install, never fabricated with store writes.
cpSync(join(tree, "bin/dist"), join(pkg, "dist"), { recursive: true });
cpSync(join(tree, "bin/package.json"), join(pkg, "package.json"));
symlinkSync(join(tree, "bin/node_modules"), join(pkg, "node_modules"));
const cli = join(pkg, "dist/cotal.js");
const env: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(COTAL_|JCODE_|CLAUDE_|ANTHROPIC_|OPENAI_|INVOCATION_ID|NODE_OPTIONS)/.test(key))),
  HOME: home, COTAL_HOME: machine, XDG_CONFIG_HOME: config, XDG_RUNTIME_DIR: join(base, "runtime"),
  COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_TELEMETRY: "off", DO_NOT_TRACK: "1", PATH: `${native}:${process.env.PATH}`, NO_COLOR: "1",
};
const anchors = new Map([project, mesh].map((root) => [root, recordSmokeSandbox({ root, cotalHome: machine, xdgConfigHome: config })]));
interface Reply { code: number | null; signal: NodeJS.Signals | null; out: string; err: string }
let transcript = "";
async function command(cwd: string, args: string[], extra: NodeJS.ProcessEnv = {}): Promise<Reply> {
  const options = { cwd, env: { ...env, ...extra }, stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"] };
  assertSmokeSandboxDown(anchors.get(cwd), args, options);
  const child = spawn(process.execPath, [cli, ...args], options);
  let out = "", err = "";
  child.stdout.on("data", (data: Buffer) => { out += data; });
  child.stderr.on("data", (data: Buffer) => { err += data; });
  const timeout = setTimeout(() => child.kill("SIGTERM"), 120_000);
  try {
    return await new Promise<Reply>((done, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        transcript += `${args.join(" ")}\nexit=${code} signal=${signal}\n${out}${err}\n`;
        writeFileSync(join(base, "commands.log"), transcript);
        done({ code, signal, out, err });
      });
    });
  } finally { clearTimeout(timeout); }
}
const run = (...args: string[]) => command(project, args);
interface NativeState { unit: string; path: string; enabled: boolean; active: boolean; pid: number; invocation: string }
const statePath = join(base, "native.json");
let state: NativeState = { unit: "", path: "", enabled: false, active: false, pid: 0, invocation: "" };
const save = () => writeFileSync(statePath, JSON.stringify(state));
save();
let stopping = false, launches = 0, main: ChildProcess | undefined, restart: NodeJS.Timeout | undefined;
const children: ChildProcess[] = [], jobs = new Set<Promise<void>>();
function argv(key: string): string[] | undefined {
  const line = readFileSync(state.path, "utf8").split("\n").find((row) => row.startsWith(`${key}=`));
  if (!line) return undefined;
  const words = line.slice(key.length + 1).match(/"(?:\\.|[^"\\])*"/g);
  assert.ok(words, `${key} contains quoted native argv`);
  return words.map((word) => (JSON.parse(word) as string).replaceAll("%%", "%").replaceAll("$$", "$"));
}
async function launch(): Promise<void> {
  if (stopping) return;
  const args = argv("ExecStart"); assert.ok(args);
  const post = argv("ExecStartPost"); assert.ok(post, "generated units acknowledge readiness at every boot");
  const environmentFile = /^EnvironmentFile=(.*)$/m.exec(readFileSync(state.path, "utf8")); assert.ok(environmentFile);
  const unitEnv: NodeJS.ProcessEnv = {};
  for (const line of readFileSync(JSON.parse(environmentFile[1]!), "utf8").split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const at = line.indexOf("="); unitEnv[line.slice(0, at)] = JSON.parse(line.slice(at + 1));
  }
  state.invocation = randomBytes(16).toString("hex"); state.active = true;
  const current = spawn(args[0]!, args.slice(1), { cwd: project, env: { ...env, ...unitEnv, INVOCATION_ID: state.invocation }, stdio: ["ignore", "pipe", "pipe"] });
  main = current; children.push(current);
  const number = ++launches;
  state.pid = current.pid!; save();
  let output = "";
  const capture = (data: Buffer) => { output += data; writeFileSync(join(base, `unit-${number}.log`), output); };
  current.stdout.on("data", capture); current.stderr.on("data", capture);
  current.once("exit", (code, signal) => {
    if (main !== current) return;
    state.active = false; state.pid = 0; save();
    const source = readFileSync(state.path, "utf8");
    if (!stopping && /^Restart=on-failure$/m.test(source) && (code !== 0 || signal)) {
      restart = setTimeout(() => {
        const job = launch(); jobs.add(job);
        void job.catch((error) => { writeFileSync(join(base, "restart-error.log"), String(error)); }).finally(() => jobs.delete(job));
      }, 5000);
    }
  });
  // Type=simple starts the post command concurrently with main-entry startup.
  const observer = spawn(post[0]!, post.slice(1), { cwd: project, env: { ...env, ...unitEnv, INVOCATION_ID: state.invocation }, stdio: ["ignore", "pipe", "pipe"] });
  children.push(observer);
  let observed = "";
  observer.stdout.on("data", (data: Buffer) => { observed += data; });
  observer.stderr.on("data", (data: Buffer) => { observed += data; });
  const code = await new Promise<number | null>((done) => observer.once("close", done));
  writeFileSync(join(base, `post-${number}.log`), observed);
  assert.equal(code, 0, observed);
}
async function stop(): Promise<void> {
  stopping = true; clearTimeout(restart);
  if (main && main.exitCode === null && main.signalCode === null) {
    const gone = new Promise<void>((done) => main!.once("exit", () => done()));
    main.kill("SIGTERM"); await gone;
  }
  state.active = false; state.pid = 0; save();
}
const server = createServer(async (request, response) => {
  try {
    if (request.url === "/start") { stopping = false; await launch(); }
    else if (request.url === "/stop") await stop();
    else { response.writeHead(404); response.end(); return; }
    response.end("ok");
  } catch (error) { response.writeHead(500); response.end(String(error)); }
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const address = server.address(); assert.ok(address && typeof address !== "string");
const endpoint = `http://127.0.0.1:${address.port}`;
writeFileSync(join(native, "systemctl"), `#!${process.execPath}
const fs = require("node:fs");
(async () => {
  const args = process.argv.slice(2), path = ${JSON.stringify(statePath)};
  const state = JSON.parse(fs.readFileSync(path));
  fs.appendFileSync(${JSON.stringify(join(base, "native-calls.log"))}, args.join(" ") + "\\n");
  if (args.includes("show-environment")) { console.log(${JSON.stringify(`HOME=${home}\nXDG_CONFIG_HOME=${config}`)}); return; }
  if (args.includes("daemon-reload")) return;
  if (args.includes("enable") || args.includes("disable")) { state.enabled = args.includes("enable"); fs.writeFileSync(path, JSON.stringify(state)); return; }
  if (args.includes("show")) {
    const unit = args[args.indexOf("show") + 1];
    console.log(["Id=" + unit, "LoadState=loaded", "ActiveState=" + (state.active ? "active" : "inactive"), "SubState=" + (state.active ? "running" : "dead"), "UnitFileState=" + (state.enabled ? "enabled" : "disabled"), "MainPID=" + state.pid, "InvocationID=" + state.invocation, "FragmentPath=" + ${JSON.stringify(join(config, "systemd/user"))} + "/" + unit, "NeedDaemonReload=no", "DropInPaths="].join("\\n")); return;
  }
  const op = args.includes("start") ? "start" : args.includes("stop") ? "stop" : null;
  if (!op) process.exit(99);
  const result = await fetch(${JSON.stringify(endpoint)} + "/" + op);
  if (!result.ok) { console.error(await result.text()); process.exit(98); }
})().catch(error => { console.error(String(error)); process.exit(97); });
`, { mode: 0o700 });
for (const tool of ["loginctl", "launchctl", "schtasks"]) writeFileSync(join(native, tool), "#!/bin/sh\nexit 99\n", { mode: 0o700 });
interface Instance { definition: string; observedProcess: string; pid: number | null }
async function broker(): Promise<number | undefined> {
  const reply = await run("status", "--space", "mesh1014", "--json");
  if (reply.code !== 0) return undefined;
  const report = JSON.parse(reply.out) as { result: { selected: { resolved: boolean; code?: string }; services: { instances: Instance[] | null } } };
  if (!report.result.selected.resolved && report.result.selected.code === "not-started") return undefined;
  const rows = report.result.services.instances;
  assert.ok(rows, "status must inspect the selected running stack's service records");
  const journal = join(mesh, ".cotal/stack-controller.json");
  if (!existsSync(journal) || JSON.parse(readFileSync(journal, "utf8")).operation.phase !== "completed") return undefined;
  if (!rows.some((row) => row.definition === "stack-delivery" && row.observedProcess === "running")) return undefined;
  return rows.find((row) => row.definition === "stack-broker" && row.observedProcess === "running")?.pid ?? undefined;
}
async function readyBroker(previous?: number): Promise<number> {
  for (const deadline = Date.now() + 120_000; Date.now() < deadline; await delay(200)) {
    const pid = await broker(); if (pid && pid !== previous) return pid;
  }
  throw new Error("the authenticated stack did not become ready");
}
let checks = 0;
console.log(`service-failure-restart evidence: ${base}`);
try {
  let reply = await run("space", "create", "native1014"); assert.equal(reply.code, 0, reply.err); checks++;
  reply = await run("space", "create", "mesh1014", "--root", mesh); assert.equal(reply.code, 0, reply.err); checks++;
  const file = join(base, "service.json");
  writeFileSync(file, JSON.stringify({ schemaVersion: 1, space: "native1014", launch: { type: "process", executable: process.execPath, args: [cli, "up", "--foreground", "--root", mesh, "--space", "mesh1014", "--server", `nats://127.0.0.1:${await freePort()}`, "--no-manager"], cwd: mesh }, readiness: { type: "process", timeoutMs: 10000 } }));
  reply = await run("service", "add", "stack-owner", "--space", "native1014", "--file", file, "--json"); assert.equal(reply.code, 0, reply.out); checks++;
  reply = await run("service", "install", "stack-owner", "--space", "native1014", "--json"); assert.equal(reply.code, 0, reply.out); checks++;
  const installed = JSON.parse(reply.out).result as { unit: string; unitPath: string };
  state = { ...JSON.parse(readFileSync(statePath, "utf8")), unit: installed.unit, path: installed.unitPath }; save();
  assert.match(readFileSync(state.path, "utf8"), /^Restart=on-failure\nRestartSec=5s$/m); checks++;
  reply = await run("service", "start", "stack-owner", "--space", "native1014", "--json"); assert.equal(reply.code, 0, reply.out); checks++;
  const first = await readyBroker();
  const pin = identityRecord(first); assert.ok("token" in pin); assert.equal(assertRecordIdentity(pin).kind, "match"); checks++;
  const before = JSON.parse(readFileSync(join(mesh, ".cotal/stack-controller.json"), "utf8")).broker;
  process.kill(first, "SIGKILL");
  const restored = await readyBroker(first); assert.notEqual(restored, first); checks++;
  assert.equal(launches, 2, "recorded OS failure policy restarted the foreground owner once"); checks++;
  reply = await run("service", "status", "stack-owner", "--space", "native1014", "--json"); assert.equal(reply.code, 0, reply.out);
  assert.equal(JSON.parse(reply.out).result.recordedState, "running", "post-start settled the unattended invocation"); checks++;
  assert.deepEqual(JSON.parse(readFileSync(join(mesh, ".cotal/stack-controller.json"), "utf8")).broker, before); checks++;
  // An arbitrary invocation cannot acknowledge this running service or launch beside it.
  const nativeArgs = argv("ExecStart")!;
  const refused = await command(project, [...nativeArgs.slice(nativeArgs.indexOf("__service-unit")), "--ready"], { INVOCATION_ID: "0".repeat(32) });
  assert.equal(refused.code, 2); checks++;
  reply = await run("service", "stop", "stack-owner", "--space", "native1014", "--yes", "--json"); assert.equal(reply.code, 0, reply.out); checks++;
  await delay(6000); assert.equal(launches, 2, "intentional native stop never restarts"); checks++;
  assert.equal(await broker(), undefined, "native stop shut down the actual stack"); checks++;
} finally {
  await stop();
  await Promise.all(jobs);
  // Native stop normally stopped the stack. The public down also cleans a partially started one.
  const cleanup = await command(mesh, ["down", "--yes"]);
  for (const child of children) if (child.exitCode === null && child.signalCode === null) {
    const gone = new Promise<void>((done) => child.once("exit", () => done())); child.kill("SIGTERM"); await gone;
  }
  await new Promise<void>((done) => server.close(() => done()));
  assert.equal(cleanup.code, 0, cleanup.out + cleanup.err);
  assert.ok(children.every((child) => child.exitCode !== null || child.signalCode !== null));
}
console.log(`service-failure-restart: ${checks} passed, 0 failed`);
emitSentinel({ cells: checks, passed: checks, failed: 0 });
