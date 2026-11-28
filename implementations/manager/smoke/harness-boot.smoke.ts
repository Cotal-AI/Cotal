/**
 * Manager harness boot inventory smoke (issue #965).
 *
 * Proves timing, not only wording: the missing harness is named by Manager.start() before any
 * startAgent call. Boot stays live for unrelated work and publishes the same unavailable status row.
 * A present harness stays pinned, while applications installed later are discovered by launch,
 * model lookup and status, and applications removed later become unavailable on status and launch
 * before reserving names or capacity, updating class spawn routing and recovering when restored.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs, { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { DEV_OWNER, epCall, isReachable, mintLifecycleUid, newIdentity, registry, type Connector, type ConnectorSetupProvider, type LaunchOpts } from "@cotal-ai/core";
import { connect } from "@nats-io/transport-node";
import { MANAGER_CONTRACTS, type ManagerStatus } from "../src/manager-service-contract.js";
import { connectorMetadataStale, extensionsDir, saveExtensionsManifest, trustProject } from "@cotal-ai/workspace";
import { Manager } from "../src/manager.js";
import { armManagerServiceObserver } from "../src/service-child.js";
import { SMOKE_BROKER_TOKEN, freePort, teardownOnSignal } from "@cotal-ai/smoke-kit";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let pass = 0;
const check = (name: string, condition: boolean, actual?: unknown): void => {
  if (!condition) throw new Error(`${name}${actual === undefined ? "" : ` - ${JSON.stringify(actual)}`}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

for (const key of Object.keys(process.env)) if (key.startsWith("COTAL_")) delete process.env[key];
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
  connectorInventory: { connectorStatuses: Array<{ agent: string; state: string; binaries: Record<string, string>; eventPlane: boolean; reason?: string }> };
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

  const missing = M.connectorInventory.connectorStatuses.find((row) => row.agent === "boot-missing");
  const available = M.connectorInventory.connectorStatuses.find((row) => row.agent === "boot-present");
  check(
    "manager boot surfaces the missing harness before any spawn is attempted",
    bootErr.includes("! manager boot: connector boot-missing unavailable - boot-missing harness needs harness-that-does-not-exist-965 on PATH - not found"),
    bootErr,
  );
  check("manager boot continues so unrelated connectors remain usable", missing?.state === "unavailable" && available?.state === "available", M.connectorInventory.connectorStatuses);
  check("declared inventory event-plane facts survive without importing connector packages",
    missing?.eventPlane === false && available?.eventPlane === true, M.connectorInventory.connectorStatuses);
  check(
    "boot records the resolved absolute harness path from a relative PATH entry",
    available?.binaries["present-harness"] === present && isAbsolute(available.binaries["present-harness"]!),
    available,
  );
  const status = M.managerStatusData();
  check("typed manager status retains the named boot-time unavailable reason", status.connectors.find((row) => row.agent === "boot-missing")?.reason === missing?.reason, status);

  let launchOpts: LaunchOpts | undefined;
  let presentCatalogBinary: string | undefined;
  let catalogEnvAllow: readonly string[] | undefined;
  const connector: Connector = {
    kind: "connector",
    name: "boot-present",
    requires: ["present-harness"],
    listModels: (opts) => {
      presentCatalogBinary = opts?.resolvedBinaries?.["present-harness"];
      catalogEnvAllow = opts?.envAllow;
      return { models: [] };
    },
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
  const opModels = (manager as unknown as { opModels(args: Record<string, unknown>): Promise<unknown> }).opModels.bind(manager);
  await opModels({ agent: "boot-present" });
  check("model catalog retains the same boot binary after PATH changes", presentCatalogBinary === present, presentCatalogBinary);
  // The catalog reads the environment a launch gets, so it lists the models that launch reaches.
  const spawnEnv = (names: string[]) => writeFileSync(join(workspaceRoot, ".cotal", "config.json"), JSON.stringify({ spawn: { env: names } }));
  spawnEnv(["CATALOG_PROBE_PROVIDER"]);
  const untrusted = await opModels({ agent: "boot-present" }) as { ok?: boolean; error?: string };
  check("model catalog refuses an untrusted project's spawn.env before calling the connector",
    untrusted.ok === false && untrusted.error?.includes("is not trusted") === true && catalogEnvAllow === undefined, untrusted);
  trustProject(workspaceRoot);
  await manager.startAgent({ name: "pin-probe", agent: "boot-present", events: false });
  await opModels({ agent: "boot-present" });
  check("model catalog receives the spawn.env names a launch receives",
    JSON.stringify(catalogEnvAllow) === JSON.stringify(["CATALOG_PROBE_PROVIDER"]) && JSON.stringify(launchOpts?.envAllow) === JSON.stringify(catalogEnvAllow), { catalogEnvAllow, launch: launchOpts?.envAllow });
  spawnEnv(["CATALOG_PROBE_BASE_URL"]);
  await opModels({ agent: "boot-present" });
  check("model catalog reads spawn.env per call, as a spawn does", JSON.stringify(catalogEnvAllow) === JSON.stringify(["CATALOG_PROBE_BASE_URL"]), catalogEnvAllow);
  rmSync(join(workspaceRoot, ".cotal", "config.json"));
  await opModels({ agent: "boot-present" });
  check("model catalog receives no extras when spawn.env declares none", catalogEnvAllow === undefined, catalogEnvAllow);
  await manager.stop({ withAgents: true });
  rmSync(present);
  process.env.PATH = binDir;

  for (const trigger of ["status", "models", "launch"] as const) {
    rmSync(installed, { force: true });
    const late = new Manager({ space: `late-${trigger}`, servers, runtime: "pty", workspaceRoot, installedExtensions: true });
    const L = late as unknown as {
      runtime: unknown;
      managerStatusData(): ManagerStatus;
      connectorInventory: { connectorStatuses: ManagerStatus["connectors"] };
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
      const row = L.connectorInventory.connectorStatuses.find((r) => r.agent === "boot-missing");
      check(`${trigger}: stored row clears the refusal and keeps event-plane facts`, row?.state === "available" && row.reason === undefined && row.eventPlane === false && row.binaries["harness-that-does-not-exist-965"] === installed, row);
      const spawned = await call("spawn", { name: "late-probe", agent: "boot-missing", events: false });
      check(`${trigger}: class spawn executes the discovered application without restarting the Manager`, spawned.reply.ok === true && launchExec?.status === 0, spawned.reply);
      check(`${trigger}: status reports class spawn enabled`, L.managerStatusData().classSpawn === true);
    } finally {
      await nc.close();
      await late.stop({ withAgents: true });
    }
  }

  rmSync(installed, { force: true });
  const uninstallBin = join(root, "uninstall-bin");
  const siblingBin = join(root, "sibling-bin");
  const emptyBin = join(root, "empty-bin");
  const siblingWorkspaceRoot = join(root, "ws-sibling");
  mkdirSync(uninstallBin);
  mkdirSync(siblingBin);
  mkdirSync(emptyBin);
  mkdirSync(join(siblingWorkspaceRoot, ".cotal", "agents"), { recursive: true });
  writeFileSync(join(siblingWorkspaceRoot, ".cotal", "agents", "pin-probe.md"), "---\nname: pin-probe\nagent: boot-present\n---\n");
  const uninstallPresent = join(uninstallBin, executable("present-harness"));
  const siblingPresent = join(siblingBin, executable("present-harness"));
  const unpinnedReason = (pinnedPath: string) =>
    `boot-present harness needs pinned present-harness (${pinnedPath}) on PATH - not found (no fallback to another copy on PATH)`;
  const movedReason = (pinnedPath: string, foundPath: string) =>
    `boot-present harness needs pinned present-harness (${pinnedPath}) on PATH - found ${foundPath} instead (restart this Manager to use it)`;
  const instUnavailableError = (reason: string) =>
    `${reason}. Restore the harness on this host, or pin another manager in this space with --on <instance> (the whole id, as ps prints it)`;
  const instMovedError = (reason: string) =>
    `${reason}. Restart this Manager to use the copy now on PATH, or pin another manager in this space with --on <instance> (the whole id, as ps prints it)`;
  const classUnavailableError = (reason: string) =>
    `${reason}. This manager cannot launch that harness. The space may have other managers; pin one with --on <instance> (the whole id, as ps prints it)`;
  const uninstallReason = unpinnedReason(uninstallPresent);
  writeFileSync(uninstallPresent, script, { mode: 0o700 });
  writeFileSync(siblingPresent, script, { mode: 0o700 });

  type TrackedManager = {
    runtime: unknown;
    agents: Map<string, unknown>;
    managerStatusData(): ManagerStatus;
    connectorInventory: { connectorStatuses: ManagerStatus["connectors"] };
    seatLaunch: { classSpawnEnabled(): boolean };
    goalWriterComponent: { goalAcceptances: Map<string, unknown> };
    servePlane: { serviceServe?: { grant: { epoch: number } } };
    namesCapacity: {
      reserve: (name: string, owner: string) => void;
      uniqueName: (base: string, unavailable?: ReadonlySet<string>) => string;
      reservedCount: number;
      occupancy(): { used: number; reserved: number; managed: number };
    };
  };
  const instrumentManager = (target: Manager, expectedCommand: string) => {
    const view = target as unknown as TrackedManager;
    const stats = { spawnCalls: 0, reserveCalls: 0, uniqueNameCalls: 0, lastCommand: "", lastError: "" };
    const origReserve = view.namesCapacity.reserve.bind(view.namesCapacity);
    const origUniqueName = view.namesCapacity.uniqueName.bind(view.namesCapacity);
    view.namesCapacity.reserve = (name: string, owner: string) => { stats.reserveCalls++; origReserve(name, owner); };
    view.namesCapacity.uniqueName = (base: string, unavailable?: ReadonlySet<string>) => { stats.uniqueNameCalls++; return origUniqueName(base, unavailable); };
    view.runtime = {
      kind: "fake", streamsTerminal: false,
      spawn: (name: string, spec: { command: string; args: string[]; env?: Record<string, string> }, cwd: string) => {
        stats.spawnCalls++;
        stats.lastCommand = spec.command;
        const exec = spawnSync(spec.command, spec.args, { cwd, env: spec.env, encoding: "utf8" });
        stats.lastError = exec.error?.message ?? "";
        let state = spec.command === expectedCommand && exec.status === 0 ? "exited" : "running";
        return { name, kind: "fake", status: () => state, stop: () => { state = "exited"; }, waitForExit: async () => state === "exited", interrupt: () => {}, attach: () => fakeSession };
      },
    };
    return { view, stats };
  };
  const countStates = (rows: readonly { state: string }[]) => ({
    available: rows.filter((r) => r.state === "available").length,
    unavailable: rows.filter((r) => r.state === "unavailable").length,
  });

  {
    const space = "uninstall-recheck";
    process.env.PATH = uninstallBin;
    const uninstalled = new Manager({ space, servers, runtime: "pty", workspaceRoot, installedExtensions: true });
    const U = instrumentManager(uninstalled, uninstallPresent);
    await uninstalled.start();
    const uninstalledId = U.view.managerStatusData().instanceId;
    process.env.PATH = siblingBin;
    const sibling = new Manager({ space, servers, runtime: "pty", workspaceRoot: siblingWorkspaceRoot, installedExtensions: true });
    const S = instrumentManager(sibling, siblingPresent);
    await sibling.start();
    const siblingId = S.view.managerStatusData().instanceId;
    process.env.PATH = uninstallBin;
    const nc = await connect({ servers });
    const caller = { owner: DEV_OWNER, actor: newIdentity().id, uid: mintLifecycleUid() };
    const callInst = (instanceId: string, command: "status" | "models" | "spawn", args?: Record<string, unknown>) =>
      epCall(nc, space, { mode: "inst", instanceId, epoch: (instanceId === siblingId ? S : U).view.servePlane.serviceServe?.grant.epoch ?? 0 },
        { endpoint: "manager", command, contract: MANAGER_CONTRACTS[command], caller, ...(args ? { args } : {}) },
        { deadlineMs: 5000 });
    const callClassSpawn = () =>
      epCall(nc, space, { mode: "one" },
        { endpoint: "manager", command: "spawn", contract: MANAGER_CONTRACTS.spawn, caller, args: { name: "pin-probe", agent: "boot-present", events: false } },
        { deadlineMs: 5000, currentEpoch: async () => 0 });
    try {
      const bootCounts = countStates(U.view.connectorInventory.connectorStatuses);
      check("uninstall fixture boots with 1 available and 1 unavailable connector and classSpawn enabled",
        bootCounts.available === 1 && bootCounts.unavailable === 1 && U.view.managerStatusData().classSpawn === true, bootCounts);

      rmSync(uninstallPresent);
      const statusReply = await callInst(uninstalledId, "status");
      const statusData = statusReply.reply.ok ? statusReply.reply.data as ManagerStatus : undefined;
      const statusCounts = countStates(statusData?.connectors ?? []);
      const presentRow = statusData?.connectors.find((r) => r.agent === "boot-present");
      const pinnedSpawn = await callInst(uninstalledId, "spawn", { name: "pin-probe", agent: "boot-present", events: false });
      const reproSummary = {
        statusCounts,
        presentRow,
        classSpawn: statusData?.classSpawn,
        pinnedSpawn: pinnedSpawn.reply,
        stats: { ...U.stats },
        agents: U.view.agents.size,
        reserved: U.view.namesCapacity.reservedCount,
        occupancy: U.view.namesCapacity.occupancy(),
        goals: U.view.goalWriterComponent.goalAcceptances.size,
      };
      console.log("after uninstall (status + launch):", JSON.stringify(reproSummary));
      check(
        "status marks a deleted application unavailable with 0 available rows and disables classSpawn",
        statusReply.reply.ok === true && statusCounts.available === 0 && statusCounts.unavailable === 2 &&
          presentRow?.state === "unavailable" && presentRow.reason === uninstallReason &&
          Object.keys(presentRow.binaries).length === 0 && statusData?.classSpawn === false,
        reproSummary,
      );
      check(
        "pinned launch of a deleted application refuses with not-executed before reserving name or capacity",
        pinnedSpawn.reply.ok === false && pinnedSpawn.reply.error.code === "failed-precondition" &&
          pinnedSpawn.reply.error.outcome === "not-executed" && pinnedSpawn.reply.error.message === instUnavailableError(uninstallReason) &&
          U.stats.spawnCalls === 0 && U.stats.reserveCalls === 0 && U.stats.uniqueNameCalls === 0 &&
          U.view.agents.size === 0 && U.view.namesCapacity.reservedCount === 0 &&
          U.view.namesCapacity.occupancy().used === 0 && U.view.goalWriterComponent.goalAcceptances.size === 0,
        reproSummary,
      );

      process.env.PATH = siblingBin;
      let siblingHandled = 0;
      let uninstalledHandled = 0;
      for (let i = 0; i < 8; i++) {
        const routed = await callClassSpawn();
        if (routed.reply.ok && routed.responder.instanceId === siblingId) siblingHandled++;
        if (routed.responder.instanceId === uninstalledId) uninstalledHandled++;
      }
      check(
        "class-spawn routing skips the manager with 0 available applications and routes all 8 spawns to the capable sibling",
        siblingHandled === 8 && uninstalledHandled === 0 && S.stats.spawnCalls === 8 && U.stats.spawnCalls === 0,
        { siblingHandled, uninstalledHandled, siblingSpawns: S.stats.spawnCalls, uninstalledSpawns: U.stats.spawnCalls },
      );

      process.env.PATH = uninstallBin;
      writeFileSync(uninstallPresent, script, { mode: 0o700 });
      const recoveredStatus = await callInst(uninstalledId, "status");
      const recoveredData = recoveredStatus.reply.ok ? recoveredStatus.reply.data as ManagerStatus : undefined;
      const recoveredCounts = countStates(recoveredData?.connectors ?? []);
      const recoveredRow = recoveredData?.connectors.find((r) => r.agent === "boot-present");
      const recoveredSpawn = await callInst(uninstalledId, "spawn", { name: "pin-probe", agent: "boot-present", events: false });
      check(
        "reinstalling the application restores 1 available row, classSpawn and launch without restarting",
        recoveredCounts.available === 1 && recoveredCounts.unavailable === 1 &&
          recoveredRow?.state === "available" && recoveredRow.reason === undefined &&
          recoveredRow.binaries["present-harness"] === uninstallPresent && recoveredData?.classSpawn === true &&
          recoveredSpawn.reply.ok === true && U.stats.spawnCalls === 1,
        { recoveredCounts, recoveredRow, classSpawn: recoveredData?.classSpawn, recoveredSpawn: recoveredSpawn.reply, stats: U.stats },
      );
    } finally {
      await nc.close();
      await sibling.stop({ withAgents: true });
      await uninstalled.stop({ withAgents: true });
    }
  }

  {
    const space = "uninstall-launch-first";
    writeFileSync(uninstallPresent, script, { mode: 0o700 });
    process.env.PATH = uninstallBin;
    const launchFirst = new Manager({ space, servers, runtime: "pty", workspaceRoot, installedExtensions: true });
    const LF = instrumentManager(launchFirst, uninstallPresent);
    await launchFirst.start();
    try {
      rmSync(uninstallPresent);
      const directLaunch = await launchFirst.startAgent({ name: "pin-probe", agent: "boot-present", events: false });
      const afterLaunchCounts = countStates(LF.view.connectorInventory.connectorStatuses);
      const afterLaunchRow = LF.view.connectorInventory.connectorStatuses.find((r) => r.agent === "boot-present");
      check(
        "launch before any status read detects a deleted executable and refuses before reserving name or capacity",
        directLaunch.ok === false && directLaunch.error === uninstallReason &&
          LF.stats.spawnCalls === 0 && LF.stats.reserveCalls === 0 && LF.stats.uniqueNameCalls === 0 &&
          LF.view.namesCapacity.occupancy().used === 0 && afterLaunchCounts.available === 0 &&
          afterLaunchCounts.unavailable === 2 && afterLaunchRow?.state === "unavailable" &&
          afterLaunchRow.reason === uninstallReason && LF.view.managerStatusData().classSpawn === false,
        { directLaunch, afterLaunchCounts, afterLaunchRow, stats: LF.stats },
      );

      writeFileSync(uninstallPresent, script, { mode: 0o700 });
      check(
        "status restores the application before testing PATH removal",
        LF.view.managerStatusData().classSpawn === true &&
          countStates(LF.view.connectorInventory.connectorStatuses).available === 1,
      );
      process.env.PATH = emptyBin;
      const fileStillExists = existsSync(uninstallPresent);
      const offPathLaunch = await launchFirst.startAgent({ name: "pin-probe", agent: "boot-present", events: false });
      const offPathStatus = LF.view.managerStatusData();
      const offPathCounts = countStates(offPathStatus.connectors);
      const offPathRow = offPathStatus.connectors.find((r) => r.agent === "boot-present");
      check(
        "an executable that still exists on disk becomes unavailable when it does not resolve on PATH",
        fileStillExists && offPathLaunch.ok === false && offPathLaunch.error === uninstallReason &&
          LF.stats.spawnCalls === 0 && LF.stats.reserveCalls === 0 && LF.stats.uniqueNameCalls === 0 &&
          offPathCounts.available === 0 && offPathCounts.unavailable === 2 &&
          offPathRow?.state === "unavailable" && offPathRow.reason === uninstallReason &&
          Object.keys(offPathRow.binaries).length === 0 && offPathStatus.classSpawn === false,
        { fileStillExists, offPathLaunch, offPathCounts, offPathRow, stats: LF.stats },
      );
    } finally {
      await launchFirst.stop({ withAgents: true });
    }
  }

  {
    const space = "recheck-load";
    const loadBin = join(root, "load-bin");
    const stateDirectory = join(root, "obs-state");
    mkdirSync(loadBin, { mode: 0o700 });
    mkdirSync(stateDirectory, { mode: 0o700 });
    const loadPresent = join(loadBin, executable("present-harness"));
    const loadSecond = join(loadBin, executable("second-harness"));
    writeFileSync(loadPresent, script, { mode: 0o700 });
    writeFileSync(loadSecond, script, { mode: 0o700 });
    saveExtensionsManifest({
      extensions: [
        {
          pkg: "@fixture/boot-connectors",
          version: "1.0.0",
          spec: ".",
          provides: [
            { kind: "connector", name: "boot-missing" },
            { kind: "connector", name: "boot-present" },
            { kind: "connector", name: "boot-second" },
          ],
          commands: [],
          connectors: [
            { name: "boot-missing", requires: ["harness-that-does-not-exist-965"], eventPlane: false },
            { name: "boot-present", requires: ["present-harness"], eventPlane: true },
            { name: "boot-second", requires: ["second-harness"], eventPlane: true },
          ],
        },
      ],
    });
    const secondConnector: Connector = {
      kind: "connector",
      name: "boot-second",
      requires: ["second-harness"],
      buildLaunch: (opts) => ({ command: opts.resolvedBinaries?.["second-harness"] ?? "second-harness", args: [] }),
    };
    registry.register(secondConnector);
    process.env.PATH = loadBin;
    const observed = new Manager({ space, servers, runtime: "pty", workspaceRoot, installedExtensions: true });
    const O = instrumentManager(observed, loadPresent);
    await observed.start();
    const nc = await connect({ servers });
    const caller = { owner: DEV_OWNER, actor: newIdentity().id, uid: mintLifecycleUid() };
    const observedId = O.view.managerStatusData().instanceId;
    let rechecks = 0;
    let byAgent: Record<string, number> = {};
    for (const row of O.view.connectorInventory.connectorStatuses) {
      let current = row.binaries;
      Object.defineProperty(row, "binaries", {
        enumerable: true,
        configurable: true,
        get: () => current,
        set: (next: Record<string, string>) => {
          rechecks++;
          byAgent[row.agent] = (byAgent[row.agent] ?? 0) + 1;
          current = next;
        },
      });
    }
    let accessCalls = 0;
    const origAccessSync = fs.accessSync;
    fs.accessSync = ((path: fs.PathLike, mode?: number) => {
      const text = String(path);
      if (text.startsWith(loadBin) || text.includes("harness-that-does-not-exist-965")) accessCalls++;
      return origAccessSync(path, mode);
    }) as typeof fs.accessSync;
    syncBuiltinESMExports();
    let observerTicks = 0;
    let observerSawImpact = false;
    const origLocalObservation = observed.localServiceObservation.bind(observed);
    observed.localServiceObservation = () => {
      observerTicks++;
      const obs = origLocalObservation();
      if (obs?.stopImpact) observerSawImpact = true;
      return obs;
    };
    let disposeObserver: (() => void) | undefined;
    try {
      rechecks = 0;
      byAgent = {};
      accessCalls = 0;
      disposeObserver = armManagerServiceObserver(observed, {
        root: workspaceRoot,
        context: { space, instanceId: "obs_inst", launchRequestId: "obs_req", stateDirectory },
      });
      await wait(2200);
      disposeObserver();
      disposeObserver = undefined;
      const observerSnapshot = {
        ticks: observerTicks,
        observed: observerSawImpact,
        rechecks,
        byAgent: { ...byAgent },
        accessCalls,
      };

      rechecks = 0;
      byAgent = {};
      accessCalls = 0;
      const launchReply = await epCall(nc, space, { mode: "inst", instanceId: observedId, epoch: O.view.servePlane.serviceServe?.grant.epoch ?? 0 },
        { endpoint: "manager", command: "spawn", contract: MANAGER_CONTRACTS.spawn, caller, args: { name: "pin-probe", agent: "boot-present", events: false } },
        { deadlineMs: 5000 });
      const launchSnapshot = {
        ok: launchReply.reply.ok,
        spawnCalls: O.stats.spawnCalls,
        rechecks,
        byAgent: { ...byAgent },
        accessCalls,
      };
      console.log("recheck load:", JSON.stringify({ observer: observerSnapshot, launch: launchSnapshot }));
      check(
        "hosted service observer triggers zero connector rechecks over multiple seconds",
        observerSnapshot.ticks >= 8 && observerSnapshot.observed &&
          observerSnapshot.rechecks === 0 && observerSnapshot.accessCalls === 0,
        observerSnapshot,
      );
      check(
        "launch rechecks only the requested connector once",
        launchReply.reply.ok === true && O.stats.spawnCalls === 1 &&
          launchSnapshot.rechecks === 1 && launchSnapshot.accessCalls > 0 && launchSnapshot.byAgent["boot-present"] === 1 &&
          (launchSnapshot.byAgent["boot-second"] ?? 0) === 0 && (launchSnapshot.byAgent["boot-missing"] ?? 0) === 0,
        launchSnapshot,
      );
    } finally {
      disposeObserver?.();
      fs.accessSync = origAccessSync;
      syncBuiltinESMExports();
      await nc.close();
      await observed.stop({ withAgents: true });
    }
  }

  // Library `new Manager({ installedExtensions: true })` loads compatible local `@cotal-ai/*`
  // connectors at non-matching versions directly without CLI setup, and refuses core-skewed ones.
  {
    process.env.PATH = binDir;
    writeFileSync(present, script, { mode: 0o700 });
    const extRoot = extensionsDir();
    const compatPkg = "@cotal-ai/lib-manager-compat";
    const skewedPkg = "@cotal-ai/lib-manager-skewed";
    const compatMarker = join(root, "lib-manager-compat-imported");
    const skewedMarker = join(root, "lib-manager-skewed-imported");
    const coreLinkTarget = new URL("../../../packages/core", import.meta.url).pathname;
    for (const [pkg, peerRange, connectorName, body] of [
      [compatPkg, "*", "lib-compat-connector", `import { writeFileSync } from "node:fs";\nimport { registry } from "@cotal-ai/core";\nwriteFileSync(${JSON.stringify(compatMarker)}, "loaded");\nregistry.register({ kind: "connector", name: "lib-compat-connector", requires: ["present-harness"], waitsForOperator: () => "fixture input screen", buildLaunch: (opts) => ({ command: opts.resolvedBinaries?.["present-harness"] ?? "present-harness", args: [] }) });\n`],
      [skewedPkg, ">=99.0.0", "lib-skewed-connector", `import { writeFileSync } from "node:fs";\nimport { registry } from "@cotal-ai/core";\nwriteFileSync(${JSON.stringify(skewedMarker)}, "loaded");\nregistry.register({ kind: "connector", name: "lib-skewed-connector", requires: ["present-harness"], buildLaunch: (opts) => ({ command: opts.resolvedBinaries?.["present-harness"] ?? "present-harness", args: [] }) });\n`],
    ] as const) {
      const pkgDir = join(extRoot, "node_modules", ...pkg.split("/"));
      const peerCoreDir = join(pkgDir, "node_modules/@cotal-ai");
      mkdirSync(peerCoreDir, { recursive: true });
      spawnSync("ln", ["-snf", coreLinkTarget, join(peerCoreDir, "core")]);
      writeFileSync(join(pkgDir, "package.json"), JSON.stringify({
        name: pkg,
        version: "0.179.0",
        type: "module",
        main: "index.mjs",
        peerDependencies: { "@cotal-ai/core": peerRange },
      }));
      writeFileSync(join(pkgDir, "index.mjs"), body);
      writeFileSync(join(workspaceRoot, ".cotal", "agents", `${connectorName}.md`), `---\nname: ${connectorName}\nagent: ${connectorName}\n---\n`);
    }
    saveExtensionsManifest({
      extensions: [
        { pkg: compatPkg, version: "0.179.0", spec: "./lib-compat", provides: [{ kind: "connector", name: "lib-compat-connector" }], commands: [], connectors: [{ name: "lib-compat-connector", requires: ["present-harness"], eventPlane: false }] },
        { pkg: skewedPkg, version: "0.179.0", spec: "./lib-skewed", provides: [{ kind: "connector", name: "lib-skewed-connector" }], commands: [], connectors: [{ name: "lib-skewed-connector", requires: ["present-harness"], eventPlane: false }] },
      ],
    });
    const libManager = new Manager({ space: "lib-core-peer", servers, runtime: "pty", workspaceRoot, installedExtensions: true });
    (libManager as unknown as { runtime: unknown }).runtime = {
      kind: "fake", streamsTerminal: false,
      spawn: (name: string, spec: { command: string; args: string[]; env?: Record<string, string> }, cwd: string) => {
        spawnSync(spec.command, spec.args, { cwd, env: spec.env, encoding: "utf8" });
        let state = "running";
        return { name, kind: "fake", status: () => state, stop: () => { state = "exited"; }, waitForExit: async () => state === "exited", interrupt: () => {}, attach: () => ({ cols: 80, rows: 24, backlog: () => Buffer.alloc(0), onData: () => () => {}, onExit: () => () => {}, write: () => {}, resize: () => {} }) };
      },
    };
    try {
      await libManager.start();
      const compatSpawn = await libManager.startAgent({ name: "lib-compat-connector", agent: "lib-compat-connector", events: false });
      check(
        "library Manager materializes a compatible local @cotal-ai/* connector at another version",
        compatSpawn.ok === true && existsSync(compatMarker),
        compatSpawn,
      );
      const skewedSpawn = await libManager.startAgent({ name: "lib-skewed-connector", agent: "lib-skewed-connector", events: false });
      check(
        "library Manager refuses a core-skewed local @cotal-ai/* connector before importing it",
        skewedSpawn.ok === false && skewedSpawn.error?.includes(`${skewedPkg} declares @cotal-ai/core ">=99.0.0"`) === true && !existsSync(skewedMarker),
        skewedSpawn,
      );
    } finally {
      await libManager.stop({ withAgents: true }).catch(() => {});
    }
  }

  {
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
            { name: "boot-present", requires: ["present-harness"], eventPlane: false },
          ],
        },
      ],
    });
    const mutableConnector = connector as { -readonly [K in keyof Connector]: Connector[K] };
    const prevCommands = mutableConnector.commands;
    const prevWaitsForOperator = mutableConnector.waitsForOperator;
    let commandsBinary: string | undefined;
    let commandsCalled = 0;
    mutableConnector.commands = {
      targets: ["command"],
      list: async (opts) => {
        commandsCalled++;
        commandsBinary = opts.resolvedBinaries?.["present-harness"];
        return { supported: true, commands: [{ name: "probe-cmd", target: "command" }] };
      },
    };

    try {
      // 1. Lost boot pin with a second copy on PATH: refuses without silent switch, names the moved copy and restart remedy, and distinguishes truly missing from moved.
      {
        const space = "lost-pin-no-fallback";
        const firstDir = join(root, "pin-first");
        const secondDir = join(root, "pin-second");
        mkdirSync(firstDir, { recursive: true, mode: 0o700 });
        mkdirSync(secondDir, { recursive: true, mode: 0o700 });
        const firstBinary = join(firstDir, executable("present-harness"));
        const secondBinary = join(secondDir, executable("present-harness"));
        writeFileSync(firstBinary, script, { mode: 0o700 });
        writeFileSync(secondBinary, process.platform === "win32" ? "@exit /b 42\r\n" : "#!/bin/sh\nexit 42\n", { mode: 0o700 });
        process.env.PATH = `${firstDir}${process.platform === "win32" ? ";" : ":"}${secondDir}`;
        const pinned = new Manager({ space, servers, runtime: "pty", workspaceRoot, installedExtensions: true });
        const P = instrumentManager(pinned, firstBinary);
        await pinned.start();
        const pinnedId = P.view.managerStatusData().instanceId;
        const nc = await connect({ servers });
        const caller = { owner: DEV_OWNER, actor: newIdentity().id, uid: mintLifecycleUid() };
        const inst = () => ({ mode: "inst" as const, instanceId: pinnedId, epoch: P.view.servePlane.serviceServe?.grant.epoch ?? 0 });
        const firstMissingReason = unpinnedReason(firstBinary);
        const firstMovedReason = movedReason(firstBinary, secondBinary);
        try {
          rmSync(firstBinary);
          const statusMoved = await epCall(nc, space, inst(), { endpoint: "manager", command: "status", contract: MANAGER_CONTRACTS.status, caller }, { deadlineMs: 5000 });
          const movedData = statusMoved.reply.ok ? statusMoved.reply.data as ManagerStatus : undefined;
          const movedRow = movedData?.connectors.find((r) => r.agent === "boot-present");
          const movedModels = await epCall(nc, space, inst(), { endpoint: "manager", command: "models", contract: MANAGER_CONTRACTS.models, caller, args: { agent: "boot-present" } }, { deadlineMs: 5000 });
          const movedCmds = await epCall(nc, space, inst(), { endpoint: "manager", command: "harness-commands", contract: MANAGER_CONTRACTS["harness-commands"], caller, args: { agent: "boot-present", cwd: workspaceRoot } }, { deadlineMs: 5000 });
          const refusedSpawn = await epCall(nc, space, inst(), {
            endpoint: "manager", command: "spawn", contract: MANAGER_CONTRACTS.spawn, caller,
            args: { name: "pin-probe", agent: "boot-present", events: false },
          }, { deadlineMs: 5000 });
          check(
            "deleting a boot-pinned binary with another copy on PATH refuses, clears binaries, and names the found copy and restart remedy across status, models, harness-commands, and pinned spawn",
            movedRow?.state === "unavailable" && Object.keys(movedRow.binaries).length === 0 &&
              movedRow.reason === firstMovedReason && movedData?.classSpawn === false &&
              movedModels.reply.ok === false && movedModels.reply.error.message === firstMovedReason &&
              movedCmds.reply.ok === false && movedCmds.reply.error.message === firstMovedReason &&
              refusedSpawn.reply.ok === false && refusedSpawn.reply.error.outcome === "not-executed" &&
              refusedSpawn.reply.error.message === instMovedError(firstMovedReason) &&
              P.stats.spawnCalls === 0 && P.stats.reserveCalls === 0,
            { movedRow, classSpawn: movedData?.classSpawn, movedModels: movedModels.reply, movedCmds: movedCmds.reply, refusedSpawn: refusedSpawn.reply, stats: { ...P.stats } },
          );

          process.env.PATH = join(root, "empty-bin");
          const statusEmpty = await epCall(nc, space, inst(), { endpoint: "manager", command: "status", contract: MANAGER_CONTRACTS.status, caller }, { deadlineMs: 5000 });
          const emptyData = statusEmpty.reply.ok ? statusEmpty.reply.data as ManagerStatus : undefined;
          const emptyRow = emptyData?.connectors.find((r) => r.agent === "boot-present");
          const emptySpawn = await epCall(nc, space, inst(), {
            endpoint: "manager", command: "spawn", contract: MANAGER_CONTRACTS.spawn, caller,
            args: { name: "pin-probe", agent: "boot-present", events: false },
          }, { deadlineMs: 5000 });
          check(
            "when no copy remains on PATH, the refusal says not found and pinned spawn tells the operator to restore the harness",
            emptyRow?.state === "unavailable" && Object.keys(emptyRow.binaries).length === 0 &&
              emptyRow.reason === firstMissingReason && emptyData?.classSpawn === false &&
              emptySpawn.reply.ok === false && emptySpawn.reply.error.message === instUnavailableError(firstMissingReason),
            { emptyRow, emptySpawn: emptySpawn.reply },
          );

          process.env.PATH = secondDir;
          const statusFlap = await epCall(nc, space, inst(), { endpoint: "manager", command: "status", contract: MANAGER_CONTRACTS.status, caller }, { deadlineMs: 5000 });
          const flapData = statusFlap.reply.ok ? statusFlap.reply.data as ManagerStatus : undefined;
          const flapRow = flapData?.connectors.find((r) => r.agent === "boot-present");
          const flapSpawn = await epCall(nc, space, inst(), {
            endpoint: "manager", command: "spawn", contract: MANAGER_CONTRACTS.spawn, caller,
            args: { name: "pin-probe", agent: "boot-present", events: false },
          }, { deadlineMs: 5000 });
          check(
            "after transitioning through empty PATH back to another directory on PATH, the connector still refuses with the found-copy restart remedy",
            flapRow?.state === "unavailable" && Object.keys(flapRow.binaries).length === 0 &&
              flapRow.reason === firstMovedReason && flapData?.classSpawn === false &&
              flapSpawn.reply.ok === false && flapSpawn.reply.error.message === instMovedError(firstMovedReason) &&
              P.stats.spawnCalls === 0,
            { flapRow, classSpawn: flapData?.classSpawn, flapSpawn: flapSpawn.reply, stats: { ...P.stats } },
          );

          writeFileSync(firstBinary, script, { mode: 0o700 });
          process.env.PATH = `${firstDir}${process.platform === "win32" ? ";" : ":"}${secondDir}`;
          const restoredSpawn = await epCall(nc, space, inst(), {
            endpoint: "manager", command: "spawn", contract: MANAGER_CONTRACTS.spawn, caller,
            args: { name: "pin-probe", agent: "boot-present", events: false },
          }, { deadlineMs: 5000 });
          const restoredStatus = P.view.managerStatusData();
          const restoredRow = restoredStatus.connectors.find((r) => r.agent === "boot-present");
          check(
            "restoring the original pinned binary on PATH recovers the connector without switching files",
            restoredSpawn.reply.ok === true && P.stats.spawnCalls === 1 && P.stats.lastCommand === firstBinary &&
              restoredRow?.state === "available" && restoredRow.binaries["present-harness"] === firstBinary &&
              restoredStatus.classSpawn === true,
            { restoredSpawn: restoredSpawn.reply, restoredRow, classSpawn: restoredStatus.classSpawn, stats: { ...P.stats } },
          );
        } finally {
          await nc.close();
          await pinned.stop({ withAgents: true });
        }
      }

      // 2. Wire `models`, wire `harness-commands`, wire launch-first `spawn`, and stale-rail window within 40 tries across two Managers.
      {
        const space = "wire-surfaces-and-routing";
        const firstBin = join(root, "wire-first-bin");
        const secondBin = join(root, "wire-second-bin");
        mkdirSync(firstBin, { recursive: true, mode: 0o700 });
        mkdirSync(secondBin, { recursive: true, mode: 0o700 });
        const firstExec = join(firstBin, executable("present-harness"));
        const secondExec = join(secondBin, executable("present-harness"));
        const firstExecReason = unpinnedReason(firstExec);
        const firstMovedToSecondReason = movedReason(firstExec, secondExec);
        writeFileSync(firstExec, script, { mode: 0o700 });
        writeFileSync(secondExec, script, { mode: 0o700 });
        process.env.PATH = firstBin;
        const firstMgr = new Manager({ space, servers, runtime: "pty", workspaceRoot, installedExtensions: true });
        const F = instrumentManager(firstMgr, firstExec);
        await firstMgr.start();
        const nc = await connect({ servers });
        const caller = { owner: DEV_OWNER, actor: newIdentity().id, uid: mintLifecycleUid() };
        const firstId = F.view.managerStatusData().instanceId;
        const callFirst = (command: "status" | "models" | "harness-commands" | "spawn", args?: Record<string, unknown>) =>
          epCall(nc, space, { mode: "inst", instanceId: firstId, epoch: F.view.servePlane.serviceServe?.grant.epoch ?? 0 },
            { endpoint: "manager", command, contract: MANAGER_CONTRACTS[command], caller, ...(args ? { args } : {}) },
            { deadlineMs: 5000 });
        try {
          // Wire models + harness-commands when available, then after deleting firstExec (before any status read).
          const okCmds = await callFirst("harness-commands", { agent: "boot-present", cwd: workspaceRoot });
          commandsCalled = 0;
          presentCatalogBinary = undefined;
          rmSync(firstExec);
          const missingModels = await callFirst("models", { agent: "boot-present" });
          const modelsStoredRow = F.view.connectorInventory.connectorStatuses.find((r) => r.agent === "boot-present");
          check(
            "wire models rechecks a deleted binary, updates the stored row, refuses with the pinned reason, and disables classSpawn without calling managerStatusData",
            okCmds.reply.ok === true && commandsBinary === firstExec &&
              missingModels.reply.ok === false && missingModels.reply.error.message === firstExecReason &&
              presentCatalogBinary === undefined && F.view.seatLaunch.classSpawnEnabled() === false &&
              modelsStoredRow?.state === "unavailable" && modelsStoredRow.reason === firstExecReason &&
              Object.keys(modelsStoredRow.binaries).length === 0,
            { okCmds: okCmds.reply, missingModels: missingModels.reply, presentCatalogBinary, modelsStoredRow },
          );

          writeFileSync(firstExec, script, { mode: 0o700 });
          await callFirst("status");
          rmSync(firstExec);
          const missingCmds = await callFirst("harness-commands", { agent: "boot-present", cwd: workspaceRoot });
          const cmdsStoredRow = F.view.connectorInventory.connectorStatuses.find((r) => r.agent === "boot-present");
          check(
            "wire harness-commands rechecks a deleted binary, updates the stored row, refuses not-executed before connector.commands.list, and disables classSpawn without calling managerStatusData",
            missingCmds.reply.ok === false && missingCmds.reply.error.code === "failed-precondition" &&
              missingCmds.reply.error.outcome === "not-executed" && missingCmds.reply.error.message === firstExecReason &&
              commandsCalled === 0 && F.view.seatLaunch.classSpawnEnabled() === false &&
              cmdsStoredRow?.state === "unavailable" && cmdsStoredRow.reason === firstExecReason &&
              Object.keys(cmdsStoredRow.binaries).length === 0,
            { missingCmds: missingCmds.reply, commandsCalled, cmdsStoredRow },
          );

          // Wire launch-first spawn (no status read before spawn) + stale-rail window within 40 tries across two Managers.
          writeFileSync(firstExec, script, { mode: 0o700 });
          await callFirst("status");
          saveExtensionsManifest({
            extensions: [
              {
                pkg: "@fixture/boot-connectors",
                version: "1.0.0",
                spec: ".",
                provides: [
                  { kind: "connector", name: "boot-missing" },
                  { kind: "connector", name: "boot-present" },
                  { kind: "connector", name: "boot-second" },
                ],
                commands: [],
                connectors: [
                  { name: "boot-missing", requires: ["harness-that-does-not-exist-965"], eventPlane: false },
                  { name: "boot-present", requires: ["present-harness"], eventPlane: false },
                  { name: "boot-second", requires: ["second-harness"], eventPlane: false },
                ],
              },
            ],
          });
          const secondHarness = join(secondBin, executable("second-harness"));
          writeFileSync(secondHarness, script, { mode: 0o700 });
          process.env.PATH = secondBin;
          const secondMgr = new Manager({ space, servers, runtime: "pty", workspaceRoot: siblingWorkspaceRoot, installedExtensions: true });
          const S2 = instrumentManager(secondMgr, secondExec);
          await secondMgr.start();
          const secondId = S2.view.managerStatusData().instanceId;
          try {
            process.env.PATH = firstBin;
            rmSync(firstExec);
            const wireDirectRefusal = await callFirst("spawn", { name: "pin-probe", agent: "boot-present", events: false });
            const directStoredRow = F.view.connectorInventory.connectorStatuses.find((r) => r.agent === "boot-present");
            check(
              "wire pinned spawn before any status read refuses not-executed with sibling --on guidance and drops classSpawn without calling managerStatusData",
              wireDirectRefusal.reply.ok === false && wireDirectRefusal.reply.error.code === "failed-precondition" &&
                wireDirectRefusal.reply.error.outcome === "not-executed" &&
                wireDirectRefusal.reply.error.message === instUnavailableError(firstExecReason) &&
                F.stats.spawnCalls === 0 && F.stats.reserveCalls === 0 &&
                F.view.seatLaunch.classSpawnEnabled() === false &&
                directStoredRow?.state === "unavailable" && directStoredRow.reason === firstExecReason &&
                Object.keys(directStoredRow.binaries).length === 0,
              { wireDirectRefusal: wireDirectRefusal.reply, stats: { ...F.stats }, directStoredRow },
            );

            // Re-arm firstMgr on firstExec (boot-present only; boot-second missing on firstBin), while secondMgr holds boot-present + boot-second on secondBin.
            // When firstExec is deleted and PATH = secondBin, firstMgr has no status call first, so its stale class-rail subscription is still live.
            // Under lost-pin refusal, firstMgr cannot fall back to secondExec: within bounded unpinned spawns one hits firstMgr (refusing not-executed, naming the found copy, and dropping classSpawn), and every subsequent unpinned spawn routes to secondMgr.
            writeFileSync(firstExec, script, { mode: 0o700 });
            await callFirst("status");
            rmSync(firstExec);
            process.env.PATH = secondBin;
            let staleRefusals = 0;
            let staleRefusalMessage = "";
            let secondWinsBeforeDrop = 0;
            for (let i = 0; i < 40 && staleRefusals === 0; i++) {
              const r = await epCall(nc, space, { mode: "one" },
                { endpoint: "manager", command: "spawn", contract: MANAGER_CONTRACTS.spawn, caller, args: { name: "pin-probe", agent: "boot-present", events: false } },
                { deadlineMs: 5000, currentEpoch: async (id) => ((id === secondId ? S2 : F).view.servePlane.serviceServe?.grant.epoch ?? 0) });
              if (!r.reply.ok && r.responder.instanceId === firstId && r.reply.error.outcome === "not-executed") {
                staleRefusals++;
                staleRefusalMessage = r.reply.error.message;
              } else if (r.reply.ok && r.responder.instanceId === secondId) {
                secondWinsBeforeDrop++;
              }
            }
            const firstStoredAfterDrop = F.view.connectorInventory.connectorStatuses.find((r) => r.agent === "boot-present");
            const classEnabledAfterDrop = F.view.seatLaunch.classSpawnEnabled();
            let secondWinsAfterDrop = 0;
            let firstHitsAfterDrop = 0;
            for (let i = 0; i < 6; i++) {
              const r = await epCall(nc, space, { mode: "one" },
                { endpoint: "manager", command: "spawn", contract: MANAGER_CONTRACTS.spawn, caller, args: { name: "pin-probe", agent: "boot-present", events: false } },
                { deadlineMs: 5000, currentEpoch: async (id) => ((id === secondId ? S2 : F).view.servePlane.serviceServe?.grant.epoch ?? 0) });
              if (r.responder.instanceId === firstId) firstHitsAfterDrop++;
              if (r.reply.ok && r.responder.instanceId === secondId) secondWinsAfterDrop++;
            }
            check(
              "real stale-rail window hits the stale manager once within 40 tries (not-executed, names found copy, drops classSpawn) and routes all subsequent spawns to the healthy sibling",
              staleRefusals === 1 && staleRefusalMessage === classUnavailableError(firstMovedToSecondReason) &&
                classEnabledAfterDrop === false && firstStoredAfterDrop?.state === "unavailable" &&
                firstStoredAfterDrop.reason === firstMovedToSecondReason && Object.keys(firstStoredAfterDrop.binaries).length === 0 &&
                firstHitsAfterDrop === 0 && secondWinsAfterDrop === 6 && F.stats.spawnCalls === 0,
              { staleRefusals, staleRefusalMessage, secondWinsBeforeDrop, classEnabledAfterDrop, firstStoredAfterDrop, firstHitsAfterDrop, secondWinsAfterDrop, firstSpawns: F.stats.spawnCalls },
            );
          } finally {
            await secondMgr.stop({ withAgents: true });
          }
        } finally {
          await nc.close();
          await firstMgr.stop({ withAgents: true });
        }
      }

      // 3. Wire single + batch `resume-preserved`: preflight refusal AND batch mid-flight removal during readiness wait.
      {
        const space = "wire-resume-recheck";
        const resumeBin = join(root, "resume-bin");
        const movedResumeBin = join(root, "resume-moved-bin");
        mkdirSync(resumeBin, { recursive: true, mode: 0o700 });
        mkdirSync(movedResumeBin, { recursive: true, mode: 0o700 });
        const resumeExec = join(resumeBin, executable("present-harness"));
        const movedResumeExec = join(movedResumeBin, executable("present-harness"));
        writeFileSync(resumeExec, script, { mode: 0o700 });
        writeFileSync(movedResumeExec, script, { mode: 0o700 });
        writeFileSync(join(workspaceRoot, ".cotal", "agents", "res-a.md"), "---\nname: res-a\nagent: boot-present\n---\n");
        writeFileSync(join(workspaceRoot, ".cotal", "agents", "res-b.md"), "---\nname: res-b\nagent: boot-present\n---\n");
        connector.waitsForOperator = () => "fixture input screen";
        process.env.PATH = `${resumeBin}${process.platform === "win32" ? ";" : ":"}${movedResumeBin}`;

        const makeEntry = (name: string) => {
          const configPath = join(workspaceRoot, ".cotal", "agents", `${name}.md`);
          const configSha256 = createHash("sha256").update(readFileSync(configPath)).digest("hex");
          return {
            space,
            name,
            identity: { mode: "open" as const, id: newIdentity().id, lifecycleUid: mintLifecycleUid() },
            launch: {
              connector: "boot-present",
              runtime: "fake",
              cwd: workspaceRoot,
              source: { kind: "persona" as const, ref: name, configPath, configSha256 },
              allowSubscribe: [],
              events: false,
            },
            dependencies: [configPath],
            spawner: `${DEV_OWNER}.operator`,
            startedAt: new Date().toISOString(),
          };
        };

        // 3a. Wire single resume-preserved refuses when binary is moved before preflight and names the found copy + restart remedy.
        const singleMgr = new Manager({ space, servers, runtime: "pty", workspaceRoot, installedExtensions: true, resumeAttemptId: "attempt_single" });
        const SM = instrumentManager(singleMgr, resumeExec);
        (SM.view as unknown as { runtimeFor: () => unknown }).runtimeFor = () => SM.view.runtime;
        await singleMgr.start();
        const singleId = SM.view.managerStatusData().instanceId;
        const singleEpoch = SM.view.servePlane.serviceServe?.grant.epoch ?? 0;
        const nc = await connect({ servers });
        const caller = { owner: DEV_OWNER, actor: newIdentity().id, uid: mintLifecycleUid() };
        try {
          rmSync(resumeExec);
          const singleInventory = { version: "cotal-manager-resume/v2" as const, space, createdAt: new Date().toISOString(), agents: [makeEntry("res-a")] };
          const singleReply = await epCall(nc, space,
            { mode: "inst", instanceId: singleId, epoch: singleEpoch },
            {
              endpoint: "manager", command: "resume-preserved", contract: MANAGER_CONTRACTS["resume-preserved"], caller,
              args: { attemptId: "attempt_single", inventory: singleInventory },
            },
            { deadlineMs: 5000 });
          const singleRow = SM.view.connectorInventory.connectorStatuses.find((r) => r.agent === "boot-present");
          check(
            "wire single resume-preserved refuses preflight when binary moved after boot, naming the found copy and restart remedy on the wire without launching or keeping reservations",
            singleReply.reply.ok === false &&
              singleReply.reply.error.message === `1 retained agent failed preflight: res-a: ${movedReason(resumeExec, movedResumeExec)}` &&
              SM.stats.spawnCalls === 0 && SM.view.agents.size === 0 && SM.view.namesCapacity.reservedCount === 0 &&
              singleRow?.state === "unavailable" && singleRow.reason === movedReason(resumeExec, movedResumeExec),
            { singleReply: singleReply.reply, stats: { ...SM.stats }, reserved: SM.view.namesCapacity.reservedCount, singleRow },
          );
        } finally {
          await singleMgr.stop({ withAgents: true });
        }

        // 3b. Wire batch resume-preserved: binary exists during preflight, is deleted while res-a launches, so res-b refuses before runtime.spawn.
        process.env.PATH = resumeBin;
        writeFileSync(resumeExec, script, { mode: 0o700 });
        const batchMgr = new Manager({ space: `${space}-batch`, servers, runtime: "pty", workspaceRoot, installedExtensions: true, resumeAttemptId: "attempt_batch" });
        const BM = batchMgr as unknown as TrackedManager & { runtimeFor: () => unknown; ep: { getRoster: () => unknown[] } };
        let batchSpawnCalls = 0;
        const spawnedNames: string[] = [];
        const batchRuntime = {
          kind: "fake",
          streamsTerminal: false,
          spawn: (name: string, spec: { command: string; args: string[]; env?: Record<string, string> }, cwd: string) => {
            batchSpawnCalls++;
            spawnedNames.push(name);
            const exec = spawnSync(spec.command, spec.args, { cwd, env: spec.env, encoding: "utf8" });
            if (name === "res-a") rmSync(resumeExec, { force: true });
            let state: "running" | "exited" = exec.error ? "exited" : "running";
            return { name, kind: "fake", status: () => state, stop: () => { state = "exited"; }, waitForExit: async () => {}, interrupt: () => {}, attach: () => fakeSession };
          },
        };
        BM.runtime = batchRuntime;
        BM.runtimeFor = () => batchRuntime;
        await batchMgr.start();
        const batchId = BM.managerStatusData().instanceId;
        const batchEpoch = BM.servePlane.serviceServe?.grant.epoch ?? 0;
        const origBatchRoster = BM.ep.getRoster.bind(BM.ep);
        BM.ep.getRoster = () => [
          ...origBatchRoster(),
          ...[...BM.agents.values()].map((a: unknown) => {
            const seat = a as { id: string; name: string; lifecycleUid: string };
            return { card: { id: `${DEV_OWNER}.${seat.id}`, name: seat.name }, status: "idle", lifecycleUid: seat.lifecycleUid, ts: Date.now() };
          }),
        ];
        try {
          const batchEntries = [
            { ...makeEntry("res-a"), space: `${space}-batch` },
            { ...makeEntry("res-b"), space: `${space}-batch` },
          ];
          const batchReply = await epCall(nc, `${space}-batch`,
            { mode: "inst", instanceId: batchId, epoch: batchEpoch },
            {
              endpoint: "manager", command: "resume-preserved", contract: MANAGER_CONTRACTS["resume-preserved"], caller,
              args: {
                attemptId: "attempt_batch",
                inventory: { version: "cotal-manager-resume/v2", space: `${space}-batch`, createdAt: new Date().toISOString(), agents: batchEntries },
              },
            },
            { deadlineMs: 5000 });
          check(
            "wire batch resume-preserved rechecks in the launch pass when the binary disappears during an earlier seat's launch",
            batchReply.reply.ok === false && batchSpawnCalls === 1 && JSON.stringify(spawnedNames) === JSON.stringify(["res-a"]) &&
              batchReply.reply.error.message === unpinnedReason(resumeExec) &&
              BM.connectorInventory.connectorStatuses.find((r) => r.agent === "boot-present")?.state === "unavailable",
            { batchReply: batchReply.reply, batchSpawnCalls, spawnedNames, row: BM.connectorInventory.connectorStatuses.find((r) => r.agent === "boot-present") },
          );
        } finally {
          await nc.close();
          await batchMgr.stop({ withAgents: true });
        }
      }

      // 4. Supervised crash restart (`SessionRecovery.recoverManagedSession`) when binary moves after initial launch.
      {
        const space = "crash-restart-recheck";
        const crashBin = join(root, "crash-bin");
        const movedCrashBin = join(root, "crash-moved-bin");
        mkdirSync(crashBin, { recursive: true, mode: 0o700 });
        mkdirSync(movedCrashBin, { recursive: true, mode: 0o700 });
        const crashExec = join(crashBin, executable("present-harness"));
        const movedCrashExec = join(movedCrashBin, executable("present-harness"));
        writeFileSync(crashExec, script, { mode: 0o700 });
        writeFileSync(movedCrashExec, script, { mode: 0o700 });
        writeFileSync(join(workspaceRoot, ".cotal", "agents", "sup-seat.md"), "---\nname: sup-seat\nagent: boot-present\n---\n");
        connector.waitsForOperator = () => "fixture input screen";
        process.env.PATH = `${crashBin}${process.platform === "win32" ? ";" : ":"}${movedCrashBin}`;
        const supMgr = new Manager({ space, servers, runtime: "pty", workspaceRoot, installedExtensions: true });
        const SUP = supMgr as unknown as TrackedManager & { runtimeFor: () => unknown; ep: { getRoster: () => unknown[] } };
        let supSpawns = 0;
        let rosterClock = Date.now();
        const exitListeners = new Map<string, Set<() => void>>();
        const supRuntime = {
          kind: "pty",
          streamsTerminal: false,
          supportsWorkClosure: true,
          spawn: (name: string) => {
            supSpawns++;
            rosterClock += 10;
            let state: "running" | "exited" = "running";
            const listeners = new Set<() => void>();
            exitListeners.set(name, listeners);
            const session = {
              ...fakeSession,
              onExit: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); },
            };
            return {
              name,
              kind: "pty",
              status: () => state,
              stop: () => { state = "exited"; for (const fn of listeners) fn(); },
              waitForExit: async () => {},
              waitForWorkExit: async () => {},
              interrupt: () => {},
              attach: () => session,
              crashNow: () => { state = "exited"; for (const fn of [...listeners]) fn(); },
            };
          },
        };
        SUP.runtime = supRuntime;
        SUP.runtimeFor = () => supRuntime;
        await supMgr.start();
        const origSupRoster = SUP.ep.getRoster.bind(SUP.ep);
        SUP.ep.getRoster = () => [
          ...origSupRoster(),
          ...[...SUP.agents.values()].map((a: unknown) => {
            const seat = a as { id: string; name: string; lifecycleUid: string };
            return { card: { id: `${DEV_OWNER}.${seat.id}`, name: seat.name }, status: "idle", lifecycleUid: seat.lifecycleUid, ts: rosterClock };
          }),
        ];
        const logs: string[] = [];
        const prevErr = console.error;
        console.error = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); prevErr(...args); };
        try {
          const started = await supMgr.startAgent({
            name: "sup-seat", agent: "boot-present", events: false,
            supervise: { restarts: 2, windowMs: 60_000 },
          });
          const seat = SUP.agents.get("sup-seat") as { handle: { crashNow(): void } } | undefined;
          rmSync(crashExec);
          seat?.handle.crashNow();
          for (let i = 0; i < 80 && SUP.agents.has("sup-seat"); i++) await wait(25);
          check(
            "supervised crash restart rechecks the connector binary, skips runtime.spawn when moved, marks the connector unavailable with the found-copy restart remedy, and retires the seat",
            started.ok === true && supSpawns === 1 && !SUP.agents.has("sup-seat") &&
              SUP.connectorInventory.connectorStatuses.find((r) => r.agent === "boot-present")?.state === "unavailable" &&
              logs.some((line) => line.includes(movedReason(crashExec, movedCrashExec))),
            { started, supSpawns, stillManaged: SUP.agents.has("sup-seat"), row: SUP.connectorInventory.connectorStatuses.find((r) => r.agent === "boot-present"), logs: logs.slice(-6) },
          );
        } finally {
          console.error = prevErr;
          await supMgr.stop({ withAgents: true });
        }
      }

      // 5. Claude wake channel failure on a pinned Manager: binary is present on PATH, refusal has clean punctuation and does not say "Restore the harness on this host".
      {
        const space = "claude-wake-refusal";
        const claudeBin = join(root, "claude-wake-bin");
        mkdirSync(claudeBin, { recursive: true, mode: 0o700 });
        const claudeExec = join(claudeBin, executable("claude"));
        writeFileSync(claudeExec, script, { mode: 0o700 });
        writeFileSync(join(workspaceRoot, ".cotal", "agents", "claude-probe.md"), "---\nname: claude-probe\nagent: claude\n---\n");
        const setupCommand = `cotal daemon setup --space ${space}`;
        const fakeClaude: Connector = {
          kind: "connector",
          name: "claude",
          requires: ["claude"],
          setup: { kind: "connector-setup", name: "claude-wake-fail-965" },
          buildLaunch: (opts) => ({ command: opts.resolvedBinaries?.["claude"] ?? "claude", args: [] }),
        };
        registry.register(fakeClaude);
        const fakeClaudeSetup: ConnectorSetupProvider = {
          kind: "connector-setup",
          name: "claude-wake-fail-965",
          connector: {
            name: "claude-wake-fail-965",
            title: "Fixture failing Claude wake setup",
            explain: "Fails registration for smoke verification",
            run: async () => { throw new Error("fixture registration blocked."); },
          },
        };
        registry.register(fakeClaudeSetup);
        saveExtensionsManifest({
          extensions: [
            {
              pkg: "@cotal-ai/connector-claude-code",
              version: (manager as unknown as { config: { expectedConnectorGeneration: string } }).config.expectedConnectorGeneration,
              spec: ".",
              provides: [
                { kind: "connector", name: "claude" },
                { kind: "connector-setup", name: "claude-wake-fail-965" },
              ],
              commands: [],
              connectors: [{ name: "claude", requires: ["claude"], eventPlane: true }],
            },
          ],
        });
        process.env.PATH = claudeBin;
        const claudeMgr = new Manager({ space, servers, runtime: "pty", workspaceRoot, installedExtensions: true, machineSetupCommand: setupCommand });
        const CM = instrumentManager(claudeMgr, claudeExec);
        await claudeMgr.start();
        const claudeId = CM.view.managerStatusData().instanceId;
        const nc = await connect({ servers });
        const caller = { owner: DEV_OWNER, actor: newIdentity().id, uid: mintLifecycleUid() };
        try {
          const claudeRow = CM.view.connectorInventory.connectorStatuses.find((r) => r.agent === "claude");
          const pinnedClaude = await epCall(nc, space,
            { mode: "inst", instanceId: claudeId, epoch: CM.view.servePlane.serviceServe?.grant.epoch ?? 0 },
            { endpoint: "manager", command: "spawn", contract: MANAGER_CONTRACTS.spawn, caller, args: { name: "claude-probe", agent: "claude", events: false } },
            { deadlineMs: 5000 });
          const expectedReason = `Claude wake channel setup failed: fixture registration blocked. Correct the cause and run \`${setupCommand}\` on this computer`;
          const expectedWireError = `${expectedReason}, or pin another manager in this space with --on <instance> (the whole id, as ps prints it)`;
          check(
            "Claude wake setup failure keeps binaries recorded, avoids double periods, and pairs machineSetupCommand with --on instead of saying Restore the harness",
            claudeRow?.state === "unavailable" && claudeRow.binaries["claude"] === claudeExec &&
              claudeRow.reason === expectedReason && !claudeRow.reason.includes("..") &&
              pinnedClaude.reply.ok === false && pinnedClaude.reply.error.outcome === "not-executed" &&
              pinnedClaude.reply.error.message === expectedWireError &&
              !pinnedClaude.reply.error.message.includes("..") &&
              !pinnedClaude.reply.error.message.includes("Restore the harness on this host"),
            { claudeRow, pinnedClaude: pinnedClaude.reply },
          );
        } finally {
          await nc.close();
          await claudeMgr.stop({ withAgents: true });
        }
      }

      // 6. Multi-binary connector with one moved binary and one missing binary on a pinned Manager: inst suffix checks the moved marker before not found.
      {
        const space = "mixed-moved-and-missing";
        const multiFirstDir = join(root, "multi-first");
        const multiSecondDir = join(root, "multi-second");
        mkdirSync(multiFirstDir, { recursive: true, mode: 0o700 });
        mkdirSync(multiSecondDir, { recursive: true, mode: 0o700 });
        const firstMultiA = join(multiFirstDir, executable("multi-a"));
        const secondMultiA = join(multiSecondDir, executable("multi-a"));
        const firstMultiB = join(multiFirstDir, executable("multi-b"));
        writeFileSync(firstMultiA, script, { mode: 0o700 });
        writeFileSync(secondMultiA, script, { mode: 0o700 });
        writeFileSync(firstMultiB, script, { mode: 0o700 });
        writeFileSync(join(workspaceRoot, ".cotal", "agents", "multi-probe.md"), "---\nname: multi-probe\nagent: boot-multi\n---\n");
        const multiConnector: Connector = {
          kind: "connector",
          name: "boot-multi",
          requires: ["multi-a", "multi-b"],
          buildLaunch: (opts) => ({ command: opts.resolvedBinaries?.["multi-a"] ?? "multi-a", args: [] }),
        };
        registry.register(multiConnector);
        saveExtensionsManifest({
          extensions: [
            {
              pkg: "@fixture/boot-multi",
              version: "1.0.0",
              spec: ".",
              provides: [{ kind: "connector", name: "boot-multi" }],
              commands: [],
              connectors: [{ name: "boot-multi", requires: ["multi-a", "multi-b"], eventPlane: false }],
            },
          ],
        });
        process.env.PATH = `${multiFirstDir}${process.platform === "win32" ? ";" : ":"}${multiSecondDir}`;
        const multiMgr = new Manager({ space, servers, runtime: "pty", workspaceRoot, installedExtensions: true });
        const MM = instrumentManager(multiMgr, firstMultiA);
        await multiMgr.start();
        const multiId = MM.view.managerStatusData().instanceId;
        const nc = await connect({ servers });
        const caller = { owner: DEV_OWNER, actor: newIdentity().id, uid: mintLifecycleUid() };
        try {
          rmSync(firstMultiA);
          rmSync(firstMultiB);
          const mixedSpawn = await epCall(nc, space,
            { mode: "inst", instanceId: multiId, epoch: MM.view.servePlane.serviceServe?.grant.epoch ?? 0 },
            { endpoint: "manager", command: "spawn", contract: MANAGER_CONTRACTS.spawn, caller, args: { name: "multi-probe", agent: "boot-multi", events: false } },
            { deadlineMs: 5000 });
          const expectedMixedReason =
            `boot-multi harness needs pinned multi-a (${firstMultiA}) on PATH - found ${secondMultiA} instead (restart this Manager to use it); ` +
            `boot-multi harness needs pinned multi-b (${firstMultiB}) on PATH - not found (no fallback to another copy on PATH)`;
          const multiRow = MM.view.connectorInventory.connectorStatuses.find((r) => r.agent === "boot-multi");
          check(
            "pinned spawn on a multi-binary connector with one moved and one missing binary gives the restart suffix instead of Restore the harness",
            multiRow?.state === "unavailable" && Object.keys(multiRow.binaries).length === 0 &&
              multiRow.reason === expectedMixedReason &&
              mixedSpawn.reply.ok === false && mixedSpawn.reply.error.outcome === "not-executed" &&
              mixedSpawn.reply.error.message === instMovedError(expectedMixedReason) &&
              MM.stats.spawnCalls === 0 && MM.stats.reserveCalls === 0,
            { multiRow, mixedSpawn: mixedSpawn.reply, stats: { ...MM.stats } },
          );
        } finally {
          await nc.close();
          await multiMgr.stop({ withAgents: true });
        }
      }

      // 7. `ServePlane` closed-connection no-op AND redial window resync when availability changes while `dialServeConnection` is in flight.
      {
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
                { name: "boot-present", requires: ["present-harness"], eventPlane: false },
              ],
            },
          ],
        });
        const space = "sync-closed-and-redial";
        const syncBin = join(root, "sync-bin");
        mkdirSync(syncBin, { recursive: true, mode: 0o700 });
        const syncExec = join(syncBin, executable("present-harness"));
        writeFileSync(syncExec, script, { mode: 0o700 });
        process.env.PATH = syncBin;
        const syncMgr = new Manager({ space, servers, runtime: "pty", workspaceRoot, installedExtensions: true });
        const SP = instrumentManager(syncMgr, syncExec);
        const rawSP = syncMgr as unknown as {
          servePlane: {
            serviceServe?: { nc: { close(): Promise<void>; isClosed(): boolean }; grant: { epoch: number } };
            dialServeConnection: (...args: unknown[]) => Promise<{ nc: unknown; handle: unknown }>;
            onServeConnectionClosed(err: Error | undefined, closed: unknown): Promise<void>;
          };
          credentialRenewal: { boundedReconnect(label: string, attempt: () => Promise<boolean>): Promise<boolean> };
          connectorInventory: { refreshConnectors(name?: string): Promise<void> | undefined };
        };
        rawSP.credentialRenewal.boundedReconnect = async (_label, attempt) => attempt();
        await syncMgr.start();
        const nc = await connect({ servers });
        const caller = { owner: DEV_OWNER, actor: newIdentity().id, uid: mintLifecycleUid() };
        let threw: unknown;
        try {
          const closedNc = rawSP.servePlane.serviceServe!.nc;
          const origDial = rawSP.servePlane.dialServeConnection.bind(rawSP.servePlane);
          let markDialed!: () => void;
          const dialed = new Promise<void>((resolve) => { markDialed = resolve; });
          let releaseRedial!: () => void;
          const redialGate = new Promise<void>((resolve) => { releaseRedial = resolve; });
          let intercepted = false;
          rawSP.servePlane.dialServeConnection = async (...args: unknown[]) => {
            const built = await origDial(...args);
            if (!intercepted) {
              intercepted = true;
              markDialed();
              await redialGate;
            }
            return built;
          };

          // Close the active serve connection; while `dialServeConnection` has already subscribed `rebuilt`
          // with `classSpawnEnabled() === true` (before `s.nc = nc; s.handle = handle`), delete the last binary
          // and refresh inventory. `s.nc.isClosed()` is true during this window, so `syncClassSpawn()` is a no-op
          // unless `onServeConnectionClosed` re-syncs after installing `rebuilt`.
          const closedPromise = (async () => {
            await closedNc.close();
          })();
          await dialed;
          rmSync(syncExec);
          try {
            rawSP.connectorInventory.refreshConnectors("boot-present");
          } catch (error) {
            threw = error instanceof Error ? error.message : String(error);
          }
          check(
            "syncClassSpawn is a clean no-op while the serve NATS connection is closed during redial",
            closedNc.isClosed() === true && threw === undefined && SP.view.seatLaunch.classSpawnEnabled() === false,
            { isClosed: closedNc.isClosed(), threw, classSpawnEnabled: SP.view.seatLaunch.classSpawnEnabled() },
          );

          releaseRedial();
          await closedPromise;
          for (let i = 0; i < 60 && rawSP.servePlane.serviceServe?.nc === closedNc; i++) await wait(25);

          let classCallError: { code?: string; outcome?: string; message?: string } | undefined;
          try {
            await epCall(nc, space, { mode: "one" },
              { endpoint: "manager", command: "spawn", contract: MANAGER_CONTRACTS.spawn, caller, args: { name: "pin-probe", agent: "boot-present", events: false } },
              { deadlineMs: 3000, currentEpoch: async () => rawSP.servePlane.serviceServe?.grant.epoch ?? 0 });
          } catch (error) {
            const epErr = error as { code?: string; outcome?: string; message?: string };
            classCallError = { code: epErr.code, outcome: epErr.outcome, message: epErr.message };
          }
          const instAfterRedial = await epCall(nc, space,
            { mode: "inst", instanceId: SP.view.managerStatusData().instanceId, epoch: rawSP.servePlane.serviceServe?.grant.epoch ?? 0 },
            { endpoint: "manager", command: "status", contract: MANAGER_CONTRACTS.status, caller },
            { deadlineMs: 5000 });
          check(
            "ServePlane redial re-syncs class spawn subscriptions when availability changed while dialServeConnection was in flight",
            rawSP.servePlane.serviceServe?.nc !== closedNc &&
              rawSP.servePlane.serviceServe?.nc.isClosed() === false &&
              instAfterRedial.reply.ok === true &&
              classCallError?.code === "unavailable" && classCallError.outcome === "not-executed",
            { redialed: rawSP.servePlane.serviceServe?.nc !== closedNc, instOk: instAfterRedial.reply.ok, classCallError },
          );
        } finally {
          await nc.close();
          await syncMgr.stop({ withAgents: true }).catch(() => {});
        }
      }
    } finally {
      mutableConnector.commands = prevCommands;
      mutableConnector.waitsForOperator = prevWaitsForOperator;
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

if (pass !== 60) throw new Error(`expected 60 checks, ran ${pass}`);
console.log(`\n${pass} checks passed`);
