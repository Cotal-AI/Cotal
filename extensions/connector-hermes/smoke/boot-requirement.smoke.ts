/**
 * Hermes boot requirement smoke (issue #1144).
 *
 * Drives the real installed-extension manager boot path twice. The cached connector metadata comes
 * from the built package artifact customers install. The mutation command rebuilds that artifact
 * after changing source, so a source mutation reaches the exact metadata the manager reads.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isReachable } from "@cotal-ai/core";
import { cacheConnector, extensionsDir, saveExtensionsManifest } from "../../../packages/workspace/src/index.js";
import { Manager } from "../../../implementations/manager/src/manager.js";

type HermesConnector = (typeof import("../src/extension.js"))["hermesConnector"];
const { hermesConnector } = await import("../dist/index.js") as { hermesConnector: HermesConnector };

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
let fail = 0;
const check = (name: string, condition: boolean, actual?: unknown): void => {
  if (condition) pass++;
  else fail++;
  console.log(`  ${condition ? "✓" : "✗"} ${name}${condition || actual === undefined ? "" : ` - ${JSON.stringify(actual)}`}`);
};

const root = mkdtempSync(join(tmpdir(), "cotal-hermes-boot-"));
const configHome = join(root, "config");
const oldConfigHome = process.env.XDG_CONFIG_HOME;
const oldPath = process.env.PATH;
process.env.XDG_CONFIG_HOME = configHome;
mkdirSync(extensionsDir(), { recursive: true });
saveExtensionsManifest({
  extensions: [{
    pkg: "@cotal-ai/connector-hermes",
    version: "0.36.0",
    spec: ".",
    provides: [{ kind: "connector", name: "hermes" }],
    commands: [],
    connectors: [cacheConnector(hermesConnector)],
  }],
});

const port = await freePort();
const servers = `nats://127.0.0.1:${port}`;
const broker = spawn("nats-server", ["-js", "-p", String(port), "-sd", join(root, "js")], { stdio: "ignore" });
const managers: Manager[] = [];

try {
  for (let i = 0; i < 100 && !(await isReachable(servers)); i++) await wait(50);
  if (!(await isReachable(servers))) throw new Error("owned broker did not start");

  for (const [label, binaries] of [["uv-only", ["uv"]], ["hermes-only", ["hermes"]]] as const) {
    const binDir = join(root, label, "bin");
    const workspaceRoot = join(root, label, "ws");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(join(workspaceRoot, ".cotal", "agents"), { recursive: true });
    for (const binary of binaries) {
      const path = join(binDir, process.platform === "win32" ? `${binary}.cmd` : binary);
      writeFileSync(path, process.platform === "win32" ? "@exit /b 0\r\n" : "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    }
    process.env.PATH = binDir;
    const manager = new Manager({ space: `hermes-boot-${label}`, servers, runtime: "pty", workspaceRoot, installedExtensions: true });
    managers.push(manager);
    await manager.start();
    const status = (manager as unknown as {
      managerStatusData(): { connectors: Array<{ agent: string; state: string; binaries: Record<string, string>; reason?: string }> };
    }).managerStatusData().connectors.find((row) => row.agent === "hermes");
    if (label === "uv-only") {
      const expected = join(binDir, process.platform === "win32" ? "uv.cmd" : "uv");
      check(
        "Hermes is available when uv is the only harness executable",
        status?.state === "available" && status.binaries.uv === expected && !("hermes" in status.binaries),
        status,
      );
    } else {
      check(
        "Hermes is unavailable when only the project command is on PATH",
        status?.state === "unavailable" && status.reason?.includes("needs uv on PATH") === true && Object.keys(status.binaries).length === 0,
        status,
      );
    }
  }
} finally {
  if (oldPath === undefined) delete process.env.PATH;
  else process.env.PATH = oldPath;
  if (oldConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = oldConfigHome;
  for (const manager of managers.reverse()) await manager.stop().catch(() => {});
  broker.kill("SIGKILL");
  for (let i = 0; i < 100 && broker.exitCode === null && broker.signalCode === null; i++) await wait(20);
  rmSync(root, { recursive: true, force: true });
}

if (pass + fail !== 2) throw new Error(`expected 2 checks, ran ${pass + fail}`);
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
