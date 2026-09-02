/**
 * cotal-lang `spawn` against the REAL manager — the fidelity leg mesh-spawn cannot carry.
 *
 * The runtime's own suite (`smoke:runtime-mesh-spawn`) proves the caller contract against a
 * manager-SHAPED endpoint it serves itself, because implementations never import each other. What
 * that cannot prove is fidelity to the shipped manager: that the mesh handler's generic resolve
 * fetches and recompiles the manager's REAL registered contracts, that its args mapping satisfies
 * the REAL spawn input schema, that the acceptance and terminal the real manager commits carry
 * what the handler reads, and that the discharge's owner-mode despawn releases a REAL seat. This
 * suite is the composition root's ride: a real broker, a real in-process `Manager`, a real agent
 * child that joins presence, and the real `MeshHandler` driving it all through a driven program.
 *
 *   1  a driven program spawns a REAL seat: the run completes, the handle pins the incarnation
 *      the manager allocated, and the seat is live on `ps`.
 *   2  a losing race branch's REAL seat is released by the driver's own sweep — the winner's is
 *      not touched.
 *
 * Throwaway everything: own open nats-server on a free port, scratch COTAL_HOME + workspace root.
 * Needs nats-server + node on PATH. Run: pnpm smoke:lang-spawn-live
 */
