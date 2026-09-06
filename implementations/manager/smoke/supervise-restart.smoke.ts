/**
 * A spawn carrying `supervise` restarts the process in place until the budget is spent.
 *
 * Live: a JWT-auth scratch broker, the real Manager, a real stub process that joins presence.
 * SIGKILL is the crash. Identity and lifecycle stay. A pending turn is still pullable after the
 * first restart and yieldable from the replacement process. Spending the budget retires the seat
 * (supervise-crash-loop). A relaunch that never joins presence retires (supervise-recovery-failed).
 * A host that cannot honour the policy (user-mode, non-pty) refuses at accept.
 *
 * Run: pnpm smoke:manager-supervise-restart   (needs nats-server + node on PATH)
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "@nats-io/transport-node";
import {
  createSpaceAuth, mintCreds, newIdentity, mintLifecycleUid, standaloneConnectOpts, setupSpaceStreams,
  DEV_OWNER, epCall, invokeCommand, resolveService, readGoalResult, registry,
  type Connector, type EpCaller, type LaunchOpts, type LaunchSpec,
} from "@cotal-ai/core";
import {
  authDir, saveSpaceAuth, agentLifecycleSecretFilePaths, recordMesh, removeMesh, userAuthStateDir,
} from "@cotal-ai/workspace";
import { Manager } from "../src/manager.js";
import { MANAGER_ENDPOINT, MANAGER_CONTRACTS } from "../src/manager-service-contract.js";
import { bootBroker } from "./_boot-broker.js";
import { bootDeliveryDaemon } from "./_boot-delivery.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const STUB = join(here, "e2e-stub.mjs");

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
const workspaceRoot = mkdtempSync(join(tmpdir(), "cotal-supervise-restart-"));
mkdirSync(join(workspaceRoot, ".cotal", "agents"), { recursive: true });
saveSpaceAuth(authDir(workspaceRoot), auth);
writeFileSync(join(workspaceRoot, ".cotal", "agents", "seat.md"), "---\nname: seat\nrole: worker\n---\n");
writeFileSync(join(workspaceRoot, ".cotal", "agents", "user.md"), "---\nname: user\nrole: worker\n---\n");
writeFileSync(join(workspaceRoot, ".cotal", "agents", "ext.md"), "---\nname: ext\nrole: worker\n---\n");

const spawnedOpts: LaunchOpts[] = [];
const envFor = (o: LaunchOpts): Record<string, string> => ({
  COTAL_SPACE: o.space, COTAL_SERVERS: String(o.servers ?? broker.servers), COTAL_CREDS: String(o.creds),
  COTAL_ID: String(o.id), COTAL_NAME: o.name, PATH: process.env.PATH ?? "",
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
  delivery = await bootDeliveryDaemon({ space, servers: broker.servers, auth });

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

  const spawnGoal = "spawn-seat".padEnd(43, "s");
  const spawned = await call("spawn", {
    name: "seat", agent: "supervise-stub", cwd: repoRoot, supervise: { restarts: 1, windowMs: 60_000 },
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
  const seatTriple: EpCaller | undefined = row
    ? { owner: DEV_OWNER, actor: row.id, uid: row.lifecycleUid }
    : undefined;
  const turnOf = (goalId: string, deadlineMs: number) => call("turn",
    { payload: JSON.stringify({ run: "r1", step: "turn:seat", context: "do the thing" }), deadlineMs },
    { id: goalId, target: { actor: row!.id, lifecycleUid: row!.lifecycleUid } });

  const g1 = "g1".padEnd(43, "a");
  const a1 = row ? await turnOf(g1, 600_000).then((r) => r.reply, asValue) : { ok: false, error: "no seat" };
  c("a turn is accepted against the live seat", (a1 as { ok?: boolean }).ok === true, a1);

  const pendingOf = (mgr: Manager): { seatDiedAt?: number } | undefined =>
    (mgr as unknown as { pendingTurns: Map<string, { seatDiedAt?: number }> }).pendingTurns.get(g1);

  if (typeof firstPid === "number") {
    try { process.kill(firstPid, "SIGKILL"); } catch (e) { c("SIGKILL the live pid", false, e); }
  }

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
  c("a pending turn is not stamped dead across a restart", pendingOf(manager)?.seatDiedAt === undefined, pendingOf(manager));

  if (seatTriple && after) {
    seatNc = await connect({ servers: broker.servers, ...standaloneConnectOpts({ creds: seatCreds, tls: false }), maxReconnectAttempts: 0 });
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

  const secondPid = M.agents.get("seat")?.handle.pid;
  const launchesBeforeSpend = spawnedOpts.length;
  if (typeof secondPid === "number") {
    try { process.kill(secondPid, "SIGKILL"); } catch (e) { c("SIGKILL the replacement pid", false, e); }
  }
  await waitFor(() => !M.agents.has("seat"), "spent budget");
  c("spending the restart budget starts no further replacement", spawnedOpts.length === launchesBeforeSpend, spawnedOpts.length);
  c("a spent supervise budget retires the seat", !M.agents.has("seat"));

  writeFileSync(join(workspaceRoot, ".cotal", "agents", "fail.md"), "---\nname: fail\nrole: worker\n---\n");
  const failGoal = "spawn-fail".padEnd(43, "f");
  const failSpawned = await call("spawn", {
    name: "fail", agent: "supervise-stub", cwd: repoRoot, supervise: { restarts: 2, windowMs: 60_000 },
  }, { id: failGoal }).then((r) => r.reply, asValue);
  const failReady = await resultOf(failGoal, 60_000);
  const failRow = M.agents.get("fail");
  c("a second supervised seat started so a failed relaunch can be observed",
    (failSpawned as { ok?: boolean }).ok === true && failReady?.state === "succeeded" && failRow !== undefined, { failSpawned, failReady });
  const failPid = failRow?.handle.pid;
  // The next recoverManagedSession calls the same connector.buildLaunch. Point it at a
  // command that is not on PATH so the live PtyRuntime.spawn throws; that is the
  // supervise-recovery-failed catch, without wrapping Manager.runtime.
  const previousBuild = stubCon.buildLaunch;
  const origErr = console.error;
  const logs: string[] = [];
  try {
    stubCon.buildLaunch = (o) => ({ command: "cotal-supervise-missing-binary", args: [], env: envFor(o) });
    console.error = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
      origErr.apply(console, args);
    };
    if (typeof failPid === "number") {
      try { process.kill(failPid, "SIGKILL"); } catch (e) { c("SIGKILL the fail pid", false, e); }
    }
    await waitFor(() => !M.agents.has("fail"), "failed relaunch", 15_000);
  } finally {
    console.error = origErr;
    stubCon.buildLaunch = previousBuild;
  }
  c("a failed supervised relaunch retires the seat",
    !M.agents.has("fail") && logs.some((l) => l.includes("this manager retired it after a supervised restart failed")),
    logs.filter((l) => /fail|reap|restart/i.test(l)).slice(-6));

  const userRoot = mkdtempSync(join(tmpdir(), "cotal-supervise-user-"));
  mkdirSync(join(userRoot, ".cotal", "agents"), { recursive: true });
  saveSpaceAuth(authDir(userRoot), auth);
  writeFileSync(join(userRoot, ".cotal", "agents", "user.md"), "---\nname: user\nrole: worker\n---\n");
  mkdirSync(userAuthStateDir(userRoot, space), { recursive: true });
  writeFileSync(join(userAuthStateDir(userRoot, space), "idp.json"), "{}\n");
  recordMesh({ space, server: broker.servers, root: userRoot, mode: "user", ts: new Date().toISOString() });
  userMgr = new Manager({ space, servers: broker.servers, runtime: "pty", workspaceRoot: userRoot });
  await userMgr.start();
  const user = await userMgr.startAgent({ name: "user", agent: "supervise-stub", cwd: repoRoot, supervise: { restarts: 1, windowMs: 1_000 } });
  c("user-mode refuses supervise at accept",
    user.ok === false && (user.error ?? "").includes("a user-mode seat has no static slot"), user);
  await userMgr.stop().catch(() => {});
  userMgr = undefined;
  removeMesh(space);

  // The accept check is `this.runtime.kind !== "pty"` before any spawn. Flip the live manager's
  // kind in place rather than starting a second instance on the same workspace (the lease refuses
  // that). Restore pty before teardown.
  const liveRuntime = (manager as unknown as { runtime: { kind: string } }).runtime;
  const previousKind = liveRuntime.kind;
  liveRuntime.kind = "tmux";
  const ext = await manager.startAgent({ name: "ext", agent: "supervise-stub", cwd: repoRoot, supervise: { restarts: 1, windowMs: 1_000 } });
  c("a non-pty runtime refuses supervise at accept", ext.ok === false && (ext.error ?? "").includes("runtime \"tmux\""), ext);
  liveRuntime.kind = previousKind;
} finally {
  await seatNc?.drain().catch(() => seatNc?.close());
  await runnerNc?.drain().catch(() => runnerNc?.close());
  await userMgr?.stop().catch(() => {});
  await manager?.stop().catch(() => {});
  await delivery?.stop().catch(() => {});
  await broker.stop().catch(() => {});
  if (prevHome === undefined) delete process.env.COTAL_HOME;
  else process.env.COTAL_HOME = prevHome;
}

const EXPECTED = 21;
const ran = ok + fail;
console.log(`supervise restart smoke: ${ok} passed, ${fail} failed`);
if (ran !== EXPECTED) {
  console.log(`SUITE INCOMPLETE — ran ${ran} of ${EXPECTED} cells; a partial run is not a pass`);
  process.exit(1);
}
process.exit(fail === 0 ? 0 : 1);
