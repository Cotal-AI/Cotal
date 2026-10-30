import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import {
  createSpaceAuth, DEV_OWNER, invokeCommand, mintAcceptedToken, mintCreds, mintGeneration,
  mintLifecycleUid, newIdentity, newTakeoverId, openChannelRegistry, openMembersRegistry,
  readChannelConfig, listMembers, replayRunJournal, resolveService, setupSpaceStreams, readAcl, openAclRegistry, channelInAllow,
  standaloneConnectOpts, withIssuerSession, type IssuedCaller, type EndpointReply,
} from "@cotal-ai/core";
import { authDir, recordMesh, saveSpaceAuth, workspaceSecretStore } from "@cotal-ai/workspace";
import { Manager } from "@cotal-ai/manager";
import "@cotal-ai/runtime";
import { bootBroker } from "../../implementations/manager/smoke/_boot-broker.js";
import { bootDeliveryDaemon } from "../../implementations/manager/smoke/_boot-delivery.js";

type Check = (name: string, condition: boolean, extra?: unknown) => void;
interface Entry {
  kind: string;
  state: string;
  status?: string;
  closed?: boolean;
  result?: unknown;
  external?: Record<string, unknown>;
}
interface TerminalSlot {
  slotLifecycleUid?: string;
  slotPhase?: string;
  cleanupComplete?: boolean;
  headState?: string;
  headLifecycleUid?: string;
  live?: boolean;
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Real issuance is required here: an open Manager mints no lifecycle ACL and performs no
 * authenticated retirement. Public checkpoints keep join, close and final retirement distinct. */
export async function checkSpawnConclave(c: Check): Promise<void> {
  const space = "langspawnconclave";
  const home = mkdtempSync(join(tmpdir(), "cotal-langspawn-conclave-home-"));
  const previousHome = process.env.COTAL_HOME;
  process.env.COTAL_HOME = home;
  const root = mkdtempSync(join(tmpdir(), "cotal-langspawn-conclave-"));
  const auth = await createSpaceAuth(space);
  const broker = await bootBroker(auth);
  let manager: Manager | undefined;
  let delivery: Awaited<ReturnType<typeof bootDeliveryDaemon>> | undefined;
  let callerNc: Awaited<ReturnType<typeof connect>> | undefined;
  let readerNc: Awaited<ReturnType<typeof connect>> | undefined;
  let psNc: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    mkdirSync(join(root, ".cotal", "agents"), { recursive: true });
    // The room is handler-derived, so this throwaway persona explicitly admits generated rooms.
    // No production grant is modified. The Manager's real mint writes this lifecycle's ACL.
    writeFileSync(join(root, ".cotal", "agents", "wf3.md"),
      "---\nname: wf3\nrole: worker\nagent: join\nsubscribe: []\nallowSubscribe: [\">\"]\nallowPublish: []\n---\n");
    saveSpaceAuth(authDir(root), auth);
    await setupSpaceStreams({ servers: broker.servers, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
    recordMesh({ space, server: broker.servers, root, mode: "auth", ts: new Date().toISOString() });
    delivery = await bootDeliveryDaemon({ space, servers: broker.servers, auth, reloadStoreIdentity: workspaceSecretStore(root).identity });
    manager = new Manager({ space, servers: broker.servers, runtime: "pty", workspaceRoot: root });
    await manager.start();
    const id = newIdentity();
    const uid = mintLifecycleUid();
    const issued = { generation: mintGeneration(Math.floor(Date.now() / 1000) + 3600), acceptedToken: mintAcceptedToken() };
    const caller: IssuedCaller = { owner: DEV_OWNER, actor: id.id, uid, generation: issued.generation };
    const creds = await withIssuerSession({ servers: broker.servers, space, auth, tls: false }, (s) =>
      mintCreds(auth, id, "agent", { lifecycleUid: uid, capabilities: ["run"], allowSubscribe: [">"], allowPublish: [">"],
        expiresInSeconds: 3600, issued, issuance: { mode: "issue", store: s.store, accepted: s.accepted, sources: [] } }));
    callerNc = await connect({ servers: broker.servers, ...standaloneConnectOpts({ creds, tls: false }), maxReconnectAttempts: 0 });
    const service = await resolveService(callerNc, space, "manager", caller);
    const call = async (command: string, args?: Record<string, unknown>): Promise<EndpointReply> =>
      (await invokeCommand(callerNc!, space, service, command, args, { deadlineMs: 30_000,
        currentEpoch: async () => service.responder.epoch,
        ...(command === "run-answer" ? { target: { mode: "self" as const } } : {}),
      })).reply;
    // The daemon's existing profile can read the actual membership registry. No test writes rows.
    readerNc = await connect({ servers: broker.servers,
      ...standaloneConnectOpts({ creds: await mintCreds(auth, newIdentity(), "delivery"), tls: false }), maxReconnectAttempts: 0 });
    const members = await openMembersRegistry(readerNc, space);
    const channels = await openChannelRegistry(readerNc, space);
    const started = await call("run-start", { source: `
const d = await spawn("wf3");
const r = await conclave([d], async (room) => {
  log("room", room.channel);
  await checkpoint("joined", "Observe the joined membership", { timeout: "2m" });
  return room.channel;
}, { name: "standup" });
log("done", r);
await checkpoint("closed", "Observe the closed membership before retirement", { timeout: "2m" });
` });
    const runId = (started.data as { runId?: string } | undefined)?.runId;
    if (!started.ok || runId === undefined) throw new Error(`conclave run-start refused: ${JSON.stringify(started.error)}`);
    const entries = async (): Promise<Entry[]> => {
      const takeoverId = newTakeoverId();
      const nc = await connect({ servers: broker.servers, ...standaloneConnectOpts({
        creds: await mintCreds(auth, newIdentity(), "run-operator", { runOperator: { endpoint: "manager", runId, takeoverId } }), tls: false,
      }), maxReconnectAttempts: 0 });
      try {
        const back = await replayRunJournal(jetstream(nc), await jetstreamManager(nc), space, runId, takeoverId);
        return back.records.filter((r) => r.record.kind === "step").map((r) => (r.record as { entry: unknown }).entry as Entry);
      } finally { await nc.drain(); }
    };
    const paused = async (asks: string): Promise<boolean> => {
      const until = Date.now() + 30_000;
      while (Date.now() < until) {
        const reply = await call("run-status", { runId });
        const view = reply.data as { journal?: Array<{ kind: string; asks?: string; state?: string }> } | undefined;
        if (!reply.ok) throw new Error(`conclave run-status refused: ${JSON.stringify(reply.error)}`);
        if (view?.journal?.some((r) => r.kind === "step" && r.state === "pending" && r.asks === asks)) return true;
        await wait(400);
      }
      return false;
    };
    const psId = newIdentity();
    const psCaller = { owner: DEV_OWNER, actor: psId.id, uid: mintLifecycleUid() };
    psNc = await connect({ servers: broker.servers, ...standaloneConnectOpts({
      creds: await mintCreds(auth, psId, "control-caller-privileged", { lifecycleUid: psCaller.uid }), tls: false,
    }), maxReconnectAttempts: 0 });
    const psService = await resolveService(psNc, space, "manager", psCaller);
    const seatAlive = async (): Promise<boolean> => {
      const reply = (await invokeCommand(psNc!, space, psService, "ps", undefined, { deadlineMs: 10_000 })).reply;
      if (!reply.ok) throw new Error(`conclave ps refused: ${JSON.stringify(reply.error)}`);
      return (reply.data as Array<{ name: string }>).some((r) => r.name === "wf3");
    };
    const answer = async (stepKey: string): Promise<void> => {
      const reply = await call("run-answer", { runId, stepKey, value: true });
      if (!reply.ok) throw new Error(`conclave run-answer refused: ${JSON.stringify(reply.error)}`);
    };
    const inside = await paused("Observe the joined membership");
    c("the real workflow pauses inside the conclave after its join", inside);
    if (!inside) throw new Error("conclave never reached its joined checkpoint");
    const joinedEntries = await entries();
    const spawnEntry = joinedEntries.find((e) => e.kind === "spawn" && e.state === "settled");
    const handle = String((spawnEntry?.result as { agent?: unknown } | undefined)?.agent ?? "");
    const seatUid = handle.slice(handle.lastIndexOf("#") + 1);
    const plan = joinedEntries.filter((e) => e.kind === "conclave" && e.state === "pending").at(-1)?.external as
      { channel?: string; members?: Array<{ uid?: string; principal?: string; generation?: number; joined?: boolean }> } | undefined;
    const channel = plan?.channel;
    if (channel === undefined) throw new Error("conclave has no recorded channel");
    c("the plan pinned the REAL seat's incarnation, resolved from its own presence row",
      plan?.members?.length === 1 && plan.members[0]?.uid === seatUid && seatUid.length >= 26, plan);
    const joined = await listMembers(members, { channel });
    const member = plan?.members?.[0];
    if (member?.principal === undefined) throw new Error("conclave member has no principal");
    const acl = await readAcl(await openAclRegistry(readerNc, space), member.principal, seatUid);
    c("the real Manager issued the exact member lifecycle's read ACL for the conclave",
      acl !== undefined && channelInAllow(acl.record.allowSubscribe, channel), acl?.record);
    console.log("  membership phase joined", JSON.stringify({ handle, plan, rows: joined }));
    c("one active membership row was actually written for the real seat before the body returns",
      plan?.members?.[0]?.joined === true && joined.length === 1 && joined[0]?.lifecycleUid === seatUid
        && joined[0]?.owner === plan?.members?.[0]?.principal && joined[0]?.state === "durable-active"
        && joined[0]?.leaveCursor === undefined && joined[0]?.activated === true
        && joined[0]?.generation === plan?.members?.[0]?.generation, joined);
    c("the minted channel exists while the conclave is open", (await readChannelConfig(channels, channel)) !== undefined);
    c("the joined seat is still live in the real manager", await seatAlive());
    await answer("/conclave:standup#0/b:in/checkpoint:joined#0");
    const outside = await paused("Observe the closed membership before retirement");
    c("the real workflow pauses after the close and before final retirement", outside);
    if (!outside) throw new Error("conclave never reached its closed checkpoint");
    const settled = (await entries()).find((e) => e.kind === "conclave" && e.state === "settled");
    c("the conclave entry settles ok with the closed fact", settled?.status === "ok" && settled.closed === true,
      { status: settled?.status, closed: settled?.closed });
    const closed = await listMembers(members, { channel });
    console.log("  membership phase closed", JSON.stringify({ handle, rows: closed }));
    c("one membership row was written for the seat and tombstoned by the close",
      joined.length === 1 && closed.length === 1 && closed[0]?.lifecycleUid === seatUid
        && closed[0]?.owner === plan?.members?.[0]?.principal && closed[0]?.leaveCursor !== undefined
        && closed[0]?.state === "live-confirmed" && closed[0]?.generation === joined[0]?.generation
        && closed[0]?.joinCursor === joined[0]?.joinCursor, closed);
    c("the minted channel's registry row is gone after the close", (await readChannelConfig(channels, channel)) === undefined);
    c("the closed membership is observed before the manager retires its seat", await seatAlive());
    await answer("/checkpoint:closed#0");
    let state: string | undefined;
    const until = Date.now() + 30_000;
    while (state !== "completed" && Date.now() < until) {
      const reply = await call("run-status", { runId });
      if (!reply.ok) throw new Error(`conclave final run-status refused: ${JSON.stringify(reply.error)}`);
      state = (reply.data as { status?: { state?: string } } | undefined)?.status?.state;
      if (state !== "completed") await wait(400);
    }
    c("the conclave run completes", state === "completed", state);
    // Run completion releases the seat but its credential barrier can still be in flight.
    // Observe the public exact-UID terminal slot, not a delay or an already-empty membership scan.
    let terminal: TerminalSlot | undefined;
    const retirementUntil = Date.now() + 30_000;
    while (Date.now() < retirementUntil) {
      const reply = (await invokeCommand(psNc!, space, psService, "slots", { names: ["wf3"], includeRetired: true }, { deadlineMs: 10_000 })).reply;
      if (!reply.ok) throw new Error(`conclave slots refused: ${JSON.stringify(reply.error)}`);
      terminal = (reply.data as TerminalSlot[])
        .find((r) => r.slotLifecycleUid === seatUid);
      if (terminal?.slotPhase === "retired" && terminal.cleanupComplete === true) break;
      await wait(400);
    }
    c("the real manager records final retirement and cleanup for the exact seat lifecycle",
      terminal?.slotLifecycleUid === seatUid && terminal.slotPhase === "retired" && terminal.cleanupComplete === true
        && terminal.headState === "retired" && terminal.headLifecycleUid === seatUid && terminal.live === false, terminal);
    const retired = await listMembers(members, { channel });
    console.log("  membership phase retired", JSON.stringify({ handle, terminal, rows: retired }));
    c("final retirement removes the previously observed membership footprint",
      joined.length === 1 && closed.length === 1 && retired.length === 0, retired);
    c("the completed conclave run released its real seat", !(await seatAlive()));
  } finally {
    await manager?.stop({ withAgents: true });
    await readerNc?.drain();
    await psNc?.drain();
    await callerNc?.drain();
    await delivery?.stop();
    await broker.stop();
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.COTAL_HOME;
    else process.env.COTAL_HOME = previousHome;
  }
}
