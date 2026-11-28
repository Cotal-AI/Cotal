/** Repair's plan asks before anything that stops or starts what the person may be using, never
 *  downgrades the service, acts only on what the plan named, and reports a step that fails partway. */
import assert from "node:assert/strict";
import { dirname, sep } from "node:path";
import { failedCopy, pickupOutcome, planFrom, probeFailure, runSteps, startSpaces, type RepairProbe, type RepairStep } from "../daemon/repair.js";
import type { DaemonStatus, HostedManager } from "../daemon/protocol.js";

const VERSION = "2.4.0";
const base = { state: "ready", protocol: 1, version: VERSION, pid: 1, startedAt: "", uptimeMs: 0 } as const;
const status = (extra: Partial<DaemonStatus> = {}): DaemonStatus => ({ ...base, ...extra }) as DaemonStatus;
const other = (version?: string): RepairProbe["service"] => ({ kind: "other", installed: "/opt/cotal", entry: "/opt/cotal/dist/cotal.js", ...(version ? { version } : {}) });
const step = (probe: RepairProbe, name: string) => planFrom(probe, VERSION).steps.find(item => item.step === name)!;
const refused = (space: string, reason = "the manager did not start", hosted = true): HostedManager => ({ space, state: "refused", restarts: 3, reason, lastRefusal: reason, hostingIntent: hosted });
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
  await startSpaces(spaces, async () => fresh, async space => { started.push(space); return { space, state: "answering", restarts: 0 }; });
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
    ["agent-apps", undefined, "Repair could not finish this step. Details shows what the background service said."],
    ["spaces", undefined, undefined],
  ]);
  assert.equal(done[1]!.detail, "raw daemon text", "Details keeps what the service said");
});

await cell("agent apps: only a confirmed pickup is fixed; agents running is waiting; no confirmation fails the step", () => {
  const apps = { apps: [], management: "service" as const };
  assert.equal(pickupOutcome({ ...apps, serviceRefresh: { state: "refreshed" } }), "The background service looked for your agent apps again.");
  assert.equal(pickupOutcome({ ...apps, serviceRefresh: { state: "pending", reason: "agents-running" } }), "The background service picks up your agent apps once the running agents finish.");
  assert.throws(() => pickupOutcome({ ...apps, serviceRefresh: { state: "pending", reason: "unconfirmed" } }), /did not confirm/);
  assert.throws(() => pickupOutcome({ ...apps, management: "other-copy" }), /did not confirm/, "a read-only reply without serviceRefresh is not a pickup");
});

await cell("W1: the spaces step leaves out a space the person disconnected and one whose removal is unconfirmed", async () => {
  const disconnected = refused("left", "Manager registration removal is unconfirmed", false);
  const unknown = { ...refused("fenced"), registrationCleanup: "unknown" as const };
  const plan = planFrom({ status: status({ managers: [refused("alpha"), disconnected, unknown] }), statusUnknown: false, service: { kind: "this" } }, VERSION);
  assert.deepEqual(plan.steps.find(item => item.step === "spaces")!.spaces, ["alpha"], "only a space that still has a hosting intent and no pending removal");
  const started: string[] = [];
  await startSpaces({ step: "spaces", outcome: "fix", found: "", spaces: ["alpha", "left"] }, async () => status({ managers: [refused("alpha"), disconnected] }), async space => { started.push(space); return { space, state: "answering", restarts: 0 }; });
  assert.deepEqual(started, ["alpha"], "apply rechecks the intent too");
});

