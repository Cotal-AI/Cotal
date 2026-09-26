/**
 * REAL NATS TRANSPORT EDGES REACH CotalEndpoint AND MeshAgent WITHOUT FLAPPING READINESS.
 *
 * The unit-shaped transport-liveness smoke controls the status iterator so it can prove epoch
 * staleness deterministically. This companion owns a throwaway nats-server on an OS-assigned port
 * and proves the public nats.js lifecycle produces the ruled disconnect/reconnect edges in practice.
 * It never starts or stops a Cotal stack and it scrubs inherited broker configuration before dialing.
 *
 * Run: pnpm smoke:transport-liveness:broker
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, connect as netConnect, type Socket } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MeshAgent } from "../src/agent.js";
import type { AgentConfig } from "../src/config.js";
import { isReachable } from "@cotal-ai/core";
import { pickFreePort } from "../../../packages/core/smoke/_free-port.js";
import { assertEphemeralBroker, scrubAmbientBrokerEnv } from "../../../packages/core/smoke/_ephemeral-only.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

scrubAmbientBrokerEnv();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (fn: () => boolean, timeoutMs = 12_000): Promise<boolean> => {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { if (fn()) return true; await sleep(50); }
  return fn();
};
const awaitExit = (proc: ChildProcess, timeoutMs = 4_000): Promise<void> =>
  new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    const timer = setTimeout(resolve, timeoutMs);
    proc.once("exit", () => { clearTimeout(timer); resolve(); });
  });

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, extra?: unknown): void => {
  if (cond) { pass++; console.log(`  \u2713 ${name}`); }
  else { fail++; console.log(`  \u2717 FAIL: ${name}`, extra ?? ""); }
};

const port = await pickFreePort();
const servers = `nats://127.0.0.1:${port}`;
assertEphemeralBroker(servers);
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const configPath = join(dir, "server.conf");
writeFileSync(configPath, `port: ${port}\njetstream { store_dir: "${join(dir, "js")}" }\n`);
const startBroker = (): ChildProcess => spawn("nats-server", ["-c", configPath], { stdio: "ignore" });
let broker = startBroker();
const releases = [teardownOnSignal(broker, dir)];

const cfg: AgentConfig = {
  space: `transport-live-${port}`,
  name: "transport-live-agent",
  servers,
  kind: "agent",
  tls: false,
  subscribe: [],
  allowSubscribe: [],
  allowPublish: [],
};
const agent = new MeshAgent(cfg);
const transport: Array<{ connected: boolean; server?: string }> = [];
const readiness: Array<{ connected: boolean }> = [];
let terminalIssueAtError: string | undefined;
agent.on("transport", (event) => transport.push(event));
agent.on("connection", (event) => readiness.push(event));
// MeshAgent registered its endpoint error handler in its constructor, before this listener. When the
// real supervisor emits its terminal error, read the public diagnostic AFTER MeshAgent processed it
// and BEFORE later re-establish attempts can report a newer pre-bind failure.
agent.ep.on("error", (error: Error) => {
  if (/^mesh connection closed/.test(error.message)) terminalIssueAtError = agent.connectionIssue;
});
let rebuildAgent: MeshAgent | undefined;
let staleAgent: MeshAgent | undefined;
let inflightAgent: MeshAgent | undefined;
let overlapAgent: MeshAgent | undefined;
let blockerAgent: MeshAgent | undefined;
let blocker2Agent: MeshAgent | undefined;
let orderingAgent: MeshAgent | undefined;

try {
  check("the owned throwaway broker starts", await until(() => false, 0) || await (async () => {
    for (let i = 0; i < 80; i++) { if (await isReachable(servers)) return true; await sleep(50); }
    return false;
  })());
  await agent.start(100);
  check(
    "initial transport=true arrives before or with full-bind readiness",
    await until(() => agent.transportConnected && agent.connected) &&
      transport[0]?.connected === true && readiness[0]?.connected === true,
    { transport, readiness, live: agent.transportConnected, ready: agent.connected },
  );

  broker.kill("SIGKILL");
  await awaitExit(broker);
  check(
    "a real broker loss emits transport=false while full-bind readiness does not flap",
    await until(() => !agent.transportConnected) && agent.connected === true &&
      transport.some((event) => event.connected === false) && readiness.length === 1,
    { transport, readiness, live: agent.transportConnected, ready: agent.connected },
  );

  broker = startBroker();
  releases.push(teardownOnSignal(broker, dir));
  check("the replacement broker starts", await (async () => {
    for (let i = 0; i < 80; i++) { if (await isReachable(servers)) return true; await sleep(50); }
    return false;
  })());
  check(
    "a real nats.js reconnect emits transport=true without another full-bind readiness edge",
    await until(() => agent.transportConnected) && agent.connected === true &&
      transport.filter((event) => event.connected === true).length >= 2 && readiness.length === 1,
    { transport, readiness, live: agent.transportConnected, ready: agent.connected },
  );

  // Keep the broker down until nats.js exhausts its reconnect attempts and closes the real current
  // connection. This reaches CotalEndpoint.superviseConnection through nc.closed(), not through a
  // constructed fake, and observes the MeshAgent diagnostic the user-facing status surface reads.
  const ep = agent.ep as unknown as {
    nc?: {
      setServers(servers: string[]): void;
      reconnect(): Promise<void>;
    };
    reestablishLoop(): Promise<void>;
  };
  ep.reestablishLoop = async () => {};
  const unreachablePort = await pickFreePort();
  ep.nc!.setServers([`127.0.0.1:${unreachablePort}`]);
  await ep.nc!.reconnect();
  check(
    "a REAL terminal close marks readiness false before exposing its user-visible reason",
    // The transport clause is not decoration. cotal_connection_status renders
    // `connected:false, transportConnected:true` as "connecting", so a terminal close that left
    // transport true would report a permanently dead session as one that is coming up. The cell
    // below proves stop() clears the flag; only this proves a terminal close does.
    await until(() => !agent.connected && /mesh connection closed/.test(terminalIssueAtError ?? ""), 30_000) &&
      agent.transportConnected === false,
    { ready: agent.connected, terminalIssueAtError, latestIssue: agent.connectionIssue, transport },
  );

  await agent.stop();
  check("clean stop clears readiness and transport", agent.connected === false && agent.transportConnected === false, {
    ready: agent.connected,
    live: agent.transportConnected,
  });

  // stop() racing the INITIAL bind, against a REAL dial. The unit suite proves the state teardown
  // for this race by replacing connectAndBind wholesale, which leaves everything inside it unproven.
  // Gating armPlane3, the last await connectAndBind makes before it reports the endpoint live, holds
  // a real bind open at its final step, so stop() lands mid-bind and the method itself decides
  // whether to announce a connection that is already being torn down. Listening on the endpoint
  // rather than on the agent is the point, and it is the load-bearing clause here: MeshAgent
  // carries its own stopping guard, so its flag stays false either way and only a direct endpoint
  // listener is exposed to the late edge.
  const raceAgent = new MeshAgent({ ...cfg, name: `transport-live-race-${port}` });
  const raceEdges: Array<{ connected: boolean }> = [];
  raceAgent.ep.on("connection", (event: { connected: boolean }) => raceEdges.push(event));
  const raceEp = raceAgent.ep as unknown as { armPlane3(): Promise<void> };
  let bindAtFinalStep = false;
  let releaseBind: () => void = () => {};
  const bindGate = new Promise<void>((resolve) => { releaseBind = resolve; });
  raceEp.armPlane3 = async () => { bindAtFinalStep = true; await bindGate; };
  const raceStart = raceAgent.start(100).catch(() => {});
  // A real dial and bind on a loaded runner, not a local poll, so this gets the same budget as
  // the terminal-close cell. It returns the moment the bind arrives, so the cost is only paid
  // when the bind never gets there, and then the cell fails loudly rather than passing empty.
  const reachedFinalStep = await until(() => bindAtFinalStep, 30_000);
  await raceAgent.stop();
  releaseBind();
  await raceStart;
  check(
    "stop during a REAL initial bind never announces the connection it then tears down",
    reachedFinalStep && !raceEdges.some((event) => event.connected === true) && raceAgent.connected === false,
    { reachedFinalStep, raceEdges, ready: raceAgent.connected },
  );

  // A sibling of the readiness race, raised in review. watchStatus seeds `transport: true` as soon as
  // the dial returns, and connectAndBind calls it long before the bind finishes, so a stop() landing
  // while the dial is still in flight can have that seed fire on an endpoint that is already stopped.
  // Proven through a real dial rather than a stub: a TCP proxy accepts the client socket and holds it,
  // so the dial is genuinely pending while stop() runs, then pipes to the real broker so the handshake
  // completes for real. Nothing in the endpoint is replaced for this cell.
  let releaseDial: () => void = () => {};
  const dialGate = new Promise<void>((resolve) => { releaseDial = resolve; });
  let dialArrived = false;
  const dialSockets: Socket[] = [];
  const proxy = createServer((client) => {
    dialArrived = true;
    dialSockets.push(client);
    client.on("error", () => {});
    void dialGate.then(() => {
      const upstream = netConnect(port, "127.0.0.1", () => {
        client.pipe(upstream);
        upstream.pipe(client);
      });
      dialSockets.push(upstream);
      upstream.on("error", () => client.destroy());
    });
  });
  const proxyPort = await pickFreePort();
  await new Promise<void>((resolve) => proxy.listen(proxyPort, "127.0.0.1", () => resolve()));

  const dialAgent = new MeshAgent({
    ...cfg,
    name: `transport-live-dial-${port}`,
    servers: `nats://127.0.0.1:${proxyPort}`,
  });
  const dialEdges: Array<{ connected: boolean }> = [];
  dialAgent.ep.on("transport", (event: { connected: boolean }) => dialEdges.push(event));
  const dialStart = dialAgent.start(100).catch(() => {});
  const sawPendingDial = await until(() => dialArrived, 30_000);
  await dialAgent.stop();
  const edgesBeforeRelease = dialEdges.length;
  releaseDial();
  await dialStart;
  await sleep(750);
  check(
    "stop during a pending dial never seeds transport live afterwards",
    sawPendingDial && edgesBeforeRelease === 0 && !dialEdges.some((event) => event.connected === true),
    { sawPendingDial, edgesBeforeRelease, dialEdges },
  );
  for (const socket of dialSockets) socket.destroy();
  await new Promise<void>((resolve) => proxy.close(() => resolve()));

  // #1028: the start() mid-bind cell above does not reach doRebuild. reconnect() is the public
  // door onto that path. Gate armPlane3 AFTER a successful first bind so the second connectAndBind
  // (the rebuild) is the one held open; wait on the gate itself, then land stop() inside that
  // window. Listening on the endpoint, not MeshAgent, for the same reason as the start() cell.
  rebuildAgent = new MeshAgent({ ...cfg, name: `transport-live-rebuild-${port}` });
  const rebuildEdges: Array<{ connected: boolean }> = [];
  rebuildAgent.ep.on("connection", (event: { connected: boolean }) => rebuildEdges.push(event));
  await rebuildAgent.start(100);
  check(
    "rebuild-race setup: first bind completed before the rebuild is forced",
    await until(() => rebuildAgent.connected, 30_000) && rebuildEdges.some((event) => event.connected === true),
    { ready: rebuildAgent.connected, rebuildEdges },
  );
  const rebuildEp = rebuildAgent.ep as unknown as { armPlane3(): Promise<void>; reconnect(): Promise<void> };
  let rebuildBindAtFinalStep = false;
  let releaseRebuildBind: () => void = () => {};
  const rebuildBindGate = new Promise<void>((resolve) => { releaseRebuildBind = resolve; });
  rebuildEp.armPlane3 = async () => { rebuildBindAtFinalStep = true; await rebuildBindGate; };
  const rebuildEdgesBeforeReconnect = rebuildEdges.length;
  const rebuildWork = rebuildEp.reconnect().catch(() => {});
  const reachedRebuildFinalStep = await until(() => rebuildBindAtFinalStep, 30_000);
  check(
    "rebuild-race wait: stop is landed only after the rebuild bind reached armPlane3",
    reachedRebuildFinalStep,
    { reachedRebuildFinalStep, rebuildBindAtFinalStep },
  );
  await rebuildAgent.stop();
  releaseRebuildBind();
  await rebuildWork;
  const rebuildNcAfterStop = (rebuildAgent.ep as unknown as { nc?: unknown }).nc;
  check(
    "stop during a REAL rebuild bind never announces the connection it then tears down",
    reachedRebuildFinalStep
      && !rebuildEdges.slice(rebuildEdgesBeforeReconnect).some((event) => event.connected === true)
      && rebuildAgent.connected === false,
    { reachedRebuildFinalStep, afterReconnect: rebuildEdges.slice(rebuildEdgesBeforeReconnect), ready: rebuildAgent.connected },
  );
  check(
    "stop during a REAL rebuild bind tears the just-bound connection rather than leaving nc live",
    reachedRebuildFinalStep && rebuildNcAfterStop === undefined,
    { reachedRebuildFinalStep, rebuildNcAfterStop: rebuildNcAfterStop === undefined ? "absent" : "present" },
  );
  // #1356: THE PRESENCE-REFUSAL RECORD MUST NOT OUTLIVE THE CONNECTION THAT OBSERVED IT.
  //
  // The first cut of that change kept the record until the next SUCCESSFUL write. A reviewer measured
  // the consequence on a live object: after a presence timeout it forced a bind failure, the endpoint's
  // own connectionIssue became "connection refused", and the very next connector log line still said
  // "the transport is fine and the fault is not the network". Same object wrong, fresh object right,
  // which isolates it to retained state rather than branch logic. These cells encode THAT
  // reproduction, not a reconstruction of it.
  //
  // The first cell is the true positive and it is the one that stops the fix from over-correcting:
  // clearing too eagerly would silently delete the diagnosis this whole change exists to add, and a
  // suite that only proves the sentence disappears cannot tell a repair from a deletion.
  staleAgent = new MeshAgent({ ...cfg, name: `transport-live-stale-${port}` });
  await staleAgent.start(100);
  await until(() => staleAgent.connected, 30_000);
  const staleEp = staleAgent.ep as unknown as {
    kv?: unknown;
    servers: string;
    publishPresence(): Promise<void>;
    presenceWriteFailure(): { forMs: number; bucket: string } | undefined;
    reconnect(): Promise<void>;
  };
  const liveKv = staleEp.kv;
  // Drive the REAL publishPresence catch: only the put is replaced, so the recording, the clearing and
  // the guard under test all run as shipped.
  staleEp.kv = { put: () => Promise.reject(new Error("timeout")) };
  await staleEp.publishPresence().catch(() => {});
  check(
    "a refused presence write IS recorded while the transport is genuinely up (the fix must not delete the diagnosis)",
    staleEp.presenceWriteFailure() !== undefined && staleAgent.transportConnected === true,
    { record: staleEp.presenceWriteFailure(), transport: staleAgent.transportConnected },
  );

  // The reviewer's reproduction: force a bind FAILURE while the record is set. `servers` is readonly
  // to the compiler only; overriding it here is the same door the reviewer used, and it reaches
  // closeFailedBind, which tears the connection down WITHOUT emitting a transport:false edge.
  staleEp.kv = liveKv;
  staleEp.servers = "nats://127.0.0.1:1";
  await staleEp.reconnect().catch(() => {});
  check(
    "a FAILED bind clears the presence-refusal record rather than carrying it onto the next connection",
    staleEp.presenceWriteFailure() === undefined,
    { record: staleEp.presenceWriteFailure() },
  );

  // The operator-visible half, and it must be driven through MeshAgent's OWN retry loop, because that
  // is where the sentence is composed. An earlier version of this cell asserted on stderr after the
  // failed reconnect alone: connectLoop was not running, no diagnosis was ever produced, and the cell
  // passed against the unfixed source as readily as the fixed one. A cell that cannot fail is not a
  // control, so it is driven here and its discrimination is checked in both directions.
  const staleErr: string[] = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  (process.stderr as unknown as { write: (chunk: unknown, ...rest: unknown[]) => boolean }).write = (
    chunk: unknown,
    ...rest: unknown[]
  ): boolean => {
    staleErr.push(String(chunk));
    return (realWrite as unknown as (c: unknown, ...r: unknown[]) => boolean)(chunk, ...rest);
  };
  const staleLoop = staleAgent.start(100).catch(() => {});
  await sleep(900);
  (process.stderr as unknown as { write: unknown }).write = realWrite;
  const staleLog = staleErr.join("");
  check(
    "the retry line names the network rather than claiming the transport is fine",
    staleLog.includes("mesh unreachable") && !staleLog.includes("the transport is fine and the fault is not the network"),
    { tail: staleLog.slice(-400) },
  );

  // The same defect wearing a smaller hat: the duration is computed from Date.now(), so a record kept
  // past stop() does not merely go stale, it keeps COUNTING UP for as long as the dead object is held.
  await staleAgent.stop();
  await staleLoop;
  check(
    "a stopped session reports no presence-refusal record",
    staleEp.presenceWriteFailure() === undefined,
    { record: staleEp.presenceWriteFailure() },
  );

  // #1356 COMPOSED WITH #1421: A PUT THAT SETTLES AFTER TEARDOWN MUST NOT RE-PLANT THE RECORD.
  //
  // The cells above tear down while nothing is in flight, so they prove the SEQUENTIAL case only. A
  // reviewer measured the gap: #1421's rebind reaches publishPresence through onPresenceBucketEmpty
  // and no teardown awaits that flight, so the put can settle after clearPresenceWriteFailure() has
  // run and write its refusal onto a stopped endpoint or a freshly bound connection. The catch writes
  // ENDPOINT fields, not kv fields, so binding a new kv is not protection.
  //
  // The stimulus is a put held OPEN and settled by this suite, because the defect is entirely about
  // WHEN the rejection lands. A put that rejects immediately cannot reach it, which is why the four
  // cells above pass against the unfenced source.
  inflightAgent = new MeshAgent({ ...cfg, name: `transport-live-inflight-${port}` });
  await inflightAgent.start(100);
  await until(() => inflightAgent!.connected, 30_000);
  const inflightEp = inflightAgent.ep as unknown as {
    kv?: unknown;
    publishPresence(): Promise<void>;
    presenceWriteFailure(): { forMs: number; bucket: string } | undefined;
    reconnect(): Promise<void>;
  };

  let settleAfterStop: ((e: Error) => void) | undefined;
  const liveInflightKv = inflightEp.kv;
  inflightEp.kv = { put: () => new Promise<void>((_resolve, reject) => (settleAfterStop = reject)) };
  const heldAcrossStop = inflightEp.publishPresence().catch(() => {});
  await until(() => settleAfterStop !== undefined, 10_000);
  // Restore the real kv BEFORE tearing down. stop() makes a best-effort offline publishPresence of its
  // own, and leaving the never-settling stub in place deadlocks the teardown this cell is measuring
  // rather than exercising it. The held put above is already captured and settles independently.
  inflightEp.kv = liveInflightKv;
  await inflightAgent.stop();
  settleAfterStop?.(new Error("timeout"));
  await heldAcrossStop;
  check(
    "a presence put that settles AFTER stop() does not resurrect the record on the stopped endpoint",
    inflightEp.presenceWriteFailure() === undefined,
    { record: inflightEp.presenceWriteFailure() },
  );

  // The production-shaped arm. Heartbeat is 2s by default and a JetStream put timeout is ~5s, so a
  // rebuild finishes inside the window routinely. Here the rebuild binds a HEALTHY connection and the
  // old-epoch put then rejects: the record must stay clear, because this connection has published
  // nothing that failed.
  inflightAgent = new MeshAgent({ ...cfg, name: `transport-live-inflight2-${port}` });
  await inflightAgent.start(100);
  await until(() => inflightAgent!.connected, 30_000);
  const rebindEp = inflightAgent.ep as unknown as {
    kv?: unknown;
    publishPresence(): Promise<void>;
    presenceWriteFailure(): { forMs: number; bucket: string } | undefined;
    reconnect(): Promise<void>;
  };
  let settleAfterRebuild: ((e: Error) => void) | undefined;
  const liveRebindKv = rebindEp.kv;
  rebindEp.kv = { put: () => new Promise<void>((_resolve, reject) => (settleAfterRebuild = reject)) };
  const heldAcrossRebuild = rebindEp.publishPresence().catch(() => {});
  await until(() => settleAfterRebuild !== undefined, 10_000);
  rebindEp.kv = liveRebindKv;
  await rebindEp.reconnect();
  const boundAfterRebuild = inflightAgent.connected;
  settleAfterRebuild?.(new Error("timeout"));
  await heldAcrossRebuild;
  check(
    "a presence put from a RETIRED epoch does not plant a refusal on the connection that replaced it",
    boundAfterRebuild && rebindEp.presenceWriteFailure() === undefined,
    { boundAfterRebuild, record: rebindEp.presenceWriteFailure() },
  );

  // #1461: TWO PUTS ON ONE EPOCH, SETTLED IN REVERSE ORDER. The fence above orders epochs, not
  // puts: both puts below run against one live connection, so it cannot speak. Heartbeats (2s)
  // against a ~5s JetStream put timeout make the overlap routine. The stimulus again holds the
  // kv.put promises open and settles them, because the defect is entirely about WHICH settle lands
  // last: put A (held open) starts first, put B rejects and plants the record, then A — the OLDER
  // put — succeeds. A success is the latest evidence only when its put is the newest one in
  // flight, so A's success must not clear B's refusal. Put C then starts AFTER the refusal and
  // succeeds: that success is newer evidence and must still clear it.
  //
  // The agent gets its OWN variable: reusing inflightAgent would orphan inflight2 (its stop lives
  // only in the finally, which would then stop the wrong agent) and an unstopped endpoint's
  // reestablish loop outlives the suite — the process never exits.
  overlapAgent = new MeshAgent({ ...cfg, name: `transport-live-inflight3-${port}` });
  await overlapAgent.start(100);
  await until(() => overlapAgent!.connected, 30_000);
  const overlapEp = overlapAgent.ep as unknown as {
    kv?: unknown;
    publishPresence(): Promise<void>;
    presenceWriteFailure(): { since?: number; error?: string } | undefined;
  };
  const heldSameEpoch: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
  const liveOverlapKv = overlapEp.kv;
  // Every put the stub sees lands in heldSameEpoch, the cell's own calls and the heartbeat's
  // alike, so nothing is ever silently swallowed. That makes raw indices unusable — a heartbeat
  // tick can land a put between any two awaits — so the cell takes puts from the FRONT of the
  // queue one at a time and settles each before starting the next leg, and a heartbeat put simply
  // plays the role the leg was about to cast anyway: any extra put settled with the same script
  // leaves every assertion below on the same observations.
  overlapEp.kv = { put: () => new Promise<void>((resolve, reject) => heldSameEpoch.push({ resolve, reject })) };
  const takePut = async (): Promise<{ resolve: () => void; reject: (e: Error) => void }> => {
    await until(() => heldSameEpoch.length > 0, 10_000);
    return heldSameEpoch.shift()!;
  };
  // Put A is held open across put B's rejection.
  const putAPromise = overlapEp.publishPresence().catch(() => {});
  const putA = await takePut();
  const putBPromise = overlapEp.publishPresence().catch(() => {});
  const putB = await takePut();
  putB.reject(new Error("bucket refuses writes"));
  await putBPromise;
  const refusal = overlapEp.presenceWriteFailure();
  putA.resolve();
  await putAPromise;
  const afterOlderSuccess = overlapEp.presenceWriteFailure();
  // The C leg runs while the stub is STILL INSTALLED, so the only puts in flight are the ones this
  // cell started and settles itself. Restoring the real kv first would let a heartbeat-era put
  // resolve, and its condition-repair path would then re-issue into the real kv unparked — a put
  // the cell no longer controls. After the C leg the cell drains every held put and only then
  // restores the real kv, so stop()'s best-effort offline publish never touches the stub (the
  // shipped cell's note) and no promise is left parked inside a stopped endpoint.
  const putCPromise = overlapEp.publishPresence().catch(() => {});
  const putC = await takePut();
  putC.resolve();
  await putCPromise;
  const afterNewerSuccess = overlapEp.presenceWriteFailure();
  check(
    "an OLDER put succeeding late does not clear a newer same-epoch refusal record",
    refusal !== undefined && afterOlderSuccess !== undefined && afterOlderSuccess.error === "bucket refuses writes",
    { refusal, afterOlderSuccess, afterNewerSuccess },
  );
  check(
    "a success whose put started AFTER the refusal still clears it",
    afterNewerSuccess === undefined,
    { afterNewerSuccess },
  );
  // Drain every held put (the cell's own leftovers and any heartbeat tick the stub captured), then
  // restore the real kv BEFORE teardown: stop() makes a best-effort offline publishPresence of its
  // own, and leaving the never-settling stub in place deadlocks it.
  for (const held of heldSameEpoch.splice(0)) held.resolve();
  overlapEp.kv = liveOverlapKv;

  // #1461 PANEL ROUND 1, Blocker 1 (catch arm): put A starts first, put B starts, put A — the OLDER
  // put — rejects. A put that is merely in flight is not evidence yet, so a settle is superseded
  // only when a put that started after it has ALREADY SETTLED. B has not settled at all, so A's
  // rejection is the latest evidence and the refusal must be recorded. At the fence that compared
  // against the newest put STARTED, A's rejection was dropped and the bucket refused a write with
  // presenceWriteFailure() undefined.
  blockerAgent = new MeshAgent({ ...cfg, name: `transport-live-blocker1-${port}` });
  await blockerAgent.start(100);
  await until(() => blockerAgent!.connected, 30_000);
  const b1Ep = blockerAgent.ep as unknown as {
    kv?: unknown;
    publishPresence(): Promise<void>;
    presenceWriteFailure(): { error?: string } | undefined;
  };
  const heldB1: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
  const liveB1Kv = b1Ep.kv;
  b1Ep.kv = { put: () => new Promise<void>((resolve, reject) => heldB1.push({ resolve, reject })) };
  const takeB1 = async () => { await until(() => heldB1.length > 0, 10_000); return heldB1.shift()!; };
  const b1A = b1Ep.publishPresence().catch(() => {});
  const b1PutA = await takeB1();
  const b1B = b1Ep.publishPresence().catch(() => {});
  const b1PutB = await takeB1();
  b1PutA.reject(new Error("bucket refuses writes"));
  await b1A;
  const b1AfterOlderRejection = b1Ep.presenceWriteFailure();
  check(
    "an OLDER put rejecting while a NEWER put is merely in flight still records the refusal",
    b1AfterOlderRejection !== undefined && b1AfterOlderRejection.error === "bucket refuses writes",
    { b1AfterOlderRejection },
  );
  for (const held of heldB1.splice(0)) held.resolve();
  b1Ep.kv = liveB1Kv;

  // #1461 PANEL ROUND 1, Blocker 2 (success arm): a refusal is recorded, put A starts after it,
  // put B starts, put A — the OLDER put — succeeds. B has not settled, so A's success is the latest
  // evidence and must clear the refusal. At the fence that compared against the newest put STARTED,
  // A's success was marked superseded and the record stayed planted after the bucket had accepted a
  // write.
  blocker2Agent = new MeshAgent({ ...cfg, name: `transport-live-blocker2-${port}` });
  await blocker2Agent.start(100);
  await until(() => blocker2Agent!.connected, 30_000);
  const b2Ep = blocker2Agent.ep as unknown as {
    kv?: unknown;
    publishPresence(): Promise<void>;
    presenceWriteFailure(): { error?: string } | undefined;
  };
  const heldB2: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
  const liveB2Kv = b2Ep.kv;
  b2Ep.kv = { put: () => new Promise<void>((resolve, reject) => heldB2.push({ resolve, reject })) };
  const takeB2 = async () => { await until(() => heldB2.length > 0, 10_000); return heldB2.shift()!; };
  const b2Seed = b2Ep.publishPresence().catch(() => {});
  const b2SeedPut = await takeB2();
  b2SeedPut.reject(new Error("bucket refuses writes"));
  await b2Seed;
  const b2Refusal = b2Ep.presenceWriteFailure();
  const b2A = b2Ep.publishPresence().catch(() => {});
  const b2PutA = await takeB2();
  const b2B = b2Ep.publishPresence().catch(() => {});
  const b2PutB = await takeB2();
  b2PutA.resolve();
  await b2A;
  const b2AfterOlderSuccess = b2Ep.presenceWriteFailure();
  for (const held of heldB2.splice(0)) held.resolve();
  b2Ep.kv = liveB2Kv;
  check(
    "an OLDER put succeeding while a NEWER put is merely in flight still clears the refusal",
    b2Refusal !== undefined && b2Refusal.error === "bucket refuses writes" && b2AfterOlderSuccess === undefined,
    { b2Refusal, b2AfterOlderSuccess },
  );

  // #636 / #2055: PRESENCE WRITES FROM ONE AGENT LAND IN CALL ORDER. The cells above drive
  // endpoint.publishPresence directly, which says nothing about MeshAgent: setStatus is two or
  // three awaited puts (an entering-working condition clear, then setActivity, then setStatus)
  // and every connector fires it without awaiting, so two overlapping calls interleave their puts
  // and the record that lands last is whichever call's last put finished last — measured at a
  // driven turn's end as working, idle, working (#2055). The stimulus is the same held-put kv
  // stub the cells above use, because the defect is entirely about WHEN a later call's puts may
  // START: with the serialization gone, the second call's first put is already in the queue while
  // the first call's is still held. The heartbeat also lands puts in this stub (it publishes
  // straight from the endpoint, 2s cadence), and an entering-working clear adds one more, so each
  // leg QUIETS the stub first — settle every put until none arrives for 300ms — and then settles
  // puts ONE AT A TIME as the leg's own calls issue them; a heartbeat put landing mid-leg plays
  // the same role the next settle was about to play and changes no observation below.
  orderingAgent = new MeshAgent({ ...cfg, name: `transport-live-ordering-${port}` });
  await orderingAgent.start(100);
  await until(() => orderingAgent!.connected, 30_000);
  const orderingEp = orderingAgent.ep as unknown as { kv?: unknown; status?: string };
  const heldOrdering: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
  const liveOrderingKv = orderingEp.kv;
  orderingEp.kv = { put: () => new Promise<void>((resolve, reject) => heldOrdering.push({ resolve, reject })) };
  const takeOrdering = async () => { await until(() => heldOrdering.length > 0, 10_000); return heldOrdering.shift()!; };
  // Settle every put that arrives until none has arrived for 300ms, polling the array directly.
  // A racing takeOrdering() call left running past its own 300ms loss would keep polling in the
  // background and could steal a put a later, explicit takeOrdering() is waiting for, discarding
  // its resolver and stalling the agent's presence chain forever — so this never calls takeOrdering.
  const quietOrdering = async (): Promise<void> => {
    let quietMs = 0;
    while (quietMs < 300) {
      const put = heldOrdering.shift();
      if (put) { put.resolve(); quietMs = 0; continue; }
      await sleep(20);
      quietMs += 20;
    }
  };
  // Settle whatever arrives in heldOrdering, in whatever order, until `done` flips true (set by a
  // `.then()` on the real call(s) under test) or the bound elapses. Never calls takeOrdering, so
  // nothing is left polling in the background after this returns — the same hazard quietOrdering
  // above avoids, and for the same reason: an orphaned poller can steal a later put out from under
  // an explicit takeOrdering() and stall the agent's presence chain forever.
  const drainUntil = async (done: { v: boolean }, timeoutMs = 5_000): Promise<void> => {
    const end = Date.now() + timeoutMs;
    while (!done.v && Date.now() < end) {
      const put = heldOrdering.shift();
      if (put) { put.resolve(); continue; }
      await sleep(20);
    }
  };

  // Cell (a): setStatus("working", "") and setStatus("idle"), neither awaited by the caller. The
  // working call's LAST put is held open; while it is held the idle call must not have started
  // ANY put. Then everything settles and the endpoint's recorded status ends idle.
  await quietOrdering();
  const orderA = orderingAgent!.setStatus("working", "").catch(() => {});
  const clearPut = await takeOrdering(); // entering working clears the condition first
  clearPut.resolve();
  const activityPut = await takeOrdering(); // setActivity("")
  activityPut.resolve();
  const statusPut = await takeOrdering(); // setStatus("working") — HELD
  const orderB = orderingAgent!.setStatus("idle").catch(() => {});
  // Give an unserialized idle write every chance to land its put while the working call's last
  // put is still held: this is the window the fix must keep empty.
  await sleep(150);
  const idleStartedWhileHeld = heldOrdering.length > 0;
  statusPut.resolve();
  // Drain whatever remains (the idle call's own put, wherever it lands) until both calls settle;
  // never assume a specific put belongs to a specific call, only that both calls need one more.
  const orderingDone = { v: false };
  void Promise.all([orderA, orderB]).then(() => { orderingDone.v = true; });
  await drainUntil(orderingDone);
  check(
    "two overlapping status writes land in call order: the later call's puts start only after the earlier call's have settled",
    !idleStartedWhileHeld && orderingAgent!.status === "idle" && orderingEp.status === "idle",
    { idleStartedWhileHeld, agentStatus: orderingAgent!.status, epStatus: orderingEp.status },
  );

  // Cell (b): a status write's put is held open when stop() is called. Departure is ordered
  // behind writes already in flight (#636): the offline put must not start until the held put
  // settles. The kv stub stays installed so ep.stop()'s offline publish parks in it too; after
  // the held put settles the offline put arrives, is settled, and only then does stop() return.
  await quietOrdering();
  const orderC = orderingAgent!.setStatus("waiting", "ordered departure").catch(() => {});
  const heldPut = await takeOrdering(); // setActivity("ordered departure") — held
  const stopPromise = orderingAgent!.stop().catch(() => {});
  // Give stop()'s offline publish every chance to start while the write already in flight is
  // still held: this is the window the fix must keep empty.
  await sleep(150);
  const offlineStartedWhileHeld = heldOrdering.length > 0;
  heldPut.resolve();
  // Two more puts are owed after this (orderC's own second put, and the offline publish), in
  // whichever order the tree under test produces — a defect-under-test can legitimately deliver
  // them in either order, so drain until both calls have settled rather than assuming which put
  // is which.
  const departureDone = { v: false };
  void Promise.all([orderC, stopPromise]).then(() => { departureDone.v = true; });
  await drainUntil(departureDone);
  check(
    "departure is ordered behind a status write already in flight",
    !offlineStartedWhileHeld && orderingEp.status === "offline",
    { offlineStartedWhileHeld, epStatus: orderingEp.status },
  );
  orderingEp.kv = liveOrderingKv;

  // Cell (c): a rejected presence write must not stall the next one. The first call's put
  // rejects; the chain swallows the rejection at its tail only, so the second call's put still
  // arrives and settles, and the endpoint records the second call's status.
  orderingAgent = new MeshAgent({ ...cfg, name: `transport-live-ordering2-${port}` });
  await orderingAgent.start(100);
  await until(() => orderingAgent!.connected, 30_000);
  const rejectEp = orderingAgent.ep as unknown as { kv?: unknown; status?: string };
  const heldReject: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
  const liveRejectKv = rejectEp.kv;
  rejectEp.kv = { put: () => new Promise<void>((resolve, reject) => heldReject.push({ resolve, reject })) };
  const takeReject = async () => { await until(() => heldReject.length > 0, 10_000); return heldReject.shift()!; };
  const rejA = orderingAgent!.setStatus("waiting").catch(() => {});
  const rejAPut = await takeReject();
  rejAPut.reject(new Error("bucket refuses writes"));
  await rejA;
  const rejB = orderingAgent!.setStatus("idle").catch(() => {});
  const rejBPut = await Promise.race([takeReject(), sleep(2_000).then(() => undefined)]);
  const secondPutArrived = rejBPut !== undefined;
  rejBPut?.resolve();
  await rejB.catch(() => {});
  for (const held of heldReject.splice(0)) held.resolve();
  rejectEp.kv = liveRejectKv;
  check(
    "a rejected presence write does not stall the next one",
    secondPutArrived && rejectEp.status === "idle",
    { secondPutArrived, epStatus: rejectEp.status },
  );
} finally {
  await orderingAgent?.stop().catch(() => {});
  await blocker2Agent?.stop().catch(() => {});
  await blockerAgent?.stop().catch(() => {});
  await overlapAgent?.stop().catch(() => {});
  await inflightAgent?.stop().catch(() => {});
  await staleAgent?.stop().catch(() => {});
  await rebuildAgent?.stop().catch(() => {});
  await agent.stop().catch(() => {});
  broker.kill("SIGKILL");
  await awaitExit(broker);
  rmSync(dir, { recursive: true, force: true });
  for (const release of releases) release();
}

const EXPECTED_CELLS = 26;
const ran = pass + fail;
console.log(`\n${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed`);
console.log(`SUITE COMPLETE: ${ran} cells`);
if (ran !== EXPECTED_CELLS) {
  console.log(`SUITE INCOMPLETE: ran ${ran} of ${EXPECTED_CELLS} cells; a partial run is not a pass`);
  process.exitCode = 1;
} else process.exitCode = fail === 0 ? 0 : 1;
