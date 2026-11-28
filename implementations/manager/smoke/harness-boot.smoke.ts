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
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { DEV_OWNER, epCall, isReachable, mintLifecycleUid, newIdentity, registry, type Connector, type LaunchOpts } from "@cotal-ai/core";
import { connect } from "@nats-io/transport-node";
import { MANAGER_CONTRACTS, type ManagerStatus } from "../src/manager-service-contract.js";
import { connectorMetadataStale, extensionsDir, saveExtensionsManifest, trustProject } from "@cotal-ai/workspace";
import { Manager } from "../src/manager.js";
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
  const missingReason = "boot-present harness needs present-harness on PATH - not found";
  writeFileSync(uninstallPresent, script, { mode: 0o700 });
  writeFileSync(siblingPresent, script, { mode: 0o700 });

  type TrackedManager = {
    runtime: unknown;
    agents: Map<string, unknown>;
    managerStatusData(): ManagerStatus;
    connectorInventory: { connectorStatuses: ManagerStatus["connectors"] };
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
    process.env.PATH = siblingBin;
    const sibling = new Manager({ space, servers, runtime: "pty", workspaceRoot: siblingWorkspaceRoot, installedExtensions: true });
    const S = instrumentManager(sibling, siblingPresent);
    await sibling.start();
    process.env.PATH = uninstallBin;
    const nc = await connect({ servers });
    const caller = { owner: DEV_OWNER, actor: newIdentity().id, uid: mintLifecycleUid() };
    const uninstalledId = U.view.managerStatusData().instanceId;
    const siblingId = S.view.managerStatusData().instanceId;
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
          presentRow?.state === "unavailable" && presentRow.reason === missingReason &&
          Object.keys(presentRow.binaries).length === 0 && statusData?.classSpawn === false,
        reproSummary,
      );
      check(
        "pinned launch of a deleted application refuses with not-executed before reserving name or capacity",
        pinnedSpawn.reply.ok === false && pinnedSpawn.reply.error.code === "failed-precondition" &&
          pinnedSpawn.reply.error.outcome === "not-executed" && pinnedSpawn.reply.error.message === missingReason &&
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
        directLaunch.ok === false && directLaunch.error === missingReason &&
          LF.stats.spawnCalls === 0 && LF.stats.reserveCalls === 0 && LF.stats.uniqueNameCalls === 0 &&
          LF.view.namesCapacity.occupancy().used === 0 && afterLaunchCounts.available === 0 &&
          afterLaunchCounts.unavailable === 2 && afterLaunchRow?.state === "unavailable" &&
          afterLaunchRow.reason === missingReason && LF.view.managerStatusData().classSpawn === false,
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
        fileStillExists && offPathLaunch.ok === false && offPathLaunch.error === missingReason &&
          LF.stats.spawnCalls === 0 && LF.stats.reserveCalls === 0 && LF.stats.uniqueNameCalls === 0 &&
          offPathCounts.available === 0 && offPathCounts.unavailable === 2 &&
          offPathRow?.state === "unavailable" && offPathRow.reason === missingReason &&
          Object.keys(offPathRow.binaries).length === 0 && offPathStatus.classSpawn === false,
        { fileStillExists, offPathLaunch, offPathCounts, offPathRow, stats: LF.stats },
      );
    } finally {
      await launchFirst.stop({ withAgents: true });
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

if (pass !== 43) throw new Error(`expected 43 checks, ran ${pass}`);
console.log(`\n${pass} checks passed`);
