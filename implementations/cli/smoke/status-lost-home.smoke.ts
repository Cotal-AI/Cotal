import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { strict as assert } from "node:assert";
import { assertSmokeSandboxDown, freePort, recordSmokeSandbox, skipSuite } from "@cotal-ai/smoke-kit";
import { assertRecordIdentity, spaceKey, type ProcessIdentityRecord } from "@cotal-ai/workspace";
import type { StatusResult } from "../src/commands/status-model.js";
import type { StackJournal } from "../src/lib/stack-journal.js";

if (process.platform !== "linux") skipSuite("status-lost-home: Linux creation-pinned recovery");

const base = mkdtempSync(join(tmpdir(), "cotal-status-lost-home-"));
const root = join(base, "project"), home = join(base, "cotal"), space = "example";
const env = {
  PATH: process.env.PATH, HOME: join(base, "user"), XDG_CONFIG_HOME: join(base, "config"),
  XDG_RUNTIME_DIR: join(base, "runtime"), COTAL_HOME: home, COTAL_SKIP_CONNECTOR_SEED: "1", DO_NOT_TRACK: "1", NO_COLOR: "1",
};
for (const path of [env.HOME, env.XDG_RUNTIME_DIR]) mkdirSync(path, { mode: 0o700 });
let anchor = recordSmokeSandbox({ root, cotalHome: home, xdgConfigHome: env.XDG_CONFIG_HOME });
const binary = resolve(import.meta.dirname, "../../../bin/dist/cotal.js");
const journalPath = join(root, ".cotal", "stack-controller.json");

function invoke(args: string[]) {
  const options = { cwd: root, env, encoding: "utf8" as const, timeout: 60_000 };
  assertSmokeSandboxDown(anchor, args, options);
  const run = spawnSync(process.execPath, [binary, ...args], options);
  assert.ifError(run.error);
  return run;
}

function cli(args: string[], exit: number) {
  const run = invoke(args);
  assert.equal(run.status, exit, `${args.join(" ")}\n${run.stdout}${run.stderr}`);
  return run.stdout;
}

async function runningBroker(up: ReturnType<typeof spawn>): Promise<ProcessIdentityRecord> {
  for (let i = 0; i < 300 && up.exitCode === null && up.signalCode === null; i++) {
    try {
      const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
        operation: { phase: string }; members: { role: string; process?: ProcessIdentityRecord }[];
      };
      const pin = journal.members.find((row) => row.role === "broker")?.process;
      if (journal.operation.phase === "completed" && pin && assertRecordIdentity(pin).kind === "match") return pin;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await sleep(100);
  }
  throw new Error("foreground stack did not publish a completed launch with a live broker pin");
}

function preview(kind: string, pin: ProcessIdentityRecord): void {
  const before = readFileSync(journalPath, "utf8");
  const { result } = JSON.parse(cli(["down", "--dry-run", "--json"], 0)) as {
    result: { kind: string; signalled: boolean; members: { role: string; process: string }[] };
  };
  assert.equal(result.kind, kind);
  assert.equal(result.signalled, false);
  assert.deepEqual(result.members.map(({ role, process }) => ({ role, process })), [{ role: "broker", process: "running" }]);
  assert.equal(readFileSync(journalPath, "utf8"), before);
  assert.equal(assertRecordIdentity(pin).kind, "match");
}

function checkIntactHome(pin: ProcessIdentityRecord): void {
  const { result } = JSON.parse(cli(["status", "--json"], 0)) as { result: StatusResult };
  assert(result.selected.resolved && result.selected.space === space);
  assert.equal(result.folder.controllerStack, true);
  const broker = result.folder.processes?.find((row) => row.name === "nats");
  assert.equal(broker?.source, "owned-service");
  assert.equal(broker.state, "running");
  preview("controller-stack-stop-preview", pin);
  console.log("PASS: intact home resolves the named space and reports a running owned broker");
}

