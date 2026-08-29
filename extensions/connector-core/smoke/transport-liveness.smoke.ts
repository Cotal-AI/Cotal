/**
 * TRANSPORT LIVENESS IS NOT ENDPOINT READINESS.
 *
 * This suite uses the real CotalEndpoint status watcher and the real MeshAgent listeners, with a
 * controlled NATS status iterator. No broker is opened. The iterator is the same public contract
 * nats.js exposes through `nc.status()`, while the controlled epochs make the late-old-connection
 * race deterministic rather than timing-dependent.
 *
 * Reproduction baseline on main 87bee50d, before the fix:
 *   - transient `disconnect` leaves MeshAgent.connected true and exposes no transport state;
 *   - a clean MeshAgent.stop() leaves connected true;
 *   - an endpoint error after a successful bind becomes connectionIssue even though that field's
 *     contract is pre-bind readiness diagnosis;
 *   - there is no epoch-safe transport signal, so old-epoch lifecycle events cannot be rejected.
 *
 * The existing `connection` event deliberately remains the full-bind readiness signal. The cells
 * below require it not to flap when raw NATS transport drops and resumes.
 *
 * MUTATION LEDGER, predicted before the first graded run. Every mutation walks every cell below.
 *
 * M1 removes the endpoint's old-epoch guard.
 *   IN  late OLD disconnect/close ignored: those events now flip the replacement false.
 *   OUT initial true: no replacement exists yet. OUT first disconnect and duplicate false: epoch 1
 *       is current. OUT ignored telemetry, reconnect, current disconnect, current close, stop, and
 *       both issue cells: none depends on rejecting a replaced connection's iterator.
 *
 * M2 drops the NATS `disconnect` edge.
 *   IN  first disconnect makes transport false; current epoch owns false fails for the same reason.
 *   OUT duplicate false idempotence: no edge also leaves the event count unchanged. OUT initial true,
 *       ignored telemetry, reconnect true, stale-old rejection, terminal close, stop, and both issue
 *       cells: their sources are unchanged. The terminal-close cell gets its false from close itself.
 *
 * M3 drops the NATS `reconnect` edge.
 *   IN  reconnect restores transport true.
 *   OUT initial true, first/duplicate disconnect, ignored telemetry, stale OLD rejection, current
 *       disconnect and close, stop, and both issue cells. Arming epoch 2 explicitly restores true,
 *       so the stale-old cell does not depend on the earlier reconnect edge.
 *
 * M4 removes the explicit initial transport=true.
 *   IN  initial true.
 *   OUT every other cell. The later explicit reconnect restores epoch 1, epoch 2 is armed while the
 *       state is already true, and the remaining edges and issue/stop contracts do not require the
 *       initial publication.
 *
 * M5 removes MeshAgent's duplicate-state guard.
 *   IN  duplicate false idempotence. IN current terminal close idempotence. OUT every value cell:
 *       duplicate delivery changes event count, not the final boolean. OUT issue cells.
 *
 * M6 removes MeshAgent.stop's readiness clear.
 *   IN  stop clears both states. OUT every preceding transport cell and both issue cells.
 *
 * M7 restores unconditional connectionIssue writes.
 *   IN  post-bind error is not presented as connectionIssue. OUT pre-bind retention (both versions
 *       retain it) and every transport/stop cell.
 *
 * M8 removes the post-stop transport-event guard. M9 removes the post-stop readiness-event guard.
 *   IN  late endpoint events after stop cannot resurrect either state, for each mutation.
 *   OUT all earlier cells: stopping is false until that final race cell. OUT both issue cells.
 *
 * M10 reverses the terminal-close readiness/error order.
 *   IN  terminal close marks readiness false before retaining its diagnostic.
 *   OUT all transport and stop cells, plus the constructed pre/post-bind issue cells: they do not
 *       invoke the endpoint supervisor's terminal-close path.
 *
 * M11 clears connectionIssue during stop.
 *   IN  stop preserves the last connection issue for post-mortem diagnosis.
 *   OUT the terminal ordering cell (it checks before stop), every transport/readiness cell, and the
 *       constructed pre/post-bind issue cells (their own stop occurs after their assertions).
 *
 * M12 removes the initial-start post-bind stop fence.
 *   IN  #975: stop racing the INITIAL bind leaves no nc, heartbeat, or armed supervisor.
 *   OUT every other cell: only the controlled initial-start race creates resources after stop.
 *
 * M13 allows post-stop endpoint errors to overwrite connectionIssue.
 *   IN  post-stop endpoint errors cannot overwrite the preserved issue.
 *   OUT the earlier issue cells and all transport/start cells: their errors occur before stop.
 *
 * M14 allows a rejected initial start to write after stop.
 *   IN  start rejection after stop cannot replace the post-mortem diagnostic.
 *   OUT every earlier cell: their connectLoop catch is not reached after stop.
 *
 * M15 removes the manual-rebuild transport=false edge.
 *   IN  cotal_reconnect lowers transport during the rebuild null window.
 *   OUT replacement transport restoration (the new watcher still seeds true) and every other cell:
 *       none enters doRebuild's explicit no-nc window.
 *
 * M16 removes the defensive epoch check from watchStatus's catch handler.
 *   IN  controlled stale status iterator THROW is ignored after replacement.
 *   OUT the stale in-loop status cell (different guard), all ordinary edges, reconnect, stop, and
 *       diagnostic cells: none makes a replaced iterator reject.
 *   REAL REACHABILITY: intentionally unclaimed. Five runs of the real broker companion exercised
 *       loss, reconnect, manual epoch replacement, and terminal close on pinned nats.js 3.4.0 with
 *       temporary catch instrumentation; every iterator ended normally and the catch fired zero
 *       times. This cell grades defensive symmetry for a future/runtime rejection, not a shipped path.
 *
 * Harness correction after the first 15-mutation run: the completion marker still named the former
 * 17-cell total after the manual-reconnect cells raised the suite to 19. Every mutation printed its
 * predicted novel failure and all 19 cells ran, but the opt-in marker correctly made those runs
 * inconclusive. The marker now matches the final suite total; no mutation or prediction changed.
 *
 * Harness correction after the first 14-mutation run: the original M7 literal still named the
 * pre-review `!_connected` guard. The post-stop fix intentionally widened that same line to
 * `!_connected && !stopping`, so mutation-proof refused before applying anything. M7 now targets the
 * final guard and restores the same unconditional-write defect; the other thirteen mutations all
 * killed their predicted named cells on that run.
 *
 * Harness correction after the first graded run: M2 and M3 changed the discriminant guards to
 * `false &&`, so TypeScript correctly narrowed their bodies to an impossible status and the core
 * build stopped before any cell. The predictions did not change. The operators now keep each guard
 * and replace only its emit with a no-op read of the narrowed payload, so the mutant stays compilable
 * and reaches the behavior it is meant to break. The other five mutations killed their predicted
 * named cells on that first run.
 *
 * Run: pnpm smoke:transport-liveness
 */
