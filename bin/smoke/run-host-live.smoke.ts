/**
 * Manager-hosted workflow runs (SPEC 14.3) against the REAL manager and the REAL runtime host:
 * `run-start` / `run-resume` / `run-answer` / `run-status` / `run-ps` served on the ep rails, the
 * drive hosted in the manager's process under its own per-run credential, and a manager restart
 * taking a parked run back from its journal.
 *
 * Phase A is a JWT-auth broker: the caller is an `agent` credential carrying `capabilities: [run]`
 * and nothing else, so every reach the family needs is proven from the rows that capability mints.
 * Phase B is an open broker driven through the shipped `cotal run` client, the path a demo mesh
 * takes. Lives under bin/smoke because it composes the manager AND the runtime (implementations
 * never import each other; the composition root does).
 *
 * Needs nats-server on PATH. Run: pnpm smoke:run-host-live
 */
import { spawn as spawnProc, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "cotal-runhost-home-"));
for (const k of Object.keys(process.env)) if (k.startsWith("COTAL_")) delete process.env[k];
process.env.COTAL_HOME = home;

const { connect } = await import("@nats-io/transport-node");
const {
  createSpaceAuth, mintCreds, newIdentity, mintLifecycleUid, standaloneConnectOpts, setupSpaceStreams,
  probeConnect, resolveService, invokeCommand, DEV_OWNER, LANG_PROBLEM_DETAIL_KIND,
} = await import("@cotal-ai/core");
type EpCallerT = import("@cotal-ai/core").EpCaller;
type ReplyT = import("@cotal-ai/core").EndpointReply;
type RunStatusViewT = import("@cotal-ai/core").RunStatusView;
type RunListRowT = import("@cotal-ai/core").RunListRow;
type RunJournalRowT = import("@cotal-ai/core").RunJournalRow;
const { authDir, saveSpaceAuth, recordMesh } = await import("@cotal-ai/workspace");
const { Manager } = await import("@cotal-ai/manager");
// Importing the runtime is what registers the `cotal-lang` run host the manager resolves.
const { runWorkflow } = await import("@cotal-ai/runtime");
const { bootBroker } = await import("../../implementations/manager/smoke/_boot-broker.js");
// The delivery daemon: the liveness oracle a manager restart on an auth mesh verify-evicts through
// (SPEC 13.1), and the timer writer a checkpoint's deadline schedule is armed by.
const { bootDeliveryDaemon } = await import("../../implementations/manager/smoke/_boot-delivery.js");

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const freePort = (): Promise<number> =>
  new Promise((res, rej) => {
    const s = createServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => res(p)); });
  });

let pass = 0, fail = 0;
const c = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra !== undefined ? JSON.stringify(extra) : ""); }
};
const until = async <T>(read: () => Promise<T | undefined>, ms: number): Promise<T | undefined> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (v !== undefined || Date.now() > deadline) return v;
    await wait(200);
  }
};

const PURE = 'const xs = [1, 2, 3];\nlog("doubled", xs.map((x) => x * 2));\n';
const CHECKPOINT = 'const d = await checkpoint("approve", "Ship it?");\nlog("resolved", d.status);\n';
const BROKEN = 'log("unclosed"\n';

const kids: ChildProcess[] = [];
const scratch: string[] = [home];
let rc = 1;

// ── Phase A: JWT-auth broker, the `run` capability alone ─────────────────────────────────────
const spaceA = `runhost-${Math.random().toString(36).slice(2, 8)}`;
const auth = await createSpaceAuth(spaceA);
const brokerA = await bootBroker(auth);
const wsA = mkdtempSync(join(tmpdir(), "cotal-runhost-wsA-"));
scratch.push(wsA);
mkdirSync(join(wsA, ".cotal", "agents"), { recursive: true });
saveSpaceAuth(authDir(wsA), auth);

