/** Real authenticated Manager/Delivery recovery with inert contained tool descendants. */
import { randomUUID } from "node:crypto";
import { readdirSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "@nats-io/transport-node";
import {
  createSpaceAuth, mintCreds, newIdentity, mintLifecycleUid, standaloneConnectOpts, setupSpaceStreams,
  DEV_OWNER, epCall, invokeCommand, resolveService, readAcceptedRow, readGoalResult, registry,
  type Connector, type EpCaller, type IssuedCaller, type LaunchOpts, type LaunchSpec,
} from "@cotal-ai/core";
import {
  authDir, saveSpaceAuth, agentLifecycleSecretFilePaths, recordMesh, removeMesh, userAuthStateDir, workspaceSecretStore,
} from "@cotal-ai/workspace";
import { Manager } from "../src/manager.js";
import { NamespacePtyRuntime } from "../dist/runtime/namespace-pty.js";
import { capturePeerProcess, type LinuxProcessHandle } from "@cotal-ai/seat";
import { createServer } from "node:net";
import { once } from "node:events";
import { MANAGER_ENDPOINT, MANAGER_CONTRACTS } from "../src/manager-service-contract.js";
import { bootBroker } from "./_boot-broker.js";
import { bootDeliveryDaemon } from "./_boot-delivery.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const STUB = join(here, "fixtures/namespace-mesh-agent.mjs");
const controlRoot=mkdtempSync(join(tmpdir(), "nsmgr-"));
const observerName="cotal-nsmgr-"+randomUUID();
const observerNonce=randomUUID();
const peers=new Map<string, LinuxProcessHandle>();
let observerError:Error|undefined;
const observer=createServer(socket=>{let text="";socket.on("error",e=>{observerError=e;});socket.on("data",chunk=>{text+=chunk;if(!text.endsWith("\n"))return;socket.removeAllListeners("data");try{const v=JSON.parse(text);if(v.nonce!==observerNonce||!["main","tool"].includes(v.role))throw Error("observer identity mismatch");const key=v.generation+":"+v.role;if(peers.has(key))throw Error("duplicate observer identity");const peer=capturePeerProcess(socket);peers.set(key,peer);console.log(JSON.stringify({receipt:"native-peer",key,identity:peer.identity}));socket.end("+");}catch(e){observerError=e as Error;socket.destroy();}});});
observer.listen("\0"+observerName);await once(observer,"listening");
console.log(JSON.stringify({receipt:"control-root",controlRoot}));

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown): void => {
  if (v) { ok++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log("  ✗ FAIL:", n, extra === undefined ? "" : extra); }
};
const asValue = (e: unknown) => ({ code: (e as { code?: string }).code, message: String((e as Error).message).slice(0, 240) });

type ManagedRow = {
  name: string;
  id: string;
  lifecycleUid: string;
  handle: { pid?: number };
  issued?: { generation: string; acceptedToken: string };
  restart?: { recovering: boolean; armed: boolean; policy?: { restarts: number; windowMs: number } };
};

const waitFor = async (predicate: () => boolean, label: string, ms = 20_000): Promise<boolean> => {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) {
      c(`${label} settled in time`, false);
      return false;
    }
    await wait(50);
  }
  c(`${label} settled in time`, true);
  return true;
};

