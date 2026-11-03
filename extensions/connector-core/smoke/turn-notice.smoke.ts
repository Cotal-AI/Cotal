/**
 * Run turns reach an idle seat by notice, not by poll (SPEC 14.3), on an AUTH mesh.
 *
 * A real JWT broker, the real Manager, the delivery daemon's timer writer, and two real MeshAgent
 * seats the manager spawns, each authenticated with the credential the manager minted for it. The
 * seats reach the broker through a loopback hop the suite can cut, so a turn accepted while a
 * seat is offline is a notice the seat really missed. The suite counts the seats' `turn-pending`
 * pulls at the manager it runs.
 *
 *   1. Idle seats pull nothing and open no connection.
 *   2. An accepted turn surfaces within 2 s, at the addressed seat only.
 *   3. Queued turns surface one at a time as each yield settles, with no wait.
 *   4. A turn its deadline ends leaves the seat it was shown to.
 *   5. A turn accepted while the seat is offline surfaces after it reconnects.
 *   6. The broker keeps each seat to its own notices: another seat may neither read nor forge them.
 *
 * Throughout, each seat's own credential also counts its notices on the broker: they repeat only
 * while a turn waits unpulled, stop once it is pulled or ends, and never reach the other seat.
 *
 * Run: pnpm smoke:turn-notice   (needs nats-server on PATH)
 */