await cell("W2: an old registration in a disconnected space says the space stays disconnected", () => {
  const stale = (hosted: boolean) => ({ ...refused("team", "Manager cleanup identity differs from its recorded instance", hosted) });
  const step = (hosted: boolean) => planFrom({ status: status({ managers: [stale(hosted)] }), statusUnknown: false, service: { kind: "this" } }, VERSION).steps.find(item => item.step === "stale-registration")!;
  assert.equal(step(true).change, "Remove the old registration and start the agent host again.");
  assert.equal(step(false).change, "Remove the old registration. This space stays disconnected from this computer.");
  assert.equal(step(false).disconnected, true, "the window's consent reads the same fact");
  assert.notEqual(planFrom({ status: status({ managers: [stale(true)] }), statusUnknown: false, service: { kind: "this" } }, VERSION).digest, planFrom({ status: status({ managers: [stale(false)] }), statusUnknown: false, service: { kind: "this" } }, VERSION).digest);
});

await cell("W3: a service record Repair cannot verify is a cannot step, never Repair again", () => {
  const probe = probeFailure(Object.assign(new Error("the systemd receipt does not name this daemon home's unit in the user manager's unit directory; nothing was changed"), { code: "CONFLICT" }));
  assert.ok(probe, "a refusal while reading the service record becomes a plan, not a thrown error");
  const owner = planFrom(probe!, VERSION).steps.find(item => item.step === "service-owner")!;
  assert.equal(owner.outcome, "cannot");
  assert.equal(owner.action, "reinstall");
  assert.equal(owner.found, "Cotal can't confirm the background service on this computer is the one it set up, so Repair won't change it. Download Cotal and install it again to replace the service.");
  assert.equal(probeFailure(new Error("EACCES")), undefined, "anything that is not a refusal still throws");
});

await cell("W4: the spaces fix reports each space's real result and fails when one stays stopped", async () => {
  const step: RepairStep = { step: "spaces", outcome: "fix", found: "", spaces: ["alpha", "beta"] };
  const read = async () => status({ managers: [refused("alpha"), refused("beta")] });
  const ok = await startSpaces(step, read, async space => ({ space, state: "answering", restarts: 0 }));
  assert.equal(ok, "alpha and beta were started again.");
  const denied = "the space refused remote supervision (403): ask the space owner to grant your cli actor the supervise scope";
  await assert.rejects(startSpaces(step, read, async space => space === "beta" ? { ...refused("beta", denied) } : { space, state: "answering", restarts: 0 }),
    (error: Error & { native?: { code?: string } }) => /beta did not start/.test(error.message) && /alpha was started again/.test(error.message) && error.native?.code === "SPACE_NOT_STARTED");
});

await cell("W5: a move refuses when the other copy's version cannot be read or compared", () => {
  for (const version of [undefined, "nightly-7"]) {
    const owner = step({ status: undefined, statusUnknown: false, service: other(version) }, "service-owner");
    assert.equal(owner.outcome, "cannot", `version ${version}`);
    assert.equal(owner.action, "update");
    assert.equal(owner.found, "Cotal can't tell which version the other copy is, so it won't replace it with this one. Update this app, then repair again.");
  }
});

await cell("W10: a row that was not checked says so and is not shown as fine", () => {
  const plan = planFrom({ status: undefined, statusUnknown: false, service: other("2.3.0") }, VERSION);
  for (const name of ["service-running", "agent-apps", "spaces"]) {
    const row = plan.steps.find(item => item.step === name)!;
    assert.equal(row.outcome, "unchecked", name);
    assert.doesNotMatch(row.found, /^Checked/, name);
  }
  const older = planFrom({ status: status({ version: "2.5.0" }), statusUnknown: false, service: { kind: "this" } }, VERSION).steps.find(item => item.step === "service-running")!;
  assert.equal(older.found, "The background service runs a different version than this app.");
});

