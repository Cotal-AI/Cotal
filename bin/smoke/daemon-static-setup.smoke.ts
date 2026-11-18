/** Non-user-auth spaces stay under their local stack, without machine-service hosting intent. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spaceSegment } from "@cotal-ai/workspace";
import { killAndAwaitExit, skipSuite } from "@cotal-ai/smoke-kit";
import { daemonPathsFor } from "../daemon/endpoint.js";
import { renderDaemonUnit } from "../daemon/install.js";
import { unitReceiptFile } from "../daemon/install-receipt.js";

if (process.platform !== "linux") skipSuite("daemon-static-setup: Linux only");
const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cli = join(repo, "bin/dist/cotal.js");
const root = mkdtempSync(join(tmpdir(), "ds7363-"));
console.log(`Retained static setup fixture: ${root}`);
const home = join(root, "home"), runtime = join(root, "rt"), daemonHome = join(root, "dh");
const project = join(root, "project"), native = join(root, "native"), config = join(root, "config");
for (const dir of [home, runtime, daemonHome, project, native, config]) mkdirSync(dir, { mode: 0o700 });
const nativeLog = join(root, "native.log");
for (const command of ["systemctl", "loginctl", "launchctl", "schtasks"]) {
  writeFileSync(join(native, command), `#!/bin/sh\nprintf '%s\\n' '${command} '"$*" >> '${nativeLog}'\n${command === "systemctl" ? 'if [ "$*" = "--user show-environment" ]; then printf \'XDG_CONFIG_HOME=%s\\n\' "$XDG_CONFIG_HOME"; exit 0; fi\n' : ""}exit 89\n`, { mode: 0o700 });
}
const env = { PATH: [native, ...(process.env.PATH ?? "").split(":").filter(entry => entry.startsWith("/"))].join(":"), HOME: home, COTAL_HOME: home,
  XDG_CONFIG_HOME: config, XDG_RUNTIME_DIR: runtime, XDG_DATA_HOME: join(root, "data"),
  XDG_STATE_HOME: join(root, "state"), XDG_CACHE_HOME: join(root, "cache"), TMPDIR: root,
  COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_TELEMETRY: "off", DO_NOT_TRACK: "1" };
const open = process.argv.includes("--open");
const recoveryOnly = process.argv.includes("--recovery-only");
const space = open ? "open-service-proof" : "static-service-proof";
let sequence = 0, failed = 0;
function check(label: string, condition: boolean, detail?: unknown): void {
  console.log(`${condition ? "PASS" : "FAIL"} ${label}`, detail ?? "");
  if (!condition) failed++;
}
async function command(...args: string[]) {
  const child = spawn(process.execPath, [cli, ...args], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  child.stdout.on("data", chunk => { out += String(chunk); });
  child.stderr.on("data", chunk => { err += String(chunk); });
  const timer = setTimeout(() => child.kill("SIGTERM"), 120_000);
  const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  clearTimeout(timer);
  writeFileSync(join(root, `${++sequence}-${args[0]}-${args[1] ?? ""}.json`), JSON.stringify({ args, code, out, err }, null, 2));
  console.log(`command ${args.join(" ")}: exit ${code}`);
  return { code, out, err, doc: args.includes("--json") && out.trim() ? JSON.parse(out) : undefined };
}
const daemonCommand = (...args: string[]) => command("daemon", ...args, "--daemon-home", daemonHome);
const paths = daemonPathsFor(daemonHome, env);
let daemon: ChildProcess | undefined, stackStarted = false;
async function startDaemon(): Promise<void> {
  daemon = spawn(process.execPath, [cli, "daemon", "serve", "--daemon-home", daemonHome], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  daemon.stdout!.on("data", chunk => { out += String(chunk); writeFileSync(join(root, "daemon.out"), out); });
  daemon.stderr!.on("data", chunk => { err += String(chunk); writeFileSync(join(root, "daemon.err"), err); });
  for (let i = 0; i < 100; i++) {
    if (out.includes("daemon ready")) return;
    assert.equal(daemon.exitCode, null, `daemon exited: ${err}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`private daemon did not become ready: ${err}`);
}
async function localManager(label: string, expected?: string): Promise<string> {
  const census = await command("ps", "--space", space, "--json");
  assert.equal(census.code, 0, census.err);
  const instance = census.doc.result.managers[0]?.instanceId;
  assert.equal(typeof instance, "string");
  check(label, expected === undefined || expected === instance, { instance, expected });
  return instance;
}
try {
  assert.equal((await command("space", "create", space, "--root", project)).code, 0);
  stackStarted = true;
  const up = await command("up", "--space", space, "--root", project, "--detach", ...(open ? ["--open"] : []));
  assert.equal(up.code, 0, up.err);
  const instance = await localManager("positive control: local stack Manager answers before setup");
  // Private receipt only. All native commands are stand-ins and refuse any service mutation.
  const previousEntry = process.argv[1];
  process.argv[1] = cli;
  const loaderFlags = process.execArgv.splice(0);
  const previousPath = process.env.PATH;
  process.env.PATH = env.PATH;
  const rendered = renderDaemonUnit(join(config, "systemd", "user"), daemonHome);
  process.env.PATH = previousPath;
  process.execArgv.push(...loaderFlags);
  process.argv[1] = previousEntry;
  mkdirSync(dirname(rendered.unitPath), { recursive: true, mode: 0o700 });
  writeFileSync(rendered.unitPath, rendered.bytes, { mode: 0o600 });
  mkdirSync(paths.state, { recursive: true, mode: 0o700 });
  writeFileSync(unitReceiptFile(paths), JSON.stringify({ v: 1, mechanism: "systemd-user", unit: rendered.unit,
    unitPath: rendered.unitPath, unitSha256: rendered.sha256, installedAt: new Date().toISOString(), daemonHome }), { mode: 0o600 });
  await startDaemon();
  const checkResult = await daemonCommand("connect-check", "--space", space, "--json");
  assert.equal(checkResult.doc.error.cause.code, "NOT_USER_AUTH");
  if (recoveryOnly) {
    const state = join(daemonHome, "daemon", spaceSegment(space));
    mkdirSync(state, { recursive: true, mode: 0o700 });
    const refusal = join(state, "manager-refusal.json");
    const saved = JSON.stringify({ space, state: "refused", restarts: 0,
      reason: "hosted Managers require a registered user-auth participant space",
      next: "use `cotal manager start` from the folder that hosts the space" });
    writeFileSync(refusal, saved, { mode: 0o600 });
    for (const phase of ["before restart", "after restart"]) {
      if (phase === "after restart") { await killAndAwaitExit(daemon!, "SIGTERM"); daemon = undefined; await startDaemon(); }
      for (const presentation of ["--json", "--plain"]) {
        const status = await daemonCommand("status", "--space", space, presentation);
        const next = presentation === "--json" ? status.doc?.result?.managers?.find((row: { space: string }) => row.space === space)?.next : status.out;
        check(`legacy refusal ${phase} ${presentation} names local stack`, status.code === 0 && next?.includes("cotal up") && !next.includes("cotal manager start"), next);
      }
      check("status preserves original saved refusal", readFileSync(refusal, "utf8") === saved);
    }
    const bad = join(home, "meshes", "unrelated-damaged.json");
    writeFileSync(bad, JSON.stringify({ space: "unrelated-damaged" }), { mode: 0o600 });
    for (const args of [["--json"], ["--plain"], ["--space", space, "--json"]]) {
      const status = await daemonCommand("status", ...args);
      check(`daemon status ${args.join(" ")} survives unrelated registry damage`, status.code === 0
        && (args.includes("--json") ? status.doc?.result?.pid === daemon?.pid : status.out.includes("Daemon")), status.doc ?? status.err);
    }
    const disconnect = await daemonCommand("service-disconnect", "--space", space, "--json");
    check("damaged registry cannot prevent local refusal retirement", disconnect.code === 0 && !existsSync(refusal), disconnect.doc);
    check("disconnect reports unknown recovery guidance rather than guessing", disconnect.code === 0 && JSON.stringify(disconnect.doc).includes("unrelated-damaged.json"), disconnect.doc);
    const status = await daemonCommand("service-status", "--space", space, "--json");
    check("damaged registry service-status returns a refusal document", status.code === 2 && status.doc?.outcome === "refused" && JSON.stringify(status.doc).includes("unrelated-damaged.json"), status.doc);
    const alive = await daemonCommand("status", "--json");
    check("same daemon answers with damaged record still present", existsSync(bad) && alive.code === 0 && alive.doc?.result?.pid === daemon?.pid, alive.doc);
    // Retain the damaged bytes after the observations, then restore registry health for teardown.
    renameSync(bad, join(root, "unrelated-damaged.retained.json"));
    await localManager("positive control: same local Manager survives recovery refusals", instance);
  } else {
  for (const presentation of ["--json", "--plain"]) {
    for (const extra of [[], ["--no-manager"]]) {
      const setup = await daemonCommand("setup", "--space", space, ...extra, presentation);
      const text = setup.out + setup.err;
      check(`setup ${presentation} ${extra.join(" ")} refuses UNSUPPORTED before intent`, setup.code === 2
        && (presentation === "--json" ? setup.doc.error?.code === "UNSUPPORTED" && setup.doc.error?.cause?.code === "NOT_USER_AUTH" : text.includes("UNSUPPORTED") && text.includes("NOT_USER_AUTH")), setup.doc?.error ?? text);
      check("setup explains local stack ownership without starting a hosted Manager", text.includes("cotal up") && text.includes("user-auth") && !text.includes("turning on the space") && !text.includes("starting the agent host"));
    }
  }
  const state = join(daemonHome, "daemon", spaceSegment(space));
  for (const file of ["manager-host.json", "manager-refusal.json", "service-connect.json", "register-request.json", "service-identity.json"])
    check(`refused setup records no ${file}`, !existsSync(join(state, file)));
  const status = await daemonCommand("status", "--json");
  check("refused setup leaves no hosted Manager row", !status.doc.result.managers?.some((row: { space: string }) => row.space === space), status.doc.result.managers);
  await localManager("positive control: local Manager survives refused setup", instance);
  await killAndAwaitExit(daemon!, "SIGTERM"); daemon = undefined;
  await startDaemon();
  const beforeDisconnect = await daemonCommand("status", "--json");
  check("restart before disconnect has no saved refusal to reload", !beforeDisconnect.doc.result.managers?.some((row: { space: string }) => row.space === space), beforeDisconnect.doc.result.managers);
  for (const presentation of ["--json", "--plain"]) {
    const status = await daemonCommand("service-status", "--space", space, presentation);
    check(`service-status ${presentation} reports unsupported without register advice`, status.code === 2
      && (presentation === "--json" ? status.doc.error?.code === "UNSUPPORTED" : (status.out + status.err).includes("UNSUPPORTED"))
      && (status.out + status.err).includes("cotal up") && !(status.out + status.err).includes("daemon register"), status.doc?.error ?? status.err);
  }
  const registration = await daemonCommand("register", "--space", space, "--json");
  assert.equal(registration.doc.error.cause.code, "NOT_USER_AUTH");
  // Existing refused rows from an older release must also disconnect without looping to setup.
  mkdirSync(state, { recursive: true, mode: 0o700 });
  writeFileSync(join(state, "manager-refusal.json"), JSON.stringify({ space, state: "refused", restarts: 0,
    reason: "hosted Managers require a registered user-auth participant space", next: "use `cotal manager start` from the folder that hosts the space" }), { mode: 0o600 });
  const disconnect = await daemonCommand("service-disconnect", "--space", space, "--json");
  assert.equal(disconnect.code, 0, disconnect.err);
  check("disconnect names local stack rather than another unsupported setup", disconnect.doc.result.manager.next.includes("cotal up") && !disconnect.doc.result.manager.next.includes("daemon setup"), disconnect.doc.result.manager);
  await killAndAwaitExit(daemon!, "SIGTERM"); daemon = undefined;
  await startDaemon();
  const restarted = await daemonCommand("status", "--json");
  check("private daemon restart retains no refused Manager", !restarted.doc.result.managers?.some((row: { space: string }) => row.space === space), restarted.doc.result.managers);
  await localManager("positive control: same local Manager answers after private daemon restart", instance);
  const calls = existsSync(nativeLog) ? readFileSync(nativeLog, "utf8").trim().split("\n") : [];
  check("native recorder saw no service mutation", calls.every(line => line === "systemctl --user show-environment"), calls);
  }
} finally {
  if (daemon) await killAndAwaitExit(daemon, "SIGTERM");
  if (stackStarted) {
    const stopped = await command("down", "--space", space, "--yes");
    assert.equal(stopped.code, 0, stopped.err);
  }
}
assert.equal(failed, 0, `${failed} static setup regression checks failed`);
console.log(`PASS daemon ${open ? "open" : "static"} setup regression`);