function checkMissingInstance(pin: ProcessIdentityRecord): void {
  const before = readFileSync(journalPath, "utf8");
  const journal = JSON.parse(before) as StackJournal;
  const instanceId = journal.members.find((row) => row.role === "broker")?.instanceId;
  assert(instanceId);
  const instance = join(home, "services", spaceKey(space), "instances", `${spaceKey(instanceId)}.json`);
  renameSync(instance, `${instance}.retained`);
  try {
    const { result } = JSON.parse(cli(["status", "--json"], 4)) as { result: StatusResult };
    assert(result.selected.resolved && result.selected.connection === "ok");
    assert.equal(result.folder.processes?.find(({ name }) => name === "nats")?.pid, pin.pid);
    const components = cli(["status", "--components"], 3).split("Component Health")[1] ?? "";
    assert.match(components, /broker\s+refused[\s\S]*owned broker health unavailable/);
    assert.doesNotMatch(components, /broker\s+(absent|serving)/);
    preview("missing-records-stack-stop-preview", pin);
    assert.equal(readFileSync(journalPath, "utf8"), before);
    console.log("PASS: a reachable registered broker with a missing instance refuses the owned health check");
  } finally { renameSync(`${instance}.retained`, instance); }
}

function checkLostHome(pin: ProcessIdentityRecord): void {
  preview("missing-records-stack-stop-preview", pin);
  console.log("PASS: missing-home stop preview sees the running broker and does not signal it");
  const before = readFileSync(journalPath, "utf8");
  const json = invoke(["status", "--json"]), text = invoke(["status", "--verbose"]);
  assert.equal(json.status, 4, `${json.stdout}${json.stderr}\n${text.stdout}${text.stderr}`);
  assert.equal(text.status, 4, `${text.stdout}${text.stderr}`);
  const { result } = JSON.parse(json.stdout) as { result: StatusResult };
  assert(!result.selected.resolved);
  assert.equal(result.selected.code, "missing-stack-records");
  assert.equal(result.selected.space, space);
  assert.equal(result.folder.controllerStack, true);
  assert.equal(result.folder.storedState, false);
  const broker = result.folder.processes?.find((row) => row.name === "nats");
  assert.equal(broker?.source, "stack-journal");
  assert.equal(broker?.state, "running");
  assert.equal(broker?.pid, pin.pid);
  assert.match(text.stdout, /member records are missing/);
  assert.match(text.stdout, /cotal down --dry-run.*cotal down --yes/);
  assert.doesNotMatch(text.stdout, /clean store --force|cotal space create|no space is registered for it here/);
  const components = cli(["status", "--components"], 3);
  assert.match(components.split("Component Health")[1] ?? "", /refused[\s\S]*member records are missing/);
  assert.equal(readFileSync(journalPath, "utf8"), before);
  assert.equal(assertRecordIdentity(pin).kind, "match");
}

function checkMissingMemberPin(pin: ProcessIdentityRecord): void {
  const before = readFileSync(journalPath, "utf8");
  const journal = JSON.parse(before) as { members: { role: string; instanceId: string | null; state: string }[] };
  const manager = journal.members.find((member) => member.role === "manager")!;
  manager.instanceId = "5fe036b3-4fa7-4076-9813-9dfddafaebc1";
  manager.state = "stopped";
  writeFileSync(journalPath, JSON.stringify(journal));
  try {
    assert.match(cli(["down", "--dry-run", "--json"], 2), /lacks a complete set of member creation pins/);
    const status = cli(["status", "--verbose"], 4);
    assert.match(status, /member records are missing/);
    assert.match(status, /restore the original stack member records/);
    assert.doesNotMatch(status, /cotal down --yes|clean store --force|cotal space create/);
    assert.equal(assertRecordIdentity(pin).kind, "match");
    console.log("PASS: status reports the live broker but does not recommend a recovery stop without all pins");
  } finally { writeFileSync(journalPath, before); }
}

