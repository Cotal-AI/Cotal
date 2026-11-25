/** `folder.noManager` keeps how a controller stack was started after a completed `down` stops it.
 * Run: pnpm exec tsx implementations/cli/smoke/status-no-manager-stopped.smoke.ts
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertSmokeSandboxDown, createSuite, freePort, recordSmokeSandbox } from "@cotal-ai/smoke-kit";
import type { StatusResult } from "../src/commands/status.js";
import { readStackJournal, stackRecordedWithoutManager, stackStartedWithoutManager, writeStackJournal, type StackJournal } from "../src/lib/stack-journal.js";

const scratch = mkdtempSync(join(tmpdir(), "cotal-status-no-manager-"));
const root = join(scratch, "project"), home = join(scratch, "home"), cotalHome = join(scratch, ".cotal");
const config = join(scratch, "config"), runtime = join(scratch, "runtime");
for (const dir of [root, home, cotalHome, config, runtime]) mkdirSync(dir, { mode: 0o700 });
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_"))),
  HOME: home, USERPROFILE: home, COTAL_HOME: cotalHome, XDG_CONFIG_HOME: config, XDG_RUNTIME_DIR: runtime,
  COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_NO_PROMPT: "1", COTAL_TELEMETRY: "off", NO_COLOR: "1",
};
const anchor = recordSmokeSandbox({ root, cotalHome, xdgConfigHome: config });
const cli = resolve(import.meta.dirname, "../../../bin/cotal.ts");
const { check, finish } = createSuite();
function run(...args: string[]) {
  assertSmokeSandboxDown(anchor, args, { cwd: root, env });
  const result = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), cli, ...args], { cwd: root, env, encoding: "utf8", timeout: 180_000 });
  if (result.error) throw result.error;
  return result;
}

const space = "delta-controller", server = `nats://127.0.0.1:${await freePort()}`;
const now = new Date().toISOString();
/** The journal an `up` (with or without a manager) and the `down` after it leave. */
function journal(withManager: boolean, kind: "up" | "down"): StackJournal {
  const manager = withManager ? randomUUID() : null;
  const state = (instanceId: string | null) => instanceId === null ? "not-attempted" : kind === "up" ? "started" : "stopped";
  return {
    schemaVersion: 1, kind: "cotal-stack-controller", root, space, server, mode: "open",
    members: [
      { role: "broker", definition: "stack-broker", instanceId: null, state: kind === "up" ? "started" : "stopped" },
      { role: "auth", definition: "stack-auth", instanceId: null, state: "not-attempted" },
      { role: "delivery", definition: "stack-delivery", instanceId: null, state: "not-attempted" },
      { role: "manager", definition: "stack-manager", instanceId: manager, state: state(manager) },
    ],
    operation: { id: randomUUID(), kind, phase: "completed", recordedAt: now, withAgents: false }, updatedAt: now,
  };
}

try {
  for (const withManager of [false, true]) {
    const label = withManager ? "a normal up" : "up --no-manager";
    check(`${label}: the running stack reads as started ${withManager ? "with" : "without"} a manager`, stackRecordedWithoutManager(journal(withManager, "up")) === !withManager);
    check(`${label} then a completed down still reads as started ${withManager ? "with" : "without"} a manager`, stackRecordedWithoutManager(journal(withManager, "down")) === !withManager);
  }
  check("stackStartedWithoutManager still says a stopped stack is not running without a manager", !stackStartedWithoutManager(journal(false, "down")));

  const created = run("space", "create", space, "--root", ".", "--json");
  check("space create succeeds", created.status === 0, created.stdout + created.stderr);
  if (created.status !== 0) throw new Error("space create failed");
  for (const withManager of [false, true]) for (const kind of ["up", "down"] as const) {
    writeStackJournal(root, readStackJournal(root), journal(withManager, kind));
    const read = run("status", "--space", space, "--json");
    const report = JSON.parse(read.stdout) as { result: StatusResult };
    const label = `${withManager ? "a normal up" : "up --no-manager"}${kind === "down" ? " then a completed down" : ""}`;
    check(`${label}: status JSON folder.noManager is ${!withManager}`,
      report.result.folder.controllerStack && report.result.folder.noManager === !withManager, report.result.folder);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
finish();
