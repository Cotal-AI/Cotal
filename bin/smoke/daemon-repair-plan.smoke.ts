/** Repair's plan asks before anything that stops or starts what the person may be using, never
 *  downgrades the service, acts only on what the plan named, and reports a step that fails partway. */
import assert from "node:assert/strict";
import { planFrom, runSteps, startSpaces, type RepairProbe, type RepairStep } from "../daemon/repair.js";
import type { DaemonStatus, HostedManager } from "../daemon/protocol.js";

const VERSION = "2.4.0";
const base = { state: "ready", protocol: 1, version: VERSION, pid: 1, startedAt: "", uptimeMs: 0 } as const;
const status = (extra: Partial<DaemonStatus> = {}): DaemonStatus => ({ ...base, ...extra }) as DaemonStatus;
const other = (version?: string): RepairProbe["service"] => ({ kind: "other", installed: "/opt/cotal", entry: "/opt/cotal/dist/cotal.js", ...(version ? { version } : {}) });
const step = (probe: RepairProbe, name: string) => planFrom(probe, VERSION).steps.find(item => item.step === name)!;
const refused = (space: string, reason = "the manager did not start"): HostedManager => ({ space, state: "refused", restarts: 3, reason, lastRefusal: reason });
const STALE = "Manager cleanup identity differs from its recorded instance";

const failed: string[] = [];
async function cell(name: string, run: () => Promise<void> | void): Promise<void> {
  try { await run(); console.log(`PASS ${name}`); }
  catch (error) { failed.push(name); console.log(`FAIL ${name}: ${(error as Error).message.split("\n")[0]}`); }
}

await cell("finding 4: a stopped service needs the start-stopped consent", () => {
  const stopped = step({ status: undefined, statusUnknown: false, service: { kind: "this" } }, "service-running");
  assert.equal(stopped.outcome, "fix");
  assert.equal(stopped.consent, "start-stopped", "starting a stopped service asks first");
});

await cell("finding 5: a move refuses a newer service and allows an older or equal one", () => {
  const newer = step({ status: status({ version: "2.5.0" }), statusUnknown: false, service: other("2.5.0") }, "service-owner");
  assert.equal(newer.outcome, "cannot", "a newer copy is not replaced by an older one");
  assert.equal(newer.consent, undefined);
  assert.equal(newer.found, "A newer copy of Cotal runs the background service. Update this app, then repair again.");
  const prerelease = step({ status: undefined, statusUnknown: false, service: other("2.4.0-beta.1") }, "service-owner");
  assert.equal(prerelease.outcome, "fix", "a prerelease of this version is older and can be moved");
  const same = step({ status: status(), statusUnknown: false, service: other(VERSION) }, "service-owner");
  assert.equal(same.consent, "takeover");
});

await cell("finding 6: unreadable agents make the consent say any agents stop", () => {
  const unread = step({ status: undefined, statusUnknown: true, service: other("2.3.0") }, "service-owner");
  assert.equal(unread.agentsUnknown, true, "an unreadable status cannot promise that no agent stops");
  assert.equal(unread.change, "Use this app for the background service. Any agents it runs stop.");
  const row = step({ status: status({ version: "2.3.0", agents: [{ space: "team", observedAt: "", state: "unreadable", message: "x" }] }), statusUnknown: false, service: other("2.3.0") }, "service-owner");
  assert.equal(row.agentsUnknown, true, "an unreadable agent row is unknown too");
  const none = step({ status: status({ version: "2.3.0", agents: [] }), statusUnknown: false, service: other("2.3.0") }, "service-owner");
  assert.equal(none.agentsUnknown, undefined);
  assert.notEqual(planFrom({ status: undefined, statusUnknown: true, service: other("2.3.0") }, VERSION).digest, planFrom({ status: undefined, statusUnknown: false, service: other("2.3.0") }, VERSION).digest, "the digest covers it");
});

await cell("finding 3: the spaces fix starts 1 named space of 3 refused", async () => {
  const plan = planFrom({ status: status({ managers: [refused("alpha"), refused("beta", STALE)] }), statusUnknown: false, service: { kind: "this" } }, VERSION);
  const spaces = plan.steps.find(item => item.step === "spaces")!;
  assert.deepEqual(spaces.spaces, ["alpha"], "the plan names the stopped space and not the stale one");
  const started: string[] = [];
  const fresh = status({ managers: [refused("alpha"), refused("beta", STALE), refused("gamma")] });
  await startSpaces(spaces, async () => fresh, async space => { started.push(space); });
  assert.deepEqual(started, ["alpha"], "a stale space and a space stopped after planning are left alone");
});

await cell("finding 9: a failed step returns the partial result and runs nothing after it", async () => {
  const steps: RepairStep[] = [
    { step: "service-running", outcome: "fix", found: "f", change: "Start the background service." },
    { step: "agent-apps", outcome: "fix", found: "f", change: "Let the background service find your agent apps." },
    { step: "spaces", outcome: "fix", found: "f", change: "Start those spaces again." },
  ];
  let calls = 0;
  const done = await runSteps(steps, async item => { calls++; if (item.step === "agent-apps") throw new Error("raw daemon text"); return "changed"; });
  assert.equal(calls, 2, "the step after a failure does not run");
  assert.deepEqual(done.map(item => [item.step, item.changed, item.failed]), [
    ["service-running", "changed", undefined],
    ["agent-apps", undefined, "Repair could not finish this step."],
    ["spaces", undefined, undefined],
  ]);
  assert.equal(done[1]!.detail, "raw daemon text", "Details keeps what the service said");
});

if (failed.length) { console.log(`${failed.length} of 5 cells failed`); process.exit(1); }