import { spawn as spawnProcess, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { connect as netConnect, createServer as createNetServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { connect } from "@nats-io/transport-node";
import {
  createSpaceAuth, mintCreds, newIdentity, mintLifecycleUid, standaloneConnectOpts, setupSpaceStreams,
  DEV_OWNER, epCall, readGoalResult, registry, turnNoticeFilter, turnNoticeSubject,
  type Connector, type EpCaller, type IssuedCaller, type LaunchOpts, type LaunchSpec,
} from "@cotal-ai/core";
import { authDir, saveSpaceAuth, agentLifecycleSecretFilePaths, workspaceSecretStore } from "../../../packages/workspace/src/index.js";
import { teardownOnSignal } from "@cotal-ai/smoke-kit";
import { Manager } from "@cotal-ai/manager";
import { MANAGER_ENDPOINT, MANAGER_CONTRACTS } from "../../../implementations/manager/src/manager-service-contract.js";
import { bootBroker } from "../../../implementations/manager/smoke/_boot-broker.js";
import { bootDeliveryDaemon } from "../../../implementations/manager/smoke/_boot-delivery.js";
import { hostTimerWriter, type HostedTimerWriter } from "../../../implementations/manager/smoke/_timer-writer.js";
import { pickFreePort } from "./_free-port.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown): void => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra === undefined ? "" : JSON.stringify(extra)); }
};
const asValue = (e: unknown) => ({ code: (e as { code?: string }).code, message: String((e as Error).message).slice(0, 240) });

const space = `turnnotice-${mintLifecycleUid().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const broker = await bootBroker(auth, { monitor: true });
const brokerPort = Number(new URL(broker.servers).port);
const workspaceRoot = mkdtempSync(join(tmpdir(), "cotal-turn-notice-ws-"));
mkdirSync(join(workspaceRoot, ".cotal", "agents"), { recursive: true });
saveSpaceAuth(authDir(workspaceRoot), auth);
for (const n of ["seata", "seatb"]) writeFileSync(join(workspaceRoot, ".cotal", "agents", `${n}.md`), `---\nname: ${n}\nrole: worker\n---\n`);

// The seats' hop to the broker. `cut` drops every seat connection and refuses new ones until
// `restore`, so the seats are offline while the manager stays connected.
let hopOpen = true;
let hopAccepts = 0;
const hopSockets = new Set<Socket>();
const hop = createNetServer((client) => {
  if (!hopOpen) { client.destroy(); return; }
  hopAccepts++;
  hopSockets.add(client);
  const up = netConnect(brokerPort, "127.0.0.1");
  hopSockets.add(up);
  for (const [a, b] of [[client, up], [up, client]] as const) {
    a.on("error", () => b.destroy());
    a.on("close", () => { hopSockets.delete(a); b.destroy(); });
  }
  client.pipe(up);
  up.pipe(client);
});
const hopPort = await pickFreePort();
await new Promise<void>((r) => hop.listen(hopPort, "127.0.0.1", r));
const cutHop = () => { hopOpen = false; for (const s of hopSockets) s.destroy(); };
const restoreHop = () => { hopOpen = true; };

// Each seat is the real MeshAgent from this package's build, configured from the launch env.
const seatScript = join(workspaceRoot, "seat.mjs");
writeFileSync(seatScript, [
  "const { MeshAgent } = await import(process.env.SEAT_AGENT_URL);",
  "const { configFromEnv } = await import(process.env.SEAT_CONFIG_URL);",
  "const agent = new MeshAgent(configFromEnv(process.env), process.env);",
  "const out = (o) => process.stdout.write(JSON.stringify({ ...o, at: Date.now() }) + '\\n');",
  "process.on('SIGTERM', () => { agent.stop().finally(() => process.exit(0)); });",
  "await agent.start();",
  "await agent.whenConnected();",
  "out({ armed: true });",
  "const held = new Set();",
  // The host's side of the relay, as an adapter runs it: peek, inject, commit, then yield.
  "setInterval(() => {",
  "  for (const id of held) if (!agent.activeTurns.has(id)) { held.delete(id); out({ gone: id }); }",
  "  const p = agent.peekPendingTurns();",
  "  if (!p) return;",
  "  agent.commitSurfacedTurns(p.goalIds);",
  "  for (const id of p.goalIds) {",
  "    out({ surfaced: id, hold: p.text.includes('HOLD') });",
  "    if (p.text.includes('HOLD')) { held.add(id); continue; }",
  "    agent.yieldTurn('done', { turn: id, note: 'ok' }).then((r) => out({ yielded: id, ok: r.ok, error: r.error }));",
  "  }",
  "}, 20);",
].join("\n"));

type SeatEvent = { at: number; armed?: boolean; surfaced?: string; hold?: boolean; yielded?: string; ok?: boolean; gone?: string };
const events = new Map<string, SeatEvent[]>();
const procs: ChildProcess[] = [];
const seatCon: Connector = {
  kind: "connector", name: "turn-seat", requires: ["node"],
  buildLaunch: (o: LaunchOpts): LaunchSpec => ({
    command: process.execPath, args: [seatScript],
    env: {
      PATH: process.env.PATH ?? "", HOME: workspaceRoot,
      SEAT_AGENT_URL: pathToFileURL(join(repoRoot, "extensions/connector-core/dist/agent.js")).href,
      SEAT_CONFIG_URL: pathToFileURL(join(repoRoot, "extensions/connector-core/dist/config.js")).href,
      COTAL_SPACE: o.space, COTAL_SERVERS: `nats://127.0.0.1:${hopPort}`, COTAL_CREDS: String(o.creds),
      COTAL_ID: String(o.id), COTAL_NAME: o.name, COTAL_LIFECYCLE_UID: String(o.lifecycleUid),
      ...(o.acceptedToken ? { COTAL_ACCEPTED_TOKEN: o.acceptedToken } : {}),
    },
  }),
};
registry.register(seatCon);
// The pty runtime would own a terminal; these seats only need stdout, so a pipe runtime spawns them.
registry.register({
  kind: "runtime", name: "pipe", available: () => true,
  create: () => ({
    kind: "pipe",
    spawn(name: string, spec: LaunchSpec, cwd: string) {
      const child = spawnProcess(spec.command, spec.args, { cwd, env: spec.env, stdio: ["ignore", "pipe", "pipe"] });
      procs.push(child);
      teardownOnSignal(child);
      const list: SeatEvent[] = [];
      events.set(name, list);
      let buf = "";
      child.stdout!.on("data", (d: Buffer) => {
        buf += d.toString();
        for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          try { list.push(JSON.parse(line) as SeatEvent); } catch { /* connector log line */ }
        }
      });
      child.stderr!.on("data", (d: Buffer) => { if (/run-turn|turn notice/.test(d.toString())) process.stdout.write(`    [${name}] ${d}`); });
      let exited = false;
      const closed = new Promise<void>((r) => child.once("close", () => { exited = true; r(); }));
      return {
        kind: "pipe", name, get pid() { return child.pid; },
        status: () => (exited ? "exited" : "running"),
        stop: () => { if (!exited) child.kill("SIGTERM"); },
        interrupt: () => { if (!exited) child.kill("SIGINT"); },
        waitForExit: () => closed,
        exitInfo: () => (exited ? { code: child.exitCode ?? 0 } : undefined),
        attach: () => ({ cols: 80, rows: 24, backlog: () => Buffer.alloc(0), onData: () => () => {}, onExit: () => () => {}, write: () => Promise.resolve(0), resize: () => {} }),
      };
    },
  }),
} as never);