function checkUnresolvedReplacement(pin: ProcessIdentityRecord): void {
  const before = readFileSync(journalPath, "utf8");
  const journal = JSON.parse(before) as StackJournal;
  const broker = journal.members.find((row) => row.role === "broker")!;
  broker.replacement = { operation: journal.operation.id, instanceId: randomUUID(), launchRequestId: randomUUID() };
  const replaced = JSON.stringify(journal);
  writeFileSync(journalPath, replaced);
  try {
    const { result } = JSON.parse(cli(["status", "--json"], 4)) as { result: StatusResult };
    assert(!result.selected.resolved && result.selected.code === "missing-stack-records");
    assert.match(result.selected.message, /unresolved replacement launch.*ownership.*unconfirmed/);
    const row = result.folder.processes?.find(({ name }) => name === "nats");
    assert.equal(row?.state, "unknown");
    assert.equal(row?.pid, null);
    assert.doesNotMatch(result.hints.join("\n"), /cotal down --yes|clean store --force|cotal space create/);
    assert.match(cli(["down", "--dry-run", "--json"], 2), /unresolved replacement launch/);
    assert.equal(readFileSync(journalPath, "utf8"), replaced);
    assert.equal(assertRecordIdentity(pin).kind, "match");
    console.log("PASS: an unresolved replacement blocks stop and cleanup advice without claiming its process");
  } finally { writeFileSync(journalPath, before); }
}

function checkDamagedRegistry(pin: ProcessIdentityRecord): void {
  const before = readFileSync(journalPath, "utf8");
  const meshes = join(home, "meshes"), record = join(meshes, "broken.json");
  mkdirSync(meshes, { recursive: true, mode: 0o700 });
  writeFileSync(record, "{", { mode: 0o600, flag: "wx" });
  try {
    const { result, warnings } = JSON.parse(cli(["status", "--json"], 4)) as { result: StatusResult; warnings: { code: string }[] };
    assert(!result.selected.resolved && result.selected.code === "registry-unreadable");
    assert(warnings.some(({ code }) => code === "MESH_REGISTRY_UNREADABLE"));
    const broker = result.folder.processes?.find(({ name }) => name === "nats");
    assert.deepEqual([broker?.source, broker?.state, broker?.pid], ["stack-journal", "running", pin.pid]);
    assert.match(result.hints.join("\n"), /repair the unreadable mesh registry/);
    assert.doesNotMatch(result.hints.join("\n"), /cotal down --yes|clean store --force|cotal space create/);
    assert.match(cli(["down", "--dry-run", "--json"], 1), /SCHEMA_INVALID/);
    assert.equal(readFileSync(journalPath, "utf8"), before);
    assert.equal(assertRecordIdentity(pin).kind, "match");
    console.log("PASS: registry damage blocks recovery advice but preserves the partial report and running broker observation");
  } finally { renameSync(record, `${record}.retained`); }
}

cli(["space", "create", space, "--root", "."], 0);
const server = `nats://127.0.0.1:${await freePort()}`;
const up = spawn(process.execPath, [binary, "up", "--foreground", "--open", "--no-manager", "--space", space, "--server", server], { cwd: root, env, stdio: ["ignore", "inherit", "inherit"] });
const closed = once(up, "close");
let pin: ProcessIdentityRecord | undefined, lostHome = false;
try {
  pin = await runningBroker(up);
  checkIntactHome(pin);
  checkMissingInstance(pin);
  renameSync(home, `${home}-retained`);
  anchor = recordSmokeSandbox({ root, cotalHome: home, xdgConfigHome: env.XDG_CONFIG_HOME });
  lostHome = true;
  checkLostHome(pin);
  console.log("PASS: status identifies missing records and names the recovery stop without writing the journal");
  checkMissingMemberPin(pin);
  checkUnresolvedReplacement(pin);
  checkDamagedRegistry(pin);
} finally {
  if (!pin) up.kill("SIGTERM");
  else if (assertRecordIdentity(pin).kind === "match") {
    const { result } = JSON.parse(cli(["down", "--yes", "--json"], 0));
    if (lostHome) {
      assert.equal(result.kind, "missing-records-stack-stop");
      console.log("PASS: the pinned recovery stop stopped the broker");
    }
  }
  assert.deepEqual(await closed, [0, null], "foreground up should exit cleanly after down");
  if (pin) assert.equal(assertRecordIdentity(pin).kind, "gone");
}
