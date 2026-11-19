/**
 * Manager harness boot inventory smoke (issue #965).
 *
 * Proves timing, not only wording: the missing harness is named by Manager.start() before any
 * startAgent call. Boot stays live for unrelated work and publishes the same unavailable status row.
 * A present harness stays pinned, while applications installed later are discovered by launch,
 * model lookup and status. The first available application also enables class spawn subscriptions.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { DEV_OWNER, epCall, isReachable, mintLifecycleUid, newIdentity, registry, type Connector, type LaunchOpts } from "@cotal-ai/core";
import { connect } from "@nats-io/transport-node";
import { MANAGER_CONTRACTS, type ManagerStatus } from "../src/manager-service-contract.js";
import { connectorMetadataStale, extensionsDir, saveExtensionsManifest } from "@cotal-ai/workspace";
import { Manager } from "../src/manager.js";
import { SMOKE_BROKER_TOKEN, freePort, teardownOnSignal } from "@cotal-ai/smoke-kit";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let pass = 0;
const check = (name: string, condition: boolean, actual?: unknown): void => {
  if (!condition) throw new Error(`${name}${actual === undefined ? "" : ` - ${JSON.stringify(actual)}`}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

const root = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const workspaceRoot = join(root, "ws");
const binDir = join(root, "bin");
mkdirSync(join(workspaceRoot, ".cotal", "agents"), { recursive: true });
writeFileSync(join(workspaceRoot, ".cotal", "agents", "pin-probe.md"), "---\nname: pin-probe\nagent: boot-present\n---\n");
writeFileSync(join(workspaceRoot, ".cotal", "agents", "late-probe.md"), "---\nname: late-probe\nagent: boot-missing\n---\n");
mkdirSync(binDir);
const script = process.platform === "win32" ? "@exit /b 0\r\n" : "#!/bin/sh\nexit 0\n";
const executable = (name: string) => process.platform === "win32" ? `${name}.cmd` : name;
const present = join(binDir, executable("present-harness"));
writeFileSync(present, script, { mode: 0o700 });

const configHome = join(root, "config");
process.env.XDG_CONFIG_HOME = configHome;
mkdirSync(extensionsDir(), { recursive: true });
saveExtensionsManifest({
  extensions: [
    {
      pkg: "@fixture/boot-connectors",
      version: "1.0.0",
      spec: ".",
      provides: [
        { kind: "connector", name: "boot-missing" },
        { kind: "connector", name: "boot-present" },
      ],
      commands: [],
      connectors: [
        { name: "boot-missing", requires: ["harness-that-does-not-exist-965"], eventPlane: false },
        { name: "boot-present", requires: ["present-harness"], eventPlane: true },
      ],
    },
  ],
});
check("an older declared inventory without eventPlane is stale instead of defaulting true",
  connectorMetadataStale({
    pkg: "@fixture/stale-connector", version: "1.0.0", spec: ".",
    provides: [{ kind: "connector", name: "stale" }], commands: [],
    connectors: [{ name: "stale", requires: [], setup: null } as never],
  }));

const port = await freePort();
const servers = `nats://127.0.0.1:${port}`;
const broker = spawn("nats-server", ["-js", "-p", String(port), "-sd", join(root, "js")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(broker, root);
const oldPath = process.env.PATH;
// A valid relative PATH entry is resolved at manager boot. The managed seat starts in workspaceRoot,
// not this process cwd, so retaining the relative spelling would fail from the launch cwd.
process.env.PATH = relative(process.cwd(), binDir);
const manager = new Manager({ space: "harness-boot", servers, runtime: "pty", workspaceRoot, installedExtensions: true });
const M = manager as unknown as {
  connectorStatuses: Array<{ agent: string; state: string; binaries: Record<string, string>; eventPlane: boolean; reason?: string }>;
  managerStatusData(): { connectors: Array<{ agent: string; state: string; binaries: Record<string, string>; eventPlane: boolean; reason?: string }> };
};
let bootErr = "";
const oldError = console.error;
console.error = (...args: unknown[]) => {
  bootErr += `${args.map(String).join(" ")}\n`;
  oldError(...args);
};

try {
  for (let i = 0; i < 100 && !(await isReachable(servers)); i++) await wait(50);
  if (!(await isReachable(servers))) throw new Error("owned broker did not start");
  await manager.start();

  const missing = M.connectorStatuses.find((row) => row.agent === "boot-missing");
  const available = M.connectorStatuses.find((row) => row.agent === "boot-present");
  check(
    "manager boot surfaces the missing harness before any spawn is attempted",
    bootErr.includes("! manager boot: connector boot-missing unavailable - boot-missing harness needs harness-that-does-not-exist-965 on PATH - not found"),
    bootErr,
  );
  check("manager boot continues so unrelated connectors remain usable", missing?.state === "unavailable" && available?.state === "available", M.connectorStatuses);
  check("declared inventory event-plane facts survive without importing connector packages",
    missing?.eventPlane === false && available?.eventPlane === true, M.connectorStatuses);
  check(
    "boot records the resolved absolute harness path from a relative PATH entry",
    available?.binaries["present-harness"] === present && isAbsolute(available.binaries["present-harness"]!),
    available,
  );
  const status = M.managerStatusData();
  check("typed manager status retains the named boot-time unavailable reason", status.connectors.find((row) => row.agent === "boot-missing")?.reason === missing?.reason, status);

  let launchOpts: LaunchOpts | undefined;
  let presentCatalogBinary: string | undefined;
  const connector: Connector = {
    kind: "connector",
    name: "boot-present",
    requires: ["present-harness"],
    listModels: (opts) => { presentCatalogBinary = opts?.resolvedBinaries?.["present-harness"]; return { models: [] }; },
    buildLaunch: (opts) => {
      launchOpts = opts;
      return { command: opts.resolvedBinaries?.["present-harness"] ?? "present-harness", args: [] };
    },
  };
  registry.register(connector);
  const fakeSession = { cols: 80, rows: 24, backlog: () => Buffer.alloc(0), onData: () => () => {}, onExit: () => () => {}, write: () => {}, resize: () => {} };
  let launchExec: ReturnType<typeof spawnSync> | undefined;
  (manager as unknown as { runtime: unknown }).runtime = {
    kind: "fake", streamsTerminal: false,
    spawn: (name: string, spec: { command: string; args: string[]; env?: Record<string, string> }, cwd: string) => {
      launchExec = spawnSync(spec.command, spec.args, { cwd, env: spec.env, encoding: "utf8" });
      let state = spec.command === present ? "exited" : "running";
      return { name, kind: "fake", status: () => state, stop: () => { state = "exited"; }, waitForExit: async () => state === "exited", interrupt: () => {}, attach: () => fakeSession };
    },
  };
  await manager.startAgent({ name: "pin-probe", agent: "boot-present", events: false });
  check("managed spawn uses the exact path resolved at boot", launchOpts?.resolvedBinaries?.["present-harness"] === present, launchOpts);
  check(
    "managed spawn executes that exact harness when its launch cwd differs from manager boot cwd",
    launchExec?.status === 0 && launchExec.error === undefined,
    { status: launchExec?.status, error: launchExec?.error?.message, cwd: workspaceRoot, command: launchOpts?.resolvedBinaries?.["present-harness"] },
  );

  let catalogBinary: string | undefined;
  const lateConnector: Connector = {
    kind: "connector", name: "boot-missing", requires: ["harness-that-does-not-exist-965"],
    waitsForOperator: () => "fixture input screen",
    listModels: (opts) => { catalogBinary = opts?.resolvedBinaries?.["harness-that-does-not-exist-965"]; return { models: [{ id: "late-model" }] }; },
    buildLaunch: (opts) => ({ command: opts.resolvedBinaries?.["harness-that-does-not-exist-965"] ?? "harness-that-does-not-exist-965", args: [] }),
  };
  registry.register(lateConnector);
  const installed = join(binDir, executable("harness-that-does-not-exist-965"));
  writeFileSync(installed, script, { mode: 0o700 });
  const launched = await manager.startAgent({ name: "late-probe", agent: "boot-missing", events: false });
  const afterInstall = M.managerStatusData().connectors.find((row) => row.agent === "boot-missing");
  console.log("after installation:", JSON.stringify({ launched, status: afterInstall }));
  check("launch discovers and executes a harness installed on the manager PATH after boot", launched.ok === true && launchExec?.status === 0, launched);
  check("status records the newly installed harness without a restart", afterInstall?.state === "available" && afterInstall.binaries["harness-that-does-not-exist-965"] === installed, afterInstall);

  const earlier = join(root, "earlier");
  mkdirSync(earlier);
  writeFileSync(join(earlier, executable("present-harness")), process.platform === "win32" ? "@exit /b 42\r\n" : "#!/bin/sh\nexit 42\n", { mode: 0o700 });
  process.env.PATH = `${earlier}${process.platform === "win32" ? ";" : ":"}${binDir}`;
  await manager.startAgent({ name: "pin-probe", agent: "boot-present", events: false });
  check("an application available at boot ignores an earlier PATH replacement", launchExec?.status === 0 && launchOpts?.resolvedBinaries?.["present-harness"] === present, launchExec?.status);
  await (manager as unknown as { opModels(args: Record<string, unknown>): Promise<unknown> }).opModels({ agent: "boot-present" });
  check("model catalog retains the same boot binary after PATH changes", presentCatalogBinary === present, presentCatalogBinary);
  await manager.stop({ withAgents: true });
  rmSync(present);
  process.env.PATH = binDir;

  for (const trigger of ["status", "models", "launch"] as const) {
    rmSync(installed, { force: true });
    const late = new Manager({ space: `late-${trigger}`, servers, runtime: "pty", workspaceRoot, installedExtensions: true });
    const L = late as unknown as {
      runtime: unknown;
      managerStatusData(): ManagerStatus;
      connectorStatuses: ManagerStatus["connectors"];
    };
    L.runtime = (manager as unknown as { runtime: unknown }).runtime;
    const nc = await connect({ servers });
    const caller = { owner: DEV_OWNER, actor: newIdentity().id, uid: mintLifecycleUid() };
    const call = (command: "status" | "models" | "spawn", args?: Record<string, unknown>) => epCall(nc, `late-${trigger}`, { mode: "one" },
      { endpoint: "manager", command, contract: MANAGER_CONTRACTS[command], caller, ...(args ? { args } : {}) },
      { deadlineMs: 5000, currentEpoch: async () => 0 });
    try {
      await late.start();
      check(`${trigger}: missing-only inventory skips class spawn`, L.managerStatusData().classSpawn === false);
      if (trigger === "models") {
        const missingModels = await call("models", { agent: "boot-missing" });
        check("models still reports a genuinely missing application", missingModels.reply.ok === false, missingModels.reply);
      }
      writeFileSync(installed, script, { mode: 0o700 });
      if (trigger === "launch") {
        const result = await late.startAgent({ name: "late-probe", agent: "boot-missing", events: false });
        check("launch alone refreshes missing-only inventory", result.ok === true, result);
      } else {
        const result = await call(trigger, trigger === "models" ? { agent: "boot-missing" } : undefined);
        check(`${trigger} discovers the newly installed application over the live endpoint`, result.reply.ok === true, result.reply);
        if (trigger === "models") check("catalog uses the newly resolved absolute binary", catalogBinary === installed, catalogBinary);
      }
      const row = L.connectorStatuses.find((r) => r.agent === "boot-missing");
      check(`${trigger}: stored row clears the refusal and keeps event-plane facts`, row?.state === "available" && row.reason === undefined && row.eventPlane === false && row.binaries["harness-that-does-not-exist-965"] === installed, row);
      const spawned = await call("spawn", { name: "late-probe", agent: "boot-missing", events: false });
      check(`${trigger}: class spawn executes the discovered application without restarting the Manager`, spawned.reply.ok === true && launchExec?.status === 0, spawned.reply);
      check(`${trigger}: status reports class spawn enabled`, L.managerStatusData().classSpawn === true);
    } finally {
      await nc.close();
      await late.stop({ withAgents: true });
    }
  }
} finally {
  console.error = oldError;
  if (oldPath === undefined) delete process.env.PATH;
  else process.env.PATH = oldPath;
  await manager.stop({ withAgents: true }).catch(() => {});
  broker.kill("SIGKILL");
  for (let i = 0; i < 100 && broker.exitCode === null && broker.signalCode === null; i++) await wait(20);
  releaseBroker();
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${pass} checks passed`);
