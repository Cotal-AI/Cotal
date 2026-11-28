/** One recovery loop per released run, a note that belongs to one space, and a cancel that drops it.
 *  Run: pnpm smoke:interrupted-run-recovery */
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as wait } from "node:timers/promises";
import { COTAL_LANG_RUN_HOST, RUN_HOST_KIND, registry } from "@cotal-ai/core";
import { spaceSegment } from "@cotal-ai/workspace";
import { createSuite } from "@cotal-ai/smoke-kit";
import { RunHosting } from "../src/run-hosting.js";
import {
  interruptedRunRecoveryStore, readInterruptedRunRecovery, updateInterruptedRunRecovery, writeInterruptedRunRecovery, type InterruptedRunRecovery,
} from "../src/interrupted-run-recovery.js";

const self = fileURLToPath(import.meta.url);
if (process.argv[2] === "bump") {
  const dir = process.argv[3]!;
  const id = process.argv[4]!;
  for (let step = 0; step < 20; step++) {
    await updateInterruptedRunRecovery(dir, (read) => {
      const epoch = (read.notes.find((note) => note.runId === id)?.epoch ?? 0) + 1;
      return [...read.notes.filter((note) => note.runId !== id), note(id, epoch)];
    });
  }
  process.exit(0);
}

function note(runId: string, epoch = 1, until = Date.now() + 30 * 60_000): InterruptedRunRecovery {
  return { runId, timeout: "30s", holder: "holder", epoch, fencingToken: 1, until };
}

registry.register({
  kind: RUN_HOST_KIND,
  name: COTAL_LANG_RUN_HOST,
  validate: () => ({ ok: true, placements: [] }),
  drive: () => ({ done: new Promise(() => undefined), release() { /* unused */ }, cancel() { /* unused */ } }),
  locate: async () => { throw new Error("unused"); },
  answer: async () => { throw new Error("unused"); },
  locateAccepted: async () => { throw new Error("unused"); },
  amend: async () => { throw new Error("unused"); },
  status: async () => undefined,
  list: async () => [],
} as never);

const { check, finish } = createSuite();
const root = mkdtempSync(join(tmpdir(), "interrupted-recovery-"));
const repo = fileURLToPath(new URL("../../..", import.meta.url));

function hosting(space: string, dir: string, logs: string[]): RunHosting {
  return new RunHosting({
    space,
    servers: "nats://127.0.0.1:1",
    endpoint: "manager",
    instanceId: `instance-${space}`,
    holder: { id: "holder", lifecycleUid: "life" },
    auth: undefined,
    log: (line) => { logs.push(line); },
    stateDir: dir,
  });
}

function ids(dir: string): string[] {
  return readInterruptedRunRecovery(dir).notes.map((row) => row.runId);
}

async function until(label: string, ready: () => boolean, budget = 4_000): Promise<void> {
  const end = Date.now() + budget;
  while (!ready()) {
    if (Date.now() > end) throw new Error(`${label}: waited ${budget}ms`);
    await wait(50);
  }
}

{
  const dir = join(root, ".cotal", spaceSegment("space-loop"));
  mkdirSync(dir, { recursive: true });
  writeInterruptedRunRecovery(dir, [note("run-shared")]);
  const logs: string[] = [];
  const host = hosting("space-loop", dir, logs);
  await Promise.all([host.reconcile(), host.reconcile()]);
  await wait(200);
  const retries = logs.filter((line) => line.includes("retrying automatic recovery"));
  check("two reconciles start one recovery loop", retries.length === 1, logs);
  check("the note survives a second reconcile", ids(dir).includes("run-shared"), ids(dir));
  await host.stop();
}

{
  const dirA = join(root, ".cotal", spaceSegment("space-a"));
  const dirB = join(root, ".cotal", spaceSegment("space-b"));
  mkdirSync(dirA, { recursive: true });
  mkdirSync(dirB, { recursive: true });
  writeInterruptedRunRecovery(dirA, [note("run-a")]);
  writeInterruptedRunRecovery(dirB, [note("run-b")]);
  const logsA: string[] = [];
  const logsB: string[] = [];
  const hostA = hosting("space-a", dirA, logsA);
  const hostB = hosting("space-b", dirB, logsB);
  await Promise.all([hostA.reconcile(), hostB.reconcile()]);
  await wait(200);
  check("space A recovers only its own run", ids(dirA).join() === "run-a", ids(dirA));
  check("space B recovers only its own run", ids(dirB).join() === "run-b", ids(dirB));
  check("space B does not mention space A's run", !logsB.some((line) => line.includes("run-a")), logsB);
  await hostA.stop();
  await hostB.stop();
}

