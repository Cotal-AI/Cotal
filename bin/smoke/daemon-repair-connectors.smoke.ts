/** Repair sets up the agent app connectors again when a space stopped because they could not be
 *  set up, then starts that space, through the service and with no terminal. */
import assert from "node:assert/strict";
import { planFrom, runSteps, type RepairProbe, type RepairStep } from "../daemon/repair.js";
import { parseRequest, type DaemonStatus, type HostedManager } from "../daemon/protocol.js";

const VERSION = "2.4.0";
const base = { state: "ready", protocol: 1, version: VERSION, pid: 1, startedAt: "", uptimeMs: 0 } as const;
const status = (managers: HostedManager[]): DaemonStatus => ({ ...base, managers }) as DaemonStatus;
const probe = (managers: HostedManager[]): RepairProbe => ({ status: status(managers), statusUnknown: false, service: { kind: "this" } });
const refused = (space: string, reason: string): HostedManager => ({ space, state: "refused", restarts: 0, reason, lastRefusal: reason });
// The reason 0.184.1 records, word for word, on a computer with no npm (seen on Linux, macOS and Windows).
const SEED = "hosted connector reconciliation failed: replacement connector reconciliation failed (exit 1): × a previous connector seed failed (package \"claude\", phase add): failed to seed connector \"claude\" from /home/person/.config/cotal/seed/store/0.177.0/claude: @cotal-ai/connector-claude-code npm install failed: npm is not on PATH - fix that, then run `cotal ext seed --repair`; run `cotal ext seed --repair` with the installed CLI";
const REPLACED = "hosted connector reconciliation failed: daemon loaded CLI 2.3.0, but the installed CLI is 2.4.0; refusing to launch a hosted Manager from the replaced installation";

const failed: string[] = [];
let cells = 0;
async function cell(name: string, run: () => Promise<void> | void): Promise<void> {
  cells++;
  try { await run(); console.log(`PASS ${name}`); }
  catch (error) { failed.push(name); console.log(`FAIL ${name}: ${(error as Error).message.split("\n")[0]}`); }
}

await cell("a space stopped on connector setup gets a connectors step before the spaces step", () => {
  const plan = planFrom(probe([refused("team", SEED), { space: "other", state: "answering", restarts: 0, connectors: [{ agent: "claude", state: "available" }] }]), VERSION);
  const names = plan.steps.map(step => step.step);
  const connectors = plan.steps.find(step => step.step === "connectors");
  assert.ok(connectors, "the plan has a connectors step");
  assert.equal(connectors.outcome, "fix");
  assert.equal(connectors.consent, undefined, "it stops nothing, so it asks nothing");
  assert.equal(connectors.found, "Cotal couldn't set up the agent app connectors on this computer.");
  assert.equal(connectors.change, "Set up the agent app connectors again.");
  assert.ok(names.indexOf("connectors") < names.indexOf("spaces"), "connectors are set up before the space starts");
  assert.deepEqual(plan.steps.find(step => step.step === "spaces")!.spaces, ["team"], "the spaces step starts 1 space, the stopped one");
  assert.equal(plan.steps.filter(step => step.outcome === "fix").length, 2, "2 fix steps: connectors, then spaces");
  for (const step of plan.steps) assert.doesNotMatch(`${step.found} ${step.change ?? ""}`, /`|cotal\s|npm/, "no command line in what the panel shows");
});

await cell("a healthy computer and a replaced installation get no connectors fix", () => {
  const healthy = planFrom(probe([{ space: "team", state: "answering", restarts: 0, connectors: [{ agent: "claude", state: "available" }] }]), VERSION);
  assert.equal(healthy.steps.find(step => step.step === "connectors")?.outcome, "ok");
  const replaced = planFrom(probe([refused("team", REPLACED)]), VERSION);
  assert.equal(replaced.steps.find(step => step.step === "connectors")?.outcome, "ok", "a version change is the service step's, not a connector repair");
  assert.notEqual(planFrom(probe([refused("team", SEED)]), VERSION).digest, planFrom(probe([refused("team", "other cause")]), VERSION).digest, "the digest covers it");
});

await cell("the service takes the connectors-repair request, with no fields", () => {
  const parsed = parseRequest(JSON.stringify({ v: 1, id: "abc123", op: "connectors-repair" }));
  assert.equal(parsed.ok, true, "the daemon admits the request");
  const extra = parseRequest(JSON.stringify({ v: 1, id: "abc123", op: "connectors-repair", space: "team" }));
  assert.equal(extra.ok, false, "it takes no fields");
});

await cell("applying runs the connector repair once, then starts the stopped space once", async () => {
  const plan = planFrom(probe([refused("team", SEED)]), VERSION);
  const order: string[] = [];
  const done = await runSteps(plan.steps, async step => { order.push(step.step); return `${step.step} done`; });
  assert.deepEqual(order, ["connectors", "spaces"], "1 connector repair, then 1 start, in that order");
  assert.equal(done.filter(step => step.changed).length, 2);
});

await cell("a connector repair that fails stops the run, says so plainly and keeps the service's words for Details", async () => {
  const plan = planFrom(probe([refused("team", SEED)]), VERSION);
  const daemonRefusal = Object.assign(new Error("the daemon refused connectors-repair: MANAGER_UNAVAILABLE connector repair failed (exit 1): npm is not on PATH"), { code: "LIFECYCLE_BLOCKED", native: { code: "MANAGER_UNAVAILABLE" } });
  let starts = 0;
  const done = await runSteps(plan.steps, async (step: RepairStep) => { if (step.step === "connectors") throw daemonRefusal; starts++; return "started"; });
  const connectors = done.find(step => step.step === "connectors")!;
  assert.equal(starts, 0, "the space is not started on connectors that failed");
  assert.equal(connectors.failed, "Cotal couldn't set up the agent app connectors. Details shows what the background service said.");
  assert.match(connectors.detail ?? "", /npm is not on PATH/, "Details keeps the cause");
});

if (failed.length) { console.log(`${failed.length} of ${cells} cells failed`); process.exit(1); }
console.log(`${cells} of ${cells} cells passed`);