let mgr: InstanceType<typeof Manager> | undefined;
let mgrB: InstanceType<typeof Manager> | undefined;
let nc: Awaited<ReturnType<typeof connect>> | undefined;
let delivery: Awaited<ReturnType<typeof bootDeliveryDaemon>> | undefined;
try {
  await setupSpaceStreams({ servers: brokerA.servers, space: spaceA, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  delivery = await bootDeliveryDaemon({ space: spaceA, servers: brokerA.servers, auth });
  mgr = new Manager({ space: spaceA, servers: brokerA.servers, runtime: "pty", workspaceRoot: wsA });
  await mgr.start();

  const id = newIdentity();
  const uid = mintLifecycleUid();
  const caller: EpCallerT = { owner: DEV_OWNER, actor: id.id, uid };
  const creds = await mintCreds(auth, id, "agent", { lifecycleUid: uid, capabilities: ["run"] });
  nc = await connect({ servers: brokerA.servers, ...standaloneConnectOpts({ creds, tls: false }), maxReconnectAttempts: 0 });
  const service = await resolveService(nc, spaceA, "manager", caller, { deadlineMs: 10_000 });
  const call = async (command: string, args?: Record<string, unknown>): Promise<ReplyT> =>
    (await invokeCommand(nc!, spaceA, service, command, args, { deadlineMs: 30_000, currentEpoch: async () => 0 })).reply;
  const status = async (runId: string): Promise<RunStatusViewT | undefined> => {
    const r = await call("run-status", { runId });
    return r.ok ? r.data as RunStatusViewT : undefined;
  };
  const stateOf = (v: RunStatusViewT | undefined) => v?.status?.state;
  type StepRow = Extract<RunJournalRowT, { kind: "step" }>;
  const pending = (v: RunStatusViewT | undefined, asks: string): StepRow | undefined =>
    v?.journal.find((r): r is StepRow => r.kind === "step" && r.state === "pending" && r.asks === asks);

  console.log("A1. a program that does not validate is refused with the language's own records");
  {
    const r = await call("run-start", { source: BROKEN, file: "broken.cotal.js" });
    const details = ((r.error as { details?: unknown } | undefined)?.details ?? []) as Array<{ kind?: string; code?: string }>;
    c("run-start refuses an invalid program as bad-request", r.ok === false && r.error?.code === "bad-request", r.error);
    c("and the refusal carries each problem as an ai.cotal.lang.problem detail with its code",
      details.length > 0 && details.every((d) => d.kind === LANG_PROBLEM_DETAIL_KIND && /^L\d{4}$/.test(String(d.code))), details);
    const ps = await call("run-ps");
    c("nothing was recorded for it", ps.ok === true && (ps.data as RunListRowT[]).length === 0, ps.data);
  }

  console.log("A2. a pure program is started on the manager and runs to completion there");
  let pureId = "";
  {
    const r = await call("run-start", { source: PURE, file: "pure.cotal.js" });
    pureId = (r.data as { runId?: string } | undefined)?.runId ?? "";
    c("run-start answers with a minted run id", r.ok === true && /^run-[0-9a-f]{32}$/.test(pureId), r);
    const first = await status(pureId);
    c("the run's record exists by the time run-start has answered", first?.status !== undefined && first.status.epoch === 1, first);
    const done = await until(async () => { const v = await status(pureId); return stateOf(v) === "completed" ? v : undefined; }, 15_000);
    // A `log`-only program performs no effect, so its journal is the activation alone.
    c("run-status reports it completed, its journal holding the hosted activation under epoch 1",
      stateOf(done) === "completed" && done!.journal.some((row) => row.kind === "activation" && row.epoch === 1), done);
    const ps = await call("run-ps");
    const row = (ps.data as RunListRowT[] | undefined)?.find((x) => x.runId === pureId);
    c("run-ps lists it on the manager endpoint as completed", row?.endpoint === "manager" && row.state === "completed", ps.data);
  }

  console.log("A3. a checkpoint parks the hosted run; run-answer resolves it from the outside");
  let cpId = "";
  {
    const r = await call("run-start", { source: CHECKPOINT, file: "cp.cotal.js" });
    cpId = (r.data as { runId?: string } | undefined)?.runId ?? "";
    c("the checkpoint program starts", r.ok === true && cpId !== "", r);
    const parked = await until(async () => { const v = await status(cpId); return pending(v, "Ship it?") ? v : undefined; }, 15_000);
    c("run-status shows the open pause and what it asks", pending(parked, "Ship it?")?.step === "/checkpoint:approve#0", parked?.journal);
    const busy = await call("run-resume", { runId: cpId });
    c("run-resume of a run this manager is driving is a conflict", busy.ok === false && busy.error?.code === "conflict", busy.error);
    const wrong = await call("run-answer", { runId: cpId, stepKey: "/checkpoint:nope#0", by: "smoke" });
    c("run-answer at a key with no open pause is not-found", wrong.ok === false && wrong.error?.code === "not-found", wrong.error);
    const answered = await call("run-answer", { runId: cpId, stepKey: "/checkpoint:approve#0", by: "smoke", value: "yes" });
    const data = answered.data as { token?: string; answerId?: string; settle?: { kind?: string } } | undefined;
    c("run-answer resolves the open checkpoint and reports the settle", answered.ok === true && typeof data?.answerId === "string" && data.settle !== undefined, answered);
    const done = await until(async () => { const v = await status(cpId); return stateOf(v) === "completed" ? v : undefined; }, 15_000);
    c("and the hosted run completes", stateOf(done) === "completed", done?.status);
  }

  console.log("A4. resume refusals name the fact");
  {
    const missing = await call("run-resume", { runId: "run-" + "0".repeat(32) });
    c("run-resume of a run that was never started is not-found", missing.ok === false && missing.error?.code === "not-found", missing.error);
  }

  console.log("A5. a manager restart takes a parked run back from its journal");
  {
    const r = await call("run-start", { source: CHECKPOINT, file: "cp2.cotal.js" });
    const runId = (r.data as { runId?: string } | undefined)?.runId ?? "";
    const parked = await until(async () => { const v = await status(runId); return pending(v, "Ship it?") ? v : undefined; }, 15_000);
    c("a second checkpoint program parks under epoch 1", parked?.status?.epoch === 1 && stateOf(parked) === "running", parked?.status);
    await mgr.stop();
    mgr = undefined;
    const t0 = Date.now();
    mgrB = new Manager({ space: spaceA, servers: brokerA.servers, runtime: "pty", workspaceRoot: wsA });
    await mgrB.start();
    const serviceB = await resolveService(nc, spaceA, "manager", caller, { deadlineMs: 10_000 });
    // The successor serves at epoch 1; a currency read pinned at 0 would reject its every reply.
    const callB = async (command: string, args?: Record<string, unknown>): Promise<ReplyT> =>
      (await invokeCommand(nc!, spaceA, serviceB, command, args, { deadlineMs: 30_000, currentEpoch: async () => serviceB.responder.epoch })).reply;
    const statusB = async (id2: string): Promise<RunStatusViewT | undefined> => {
      const x = await callB("run-status", { runId: id2 });
      return x.ok ? x.data as RunStatusViewT : undefined;
    };
    const taken = await until(async () => { const v = await statusB(runId); return v?.status?.epoch === 2 ? v : undefined; }, 15_000);
    c("the successor takes the parked run back: still running, now under epoch 2, the pause still open",
      taken?.status?.epoch === 2 && stateOf(taken) === "running" && pending(taken, "Ship it?") !== undefined, { status: taken?.status, ms: Date.now() - t0 });
    const busy = await callB("run-resume", { runId });
    c("and holds it: a resume is a conflict on the successor too", busy.ok === false && busy.error?.code === "conflict", busy.error);
    const answered = await callB("run-answer", { runId, stepKey: "/checkpoint:approve#0", by: "smoke", value: "go" });
    c("the answer lands on the taken-back run", answered.ok === true, answered);
    const done = await until(async () => { const v = await statusB(runId); return stateOf(v) === "completed" ? v : undefined; }, 15_000);
    c("and it completes under the successor", stateOf(done) === "completed" && done?.status?.epoch === 2, done?.status);
    const ps = await callB("run-ps");
    c("run-ps on the successor shows all three runs completed",
      ps.ok === true && [pureId, cpId, runId].every((x) => (ps.data as RunListRowT[]).find((row) => row.runId === x)?.state === "completed"), ps.data);
  }
  await nc.drain().catch(() => undefined);
  nc = undefined;
  await mgrB.stop();
  mgrB = undefined;
} catch (e) {
  fail++;
  console.log("  ✗ FAIL: phase A threw", (e as Error).stack ?? String(e));
}

// ── Phase B: open broker, the shipped `cotal run` client ─────────────────────────────────────
try {
  const port = await freePort();
  const server = `nats://127.0.0.1:${port}`;
  const spaceB = "runhost-open";
  const sd = mkdtempSync(join(tmpdir(), "cotal-runhost-js-"));
  scratch.push(sd);
  const broker = spawnProc("nats-server", ["-a", "127.0.0.1", "-p", String(port), "-js", "-sd", sd], { stdio: "ignore" });
  kids.push(broker);
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { up = (await probeConnect(server, { timeoutMs: 400 })).ok; if (!up) await wait(120); }
  if (!up) throw new Error(`nats-server did not come up on ${port}`);
  await setupSpaceStreams({ servers: server, space: spaceB });
  const wsB = mkdtempSync(join(tmpdir(), "cotal-runhost-wsB-"));
  scratch.push(wsB);
  mkdirSync(join(wsB, ".cotal", "agents"), { recursive: true });
  recordMesh({ space: spaceB, server, root: wsB, mode: "open", ts: new Date().toISOString() });
  mgr = new Manager({ space: spaceB, servers: server, runtime: "pty", workspaceRoot: wsB });
  await mgr.start();

  const file = join(wsB, "cp.cotal.js");
  writeFileSync(file, CHECKPOINT);
  const LOGS: string[] = [];
  const realLog = console.log;
  console.log = (...a: unknown[]) => { LOGS.push(a.map(String).join(" ")); };
  const cli = async (positionals: string[], values: Record<string, string> = {}): Promise<string> => {
    LOGS.length = 0;
    await runWorkflow({ values: { server, space: spaceB, ...values }, positionals, raw: [] });
    return LOGS.join("\n");
  };
  let out = "", runId = "";
  try {
    out = await cli(["start"], { file });
    runId = /started run (run-[0-9a-f]+) on the manager/.exec(out)?.[1] ?? "";
    let journal = "";
    for (let i = 0; i < 50 && !journal.includes("asks        Ship it?"); i++) { await wait(200); journal = await cli(["journal", runId]); }
    const answer = await cli(["answer", runId, "/checkpoint:approve#0"], { by: "smoke", value: '"yes"' });
    let done = "";
    for (let i = 0; i < 50 && !done.includes("completed, holder"); i++) { await wait(200); done = await cli(["journal", runId]); }
    const ps = await cli(["ps"]);
    console.log = realLog;
    c("B1. `cotal run start` hands the program to the open-mesh manager and prints the minted id", runId !== "", out);
    c("B2. `cotal run journal` shows the open pause and its question", journal.includes("/checkpoint:approve#0  pending") && journal.includes("asks        Ship it?"), journal);
    c("B3. `cotal run answer` resolves it through the manager", answer.includes('"answerId"'), answer);
    c("B4. and the journal then reads completed", done.includes("completed, holder"), done);
    c("B5. `cotal run ps` lists the run", ps.includes(runId), ps);
  } finally {
    console.log = realLog;
  }
  await mgr.stop();
  mgr = undefined;
} catch (e) {
  fail++;
  console.log("  ✗ FAIL: phase B threw", (e as Error).stack ?? String(e));
}

const EXPECTED_CELLS = 25;
if (pass + fail !== EXPECTED_CELLS) {
  console.log(`SUITE INCOMPLETE — ran ${pass + fail} of ${EXPECTED_CELLS} cells; a partial run is not a pass`);
  fail += 1;
}
rc = fail === 0 ? 0 : 1;
try { await nc?.drain(); } catch { /* teardown */ }
try { await mgr?.stop(); } catch { /* teardown */ }
try { await mgrB?.stop(); } catch { /* teardown */ }
try { await delivery?.stop(); } catch { /* teardown */ }
for (const k of kids) { try { k.kill("SIGKILL"); } catch { /* gone */ } }
await brokerA.stop().catch(() => undefined);
for (const d of scratch) rmSync(d, { recursive: true, force: true });
console.log(`run-host-live.smoke: ${pass} passed, ${fail} failed`);
process.exit(rc);