import type { Status } from "@nats-io/nats-core";
import { MeshAgent } from "../src/agent.js";
import type { AgentConfig } from "../src/config.js";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, extra?: unknown): void => {
  if (cond) { pass++; console.log(`  \u2713 ${name}`); }
  else { fail++; console.log(`  \u2717 FAIL: ${name}`, extra ?? ""); }
};

class StatusQueue implements AsyncIterable<Status> {
  private pending: Array<{
    resolve: (value: IteratorResult<Status>) => void;
    reject: (error: Error) => void;
  }> = [];
  private values: Status[] = [];
  private done = false;

  push(value: Status): void {
    const next = this.pending.shift();
    if (next) next.resolve({ value, done: false });
    else this.values.push(value);
  }

  fail(error: Error): void {
    const next = this.pending.shift();
    if (next) next.reject(error);
    else throw new Error("StatusQueue.fail requires a pending iterator read");
  }

  close(): void {
    this.done = true;
    for (const next of this.pending.splice(0)) next.resolve({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<Status> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value) return Promise.resolve({ value, done: false });
        if (this.done) return Promise.resolve({ value: undefined, done: true });
        return new Promise<IteratorResult<Status>>((resolve, reject) => this.pending.push({ resolve, reject }));
      },
    };
  }
}

class FakeNc {
  readonly queue = new StatusQueue();
  closedFlag = false;
  constructor(readonly server: string) {}
  status(): AsyncIterable<Status> { return this.queue; }
  getServer(): string { return this.server; }
  isClosed(): boolean { return this.closedFlag; }
  async drain(): Promise<void> { this.closedFlag = true; this.queue.push({ type: "close" }); this.queue.close(); }
  async closed(): Promise<void> { return new Promise(() => {}); }
}