{
  const dir = join(root, ".cotal", spaceSegment("space-expired"));
  mkdirSync(dir, { recursive: true });
  writeInterruptedRunRecovery(dir, [note("run-old", 1, Date.now() - 1_000)]);
  const logs: string[] = [];
  const host = hosting("space-expired", dir, logs);
  await host.reconcile();
  check("an expired note tells the operator how to resume", logs.some((line) => line.includes("run-old") && line.includes("window ended") && line.includes("cotal run resume")), logs);
  check("an expired note is removed", ids(dir).length === 0, ids(dir));
  check("an expired note does not start a retry", !logs.some((line) => line.includes("retrying automatic recovery")), logs);
  await host.stop();
}

{
  const dir = join(root, ".cotal", spaceSegment("space-corrupt"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "interrupted-run-recovery.json"), "not-json\n", { mode: 0o600 });
  const logs: string[] = [];
  const host = hosting("space-corrupt", dir, logs);
  await host.reconcile();
  check("a corrupt note is logged", logs.some((line) => line.includes("could not read its note") && line.includes("cotal run resume")), logs);
  await host.stop();
}

{
  const dir = join(root, ".cotal", spaceSegment("space-cancel"));
  mkdirSync(dir, { recursive: true });
  writeInterruptedRunRecovery(dir, [note("run-cancel")]);
  const logs: string[] = [];
  const host = hosting("space-cancel", dir, logs);
  await host.reconcile();
  await until("recovery did not start", () => logs.some((line) => line.includes("retrying automatic recovery")));
  (host as unknown as { cancellations: Map<string, { runId: string }> }).cancellations.set("served", { runId: "run-cancel" });
  await until("a cancel did not drop the note", () => !ids(dir).includes("run-cancel"));
  check("a cancel removes the note", !ids(dir).includes("run-cancel"), ids(dir));
  check("a cancel does not log a failed resume", !logs.some((line) => line.includes("could not resume")), logs);
  await host.stop();
}

{
  const dir = join(root, "lock");
  mkdirSync(dir, { recursive: true });
  await Promise.all(["left", "right"].map((id) => new Promise<void>((resolve, reject) => {
    execFile(process.execPath, ["--import", "tsx", self, "bump", dir, id], { cwd: repo }, (error, _stdout, stderr) => {
      if (error) reject(new Error(`${id}: ${stderr || error.message}`));
      else resolve();
    });
  })));
  const notes = readInterruptedRunRecovery(dir).notes;
  check("two processes keep both rows", notes.find((row) => row.runId === "left")?.epoch === 20 && notes.find((row) => row.runId === "right")?.epoch === 20, notes);
}

{
  const dir = join(root, "blocked");
  mkdirSync(dir, { recursive: true });
  writeInterruptedRunRecovery(dir, [note("run-blocked"), note("run-old", 1, Date.now() - 1_000)]);
  const logs: string[] = [];
  const host = hosting("space-write", dir, logs);
  const refused: string[] = [];
  const onRejection = (error: unknown) => { refused.push(String(error)); };
  process.on("unhandledRejection", onRejection);
  const real = interruptedRunRecoveryStore.write;
  interruptedRunRecoveryStore.write = (target, rows) => {
    if (target === dir) throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    real(target, rows);
  };
  try {
    await host.reconcile();
    await until("the rejected write was not logged", () => logs.some((line) => line.includes("run-blocked") && line.includes("could not record its note")));
    await until("recovery did not try again after the rejected write", () => logs.some((line) => line.includes("run-blocked") && line.includes("retrying automatic recovery")), 8_000);
    const listed = await host.list({ endpoint: "manager" }).then(() => "answered", () => "refused-the-read");
    check("a rejected note write leaves the host answering", refused.length === 0 && listed === "refused-the-read", { refused, listed, logs });
    check("a rejected note write is logged and the retry continues", logs.some((line) => line.includes("run-blocked") && line.includes("could not record its note")) && logs.some((line) => line.includes("run-blocked") && line.includes("retrying automatic recovery")), logs);
  } finally {
    interruptedRunRecoveryStore.write = real;
    process.off("unhandledRejection", onRejection);
    await host.stop();
  }
}

finish();
