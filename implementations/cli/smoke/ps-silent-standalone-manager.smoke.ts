/** `cotal ps` must not report "no manager is running" when a registered standalone manager is unresponsive.
 * Run: pnpm exec tsx implementations/cli/smoke/ps-silent-standalone-manager.smoke.ts
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSuite, freePort } from "@cotal-ai/smoke-kit";
import { CommandFailure, canonicalRoot } from "@cotal-ai/workspace";
import type { ScatterReply } from "@cotal-ai/workspace/control";
import { throwScatterFailure } from "../src/commands/agents.js";
import { readStackJournal, stackManagerAbsent, writeStackJournal, type StackJournal } from "../src/lib/stack-journal.js";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "cotal-ps-silent-standalone-")));
const root = join(scratch, "project");
const home = join(scratch, "home");
const cotalHome = join(scratch, ".cotal");
for (const dir of [root, home, cotalHome]) mkdirSync(dir, { recursive: true, mode: 0o700 });

const prevHome = process.env.HOME;
const prevUserProfile = process.env.USERPROFILE;
const prevCotalHome = process.env.COTAL_HOME;
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.COTAL_HOME = cotalHome;

const { check, finish } = createSuite();
const space = "diagnostic";
const server = `nats://127.0.0.1:${await freePort()}`;
const now = new Date().toISOString();

function makeJournal(withManager: boolean): StackJournal {
  const managerId = withManager ? randomUUID() : null;
  return {
    schemaVersion: 1,
    kind: "cotal-stack-controller",
    root: canonicalRoot(root),
    space,
    server,
    mode: "open",
    members: [
      { role: "broker", definition: "stack-broker", instanceId: null, state: "started" },
      { role: "auth", definition: "stack-auth", instanceId: null, state: "not-attempted" },
      { role: "delivery", definition: "stack-delivery", instanceId: null, state: "not-attempted" },
      { role: "manager", definition: "stack-manager", instanceId: managerId, state: withManager ? "started" : "not-attempted" },
    ],
    operation: { id: randomUUID(), kind: "up", phase: "completed", recordedAt: now, withAgents: false },
    updatedAt: now,
  };
}

function captureFailure(fn: () => never): CommandFailure | undefined {
  try {
    fn();
  } catch (err) {
    if (err instanceof CommandFailure) return err;
    throw err;
  }
  return undefined;
}

try {
  writeStackJournal(root, undefined, makeJournal(false));

  // 1. No manager registered at all on a --no-manager stack: still reports no manager is running.
  const noLiveScatter: ScatterReply = {
    ok: false,
    code: "failed-precondition",
    error: "no live instances of manager in space diagnostic",
    noLiveManager: true,
  };
  const noLiveErr = captureFailure(() =>
    throwScatterFailure(noLiveScatter, { space, scope: "all-managers" }, { root, space, server }, "ps", {}),
  );
  check(
    "no-manager stack with empty registry reports no manager is running",
    noLiveErr?.code === "TARGET_UNAVAILABLE" &&
      noLiveErr.message === "no manager is running for this space, so it has no managed agents to list" &&
      (noLiveErr.remedy?.includes("a stack started with --no-manager has none") ?? false),
    noLiveErr,
  );

  // 2. Registered standalone manager is unresponsive (deadline-exceeded, unanswered: true):
  //    must report that the registered manager did not answer, NOT "no manager is running" or bare `cotal up`.
  const deadlineDetail = "no manager reachable on the ep rails (deadline-exceeded: no describe reply from manager within 10000ms on the ep rail)";
  const silentStandaloneScatter: ScatterReply = {
    ok: false,
    code: "deadline-exceeded",
    error: deadlineDetail,
    unanswered: true,
  };
  const silentStandaloneErr = captureFailure(() =>
    throwScatterFailure(silentStandaloneScatter, { space, scope: "all-managers" }, { root, space, server }, "ps", {}),
  );
  check(
    "no-manager stack with unanswered registered manager reports unanswered read, not absent manager",
    silentStandaloneErr?.code === "TARGET_UNAVAILABLE" &&
      silentStandaloneErr.message === deadlineDetail &&
      !silentStandaloneErr.message.includes("no manager is running for this space") &&
      !(silentStandaloneErr.remedy?.includes("cotal up") ?? false) &&
      (silentStandaloneErr.native as { code?: string } | undefined)?.code === "deadline-exceeded",
    silentStandaloneErr,
  );

  // 3. Normal stack (started WITH a manager) whose stack-manager died while still registered:
  //    still reports no manager is running so crashed stack-manager recovery keeps working.
  writeStackJournal(root, readStackJournal(root), makeJournal(true));
  check("stackManagerAbsent is true when normal stack has no running stack-manager", stackManagerAbsent(root, space));
  const crashedStackErr = captureFailure(() =>
    throwScatterFailure(silentStandaloneScatter, { space, scope: "all-managers" }, { root, space, server }, "ps", {}),
  );
  check(
    "normal stack with dead stack-manager still reports no manager is running on unanswered read",
    crashedStackErr?.code === "TARGET_UNAVAILABLE" &&
      crashedStackErr.message === "no manager is running for this space, so it has no managed agents to list",
    crashedStackErr,
  );
} finally {
  if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
  if (prevCotalHome === undefined) delete process.env.COTAL_HOME; else process.env.COTAL_HOME = prevCotalHome;
  rmSync(scratch, { recursive: true, force: true });
}
finish();
