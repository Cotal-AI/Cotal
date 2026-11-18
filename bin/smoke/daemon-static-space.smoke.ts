/** Static-auth spaces keep their stack Manager and never acquire daemon hosting intent. */
import { strict as assert } from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { emitSentinel, killAndAwaitExit, skipSuite } from "@cotal-ai/smoke-kit";
import { spaceSegment } from "@cotal-ai/workspace";

if (process.platform !== "linux") skipSuite("daemon-static-space: Linux recording service fixture only");
const repo = fileURLToPath(new URL("../../", import.meta.url));
const entry = join(repo, "bin", "dist", "cotal.js");
const root = mkdtempSync(join(tmpdir(), "cotal-static-"));
const project = join(root, "project"), home = join(root, "home"), machine = join(root, "machine");
const native = join(root, "native"), config = join(root, "config"), runtime = join(root, "rt");
for (const dir of [project, home, machine, native, config, runtime]) mkdirSync(dir, { mode: 0o700 });
const nativeCalls = join(root, "native-calls.jsonl");
for (const tool of ["systemctl", "loginctl", "launchctl", "schtasks"]) {
  writeFileSync(join(native, tool), `#!${process.execPath}\nimport('node:fs').then(({appendFileSync})=>{const args=process.argv.slice(2).join(' ');appendFileSync(${JSON.stringify(nativeCalls)},JSON.stringify({tool:${JSON.stringify(tool)},args})+'\\n');if(${JSON.stringify(tool)}==='systemctl'&&args==='--user show-environment')console.log(${JSON.stringify(`XDG_CONFIG_HOME=${config}`)});else process.exitCode=89;});\n`, { mode: 0o700 });
}
const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_") && !["NODE_OPTIONS", "NODE_PATH"].includes(key)));
Object.assign(env, {
  HOME: home, COTAL_HOME: home, XDG_CONFIG_HOME: config, XDG_RUNTIME_DIR: runtime,
  XDG_CACHE_HOME: join(root, "cache"), XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"),
  PATH: `${native}:${process.env.PATH}`, COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_NO_UPDATE_CHECK: "1", DO_NOT_TRACK: "1", NO_COLOR: "1",
});
const space = "static-demo";
const managerDir = join(machine, "daemon", spaceSegment(space));
const refusal = join(managerDir, "manager-refusal.json");
const intent = join(managerDir, "manager-host.json");
const unit = `cotal-daemon-${createHash("sha256").update(machine).digest("hex").slice(0, 16)}.service`;
const unitPath = join(config, "systemd", "user", unit);
const unitBytes = `[Unit]\nDescription=Cotal machine daemon\n\n[Service]\nType=simple\nExecStart="${process.execPath}" "${entry}" daemon serve --daemon-home "${machine}"\nRestart=always\n\n[Install]\nWantedBy=default.target\n`;
mkdirSync(dirname(unitPath), { recursive: true, mode: 0o700 });
writeFileSync(unitPath, unitBytes, { mode: 0o600 });
mkdirSync(join(machine, "daemon"), { mode: 0o700 });
writeFileSync(join(machine, "service-unit.json"), JSON.stringify({ v: 1, unit, unitPath, unitSha256: createHash("sha256").update(unitBytes).digest("hex"), installedAt: new Date().toISOString(), daemonHome: machine }), { mode: 0o600 });

