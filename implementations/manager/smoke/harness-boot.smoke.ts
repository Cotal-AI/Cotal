/**
 * Manager harness boot inventory smoke (issue #965).
 *
 * Proves timing, not only wording: the missing harness is named by Manager.start() before any
 * startAgent call. Boot stays live for unrelated work and publishes the same unavailable row through
 * the typed manager status surface. A present harness is recorded as an absolute executable path.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { isReachable, registry, type Connector, type LaunchOpts } from "@cotal-ai/core";
import { extensionsDir, saveExtensionsManifest } from "@cotal-ai/workspace";
import { Manager } from "../src/manager.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const server = createServer();
  server.on("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const port = (server.address() as AddressInfo).port;
    server.close(() => resolve(port));
  });
});
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
mkdirSync(binDir);
const present = join(binDir, process.platform === "win32" ? "present-harness.cmd" : "present-harness");
writeFileSync(present, process.platform === "win32" ? "@exit /b 0\r\n" : "#!/bin/sh\nexit 0\n", { mode: 0o700 });

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
        { name: "boot-missing", requires: ["harness-that-does-not-exist-965"] },
        { name: "boot-present", requires: ["present-harness"] },
      ],
    },
  ],
});

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
  connectorStatuses: Array<{ agent: string; state: string; binaries: Record<string, string>; reason?: string }>;
  managerStatusData(): { connectors: Array<{ agent: string; state: string; binaries: Record<string, string>; reason?: string }> };
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
  check(
    "boot records the resolved absolute harness path from a relative PATH entry",
    available?.binaries["present-harness"] === present && isAbsolute(available.binaries["present-harness"]!),
    available,
  );
  const status = M.managerStatusData();
  check("typed manager status retains the named boot-time unavailable reason", status.connectors.find((row) => row.agent === "boot-missing")?.reason === missing?.reason, status);

  let launchOpts: LaunchOpts | undefined;
  const connector: Connector = {
    kind: "connector",
    name: "boot-present",
    requires: ["present-harness"],
    buildLaunch: (opts) => {
      launchOpts = opts;
      return { command: opts.resolvedBinaries?.["present-harness"] ?? "present-harness", args: [] };
    },
  };
  registry.register(connector);
  const fakeSession = { cols: 80, rows: 24, backlog: () => Buffer.alloc(0), onData: () => () => {}, onExit: () => () => {}, write: () => {}, resize: () => {} };
  let launchExec: ReturnType<typeof spawnSync> | undefined;
  (manager as unknown as { runtime: unknown }).runtime = {
    kind: "fake",
    spawn: (name: string, spec: { command: string; args: string[]; env?: Record<string, string> }, cwd: string) => {
      launchExec = spawnSync(spec.command, spec.args, { cwd, env: spec.env, encoding: "utf8" });
      return { name, kind: "fake", status: () => "exited", stop: () => {}, interrupt: () => {}, attach: () => fakeSession };
    },
  };
  await manager.startAgent({ name: "pin-probe", agent: "boot-present" });
  check("managed spawn uses the exact path resolved at boot", launchOpts?.resolvedBinaries?.["present-harness"] === present, launchOpts);
  check(
    "managed spawn executes that exact harness when its launch cwd differs from manager boot cwd",
    launchExec?.status === 0 && launchExec.error === undefined,
    { status: launchExec?.status, error: launchExec?.error?.message, cwd: workspaceRoot, command: launchOpts?.resolvedBinaries?.["present-harness"] },
  );
} finally {
  console.error = oldError;
  if (oldPath === undefined) delete process.env.PATH;
  else process.env.PATH = oldPath;
  await manager.stop().catch(() => {});
  broker.kill("SIGKILL");
  for (let i = 0; i < 100 && broker.exitCode === null && broker.signalCode === null; i++) await wait(20);
  releaseBroker();
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${pass} checks passed`);
