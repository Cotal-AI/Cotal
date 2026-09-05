/**
 * cotal-lang `spawn({ supervise })` against the REAL manager: a driven program, a real
 * join-connector child, SIGKILL mid-turn, the replacement pulls and yields the same goal,
 * then a second kill spends the budget and the next turn fails L4002.
 *
 * Modelled on lang-spawn-live: seat-env hygiene, scratch COTAL_HOME, own nats-server,
 * setupSpaceStreams, recordMesh, in-process Manager, startRun + MeshHandler as run-command.ts.
 *
 * `turn` has no `context` option (L3011); the program names the step `do-it` and the handler
 * renders context itself. Needs nats-server + node on PATH. Run: pnpm smoke:lang-supervise-live
 */
import { spawn as spawnProc, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const home = mkdtempSync(join(tmpdir(), "cotal-langsupervise-home-"));
for (const k of Object.keys(process.env)) if (k.startsWith("COTAL_")) delete process.env[k];
process.env.COTAL_HOME = home;

const { connect } = await import("@nats-io/transport-node");
const { jetstream, jetstreamManager } = await import("@nats-io/jetstream");
const {
  probeConnect, registry, DEV_OWNER, openRecordsBucket,
  replayRunJournal, newTakeoverId, resolveService, invokeCommand, setupSpaceStreams,
} = await import("@cotal-ai/core");
type LaunchOptsT = import("@cotal-ai/core").LaunchOpts;
type LaunchSpecT = import("@cotal-ai/core").LaunchSpec;
type ConnectorT = import("@cotal-ai/core").Connector;
type EpCallerT = import("@cotal-ai/core").EpCaller;
interface JournalEntryT {
  kind: string;
  state: string;
  status?: string;
  result?: unknown;
  external?: Record<string, unknown>;
  error?: { code?: string; kind?: string; message?: string };
}
const { recordMesh } = await import("@cotal-ai/workspace");
const { Manager } = await import("@cotal-ai/manager");
const { MeshHandler, EpfSettleWatcher, startRun } = await import("@cotal-ai/runtime");
const { launchEnv } = await import("@cotal-ai/connector-core");

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
const SPACE = "langsupervise";
const CALLER: EpCallerT = { owner: DEV_OWNER, actor: "wf_langsupervise", uid: "c".repeat(26) };
const kids: ChildProcess[] = [];
const here = dirname(fileURLToPath(import.meta.url));
const SEAT = join(here, "lang-supervise-live-seat.mjs");
const coreDist = join(here, "..", "..", "packages", "core", "dist", "index.js");

const workspaceRoot = mkdtempSync(join(tmpdir(), "cotal-langsupervise-ws-"));
mkdirSync(join(workspaceRoot, ".cotal", "agents"), { recursive: true });
writeFileSync(join(workspaceRoot, ".cotal", "agents", "seat.md"), "---\nname: seat\nrole: worker\nagent: join\n---\n");
const turnLog = join(workspaceRoot, "seat-turns.log");
writeFileSync(turnLog, "");

let yieldOnPull = false;
const envJoin = (o: LaunchOptsT): Record<string, string> => ({
  ...launchEnv(), CORE_DIST: coreDist,
  COTAL_SPACE: o.space, COTAL_SERVERS: String(o.servers ?? SERVER),
  COTAL_ID: o.id ?? "", COTAL_LIFECYCLE_UID: o.lifecycleUid ?? "", COTAL_NAME: o.name,
  COTAL_TURN_LOG: turnLog,
  COTAL_AUTO_YIELD: yieldOnPull ? "1" : "0",
});
const joinCon: ConnectorT = {
  kind: "connector",
  name: "join",
  requires: ["node"],
  buildLaunch: (o): LaunchSpecT => ({ command: process.execPath, args: [SEAT], env: envJoin(o) }),
};
registry.register(joinCon);

const rowsOf = (text: string): Array<{ pid: string; action: string; goalId: string }> =>
  text.split("\n").filter(Boolean).map((line) => {
    const [pid, action, goalId] = line.split("\t");
    return { pid, action, goalId };
  });

let mgr: InstanceType<typeof Manager> | undefined;
let rc = 1;
try {
  const broker = spawnProc("nats-server", ["-a", "127.0.0.1", "-p", String(PORT), "-js", "-sd", mkdtempSync(join(tmpdir(), "cotal-langsupervise-js-"))], { stdio: "ignore" });
  kids.push(broker);
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { up = (await probeConnect(SERVER, { timeoutMs: 400 })).ok; if (!up) await wait(120); }
  if (!up) throw new Error(`nats-server did not come up on ${PORT}`);
  await setupSpaceStreams({ servers: SERVER, space: SPACE });
  recordMesh({ space: SPACE, server: SERVER, root: workspaceRoot, mode: "open", ts: new Date().toISOString() });

  mgr = new Manager({ space: SPACE, servers: SERVER, runtime: "pty", workspaceRoot });
  await mgr.start();

  const nc = await connect({ servers: SERVER, maxReconnectAttempts: 0 });
  const js = jetstream(nc);
  const jsm = await jetstreamManager(nc);
  const kv = await openRecordsBucket(nc, SPACE);

  const mk = (runId: string) => new MeshHandler(
    nc, kv, js, jsm,
    { space: SPACE, endpoint: "manager", runId, caller: CALLER, instanceId: "i".repeat(26), epoch: 1, holder: { id: "cli-run", lifecycleUid: "u_langsupervise" }, defaultCheckpointTimeout: "1h" },
    new EpfSettleWatcher(jsm, SPACE, 3_000),
    () => Date.now(),
  );
  const lease = () => ({ holder: "m1", epoch: 1, fencingToken: 1, takeoverId: newTakeoverId() });
  const entriesOf = async (runId: string, kind: string): Promise<JournalEntryT[]> => {
    const back = await replayRunJournal(js, jsm, SPACE, runId, newTakeoverId());
    return back.records
      .map((r) => r.record)
      .filter((r) => r.kind === "step")
      .map((r) => (r as { entry: unknown }).entry as JournalEntryT)
      .filter((e) => e.kind === kind);
  };
  const service = await resolveService(nc, SPACE, "manager", CALLER);
  type PsRow = { name?: unknown; pid?: unknown; lifecycleUid?: unknown };
  const psRows = async (): Promise<PsRow[]> => {
    const r = await invokeCommand(nc, SPACE, service, "ps", undefined, { deadlineMs: 10_000, currentEpoch: async () => 0 });
    return (r.reply.data ?? []) as PsRow[];
  };

  const source = `
const s = await spawn("seat", { supervise: { restarts: 1, window: "1m" } });
const t = await turn(s, { name: "do-it" });
log("first", t.status);
try {
  await turn(s, { name: "again", deadline: "25s" });
  log("reached", true);
} catch (e) {
  log("caught", e.code);
}
`;
  const drv = startRun(js, jsm, {
    space: SPACE, endpoint: "manager", kv, runId: "ls-sup", lease: lease(),
    source, handler: mk("ls-sup"),
  }).catch((e: unknown) => ({ status: "threw" as const, error: String((e as Error)?.message).slice(0, 180) }));

  let pending: JournalEntryT | undefined;
  {
    const until = Date.now() + 45_000;
    while (pending === undefined && Date.now() < until) {
      pending = (await entriesOf("ls-sup", "turn")).find((e) => e.state === "pending" && typeof e.external?.goalId === "string");
      if (pending === undefined) await wait(400);
    }
  }
  const goalId = String(pending?.external?.goalId ?? "");
  c("the run parks on the first turn through the real manager", goalId.length > 0, JSON.stringify(pending?.external));

  let first: PsRow | undefined;
  {
    const until = Date.now() + 20_000;
    while (first === undefined && Date.now() < until) {
      first = (await psRows()).find((row) => row.name === "seat" && typeof row.pid === "number");
      if (first === undefined) await wait(200);
    }
  }
  const firstPid = typeof first?.pid === "number" ? first.pid : undefined;
  const firstUid = typeof first?.lifecycleUid === "string" ? first.lifecycleUid : undefined;
  c("the live seat has a process pid", typeof firstPid === "number" && firstPid > 0, firstPid);

  yieldOnPull = true;
  if (typeof firstPid === "number") {
    try { process.kill(firstPid, "SIGKILL"); } catch (e) { c("SIGKILL the live pid mid-turn", false, e); }
  }

  let replacement: PsRow | undefined;
  {
    const until = Date.now() + 30_000;
    while (replacement === undefined && Date.now() < until) {
      const row = (await psRows()).find((r) => r.name === "seat" && typeof r.pid === "number");
      if (row !== undefined && row.pid !== firstPid) replacement = row;
      else await wait(200);
    }
  }
  c("a supervised crash keeps the same managed row", replacement !== undefined, replacement);
  c("a supervised crash keeps identity and lifecycle",
    replacement?.lifecycleUid === firstUid && firstUid !== undefined,
    { firstUid, next: replacement?.lifecycleUid });
  c("the replacement process has a different pid",
    typeof replacement?.pid === "number" && replacement.pid !== firstPid,
    { firstPid, next: replacement?.pid });

  let pulled: { pid: string; goalId: string } | undefined;
  let yielded: { pid: string; goalId: string } | undefined;
  {
    const until = Date.now() + 30_000;
    while ((pulled === undefined || yielded === undefined) && Date.now() < until) {
      const rows = rowsOf(readFileSync(turnLog, "utf8"));
      pulled = rows.find((r) => r.action === "PULLED" && r.goalId === goalId && String(r.pid) === String(replacement?.pid));
      yielded = rows.find((r) => r.action === "YIELDED" && r.goalId === goalId && String(r.pid) === String(replacement?.pid));
      if (pulled === undefined || yielded === undefined) await wait(200);
    }
  }
  c("the replacement process pulls the same turn goal",
    pulled?.goalId === goalId && String(pulled?.pid) === String(replacement?.pid),
    { pulled, goalId, pid: replacement?.pid });
  c("the replacement process yields the same turn goal",
    yielded?.goalId === goalId && String(yielded?.pid) === String(replacement?.pid),
    { yielded, goalId, pid: replacement?.pid });

  let firstSettled: JournalEntryT | undefined;
  {
    const until = Date.now() + 30_000;
    while (firstSettled === undefined && Date.now() < until) {
      firstSettled = (await entriesOf("ls-sup", "turn")).find((e) => e.state === "settled" && String(e.external?.goalId ?? "") === goalId);
      if (firstSettled === undefined) await wait(400);
    }
  }
  c("the program's first turn step settles ok after the restart yield",
    firstSettled?.status === "ok" && (firstSettled?.result as { status?: string } | undefined)?.status === "done",
    JSON.stringify({ status: firstSettled?.status, result: firstSettled?.result }));

  const secondPid = typeof replacement?.pid === "number" ? replacement.pid : undefined;
  if (typeof secondPid === "number") {
    try { process.kill(secondPid, "SIGKILL"); } catch (e) { c("SIGKILL the replacement pid", false, e); }
  }
  {
    const until = Date.now() + 20_000;
    let gone = false;
    while (!gone && Date.now() < until) {
      gone = !(await psRows()).some((r) => r.name === "seat");
      if (!gone) await wait(200);
    }
    c("spending the restart budget retires the seat", gone);
  }

  const out = await Promise.race([drv, wait(60_000).then(() => undefined)]);
  c("the run completes after the second turn fails in-program",
    (out as { status?: string } | undefined)?.status === "completed", JSON.stringify(out));

  const turns = await entriesOf("ls-sup", "turn");
  const second = turns.filter((e) => e.state === "settled" && String(e.external?.goalId ?? "") !== goalId).at(-1);
  c("the next turn fails L4002 with the recorded reason",
    second?.status === "failed"
      && second?.error?.code === "L4002"
      && second?.error?.kind === "turn"
      && typeof second?.error?.message === "string"
      && second.error.message.includes("found the agent down"),
    JSON.stringify(second?.error));

  await nc.drain().catch(() => undefined);
  const EXPECTED_CELLS = 11;
  if (pass + fail !== EXPECTED_CELLS) {
    console.log(`SUITE INCOMPLETE — ran ${pass + fail} of ${EXPECTED_CELLS} cells; a partial run is not a pass`);
    fail += 1;
  }
  rc = fail === 0 ? 0 : 1;
} finally {
  try { await mgr?.stop(); } catch { /* teardown */ }
  for (const k of kids) { try { k.kill("SIGKILL"); } catch { /* gone */ } }
  rmSync(home, { recursive: true, force: true });
  rmSync(workspaceRoot, { recursive: true, force: true });
}
console.log(`lang-supervise-live.smoke: ${pass} passed, ${fail} failed`);
process.exit(rc);