await cell("W7: every step that changes the service runs inside the admission gate; the agent-apps pickup takes it itself", async () => {
  const fix = (step: RepairStep["step"]): RepairStep => ({ step, outcome: "fix", found: "f", change: step });
  const trace: string[] = [];
  let held = false;
  const gate = async <T>(run: () => Promise<T>) => { trace.push("gate"); held = true; try { return await run(); } finally { held = false; trace.push("release"); } };
  await runSteps([fix("service-owner"), fix("service-running"), fix("agent-apps"), fix("spaces"), fix("stale-registration")],
    async step => { trace.push(`${step.step}${held ? "+gate" : ""}`); return "ok"; }, undefined, undefined, gate, step => step.step === "agent-apps");
  assert.deepEqual(trace, ["gate", "service-owner+gate", "service-running+gate", "release", "agent-apps", "gate", "spaces+gate", "stale-registration+gate", "release"]);
  const blocked = await runSteps([fix("service-running"), fix("spaces")], async () => "ok", undefined, undefined,
    async () => { throw Object.assign(new Error("Wait for the current change to finish, then try again."), { code: "LIFECYCLE_BLOCKED" }); });
  assert.deepEqual(blocked.map(item => [item.step, item.changed, item.failed]), [
    ["service-running", undefined, "Another change is running on this computer. Wait for it to finish, then choose Repair again."],
    ["spaces", undefined, undefined],
  ], "a held gate fails the first step and changes nothing");
});

await cell("W8: a rolled-back move and a failed restore each get their own next step, never the same Repair", () => {
  const rolled = failedCopy({ native: { code: "MOVE_ROLLED_BACK" } });
  assert.match(rolled, /Keep using the other copy for now, and update this app before trying again\./);
  assert.match(rolled, /don't start again by themselves/);
  const restore = failedCopy({ native: { code: "MOVE_RESTORE_FAILED" } });
  assert.equal(restore, "This app's service didn't start, and the other copy's service didn't start again either, so no background service runs on this computer. Choose Repair to set up this app's service.");
});

await cell("a recorded service that can't run (gone, or in a disk image, App Translocation or Downloads) is moved whatever its version; a real copy keeps the version guard", () => {
  // The recorded paths use this computer's separator, as a real record does. A disk image mounts under
  // /Volumes on macOS only, so that location is checked where paths are POSIX.
  const native = (posix: string) => posix.split("/").join(sep);
  const home = native("/Users/ada");
  const at = (entry: string, version?: string): RepairProbe => ({ status: undefined, statusUnknown: false, service: { kind: "other", installed: dirname(dirname(entry)), entry, ...(version ? { version } : {}) } });
  const owner = (probe: RepairProbe) => planFrom(probe, VERSION, home).steps.find(item => item.step === "service-owner")!;
  for (const entry of [
    ...(sep === "/" ? ["/Volumes/Cotal/Cotal.app/Contents/Resources/runtime/dist/cotal.js"] : []),
    native("/private/var/folders/xy/abc/T/AppTranslocation/1234-5678/d/Cotal.app/Contents/Resources/runtime/dist/cotal.js"),
    native("/Users/ada/Downloads/Cotal.app/Contents/Resources/runtime/dist/cotal.js"),
  ]) {
    const step = owner(at(entry));
    assert.equal(step.outcome, "fix", entry);
    assert.equal(step.consent, "takeover", entry);
    assert.equal(step.found, "The background service points at a copy of Cotal that can't run from where it is now.", entry);
    assert.equal(owner(at(entry, "9.0.0")).consent, "takeover", "even a newer version there can't run, so it moves");
  }
  const gone = owner({ status: undefined, statusUnknown: false, service: { kind: "other", installed: "/opt/cotal", entry: "/opt/cotal/dist/cotal.js", missing: true } });
  assert.equal(gone.consent, "takeover", "a recorded program that no longer exists moves too");
  const real = owner(at("/opt/cotal/dist/cotal.js"));
  assert.equal(real.outcome, "cannot", "a real installed copy whose version can't be read keeps the W5 guard");
  assert.equal(owner(at(native("/Users/ada/Downloads-old/Cotal.app/Contents/Resources/runtime/dist/cotal.js"))).outcome, "cannot", "a folder that only starts with Downloads is not Downloads");
});

const CELLS = 15;
if (failed.length) { console.log(`${failed.length} of ${CELLS} cells failed`); process.exit(1); }