type Doc = {
  result?: { pid?: number; managers?: { state: string; next?: string; lastRefusal?: string }[]; manager?: { state: string; next?: string } };
  error?: { code?: string; message?: string; remedy?: string; cause?: { code?: string } };
};
let passed = 0, failed = 0;
function check(label: string, value: unknown): void {
  if (value) { passed++; console.log(`ok ${label}`); }
  else { failed++; console.error(`FAIL ${label}`); }
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function cli(args: string[], json = true) {
  const child = spawn(process.execPath, [entry, ...args, ...(json ? ["--json"] : [])], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  child.stdout.on("data", chunk => out += chunk);
  child.stderr.on("data", chunk => err += chunk);
  const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    const doc = json ? JSON.parse(out) as Doc : {};
    return { code, doc, out, err };
  } finally { clearTimeout(timer); await killAndAwaitExit(child, "SIGTERM"); }
}
const daemonArgs = (op: string, extra: string[] = []) => ["daemon", op, "--daemon-home", machine, "--space", space, ...extra];
let daemon: ChildProcess | undefined;
async function startDaemon() {
  daemon = spawn(process.execPath, [entry, "daemon", "serve", "--daemon-home", machine], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  daemon.stdout!.on("data", chunk => output += chunk);
  daemon.stderr!.on("data", chunk => output += chunk);
  const deadline = Date.now() + 30_000;
  while (!output.includes("daemon ready") && daemon.exitCode === null && Date.now() < deadline) await sleep(100);
  assert.ok(output.includes("daemon ready"), output);
}
async function stopDaemon() {
  if (daemon) await killAndAwaitExit(daemon, "SIGTERM");
  daemon = undefined;
}
function noRecords(label: string) {
  check(`${label}: no Manager intent or refusal`, !existsSync(intent) && !existsSync(refusal));
  check(`${label}: no machine service records`, ["register-request.json", "service-identity.json", "service-connect.json", "service-store"].every(file => !existsSync(join(managerDir, file))));
}
function localRemedy(text: string | undefined) {
  return Boolean(text?.includes("cotal up") && !/cotal (?:daemon (?:setup|register)|manager start)/.test(text));
}
let stackStarted = false;
try {
  const created = await cli(["space", "create", space, "--root", project]);
  assert.equal(created.code, 0, created.out + created.err);
  stackStarted = true;
  const up = await cli(["up", "--space", space, "--root", project, "--detach"]);
  assert.equal(up.code, 0, up.out + up.err);
  const managerBefore = await cli(["manager", "start", "--space", space], false);
  check("positive control: local stack Manager already answers", managerBefore.code === 0 && managerBefore.out.includes("Already running"));
  await startDaemon();
  const statusBefore = await cli(daemonArgs("service-status"));
  console.log("initial service-status", statusBefore.code, statusBefore.doc.error);
  check("unrequested static space reports UNSUPPORTED, not register first", statusBefore.code === 2 && statusBefore.doc.error?.code === "UNSUPPORTED" && localRemedy(statusBefore.doc.error.remedy));
  for (const [label, flags] of [["manager", []], ["service-only", ["--no-manager", "--wait", "0"]]] as const) {
    const setup = await cli(daemonArgs("setup", [...flags]));
    console.log(`${label} setup`, setup.code, setup.doc.error, setup.err);
    check(`${label} setup refuses UNSUPPORTED / NOT_USER_AUTH`, setup.code === 2 && setup.doc.error?.code === "UNSUPPORTED" && setup.doc.error.cause?.code === "NOT_USER_AUTH");
    check(`${label} setup explains local stack and user-auth hosting`, setup.doc.error?.message?.includes("user sign-in") && localRemedy(setup.doc.error.remedy) && setup.doc.error.remedy?.includes("user-auth"));
    check(`${label} setup prints no intent, host, registration or skipped sign-in progress`, !/turning on the space|starting the agent host|register:|sign-in: skipped/.test(setup.err));
    noRecords(`${label} setup`);
  }
  const managerAfter = await cli(["manager", "start", "--space", space], false);
  check("positive control: refused setup leaves stack Manager answering", managerAfter.code === 0 && managerAfter.out.includes("Already running"));
  await stopDaemon();
  await startDaemon();
  const restarted = await cli(daemonArgs("status"));
  check("restart has no refused Manager", restarted.code === 0 && restarted.doc.result?.managers?.every(manager => manager.state !== "refused"));
  noRecords("restart");
  const register = await cli(daemonArgs("register"));
  check("register shares UNSUPPORTED / NOT_USER_AUTH and local remedy", register.code === 2 && register.doc.error?.code === "UNSUPPORTED" && register.doc.error.cause?.code === "NOT_USER_AUTH" && localRemedy(register.doc.error.remedy));
  const status = await cli(daemonArgs("service-status"));
  check("status after refused register keeps local remedy", status.code === 2 && status.doc.error?.code === "UNSUPPORTED" && localRemedy(status.doc.error.remedy));
  await stopDaemon();
  // An older release's refusal is retained until explicit disconnect, not silently removed by setup.
  mkdirSync(managerDir, { recursive: true, mode: 0o700 });
  writeFileSync(refusal, JSON.stringify({ space, state: "refused", restarts: 0, reason: "hosted Managers require a registered user-auth participant space", lastRefusal: "hosted Managers require a registered user-auth participant space", next: "use `cotal manager start` from the folder that hosts the space" }), { mode: 0o600 });
  await startDaemon();
  const legacy = await cli(daemonArgs("status"));
  check("legacy refused record is visible before disconnect", legacy.doc.result?.managers?.some(manager => manager.state === "refused"));
  const disconnected = await cli(daemonArgs("service-disconnect"));
  console.log("disconnect", disconnected.code, disconnected.doc.result?.manager);
  check("disconnect clears legacy refusal with local-stack next step", disconnected.code === 0 && disconnected.doc.result?.manager?.state === "stopped" && localRemedy(disconnected.doc.result.manager.next));
  noRecords("disconnect");
  const finalManager = await cli(["manager", "start", "--space", space], false);
  check("positive control: disconnect leaves stack Manager answering", finalManager.code === 0 && finalManager.out.includes("Already running"));
  const calls = existsSync(nativeCalls) ? readFileSync(nativeCalls, "utf8").trim().split("\n").map(line => JSON.parse(line) as { tool: string; args: string }) : [];
  check("all native calls are directory reads through the stand-in", calls.length > 0 && calls.every(call => call.tool === "systemctl" && call.args === "--user show-environment"));
} finally {
  await stopDaemon();
  if (stackStarted) {
    const down = await cli(["down", "--space", space, "--yes"]);
    assert.equal(down.code, 0, down.out + down.err);
  }
  console.log(`retained fixture: ${root}`);
}
emitSentinel({ passed, failed });
process.exitCode = failed ? 1 : 0;
