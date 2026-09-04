/**
 * The turn relay on an AUTH mesh: a real JWT broker, the real Manager registered on it, a real
 * spawned seat that joined presence under the credential the manager minted for it, and the real
 * delivery-hosted timer writer. Every other turn suite runs on an open mesh, where the broker
 * enforces nothing, and that is how three grant holes shipped under green suites:
 *
 *   1. The manager minted the turn's deadline hold over its GOAL-WRITER connection, which holds no
 *      timer row. On an auth mesh the `.schedule` publish was broker-denied, every `turn` accept
 *      unwound with a `failed` terminal, and no run could ever drive a seat.
 *   2. The seat pulled its turns with `turn-pending` under its own credential, whose baseline
 *      carried self-mode `stop` and nothing else. The publish was broker-dropped, the connector
 *      read the silence as "no manager in this space", and the relay was dead for every seat.
 *   3. No profile minted a `turn` request row, the run driver's own `control-caller-admin`
 *      included, so a run's every turn submit was dropped at the broker before the manager saw it.
 *
 * So this suite asks the broker, not the code: a run-shaped caller submits a turn through the
 * ep rail; the seat's OWN minted credential pulls and yields it; and a turn nobody yields is denied
 * at its deadline by the manager settling the hold it owns, with no fire read at all.
 *
 * Run: pnpm smoke:turn-relay-auth   (needs nats-server + node on PATH)
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "@nats-io/transport-node";
import {
  createSpaceAuth, mintCreds, newIdentity, mintLifecycleUid, standaloneConnectOpts, setupSpaceStreams,
  DEV_OWNER, epCall, invokeCommand, resolveService, readGoalResult, readGoalIndex, registry,
  startTimerWriter,
  type Connector, type EpCaller, type LaunchOpts, type LaunchSpec, type TimerWriterHandle,
} from "@cotal-ai/core";
import { authDir, saveSpaceAuth, agentLifecycleSecretFilePaths } from "@cotal-ai/workspace";
import { Manager } from "../src/manager.js";
import { MANAGER_ENDPOINT, MANAGER_CONTRACTS } from "../src/manager-service-contract.js";
import { bootBroker } from "./_boot-broker.js";
import { bootDeliveryDaemon } from "./_boot-delivery.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const STUB = join(here, "e2e-stub.mjs");

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown): void => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra === undefined ? "" : JSON.stringify(extra)); }
};
const asValue = (e: unknown) => ({ code: (e as { code?: string }).code, message: String((e as Error).message).slice(0, 240) });

const space = `turnauth-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const broker = await bootBroker(auth);
const workspaceRoot = mkdtempSync(join(tmpdir(), "cotal-turn-auth-ws-"));
mkdirSync(join(workspaceRoot, ".cotal", "agents"), { recursive: true });
saveSpaceAuth(authDir(workspaceRoot), auth);
writeFileSync(join(workspaceRoot, ".cotal", "agents", "seat.md"), "---\nname: seat\nrole: worker\n---\n");

// The real stub agent: joins presence under the credential the manager minted, exactly as a
// connector's plugin does. Its credential FILE is what the seat-side cells connect with below,
// so what they exercise is the grant a spawned seat really holds.
const envFor = (o: LaunchOpts): Record<string, string> => ({
  COTAL_SPACE: o.space, COTAL_SERVERS: String(o.servers ?? broker.servers), COTAL_CREDS: String(o.creds),
  COTAL_ID: String(o.id), COTAL_NAME: o.name, PATH: process.env.PATH ?? "",
  ...(o.lifecycleUid ? { COTAL_LIFECYCLE_UID: o.lifecycleUid } : {}),
});
const stubCon: Connector = { kind: "connector", name: "turn-stub", requires: ["node"], buildLaunch: (o): LaunchSpec => ({ command: "node", args: [STUB], env: envFor(o) }) };
registry.register(stubCon);

let manager: Manager | undefined;
let delivery: Awaited<ReturnType<typeof bootDeliveryDaemon>> | undefined;
let writer: TimerWriterHandle | undefined;
let writerNc: Awaited<ReturnType<typeof connect>> | undefined;
let runnerNc: Awaited<ReturnType<typeof connect>> | undefined;
let seatNc: Awaited<ReturnType<typeof connect>> | undefined;

try {
  await setupSpaceStreams({ servers: broker.servers, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  delivery = await bootDeliveryDaemon({ space, servers: broker.servers, auth });
  // The timer writer the delivery daemon hosts on a live mesh, under the delivery credential: the
  // deadline cell below waits on a pause armed through it, never through a suite pump.
  writerNc = await connect({ servers: broker.servers, ...standaloneConnectOpts({ creds: await mintCreds(auth, newIdentity(), "delivery"), tls: false }), maxReconnectAttempts: 0 });
  writer = await startTimerWriter(writerNc, space, { pollMs: 1_000 });

  manager = new Manager({ space, servers: broker.servers, runtime: "pty", workspaceRoot });
  await manager.start();
  const M = manager as unknown as { agents: Map<string, { id: string; lifecycleUid: string }> };

  // The run driver's OWN instrument: `cotal run` connects as `control-caller-admin`, spawns the
  // seat under it, and turns the seat on owner reach exactly as the runtime submits it (a static
  // mesh admits a named turn from the seat's spawner). No other profile carried a `turn` row at
  // all until the seat-write set gained it, so every run's turn was broker-dropped on an auth mesh.
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
    }, { deadlineMs: 15_000, currentEpoch: async () => 0 });
  // Terminal facts are read over the manager's own goal-writer context: the EPF read is a commit
  // principal's row, and this suite grades the relay, not the run driver's own grant profile.
  const actx = (manager as unknown as { goalWriter: { ctx: Parameters<typeof readGoalResult>[0] } }).goalWriter.ctx;
  const resultOf = async (goalId: string, ms: number): Promise<Awaited<ReturnType<typeof readGoalResult>>> => {
    const until = Date.now() + ms;
    for (;;) {
      const fact = await readGoalResult(actx, { endpoint: MANAGER_ENDPOINT, caller: runner, goalId });
      if (fact !== undefined || Date.now() >= until) return fact;
      await wait(500);
    }
  };

  console.log("1. the run instrument spawns a seat on the auth mesh, and it joins presence under its minted credential");
  const spawnGoal = "spawn-seat".padEnd(43, "s");
  const spawned = await call("spawn", { name: "seat", agent: "turn-stub", cwd: repoRoot }, { id: spawnGoal }).then((r) => r.reply, asValue);
  const readiness = await resultOf(spawnGoal, 60_000);
  check("the seat started (its spawn goal succeeded on a real presence join)",
    (spawned as { ok?: boolean }).ok === true && readiness?.state === "succeeded", { spawned, readiness });
  const seat = M.agents.get("seat")!;
  const seatTriple: EpCaller = { owner: DEV_OWNER, actor: seat.id, uid: seat.lifecycleUid };
  const seatCreds = readFileSync(agentLifecycleSecretFilePaths(workspaceRoot, space, "seat", seat.lifecycleUid).creds, "utf8");
  const turnOf = (goalId: string, deadlineMs: number) => call("turn",
    { payload: JSON.stringify({ run: "r1", step: "turn:seat", context: "do the thing" }), deadlineMs },
    { id: goalId, target: { actor: seat.id, lifecycleUid: seat.lifecycleUid } });

  console.log("\n2. the manager accepts a turn on the auth mesh: the hold's schedule rides the serve grant");
  const g1 = "g1".padEnd(43, "a");
  const a1 = await turnOf(g1, 600_000).then((r) => r.reply, asValue);
  check("the run instrument's turn is ACCEPTED (the request row is granted; the hold's schedule published)",
    (a1 as { ok?: boolean }).ok === true && ((a1 as { data?: { goalId?: string } }).data?.goalId === g1), a1);
  const early = await readGoalResult(actx, { endpoint: MANAGER_ENDPOINT, caller: runner, goalId: g1 });
  check("...and no `failed` terminal was unwound onto it", early === undefined, early);

  console.log("\n3. the seat pulls and yields under ITS OWN credential: the relay rows are in the agent baseline");
  seatNc = await connect({ servers: broker.servers, ...standaloneConnectOpts({ creds: seatCreds, tls: false }), maxReconnectAttempts: 0 });
  const seatService = await resolveService(seatNc, space, MANAGER_ENDPOINT, seatTriple);
  const pulled = await invokeCommand(seatNc, space, seatService, "turn-pending", undefined, { target: { mode: "self" }, deadlineMs: 10_000 }).then((r) => r.reply, asValue);
  const turns = ((pulled as { data?: { turns?: Array<{ goalId?: string; payload?: string }> } }).data?.turns ?? []);
  check("the seat's minted credential is SERVED its pending turn, never broker-dropped",
    (pulled as { ok?: boolean }).ok === true && turns.length === 1 && turns[0]?.goalId === g1, pulled);
  check("the payload the run submitted reaches the seat verbatim",
    turns[0]?.payload !== undefined && (JSON.parse(turns[0].payload) as { run?: string }).run === "r1", turns[0]?.payload);
  const y = await invokeCommand(seatNc, space, seatService, "turn-yield", { goalId: g1, status: "done", note: "did it" }, { target: { mode: "self" }, deadlineMs: 10_000 }).then((r) => r.reply, asValue);
  check("the seat's yield is served and completes the goal with its live currency",
    (y as { ok?: boolean }).ok === true && (y as { data?: { state?: string } }).data?.state === "succeeded", y);
  const done = await readGoalResult(actx, { endpoint: MANAGER_ENDPOINT, caller: runner, goalId: g1 });
  check("the run reads the yield off the goal's result fact", done?.state === "succeeded" && (done.data as { note?: string } | undefined)?.note === "did it", done);

  console.log("\n4. a turn nobody yields is denied at its deadline: the manager expires the hold it owns, with no fire read");
  const g2 = "g2".padEnd(43, "b");
  const a2 = await turnOf(g2, 3_000).then((r) => r.reply, asValue);
  check("a short-deadline turn is accepted", (a2 as { ok?: boolean }).ok === true, a2);
  const denied = await resultOf(g2, 30_000);
  check("the goal's terminal is the deadline deny, reason `turn-deadline`",
    denied?.state === "failed" && (denied.data as { reason?: string } | undefined)?.reason === "turn-deadline", denied);
  const late = await invokeCommand(seatNc, space, seatService, "turn-yield", { goalId: g2, status: "done" }, { target: { mode: "self" }, deadlineMs: 10_000 }).then((r) => r.reply, asValue);
  check("a yield after the deadline is told the turn already ended failed; it never records a success over the deny",
    (late as { ok?: boolean }).ok === true && (late as { data?: { state?: string } }).data?.state === "failed", late);

  console.log("\n5. an accept that unwinds after its bind is never re-accepted: the run's retry is told what the goal came to");
  // The bind is create-only and outlives the unwind (the failed terminal, the cleared index), so a
  // same-fingerprint retry of an unwound accept lands on `!bound` with no relay pending. Served
  // from the index it had just re-recorded, that retry was handed a live deadline on a turn no
  // seat would ever be shown. The unwind is forced here by a deadline past the scheduler's range,
  // which the hold's mint refuses after the goal is bound.
  const g3 = "g3".padEnd(43, "c");
  const beyond = 300_000_000_000_000;
  const first = await turnOf(g3, beyond).then((r) => r.reply, asValue);
  const unwound = await resultOf(g3, 15_000);
  check("the accept unwinds: refused to the caller, with a failed terminal committed on the bound goal",
    (first as { ok?: boolean }).ok === false && unwound?.state === "failed", { first, unwound });
  const retry = await turnOf(g3, beyond).then((r) => r.reply, asValue);
  check("a retry of the unwound accept is refused naming the terminal, never handed a live acceptance",
    (retry as { ok?: boolean }).ok === false && /already ended failed/.test(String((retry as { error?: { message?: string } }).error?.message)), retry);
  const leftover = await readGoalIndex(actx, { endpoint: MANAGER_ENDPOINT, caller: runner, goalId: g3 });
  check("and no index entry remains for the ended goal, so no sweep finds a relay to adopt", leftover === undefined, leftover);
} finally {
  await seatNc?.drain().catch(() => seatNc?.close());
  await runnerNc?.drain().catch(() => runnerNc?.close());
  await manager?.stop().catch(() => {});
  await writer?.stop().catch(() => {});
  await writerNc?.drain().catch(() => writerNc?.close());
  await delivery?.stop().catch(() => {});
  await broker.stop().catch(() => {});
}

const EXPECTED_CELLS = 13;
console.log(`\n${fail === 0 && pass === EXPECTED_CELLS ? "TURN RELAY AUTH SMOKE OK ✅" : "TURN RELAY AUTH SMOKE FAILED"}  (${pass} passed, ${fail} failed)`);
if (pass + fail !== EXPECTED_CELLS) {
  console.log(`SUITE INCOMPLETE — ran ${pass + fail} of ${EXPECTED_CELLS} cells; a partial run is not a pass`);
  process.exit(1);
}
process.exit(fail === 0 ? 0 : 1);