const space = `sup-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const broker = await bootBroker(auth);
const workspaceRoot = mkdtempSync(join(repoRoot, ".namespace-manager-"));
console.log(JSON.stringify({receipt:"workspace-root",workspaceRoot,brokerPid:broker.pid,brokerServers:broker.servers}));
mkdirSync(join(workspaceRoot, ".cotal", "agents"), { recursive: true });
saveSpaceAuth(authDir(workspaceRoot), auth);
// No role: the suite's spawner holds no issued evidence, so it hands on no role (SPEC 13.15).
writeFileSync(join(workspaceRoot, ".cotal", "agents", "seat.md"), "---\nname: seat\n---\n");
writeFileSync(join(workspaceRoot, ".cotal", "agents", "user.md"), "---\nname: user\n---\n");
writeFileSync(join(workspaceRoot, ".cotal", "agents", "ext.md"), "---\nname: ext\n---\n");

const spawnedOpts: LaunchOpts[] = [];
const envFor = (o: LaunchOpts): Record<string, string> => ({
  COTAL_SPACE: o.space, COTAL_SERVERS: String(o.servers ?? broker.servers), COTAL_CREDS: String(o.creds),
  COTAL_ID: String(o.id), COTAL_NAME: o.name, PATH: "/usr/bin:/bin",
  COTAL_NAMESPACE_OBSERVER:observerName,COTAL_NAMESPACE_NONCE:observerNonce,COTAL_NAMESPACE_GENERATION:String(spawnedOpts.length),COTAL_NAMESPACE_CRASH:join(workspaceRoot,"crash"),COTAL_NAMESPACE_EFFECT:join(workspaceRoot,"effect-"+spawnedOpts.length),
  ...(o.lifecycleUid ? { COTAL_LIFECYCLE_UID: o.lifecycleUid } : {}),
});
const stubCon: Connector = {
  kind: "connector",
  name: "supervise-stub",
  requires: ["node"],
  buildLaunch: (o): LaunchSpec => {
    spawnedOpts.push(o);
    return { command: "node", args: [STUB], env: envFor(o) };
  },
};
registry.register(stubCon);

const home = mkdtempSync(join(tmpdir(), "cotal-supervise-home-"));
const prevHome = process.env.COTAL_HOME;
process.env.COTAL_HOME = home;

let manager: Manager | undefined;
let delivery: Awaited<ReturnType<typeof bootDeliveryDaemon>> | undefined;
let runnerNc: Awaited<ReturnType<typeof connect>> | undefined;
let seatNc: Awaited<ReturnType<typeof connect>> | undefined;
let userMgr: Manager | undefined;

try {
  await setupSpaceStreams({ servers: broker.servers, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  delivery = await bootDeliveryDaemon({
    space, servers: broker.servers, auth,
    reloadStoreIdentity: workspaceSecretStore(workspaceRoot).identity,
  });

  manager = new Manager({ space, servers: broker.servers, runtime: "pty", workspaceRoot });
  await manager.start();
  const M = manager as unknown as { agents: Map<string, ManagedRow> };

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
    }, { deadlineMs: 20_000, currentEpoch: async () => 0 });
  const actx = (manager as unknown as { goalWriter: { ctx: Parameters<typeof readGoalResult>[0] } }).goalWriter.ctx;
  const resultOf = async (goalId: string, ms: number): Promise<Awaited<ReturnType<typeof readGoalResult>>> => {
    const until = Date.now() + ms;
    for (;;) {
      const fact = await readGoalResult(actx, { endpoint: MANAGER_ENDPOINT, caller: runner, goalId });
      if (fact !== undefined || Date.now() >= until) return fact;
      await wait(200);
    }
  };

  const unknown = await call("spawn", { name: "seat", agent: "supervise-stub", cwd: repoRoot, supervise: { restarts: 1, windowMs: 1000, extra: true } }).then((r) => r.reply, asValue);
  c("opStart refuses an unknown supervise key",
    /unknown key|additional propert/i.test(JSON.stringify(unknown)), unknown);

  const missing = await call("spawn", { name: "seat", agent: "supervise-stub", cwd: repoRoot, supervise: { restarts: 1 } }).then((r) => r.reply, asValue);
  c("opStart refuses a policy without windowMs",
    /windowMs/i.test(JSON.stringify(missing)), missing);

  // The stock PTY owns only the seat process, not detached tool sessions. Its policy must refuse
  // before connector build/provisioning. Recovery mechanics below use an explicitly bounded fixture.
  const refused = await call("spawn", {
    name: "seat", agent: "supervise-stub", cwd: repoRoot, events: false, supervise: { restarts: 1, windowMs: 60_000 },
  }, { id: "uncontained-seat".padEnd(43, "u") }).then((r) => r.reply, asValue);
  c("stock PTY refuses supervise without local-work closure", /cannot prove prior local work ended/.test(JSON.stringify(refused)), refused);
  c("refused supervise creates no seat and builds no connector", M.agents.size === 0 && spawnedOpts.length === 0);
  const runtime = new NamespacePtyRuntime(controlRoot, {bwrap:"/usr/bin/bwrap",unshare:"/usr/bin/unshare"});
  c("candidate still does not declare automatic restart support",(runtime as import("@cotal-ai/core").Runtime).supportsWorkClosure!==true);
  const nativeSpawn=runtime.spawn.bind(runtime);
  // Explicit test-only admission for this inert connector. The shipped adapter stays unregistered
  // and does not declare supportsWorkClosure. No cleanup behavior is substituted by the fixture.
  Object.assign(runtime,{supportsWorkClosure:true,spawn(...args:Parameters<typeof nativeSpawn>){
    if(args[1].command!=="node"||args[1].args[0]!==STUB)throw Error("fixture admits only the native test connector");
    return nativeSpawn(...args);
  }});
  (manager as unknown as {runtime:import("@cotal-ai/core").Runtime}).runtime=runtime;

  const spawnGoal = "spawn-seat".padEnd(43, "s");
  const spawned = await call("spawn", {
    name: "seat", agent: "supervise-stub", cwd: repoRoot, events: false, supervise: { restarts: 1, windowMs: 60_000 },
  }, { id: spawnGoal }).then((r) => r.reply, asValue);
  const readiness = await resultOf(spawnGoal, 60_000);
  c("the seat started under supervise",
    (spawned as { ok?: boolean }).ok === true && readiness?.state === "succeeded", { spawned, readiness });

  const row = M.agents.get("seat");
  const firstPid = row?.handle.pid;
  const firstId = row?.id;
  const firstUid = row?.lifecycleUid;
  c("the live seat has a process pid", typeof firstPid === "number" && firstPid > 0, firstPid);

  const seatCreds = firstUid
    ? readFileSync(agentLifecycleSecretFilePaths(workspaceRoot, space, "seat", firstUid).creds, "utf8")
    : "";
  const turnOf = (goalId: string, deadlineMs: number) => call("turn",
    { payload: JSON.stringify({ run: "r1", step: "turn:seat", context: "do the thing" }), deadlineMs },
    { id: goalId, target: { actor: row!.id, lifecycleUid: row!.lifecycleUid } });

  const g1 = "g1".padEnd(43, "a");
  const a1 = row ? await turnOf(g1, 600_000).then((r) => r.reply, asValue) : { ok: false, error: "no seat" };
  c("a turn is accepted against the live seat", (a1 as { ok?: boolean }).ok === true, a1);

  const pendingOf = (mgr: Manager): { seatDiedAt?: number } | undefined =>
    (mgr as unknown as { pendingTurns: Map<string, { seatDiedAt?: number }> }).pendingTurns.get(`${runner.owner}.${runner.actor}.${runner.uid}.${g1}`);

  await waitFor(()=>peers.has("1:main")&&peers.has("1:tool")||!!observerError,"predecessor kernel handles");
  if(observerError)throw observerError;
  const firstReference=(row!.handle as unknown as {reference:import("@cotal-ai/core").RuntimeReference}).reference;
  writeFileSync(join(workspaceRoot,"crash"),"crash\n");
  peers.get("1:main")!.signal("SIGKILL");

  const recovered = await waitFor(() => {
    const cur = M.agents.get("seat");
    return !!cur && cur.handle.pid !== undefined && cur.handle.pid !== firstPid && cur.restart?.recovering === false;
  }, "first recovery");
  const after = M.agents.get("seat");
  c("a supervised crash keeps the same managed row", recovered && after !== undefined && M.agents.has("seat"));
  c("a supervised crash keeps identity and lifecycle", after?.id === firstId && after?.lifecycleUid === firstUid, { id: after?.id, uid: after?.lifecycleUid, firstId, firstUid });
  c("the replacement process has a different pid", typeof after?.handle.pid === "number" && after.handle.pid !== firstPid, { firstPid, next: after?.handle.pid });
  c("a restart never replays fork source or initial prompt",
    spawnedOpts.length >= 2 && spawnedOpts[1]?.resume === undefined && spawnedOpts[1]?.prompt === undefined, spawnedOpts[1]);
  c("a pending turn is not stamped dead across a restart", pendingOf(manager) !== undefined && pendingOf(manager)?.seatDiedAt === undefined, pendingOf(manager));

  if (row && after) {
    seatNc = await connect({ servers: broker.servers, ...standaloneConnectOpts({ creds: seatCreds, tls: false }), maxReconnectAttempts: 0 });
    // The seat's credential is an issuance (SPEC 13.15): its rows live on the versioned rail, so
    // its caller carries the generation it discovers from the accepted row under its own grant.
    const seatRef = await readAcceptedRow(seatNc, space, after.issued!.acceptedToken);
    const seatTriple: EpCaller = { owner: DEV_OWNER, actor: after.id, uid: after.lifecycleUid, generation: seatRef.generation } as IssuedCaller;
    const seatService = await resolveService(seatNc, space, MANAGER_ENDPOINT, seatTriple);
    const pulled = await invokeCommand(seatNc, space, seatService, "turn-pending", undefined, { target: { mode: "self" }, deadlineMs: 10_000 }).then((r) => r.reply, asValue);
    const turns = ((pulled as { data?: { turns?: Array<{ goalId?: string }> } }).data?.turns ?? []);
    c("the replacement process can still pull the pending turn",
      (pulled as { ok?: boolean }).ok === true && turns.length === 1 && turns[0]?.goalId === g1, pulled);
    const y = await invokeCommand(seatNc, space, seatService, "turn-yield", { goalId: g1, status: "done", note: "after restart" }, { target: { mode: "self" }, deadlineMs: 10_000 }).then((r) => r.reply, asValue);
    c("the replacement process yields the same turn",
      (y as { ok?: boolean }).ok === true && (y as { data?: { state?: string } }).data?.state === "succeeded", y);
    await seatNc.drain().catch(() => seatNc?.close());
    seatNc = undefined;
  } else {
    c("the replacement process can still pull the pending turn", false, "no seat triple");
    c("the replacement process yields the same turn", false, "no seat triple");
  }

  c("predecessor detached tool is closed before successor is used",peers.get("1:tool")!.hasExited());
  c("predecessor namespace closure journaled",JSON.parse(readFileSync(join(controlRoot,firstReference.id,"record.json"),"utf8")).closed===true);
  await wait(1000);
  c("predecessor tool made no delayed effect",!existsSync(join(workspaceRoot,"effect-1")));
  c("successor has a distinct captured process identity",peers.has("2:main")&&peers.get("2:main")!.identity.pid!==peers.get("1:main")!.identity.pid);
} finally {
  await seatNc?.drain().catch(() => seatNc?.close());
  await runnerNc?.drain().catch(() => runnerNc?.close());
  await userMgr?.stop({ withAgents: true }).catch(() => {});
  await manager?.stop({ withAgents: true }).catch(() => {});
  const closureRecords=readdirSync(controlRoot).filter(name=>/^[a-f0-9]{32}$/.test(name)).map(name=>JSON.parse(readFileSync(join(controlRoot,name,"record.json"),"utf8")));
  c("normal manager shutdown also persists namespace closure",closureRecords.length===2&&closureRecords.every(record=>record.closed===true));
  await delivery?.stop().catch(() => {});
  await broker.stop().catch(() => {});
  for(const peer of peers.values()){if(!peer.hasExited())peer.signal("SIGKILL");await peer.waitForExit({signal:AbortSignal.timeout(5000)});peer.close();}
  await new Promise<void>(resolve=>observer.close(()=>resolve()));
  if (prevHome === undefined) delete process.env.COTAL_HOME;
  else process.env.COTAL_HOME = prevHome;
}

const EXPECTED = 22;
const ran = ok + fail;
console.log(`namespace manager smoke: ${ok} passed, ${fail} failed`);
if (ran !== EXPECTED) {
  console.log(`SUITE INCOMPLETE — ran ${ran} of ${EXPECTED} cells; a partial run is not a pass`);
  process.exit(1);
}
process.exit(fail === 0 ? 0 : 1);