class ClosingNc extends FakeNc {
  private resolveClose!: (error?: Error) => void;
  private readonly closePromise = new Promise<Error | undefined>((resolve) => { this.resolveClose = resolve; });
  override closed(): Promise<Error | undefined> { return this.closePromise; }
  finish(error?: Error): void { this.closedFlag = true; this.resolveClose(error); }
}

class DrainWitnessNc extends FakeNc {
  drains = 0;
  override async drain(): Promise<void> { this.drains++; await super.drain(); }
}

const cfg: AgentConfig = {
  space: "transport-liveness",
  name: "transport-agent",
  servers: "nats://127.0.0.1:1",
  kind: "agent",
  tls: false,
  subscribe: [],
  allowSubscribe: [],
  allowPublish: [],
};

type EndpointHarness = {
  nc?: FakeNc;
  heartbeatTimer?: ReturnType<typeof setInterval>;
  watchStatus(): void;
  superviseConnection(): void;
  reestablishLoop(): Promise<void>;
  connectAndBind(): Promise<void>;
};
type AgentHarness = {
  readonly transportConnected: boolean;
};

function arm(agent: MeshAgent, nc: FakeNc): void {
  const ep = agent.ep as unknown as EndpointHarness;
  ep.nc = nc;
  ep.watchStatus();
}

