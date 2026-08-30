/**
 * Hermes installed-extension boot availability (issue #1144).
 *
 * Drives Manager.start() with the cached metadata derived from the shipped Hermes connector. Each
 * arm owns a broker and an isolated extension manifest; no stack lifecycle command is involved.
 */
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isReachable } from "@cotal-ai/core";
import { hermesConnector } from "@cotal-ai/connector-hermes";
import { cacheConnector, extensionsDir, saveExtensionsManifest } from "@cotal-ai/workspace";
import { Manager } from "../src/manager.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

const freePort = (): Promise<number> => new Promise((resolve) => {
  const server = createServer();
  server.listen(0, "127.0.0.1", () => {
    const port = (server.address() as AddressInfo).port;
    server.close(() => resolve(port));
  });
});
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let passed = 0;
let failed = 0;
const check = (name: string, condition: boolean, actual?: unknown): void => {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
    return;
  }
  failed++;
  console.log(`  ✗ FAIL: ${name}${actual === undefined ? "" : ` - ${JSON.stringify(actual)}`}`);
};

const root = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const oldConfigHome = process.env.XDG_CONFIG_HOME;
const oldPath = process.env.PATH;
process.env.XDG_CONFIG_HOME = join(root, "config");
mkdirSync(extensionsDir(), { recursive: true });
saveExtensionsManifest({
  extensions: [{
    pkg: "@cotal-ai/connector-hermes",
    version: "0.36.0",
    spec: "seeded",
    source: "seeded",
    provides: [{ kind: "connector", name: "hermes" }],
    commands: [],
    connectors: [cacheConnector(hermesConnector)],
  }],
});

const port = await freePort();
const servers = `nats://127.0.0.1:${port}`;
const broker = spawn("nats-server", ["-js", "-p", String(port), "-sd", join(root, "js")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(broker, root);

try {
  for (let i = 0; i < 100 && !(await isReachable(servers)); i++) await wait(50);
  if (!(await isReachable(servers))) throw new Error("owned broker did not start");

  for (const [label, binary] of [["uv-only", "uv"], ["hermes-only", "hermes"]] as const) {
    const binDir = join(root, label, "bin");
    mkdirSync(binDir, { recursive: true });
    const executable = join(binDir, binary);
    writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    chmodSync(executable, 0o700);
    process.env.PATH = binDir;

    const workspaceRoot = join(root, label, "workspace");
    mkdirSync(join(workspaceRoot, ".cotal", "agents"), { recursive: true });
    const manager = new Manager({
      space: `hermes-boot-${label}`,
      servers,
      runtime: "pty",
      workspaceRoot,
      installedExtensions: true,
      name: `manager-${label}`,
    });
    let bootErr = "";
    const oldError = console.error;
    console.error = (...args: unknown[]) => { bootErr += `${args.map(String).join(" ")}\n`; };
    try {
      await manager.start();
      const statuses = (manager as unknown as {
        connectorStatuses: Array<{ agent: string; state: string; binaries: Record<string, string>; reason?: string }>;
      }).connectorStatuses;
      const hermes = statuses.find((row) => row.agent === "hermes");
      if (label === "uv-only") {
        check("documented uv-only Hermes install is available at manager boot", hermes?.state === "available", { hermes, bootErr });
        check("manager boot records the exact uv executable from installed Hermes metadata", hermes?.binaries.uv === executable, hermes);
      } else {
        check("hermes-only PATH is unavailable because the shipped launcher requires uv", hermes?.state === "unavailable", { hermes, bootErr });
        check("hermes-only refusal names uv rather than the unused hermes executable", hermes?.reason === "hermes harness needs uv on PATH - not found", hermes);
      }
    } finally {
      console.error = oldError;
      await manager.stop().catch(() => {});
    }
  }
} finally {
  if (oldPath === undefined) delete process.env.PATH;
  else process.env.PATH = oldPath;
  if (oldConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = oldConfigHome;
  broker.kill("SIGKILL");
  for (let i = 0; i < 100 && broker.exitCode === null && broker.signalCode === null; i++) await wait(20);
  releaseBroker();
  rmSync(root, { recursive: true, force: true });
}

console.log(`HERMES BOOT AVAILABILITY: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