import { spawn as spawnProc, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Seat-env hygiene BEFORE any cotal import: whatever runs this suite may itself be a managed
// session whose COTAL_* names a live mesh; nothing may leak into the rig or its children.
const home = mkdtempSync(join(tmpdir(), "cotal-langspawn-home-"));
for (const k of Object.keys(process.env)) if (k.startsWith("COTAL_")) delete process.env[k];
process.env.COTAL_HOME = home;

const { connect } = await import("@nats-io/transport-node");
const { jetstream, jetstreamManager } = await import("@nats-io/jetstream");
const {
  probeConnect, registry, DEV_OWNER, openRecordsBucket,
  timerWriterContext, timerWriterConsumerConfig, timerWriterDurable, armCheckpointTimer,
  eptReqStreamName, replayRunJournal, newTakeoverId, resolveService, invokeCommand,
} = await import("@cotal-ai/core");
type LaunchOptsT = import("@cotal-ai/core").LaunchOpts;
type LaunchSpecT = import("@cotal-ai/core").LaunchSpec;
type ConnectorT = import("@cotal-ai/core").Connector;
type EpCallerT = import("@cotal-ai/core").EpCaller;
// The lang entry, structurally (bin does not depend on @cotal-ai/lang): only the fields read here.
interface JournalEntryT { kind: string; state: string; status?: string; result?: unknown }
const { recordMesh } = await import("@cotal-ai/workspace");
const { Manager } = await import("@cotal-ai/manager");
const { MeshHandler, EpfSettleWatcher, startRun } = await import("@cotal-ai/runtime");
const { launchEnv } = await import("@cotal-ai/connector-core"); // the OS env allow-list a real connector supplies

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

const PORT = await freePort();
const SERVER = `nats://127.0.0.1:${PORT}`;
const SPACE = "langspawn";
const CALLER: EpCallerT = { owner: DEV_OWNER, actor: "wf_langspawn", uid: "b".repeat(26) };
const kids: ChildProcess[] = [];

const workspaceRoot = mkdtempSync(join(tmpdir(), "cotal-langspawn-ws-"));
mkdirSync(join(workspaceRoot, ".cotal", "agents"), { recursive: true });
// The persona pins the harness (`agent: join`): the lang `spawn` sends no harness of its own, so
// this is exactly how a workflow-spawned seat picks its connector in production.
for (const n of ["wf1", "wf2"])
  writeFileSync(join(workspaceRoot, ".cotal", "agents", `${n}.md`), `---\nname: ${n}\nrole: worker\nagent: join\n---\n`);

// A real agent child: joins presence under the manager-assigned id, then parks. Readiness
// resolves `succeeded` off its presence join — a REAL process, not a scripted verdict.
const coreDist = join(import.meta.dirname, "..", "..", "packages", "core", "dist", "index.js");
const JOIN_CHILD = [
  "const{pathToFileURL}=require('node:url');",
  "import(pathToFileURL(process.env.CORE_DIST).href).then(async({CotalEndpoint})=>{",
  "const ep=new CotalEndpoint({space:process.env.COTAL_SPACE,servers:process.env.COTAL_SERVERS,lifecycleUid:process.env.COTAL_LIFECYCLE_UID||undefined,channels:[],consume:false,registerPresence:true,watchPresence:false,card:{id:process.env.COTAL_ID||undefined,name:process.env.COTAL_NAME,kind:'agent'}});",
  "ep.on('error',()=>{});await ep.start();setInterval(()=>{},1<<30);});",
].join("");
const envJoin = (o: LaunchOptsT): Record<string, string> => ({
  ...launchEnv(), CORE_DIST: coreDist,
  COTAL_SPACE: o.space, COTAL_SERVERS: String(o.servers ?? SERVER),
  COTAL_ID: o.id ?? "", COTAL_LIFECYCLE_UID: o.lifecycleUid ?? "", COTAL_NAME: o.name,
});
const joinCon: ConnectorT = { kind: "connector", name: "join", requires: ["node"], buildLaunch: (o): LaunchSpecT => ({ command: process.execPath, args: ["-e", JOIN_CHILD], env: envJoin(o) }) };
registry.register(joinCon);

let mgr: InstanceType<typeof Manager> | undefined;
let rc = 1;
try {
  const broker = spawnProc("nats-server", ["-a", "127.0.0.1", "-p", String(PORT), "-js", "-sd", mkdtempSync(join(tmpdir(), "cotal-langspawn-js-"))], { stdio: "ignore" });
  kids.push(broker);
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { up = (await probeConnect(SERVER, { timeoutMs: 400 })).ok; if (!up) await wait(120); }
  if (!up) throw new Error(`nats-server did not come up on ${PORT}`);
  recordMesh({ space: SPACE, server: SERVER, root: workspaceRoot, mode: "open", ts: new Date().toISOString() });

  mgr = new Manager({ space: SPACE, servers: SERVER, runtime: "pty", workspaceRoot });
  await mgr.start();

  const nc = await connect({ servers: SERVER, maxReconnectAttempts: 0 });
  const js = jetstream(nc);
  const jsm = await jetstreamManager(nc);
  const kv = await openRecordsBucket(nc, SPACE);

  // The timer pump the delivery daemon would host on a live mesh (the race leg sleeps).
  await jsm.consumers.add(eptReqStreamName(SPACE), timerWriterConsumerConfig(SPACE, { ackWaitMs: 5_000 }));
  const writerC = await js.consumers.get(eptReqStreamName(SPACE), timerWriterDurable(SPACE));
  const wctx = await timerWriterContext(nc, SPACE);
  const pumpState = { over: false };
  const pump = (async () => {
    while (!pumpState.over) {
      for await (const m of await writerC.fetch({ max_messages: 4, expires: 1_200 })) {
        await armCheckpointTimer(wctx, { subject: m.subject, headers: m.headers, data: m.data });
        m.ack();
      }
    }
  })();

  const mk = (runId: string) => new MeshHandler(
    nc, kv, js, jsm,
    { space: SPACE, endpoint: "manager", runId, caller: CALLER, instanceId: "i".repeat(26), epoch: 1, holder: { id: "cli-run", lifecycleUid: "u_langspawn" }, defaultCheckpointTimeout: "1h" },
    new EpfSettleWatcher(js, jsm, SPACE, 3_000),
    () => Date.now(),
  );
  const lease = (() => { let n = 0; return () => ({ holder: "m1", epoch: 1, fencingToken: (n += 1), takeoverId: newTakeoverId() }); })();
  const entriesOf = async (runId: string, kind: string): Promise<JournalEntryT[]> => {
    const back = await replayRunJournal(js, jsm, SPACE, runId, newTakeoverId());
    return back.records
      .map((r) => r.record)
      .filter((r) => r.kind === "step")
      .map((r) => (r as { entry: unknown }).entry as JournalEntryT)
      .filter((e) => e.kind === kind);
  };
  // The same generic resolve the handler itself performs — here it doubles as the suite's own
  // read surface, so `ps` is read through the manager's real registered contract too.
  const service = await resolveService(nc, SPACE, "manager", CALLER);
  const psNames = async (): Promise<string[]> => {
    const r = await invokeCommand(nc, SPACE, service, "ps", undefined, { deadlineMs: 10_000, currentEpoch: async () => 0 });
    return ((r.reply.data ?? []) as Array<{ name?: unknown }>).map((row) => String(row.name));
  };

  // ── 1) a driven program spawns a REAL seat ──────────────────────────────────────────────────
  {
    console.log("• 1 — a driven program spawns a real seat through the real manager");
    const out = await startRun(js, jsm, {
      space: SPACE, endpoint: "manager", kv, runId: "ls-1", lease: lease(),
      source: `const d = await spawn("wf1");\nlog("agent", d.agent);`,
      handler: mk("ls-1"),
    });
    c("the run completes through the real accept and the real readiness terminal",
      out.status === "completed", JSON.stringify(out));
    const settled = (await entriesOf("ls-1", "spawn")).find((e) => e.state === "settled");
    const value = settled?.result as { agent?: string; persona?: string } | undefined;
    c("the settled entry records a handle for the manager-allocated seat",
      settled?.status === "ok" && typeof value?.agent === "string" && value.agent.startsWith("wf1#"), value?.agent);
    c("the handle carries the persona", value?.persona === "wf1", value?.persona);
    const names = await psNames();
    c("the seat is LIVE on the manager's own ps", names.includes("wf1"), names);
  }

  // ── 2) a losing race branch's real seat is released by the driver's sweep ───────────────────
  {
    console.log("• 2 — a losing race branch's real seat is released by the driver's sweep");
    const source = `
const out = await race({
  seat: async () => {
    const d = await spawn("wf2");
    await sleep("10m");
    return d.agent;
  },
  fast: async () => {
    await sleep("3s");
    return "fast";
  },
}, { name: "r" });
log("winner", out.index);
`;
    const out = await startRun(js, jsm, {
      space: SPACE, endpoint: "manager", kv, runId: "ls-2", lease: lease(),
      source, handler: mk("ls-2"),
    });
    c("the racing run completes", out.status === "completed", JSON.stringify(out));
    const scope = (await entriesOf("ls-2", "race")).find((e) => e.state === "settled");
    const winner = ((scope?.result as { value?: { index?: unknown } } | undefined)?.value)?.index;
    c("the fast branch wins while the seat branch parks", winner === "fast", JSON.stringify(scope?.result)?.slice(0, 90));
    const names = await psNames();
    c("the loser's REAL seat is gone: the driver's sweep despawned it through the real manager",
      !names.includes("wf2"), names);
    c("and the winner-unrelated seat from the first run was not touched", names.includes("wf1"), names);
  }

  pumpState.over = true;
  await pump;
  await nc.drain().catch(() => undefined);
  rc = fail === 0 ? 0 : 1;
} finally {
  try { await mgr?.stop(); } catch { /* teardown */ }
  for (const k of kids) { try { k.kill("SIGKILL"); } catch { /* gone */ } }
  rmSync(home, { recursive: true, force: true });
  rmSync(workspaceRoot, { recursive: true, force: true });
}
console.log(`lang-spawn-live.smoke: ${pass} passed, ${fail} failed`);
process.exit(rc);