let unexpected: unknown;
try {
console.log("transport lifecycle is separate from full-bind readiness:");
const agent = new MeshAgent(cfg);
const endpointEvents: Array<{ connected: boolean; server?: string }> = [];
const agentEvents: Array<{ connected: boolean; server?: string }> = [];
const endpointErrors: string[] = [];
agent.ep.on("transport", (event: { connected: boolean; server?: string }) => endpointEvents.push(event));
agent.on("transport", (event: { connected: boolean; server?: string }) => agentEvents.push(event));
agent.ep.on("error", (error: Error) => endpointErrors.push(error.message));
agent.ep.emit("connection", { connected: true });
const epoch1 = new FakeNc("nats://epoch-1");
arm(agent, epoch1);
await tick();
check(
  "arming status publishes an explicit initial transport=true with the real server",
  (agent as unknown as AgentHarness).transportConnected === true &&
    endpointEvents[0]?.connected === true && endpointEvents[0]?.server === "nats://epoch-1",
  { transport: (agent as unknown as AgentHarness).transportConnected, endpointEvents },
);

epoch1.queue.push({ type: "disconnect", server: "nats://epoch-1" });
await tick();
check(
  "a NATS disconnect makes transport false WITHOUT flapping full-bind readiness",
  (agent as unknown as AgentHarness).transportConnected === false && agent.connected === true,
  { transport: (agent as unknown as AgentHarness).transportConnected, ready: agent.connected },
);
const afterFirstFalse = agentEvents.length;
epoch1.queue.push({ type: "disconnect", server: "nats://epoch-1" });
await tick();
check(
  "a duplicate transport=false is idempotent at MeshAgent",
  agentEvents.length === afterFirstFalse,
  { agentEvents },
);
epoch1.queue.push({ type: "reconnecting" });
epoch1.queue.push({ type: "staleConnection" });
epoch1.queue.push({ type: "forceReconnect" });
epoch1.queue.push({ type: "update", added: ["nats://other"] });
await tick();
check(
  "reconnecting and precursor or informational statuses emit no transport edge",
  agentEvents.length === afterFirstFalse,
  { agentEvents },
);
epoch1.queue.push({ type: "reconnect", server: "nats://epoch-1" });
await tick();
check(
  "the distinguishable NATS reconnect edge restores transport without another readiness event",
  (agent as unknown as AgentHarness).transportConnected === true && agent.connected === true &&
    agentEvents.at(-1)?.connected === true,
  { transport: (agent as unknown as AgentHarness).transportConnected, ready: agent.connected, agentEvents },
);

console.log("old connection epochs cannot overwrite a healthy replacement:");
const epoch2 = new FakeNc("nats://epoch-2");
arm(agent, epoch2);
await tick();
const beforeStale = agentEvents.length;
epoch1.queue.push({ type: "disconnect", server: "nats://epoch-1" });
epoch1.queue.push({ type: "close" });
await tick();
check(
  "late disconnect and close from the OLD epoch are ignored after the replacement is current",
  (agent as unknown as AgentHarness).transportConnected === true && agentEvents.length === beforeStale,
  { transport: (agent as unknown as AgentHarness).transportConnected, agentEvents },
);
epoch1.queue.fail(new Error("stale iterator failure"));
await tick();
check(
  "a controlled stale status iterator THROW is ignored after the replacement epoch is current",
  !endpointErrors.includes("stale iterator failure"),
  { endpointErrors },
);
epoch2.queue.push({ type: "disconnect", server: "nats://epoch-2" });
await tick();
check(
  "the CURRENT epoch still owns transport=false",
  (agent as unknown as AgentHarness).transportConnected === false && agentEvents.at(-1)?.server === "nats://epoch-2",
  { transport: (agent as unknown as AgentHarness).transportConnected, agentEvents },
);
const beforeClose = agentEvents.length;
epoch2.queue.push({ type: "close" });
await tick();
check(
  "current terminal close confirms false with server omitted and is idempotent at MeshAgent",
  endpointEvents.at(-1)?.connected === false && !("server" in endpointEvents.at(-1)!) &&
    agentEvents.length === beforeClose,
  { endpointEvents, agentEvents },
);

console.log("manual rebuild owns an explicit no-transport window:");
const manual = new MeshAgent({ ...cfg, name: "manual-reconnect-agent" });
manual.ep.emit("connection", { connected: true });
const manualEp = manual.ep as unknown as EndpointHarness;
const manualOld = new FakeNc("nats://manual-old");
arm(manual, manualOld);
await tick();
let releaseRebind!: () => void;
const rebindGate = new Promise<void>((resolve) => { releaseRebind = resolve; });
const manualNew = new FakeNc("nats://manual-new");
manualEp.connectAndBind = async () => {
  await rebindGate;
  manualEp.nc = manualNew;
  manualEp.watchStatus();
  manual.ep.emit("connection", { connected: true });
};
const manualResult = manual.reconnect();
await tick();
check(
  "cotal_reconnect lowers transport during the rebuild null window",
  manualEp.nc === undefined && manual.connected === false && manual.transportConnected === false,
  { hasNc: manualEp.nc !== undefined, ready: manual.connected, transport: manual.transportConnected },
);
releaseRebind();
check(
  "cotal_reconnect restores transport on the replacement epoch",
  (await manualResult).ok === true && manual.transportConnected === true && manual.connected === true,
  { ready: manual.connected, transport: manual.transportConnected },
);
await manual.stop();

console.log("shutdown and readiness diagnostics are truthful:");
const stopping = new MeshAgent({ ...cfg, name: "stopping-agent" });
stopping.ep.emit("connection", { connected: true });
arm(stopping, new FakeNc("nats://stop"));
await tick();
await stopping.stop();
check(
  "MeshAgent.stop clears both readiness and transport locally",
  stopping.connected === false && (stopping as unknown as AgentHarness).transportConnected === false,
  { ready: stopping.connected, transport: (stopping as unknown as AgentHarness).transportConnected },
);
stopping.ep.emit("transport", { connected: true, server: "nats://late" });
stopping.ep.emit("connection", { connected: true });
check(
  "late endpoint events after stop cannot resurrect readiness or transport",
  stopping.connected === false && (stopping as unknown as AgentHarness).transportConnected === false,
  { ready: stopping.connected, transport: (stopping as unknown as AgentHarness).transportConnected },
);

const issue = new MeshAgent({ ...cfg, name: "issue-agent" });
issue.ep.emit("error", new Error("pre-bind refused"));
check("a pre-bind endpoint error is retained for readiness diagnosis", issue.connectionIssue === "pre-bind refused", issue.connectionIssue);
issue.ep.emit("connection", { connected: true });
issue.ep.emit("error", new Error("post-bind consumer reset"));
check(
  "a post-bind endpoint error is logged but is NOT presented as the pre-bind connection issue",
  issue.connectionIssue === undefined,
  issue.connectionIssue,
);
await issue.stop();

const terminal = new MeshAgent({ ...cfg, name: "terminal-agent" });
terminal.ep.emit("connection", { connected: true });
const terminalNc = new ClosingNc("nats://terminal");
const terminalEp = terminal.ep as unknown as EndpointHarness;
terminalEp.nc = terminalNc;
terminalEp.reestablishLoop = async () => {};
terminalEp.superviseConnection();
terminalNc.finish(new Error("terminal socket loss"));
await tick();
check(
  "terminal close marks readiness false BEFORE retaining its matching diagnostic",
  terminal.connected === false && terminal.connectionIssue?.includes("terminal socket loss") === true,
  { ready: terminal.connected, issue: terminal.connectionIssue },
);
await terminal.stop();
check(
  "stop preserves the last connection issue for post-mortem diagnosis",
  terminal.connectionIssue?.includes("terminal socket loss") === true,
  terminal.connectionIssue,
);
terminal.ep.emit("error", new Error("late teardown noise"));
check(
  "post-stop endpoint errors cannot overwrite the preserved connection issue",
  terminal.connectionIssue?.includes("terminal socket loss") === true,
  terminal.connectionIssue,
);

const starting = new MeshAgent({ ...cfg, name: "starting-agent" });
const startingEp = starting.ep as unknown as EndpointHarness;
let releaseBind!: () => void;
const bindGate = new Promise<void>((resolve) => { releaseBind = resolve; });
const freshNc = new DrainWitnessNc("nats://fresh-after-stop");
let supervised = 0;
startingEp.connectAndBind = async () => {
  await bindGate;
  startingEp.nc = freshNc;
  startingEp.heartbeatTimer = setInterval(() => {}, 60_000);
};
startingEp.superviseConnection = () => { supervised++; };
const startingPromise = starting.start(1);
await tick();
await starting.stop(); // stop fully completes while the initial bind is still parked
releaseBind();
await startingPromise;
check(
  "#975: stop racing the INITIAL bind leaves no nc, heartbeat, or armed supervisor",
  freshNc.drains === 1 && freshNc.closedFlag === true && startingEp.nc === undefined &&
    startingEp.heartbeatTimer === undefined && supervised === 0,
  {
    drains: freshNc.drains,
    closed: freshNc.closedFlag,
    hasNc: startingEp.nc !== undefined,
    hasHeartbeat: startingEp.heartbeatTimer !== undefined,
    supervised,
  },
);
// Test-harness cleanup only. Under the deliberate #975 mutation the product leaves this interval and
// nc live, which is the named failure above. Clear/close them after observing so the suite reaches its
// terminal marker and mutation-proof can grade the red instead of timing out on the leaked resource.
if (startingEp.heartbeatTimer) clearInterval(startingEp.heartbeatTimer);
if (!freshNc.closedFlag) await freshNc.drain();

const failing = new MeshAgent({ ...cfg, name: "failing-start-agent" });
let rejectStart!: (error: Error) => void;
const startGate = new Promise<void>((_resolve, reject) => { rejectStart = reject; });
(failing.ep as unknown as EndpointHarness).connectAndBind = () => startGate;
const failedStart = failing.start(1);
await tick();
await failing.stop();
rejectStart(new Error("late start rejection"));
await failedStart;
check(
  "a start rejection arriving after stop cannot replace the post-mortem diagnostic",
  failing.connectionIssue === undefined,
  failing.connectionIssue,
);

} catch (error) {
  unexpected = error;
} finally {
  const EXPECTED_CELLS = 20;
  const ran = pass + fail;
  if (unexpected !== undefined) console.log(`  UNEXPECTED THROW: ${String(unexpected)}`);
  console.log(`\n${fail === 0 && unexpected === undefined ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed`);
  console.log(`SUITE COMPLETE: ${ran} cells`);
  if (ran !== EXPECTED_CELLS) {
    console.log(`SUITE INCOMPLETE: ran ${ran} of ${EXPECTED_CELLS} cells; a partial run is not a pass`);
  }
  process.exitCode = fail === 0 && unexpected === undefined && ran === EXPECTED_CELLS ? 0 : 1;
}