const until = async (pred: () => boolean, ms: number): Promise<boolean> => {
  const end = Date.now() + ms;
  while (!pred()) { if (Date.now() >= end) return false; await wait(10); }
  return true;
};
const eventOf = (seat: string, key: keyof SeatEvent, goalId?: string) =>
  (events.get(seat) ?? []).find((e) => e[key] !== undefined && (goalId === undefined || e[key] === goalId));

let manager: Manager | undefined;
let delivery: Awaited<ReturnType<typeof bootDeliveryDaemon>> | undefined;
let writer: HostedTimerWriter | undefined;
let writerNc: Awaited<ReturnType<typeof connect>> | undefined;
let runnerNc: Awaited<ReturnType<typeof connect>> | undefined;
const probes: Awaited<ReturnType<typeof connect>>[] = [];

try {
  await setupSpaceStreams({ servers: broker.servers, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  delivery = await bootDeliveryDaemon({ space, servers: broker.servers, auth, reloadStoreIdentity: workspaceSecretStore(workspaceRoot).identity });
  writerNc = await connect({ servers: broker.servers, ...standaloneConnectOpts({ creds: await mintCreds(auth, newIdentity(), "delivery"), tls: false }), maxReconnectAttempts: 0 });
  writer = await hostTimerWriter(writerNc, space, { pollMs: 1_000 });
  manager = new Manager({ space, servers: broker.servers, runtime: "pipe", workspaceRoot });
  await manager.start();
  const M = manager as unknown as {
    managerInstanceId: string;
    agents: Map<string, { id: string; lifecycleUid: string; issued?: { generation: string; acceptedToken: string } }>;
    turnPendingFor(c: { owner: string; actor: string; uid: string }): unknown;
  };
  // Count the seats' pulls where they land: the manager's own turn-pending answer.
  const pulls = new Map<string, number>();
  const turnPendingFor = M.turnPendingFor.bind(M);
  M.turnPendingFor = (c) => { pulls.set(c.actor, (pulls.get(c.actor) ?? 0) + 1); return turnPendingFor(c); };

  const runnerId = newIdentity();
  const runner: EpCaller = { owner: DEV_OWNER, actor: runnerId.id, uid: mintLifecycleUid() };
  runnerNc = await connect({
    servers: broker.servers,
    ...standaloneConnectOpts({ creds: await mintCreds(auth, runnerId, "control-caller-admin", { lifecycleUid: runner.uid }), tls: false }),
    maxReconnectAttempts: 0,
  });
  const call = (command: string, args: Record<string, unknown> | undefined, opts: { id?: string; target?: { actor: string; lifecycleUid: string } } = {}) =>
    epCall(runnerNc!, space, { mode: "one" }, {
      endpoint: MANAGER_ENDPOINT, command, contract: MANAGER_CONTRACTS[command], caller: runner,
      ...(opts.id !== undefined ? { id: opts.id } : {}),
      ...(args !== undefined ? { args } : {}),
      ...(opts.target ? { target: { mode: "owner" as const, owner: DEV_OWNER, actor: opts.target.actor, lifecycleUid: opts.target.lifecycleUid } } : {}),
    }, { deadlineMs: 15_000, currentEpoch: async () => 0 }).then((r) => r.reply, asValue);
  const actx = (manager as unknown as { goalWriter: { ctx: Parameters<typeof readGoalResult>[0] } }).goalWriter.ctx;
  const resultOf = async (goalId: string, ms: number) => {
    const end = Date.now() + ms;
    for (;;) {
      const fact = await readGoalResult(actx, { endpoint: MANAGER_ENDPOINT, caller: runner, goalId });
      if (fact !== undefined || Date.now() >= end) return fact;
      await wait(250);
    }
  };

  console.log("0. the manager spawns two seats; each is a real MeshAgent on its minted credential");
  for (const name of ["seata", "seatb"]) {
    const goal = `spawn-${name}`.padEnd(43, "s");
    const r = await call("spawn", { name, agent: "turn-seat", cwd: repoRoot, events: false }, { id: goal });
    const fact = await resultOf(goal, 60_000);
    if ((r as { ok?: boolean }).ok !== true || fact?.state !== "succeeded") console.log(`    spawn ${name}: ${JSON.stringify({ r, fact }).slice(0, 600)}`);
  }
  const armed = await until(() => eventOf("seata", "armed") !== undefined && eventOf("seatb", "armed") !== undefined, 30_000);
  check("both seats started and armed their turn relay", armed, Object.fromEntries(events));
  const seatA = M.agents.get("seata")!, seatB = M.agents.get("seatb")!;
  // Each seat's notices as its own credential reads them, straight off the broker, so a notice the
  // hop dropped is still counted.
  const seatCreds = (name: string, uid: string) => readFileSync(agentLifecycleSecretFilePaths(workspaceRoot, space, name, uid).creds, "utf8");
  const railOf = (s: typeof seatA): EpCaller => ({ owner: DEV_OWNER, actor: s.id, uid: s.lifecycleUid, ...(s.issued ? { generation: s.issued.generation } : {}) }) as IssuedCaller;
  const noticesSeen = { a: 0, b: 0 };
  for (const [key, name, seat] of [["a", "seata", seatA], ["b", "seatb", seatB]] as const) {
    const nc = await connect({ servers: broker.servers, ...standaloneConnectOpts({ creds: seatCreds(name, seat.lifecycleUid), tls: false }), maxReconnectAttempts: 0 });
    probes.push(nc);
    nc.subscribe(turnNoticeFilter(space, M.managerInstanceId, railOf(seat)), { callback: () => { noticesSeen[key]++; } });
    await nc.flush();
  }
  const turn = (goalId: string, seat: typeof seatA, context: string, deadlineMs = 120_000) => call("turn",
    { payload: JSON.stringify({ run: "r1", step: `turn:${goalId}`, context }), deadlineMs },
    { id: goalId, target: { actor: seat.id, lifecycleUid: seat.lifecycleUid } });

  console.log("\n1. idle seats pull nothing and open no connection");
  // The first pull follows the bind asynchronously; the window opens once both have landed.
  await until(() => (pulls.get(seatA.id) ?? 0) >= 1 && (pulls.get(seatB.id) ?? 0) >= 1, 20_000);
  await wait(1_000);
  const varz = async () => ((await (await fetch(`${broker.monitorUrl}/varz`)).json()) as { total_connections: number }).total_connections;
  const idle0 = { a: pulls.get(seatA.id) ?? 0, b: pulls.get(seatB.id) ?? 0, hop: hopAccepts, broker: await varz() };
  await wait(20_000);
  const idle1 = { a: pulls.get(seatA.id) ?? 0, b: pulls.get(seatB.id) ?? 0, hop: hopAccepts, broker: await varz() };
  console.log(`    after arming ${JSON.stringify(idle0)}, after 20 s idle ${JSON.stringify(idle1)}`);
  check("each seat pulled once when it armed", idle0.a === 1 && idle0.b === 1, idle0);
  check("over 20 s idle neither seat pulled, and no connection was opened", idle1.a === idle0.a && idle1.b === idle0.b && idle1.hop === idle0.hop && idle1.broker === idle0.broker, { idle0, idle1 });

  console.log("\n2. an accepted turn surfaces within 2 s, at the addressed seat only");
  const g1 = "n1".padEnd(43, "a");
  const a1 = await turn(g1, seatA, "first");
  const accepted1 = Date.now();
  const shown1 = await until(() => eventOf("seata", "surfaced", g1) !== undefined, 2_000);
  const latency1 = (eventOf("seata", "surfaced", g1)?.at ?? Infinity) - accepted1;
  console.log(`    surfaced ${latency1} ms after the accept reply`);
  check("the turn is accepted and surfaces at seat A within 2 s", (a1 as { ok?: boolean }).ok === true && shown1 && latency1 <= 2_000, { a1, latency1 });
  const r1 = await resultOf(g1, 10_000);
  check("seat A's yield completes the goal", r1?.state === "succeeded" && (r1.data as { note?: string } | undefined)?.note === "ok", r1);
  check("seat B was shown nothing", eventOf("seatb", "surfaced") === undefined, events.get("seatb"));

  console.log("\n3. queued turns surface one at a time as each yield settles");
  const g2 = "n2".padEnd(43, "b"), g3 = "n3".padEnd(43, "c");
  const t0 = Date.now();
  const [a2, a3] = [await turn(g2, seatA, "second"), await turn(g3, seatA, "third")];
  const both = await until(() => eventOf("seata", "yielded", g3) !== undefined, 6_000);
  const s2 = eventOf("seata", "surfaced", g2), s3 = eventOf("seata", "surfaced", g3), y2 = eventOf("seata", "yielded", g2);
  console.log(`    second surfaced at +${(s2?.at ?? 0) - t0} ms, third at +${(s3?.at ?? 0) - t0} ms`);
  check("both queued turns were accepted, surfaced in order, and yielded within 6 s",
    (a2 as { ok?: boolean }).ok === true && (a3 as { ok?: boolean }).ok === true && both && s2 !== undefined && s3 !== undefined && y2 !== undefined && s2.at <= y2.at && y2.at <= s3.at,
    { a2, a3, s2, s3, y2 });

  console.log("\n4. a turn its deadline ends leaves the seat it was shown to");
  const g4 = "n4".padEnd(43, "d");
  await turn(g4, seatA, "HOLD past the deadline", 4_000);
  const shown4 = await until(() => eventOf("seata", "surfaced", g4) !== undefined, 2_000);
  const r4 = await resultOf(g4, 20_000);
  const deniedAt = Date.now();
  const gone4 = await until(() => eventOf("seata", "gone", g4) !== undefined, 3_000);
  console.log(`    dropped ${(eventOf("seata", "gone", g4)?.at ?? Infinity) - deniedAt} ms after the deadline terminal was read`);
  check("the held turn surfaced, the manager denied it at its deadline, and the seat dropped it",
    shown4 && r4?.state === "failed" && (r4.data as { reason?: string } | undefined)?.reason === "turn-deadline" && gone4, { r4 });
  const afterExpiry = noticesSeen.a;
  await wait(11_000);
  check("after the deadline's own notice, an expired turn is noticed no more", noticesSeen.a === afterExpiry, { afterExpiry, now: noticesSeen.a });

  console.log("\n5. a turn accepted while the seat is offline surfaces after it reconnects");
  const pullsBeforeCut = pulls.get(seatA.id) ?? 0;
  cutHop();
  await wait(300);
  const g5 = "n5".padEnd(43, "e");
  const a5 = await turn(g5, seatA, "while offline");
  const offlinePulls = pulls.get(seatA.id) ?? 0;
  const noticesAtAccept = noticesSeen.a;
  await wait(11_000);
  const missed = eventOf("seata", "surfaced", g5) === undefined;
  const repeated = noticesSeen.a - noticesAtAccept;
  console.log(`    ${repeated} notice(s) reached seat A's credential in 11 s offline`);
  check("while the turn waits unpulled the manager repeats its notice", repeated >= 2, { repeated });
  restoreHop();
  const restoredAt = Date.now();
  const caught = await until(() => eventOf("seata", "yielded", g5) !== undefined, 15_000);
  console.log(`    surfaced ${(eventOf("seata", "surfaced", g5)?.at ?? Infinity) - restoredAt} ms after the hop reopened`);
  check("the turn was accepted while seat A was offline and its notice reached nobody", (a5 as { ok?: boolean }).ok === true && missed && offlinePulls === pullsBeforeCut, { a5, missed, offlinePulls, pullsBeforeCut });
  check("after the reconnect seat A pulled, was shown the turn, and yielded it", caught && (pulls.get(seatA.id) ?? 0) > offlinePulls, { pulls: Object.fromEntries(pulls) });
  await wait(1_000);
  const afterYield = noticesSeen.a;
  await wait(11_000);
  check("once pulled and yielded, the turn is noticed no more", noticesSeen.a === afterYield, { afterYield, now: noticesSeen.a });
  check("seat B's own credential saw none of seat A's notices", noticesSeen.b === 0, noticesSeen);

  console.log("\n6. the broker keeps each seat to its own notices");
  const asB = await connect({ servers: broker.servers, ...standaloneConnectOpts({ creds: seatCreds("seatb", seatB.lifecycleUid), tls: false }), maxReconnectAttempts: 0 });
  probes.push(asB);
  const denials: string[] = [];
  void (async () => { for await (const s of asB.status()) if (s.type === "error") denials.push(String((s as { error?: Error }).error?.message ?? s.type)); })();
  const readA = asB.subscribe(turnNoticeFilter(space, M.managerInstanceId, railOf(seatA)));
  const readAClosed = readA.closed.then(() => "closed", (e: Error) => e.message);
  asB.publish(turnNoticeSubject(space, M.managerInstanceId, 1, railOf(seatA)), new TextEncoder().encode("{}"));
  await asB.flush().catch(() => {});
  await wait(500);
  const readOutcome = await Promise.race([readAClosed, wait(1_000).then(() => "still open")]);
  console.log(`    B reading A's notices: ${readOutcome}; broker said: ${denials.join(" | ").slice(0, 400)}`);
  check("seat B's credential is refused a subscription to seat A's notices", /permission/i.test(readOutcome) || denials.some((d) => /subscription/i.test(d)), { readOutcome, denials });
  check("seat B's credential is refused publishing a notice as seat A's manager", denials.some((d) => /publish/i.test(d)), denials);
} finally {
  for (const nc of probes) await nc.close().catch(() => {});
  await runnerNc?.drain().catch(() => runnerNc?.close());
  await manager?.stop({ withAgents: true }).catch(() => {});
  for (const p of procs) if (p.exitCode === null && p.signalCode === null) p.kill("SIGKILL");
  for (const s of hopSockets) s.destroy();
  await new Promise<void>((r) => hop.close(() => r()));
  await writer?.stop().catch(() => {});
  await writerNc?.drain().catch(() => writerNc?.close());
  await delivery?.stop().catch(() => {});
  await broker.stop().catch(() => {});
}

const EXPECTED_CELLS = 16;
console.log(`\n${fail === 0 && pass === EXPECTED_CELLS ? "TURN NOTICE SMOKE OK ✅" : "TURN NOTICE SMOKE FAILED"}  (${pass} passed, ${fail} failed)`);
if (pass + fail !== EXPECTED_CELLS) {
  console.log(`SUITE INCOMPLETE — ran ${pass + fail} of ${EXPECTED_CELLS} cells; a partial run is not a pass`);
  process.exit(1);
}
process.exit(fail === 0 ? 0 : 1);
