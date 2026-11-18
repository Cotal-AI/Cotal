/** Broker-only startup and refresh do not depend on application connector installation. */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { resolveOnPath } from "@cotal-ai/workspace";
import { assertSmokeSandboxDown, createSuite, freePort, recordSmokeSandbox, SMOKE_BROKER_TOKEN } from "@cotal-ai/smoke-kit";

const bin = resolve(import.meta.dirname, "../../../bin/dist/cotal.js");
assert(existsSync(bin), "build the shipped CLI before running this suite");
const sandbox = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}broker-only-no-seed-`));
const tools = join(sandbox, "bin");
mkdirSync(tools, { mode: 0o700 });
for (const name of ["node", "git", "nats-server", "sh", "ps", "readlink"]) {
  const executable = name === "node" ? process.execPath : resolveOnPath(name);
  assert(executable, `missing fixture executable: ${name}`);
  symlinkSync(executable, join(tools, name));
}
const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_") && key !== "FORCE_COLOR"));
const suite = createSuite();

for (const scenario of ["legacy-auth", "legacy-open", "controller-auth", "controller-open", "legacy-foreground", "controller-foreground", "manifest"] as const) {
  const root = join(sandbox, scenario), home = join(root, "home"), xdg = join(root, "config");
  for (const dir of [root, home, xdg, join(root, "runtime")]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const env = { ...inherited, HOME: home, USERPROFILE: home, COTAL_HOME: join(home, ".cotal"), XDG_CONFIG_HOME: xdg, XDG_RUNTIME_DIR: join(root, "runtime"), PATH: tools, COTAL_ALLOW_CHECKOUT_SEED: "1", COTAL_TELEMETRY: "off", COTAL_NO_PROMPT: "1", NO_COLOR: "1" };
  const anchor = recordSmokeSandbox({ root, cotalHome: env.COTAL_HOME, xdgConfigHome: xdg });
  let sequence = 0;
  const run = (...args: string[]) => {
    const options = { cwd: root, env, encoding: "utf8" as const, timeout: 90_000 };
    assertSmokeSandboxDown(anchor, args, options);
    const result = spawnSync(process.execPath, [bin, ...args], options);
    writeFileSync(join(root, `${++sequence}-${args[0]}.log`), `${result.stdout}${result.stderr}\nexit=${result.status} signal=${result.signal}\n`);
    return { status: result.status, text: result.stdout + result.stderr };
  };
  const seedFiles = (): string[] => readdirSync(xdg, { recursive: true }).map(String).filter(path => path.split(/[\\/]/).some(part => part === "seed" || part === "extensions"));
  const controller = scenario.startsWith("controller"), open = scenario.endsWith("open"), foreground = scenario.endsWith("foreground");
  const space = `no-seed-${scenario}`;
  suite.check(`${scenario}: fixture PATH excludes npm and npx with automatic seeding enabled`, !resolveOnPath("npm", env) && !resolveOnPath("npx", env) && !("COTAL_SKIP_CONNECTOR_SEED" in env));
  // Space preparation does not need connectors, but currently has a separate automatic seed prelude.
  if (controller) {
    const prepared = spawnSync(process.execPath, [bin, "space", "create", space, "--root", root], { cwd: root, env: { ...env, COTAL_SKIP_CONNECTOR_SEED: "1" }, encoding: "utf8", timeout: 90_000 });
    assert.equal(prepared.status, 0, prepared.stdout + prepared.stderr);
  }
  const port = await freePort();
  const server = `nats://127.0.0.1:${port}`;
  const manifest = join(root, "cotal.yaml");
  if (scenario === "manifest") writeFileSync(manifest, `apiVersion: cotal/v1\nkind: Mesh\nspace: ${space}\nbroker:\n  servers: ${server}\nchannels: {}\nagents: {}\n`);
  const args = ["up", "--no-manager", ...(scenario === "manifest" ? ["-f", manifest] : ["--space", space, "--server", server]), ...(open ? ["--open"] : []), ...(foreground ? ["--foreground"] : [])];
  let child: ReturnType<typeof spawn> | undefined;
  let childExit: Promise<number | null> | undefined;
  let output = "";
  try {
    if (foreground) {
      child = spawn(process.execPath, [bin, ...args], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
      childExit = new Promise((resolveExit, reject) => { child!.once("exit", resolveExit); child!.once("error", reject); });
      child.stdout!.on("data", chunk => { output += String(chunk); });
      child.stderr!.on("data", chunk => { output += String(chunk); });
      const deadline = Date.now() + 90_000;
      while (!output.includes("no local daemon-credential renewal owner") && child.exitCode === null && child.signalCode === null && Date.now() < deadline) await delay(50);
      suite.check(`${scenario}: foreground auth startup reaches delivery readiness without npm`, output.includes("no local daemon-credential renewal owner") && child.exitCode === null, output);
    } else {
      const started = run(...args);
      suite.check(`${scenario}: shipped broker-only startup succeeds without npm`, started.status === 0, started.text);
      assert.equal(started.status, 0, started.text);
    }
    const inventory = run("service", "--space", space, "--json");
    assert.equal(inventory.status, 0, inventory.text);
    const receipt = JSON.parse(inventory.text) as { result: { services: { preset: string; state: string }[]; instances: { observedProcess: string }[]; processes: { name: string; processState: string }[] } };
    const services = receipt.result.services;
    suite.check(`${scenario}: broker and required delivery process are running`, (controller ? services.some(row => row.preset === "broker" && row.state === "running") : receipt.result.processes.some(row => row.name === "nats" && row.processState === "alive")) && (open || services.some(row => row.preset === "delivery" && row.state.startsWith("running"))), inventory.text);
    suite.check(`${scenario}: no manager process was created`, services.every(row => row.preset !== "manager" || row.state === "not started") && !readdirSync(join(root, ".cotal")).some(name => /^manager\..*\.pid$/.test(name)), inventory.text);
    suite.check(`${scenario}: startup wrote no connector seed or extension files`, seedFiles().length === 0, seedFiles());
    if (!foreground) {
      const refreshed = run("up", "--space", space, "--no-manager", ...(open ? ["--open"] : []));
      suite.check(`${scenario}: live refresh also succeeds without npm or seed writes`, refreshed.status === 0 && seedFiles().length === 0, refreshed.text);
    }
    if (scenario === "legacy-auth") {
      const stopped = run("down", "--yes");
      assert.equal(stopped.status, 0, stopped.text);
      const managed = run("up", "--space", space);
      suite.check("manager-backed startup still fails loud when npm is missing", managed.status === 5 && managed.text.includes("npm is not on PATH") && managed.text.includes("OPERATION_FAILED"), managed.text);
      const cursor = seedFiles().find(path => path.endsWith("reconcile.cursor.json"));
      assert(cursor, "the failed connector install leaves its seed failure evidence");
      const before = readFileSync(join(xdg, cursor), "utf8");
      const refreshed = run("up", "--space", space, "--no-manager");
      suite.check("broker-only restart leaves a previous connector failure intact", refreshed.status === 0 && readFileSync(join(xdg, cursor), "utf8") === before, refreshed.text);
      const managedAgain = run("up", "--space", space);
      suite.check("manager-backed refresh still reports the recorded connector failure", managedAgain.text.includes("previous connector seed failed") && managedAgain.text.includes("control plane degraded"), managedAgain.text);
    }
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGINT");
    if (childExit) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([childExit, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("foreground CLI did not stop")), 90_000); })]);
      } finally { if (timer) clearTimeout(timer); }
      writeFileSync(join(root, "foreground.log"), output);
    }
    const stopped = run("down", "--yes");
    suite.check(`${scenario}: native shutdown completes`, stopped.status === 0, stopped.text);
    const closed = await new Promise<boolean>((resolveClosed, reject) => {
      const socket = connect(port, "127.0.0.1");
      socket.once("connect", () => { socket.destroy(); resolveClosed(false); });
      socket.once("error", (error: NodeJS.ErrnoException) => error.code === "ECONNREFUSED" ? resolveClosed(true) : reject(error));
    });
    suite.check(`${scenario}: the owned broker listener is closed`, closed);
    const inventory = run("service", "--space", space, "--json");
    if (controller) {
      const receipt = JSON.parse(inventory.text) as { result: { instances: { observedProcess: string }[] } };
      suite.check(`${scenario}: every controller member is stopped`, receipt.result.instances.every(row => row.observedProcess === "gone" || row.observedProcess === "previous-boot"), inventory.text);
    }
  }
}
console.log(`Retained isolated startup logs: ${sandbox}`);
suite.finish();
process.exit(process.exitCode ?? 0);
