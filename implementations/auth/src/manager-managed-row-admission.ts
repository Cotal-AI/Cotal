import {
  GOAL_TERMINAL_STATES,
  DEV_OWNER,
  RECORD_KINDS,
  canonicalJson,
  epAuthBucket,
  epgateKey,
  parseEndpointGate,
  parseGoalIndexEntry,
  principalKey,
  patternInAllow,
  readGoalBindByRefLeader,
  readGoalSpecByRefLeader,
  readGoalStatusByRefLeader,
  readRecordLeader,
  recordAtomicKey,
  type EpCaller,
  type EndpointGateRow,
  type GoalBindFact,
  type GoalIndexEntry,
  type GoalSpecValue,
  type GoalStatusValue,
  type ManagedRowIntent,
} from "@cotal-ai/core";
import type { JetStreamManager } from "@nats-io/jetstream";

/** Fixed local serving registration coordinates committed into a requester nonce before mint. */
export interface LocalManagerCurrency {
  kind: "local-manager";
  instanceId: string;
  processEpoch: number;
  serveActor: string;
}

/** Endpoint-goal custody retained by the manager before native create. The original user caller is
 * separate from the current manager requester. A restart may rotate manager attempt credentials,
 * but may never rewrite these accepted goal/child coordinates. */
export interface ManagerEndpointAdmissionCustody {
  kind: "endpoint-goal";
  originalCaller: EpCaller;
  goalId: string;
  acceptingInstanceId: string;
  fingerprint: string;
  acceptedEpoch: number;
  operationId: string;
  target: { owner: string; actor: string; lifecycleUid: string };
}

export interface ManagerManagedRowAdmissionReaders {
  /** Exact leader point-read of epgate.manager.<instanceId>. */
  readManagerGate(instanceId: string): Promise<EndpointGateRow | undefined>;
  /** Exact accepted-goal reads. No raw key/filter/handle escapes this helper. */
  readGoalIndex(ref: { endpoint: "manager"; caller: EpCaller; goalId: string }): Promise<GoalIndexEntry | undefined>;
  readGoalBind(ref: { endpoint: "manager"; caller: EpCaller; goalId: string }): Promise<GoalBindFact | undefined>;
  readGoalSpec(ref: { endpoint: "manager"; caller: EpCaller; goalId: string }): Promise<{ value: GoalSpecValue; revision: number } | undefined>;
  readGoalStatus(ref: { endpoint: "manager"; caller: EpCaller; goalId: string }): Promise<GoalStatusValue | undefined>;
  /** Fresh user ledger/delegation decision for the original authenticated spawn caller and child. */
  authorizeOriginalSpawn(input: { caller: EpCaller; intent: Extract<ManagedRowIntent, { command: "create-managed-row" }> }): Promise<void>;
}

/** Construct the exact fixed-space leader readers. The returned object exposes only closed
 * manager admission operations, never JSM/KV/NATS handles or caller-selected keys/filters. */
export function managerManagedRowAdmissionReaders(input: {
  space: string;
  jsm: JetStreamManager;
  authorizeOriginalSpawn: ManagerManagedRowAdmissionReaders["authorizeOriginalSpawn"];
}): ManagerManagedRowAdmissionReaders {
  const { space, jsm } = input;
  return Object.freeze({
    async readManagerGate(instanceId: string) {
      const key = epgateKey("manager", instanceId);
      let message;
      try { message = await jsm.streams.getMessage(`KV_${epAuthBucket(space)}`, { last_by_subj: `$KV.${epAuthBucket(space)}.${key}` }); }
      catch (error) { if ((error as { code?: unknown }).code === 10037) return undefined; throw error; }
      if (!message) return undefined;
      const operation = message.header?.get("KV-Operation");
      if (operation) throw new Error(`manager serving gate ${key} carries a ${operation} marker`);
      return parseEndpointGate(message.data, key);
    },
    async readGoalIndex(ref: { endpoint: "manager"; caller: EpCaller; goalId: string }) {
      const key = recordAtomicKey(RECORD_KINDS.goalidx, [ref.endpoint, ref.caller.owner, ref.caller.actor, ref.caller.uid, ref.goalId]);
      const entry = await readRecordLeader(jsm, space, key);
      return entry === undefined ? undefined : parseGoalIndexEntry(entry.value, key);
    },
    readGoalBind: (ref: { endpoint: "manager"; caller: EpCaller; goalId: string }) => readGoalBindByRefLeader(jsm, space, ref),
    readGoalSpec: (ref: { endpoint: "manager"; caller: EpCaller; goalId: string }) => readGoalSpecByRefLeader(jsm, space, ref),
    readGoalStatus: (ref: { endpoint: "manager"; caller: EpCaller; goalId: string }) => readGoalStatusByRefLeader(jsm, space, ref),
    authorizeOriginalSpawn: input.authorizeOriginalSpawn,
  });
}

/** Own the dedicated admission reader client. Any failure after connection open closes it before
 * propagating. `close()` is idempotent and is the single service fence/shutdown path. */
export async function openManagerManagedRowAdmissionPlane(input: {
  space: string;
  open(): Promise<{ jsm: JetStreamManager; close(): Promise<void> }>;
  authorizeOriginalSpawn: ManagerManagedRowAdmissionReaders["authorizeOriginalSpawn"];
  afterOpen?: () => Promise<void>;
}): Promise<{ readers: ManagerManagedRowAdmissionReaders; close(): Promise<void> }> {
  let client: { jsm: JetStreamManager; close(): Promise<void> } | undefined;
  try {
    client = await input.open();
    await input.afterOpen?.();
    const readers = managerManagedRowAdmissionReaders({ space: input.space, jsm: client.jsm, authorizeOriginalSpawn: input.authorizeOriginalSpawn });
    let closed = false;
    return { readers, close: async () => { if (closed) return; closed = true; await client!.close(); } };
  } catch (error) {
    await client?.close().catch(() => {});
    throw error;
  }
}

const sameCaller = (a: EpCaller, b: EpCaller): boolean => a.owner === b.owner && a.actor === b.actor && a.uid === b.uid;

export function assertOriginalManagerSpawnDelegation(input: {
  caller: EpCaller;
  intent: Extract<ManagedRowIntent, { command: "create-managed-row" }>;
  grant: { lifecycleUid?: string; scope?: string[]; allowSubscribe?: string[]; allowPublish?: string[] };
}): void {
  const { caller, intent, grant } = input;
  if (intent.target.owner !== caller.owner || intent.parent !== `${caller.owner}.${caller.actor}`)
    throw new Error("managed-row child owner/parent does not exactly name the original endpoint caller");
  const scope = grant.scope ?? [], allowSubscribe = grant.allowSubscribe ?? [], allowPublish = grant.allowPublish ?? [];
  if (grant.lifecycleUid !== caller.uid || !scope.includes("spawn")) throw new Error("original endpoint caller is stale or lacks current spawn scope");
  const overScope = intent.scope.filter((entry) => !scope.includes(entry));
  const overSub = intent.allowSubscribe.filter((entry) => !patternInAllow(allowSubscribe, entry));
  const overPub = intent.allowPublish.filter((entry) => !patternInAllow(allowPublish, entry));
  if (overScope.length || overSub.length || overPub.length || (intent.role && !scope.includes(`role:${intent.role}`)))
    throw new Error("managed-row child policy exceeds the original caller's current delegation grant");
}

/** Closed production decision for endpoint-originated create. Call for both initial and final phase.
 * UID LIMITATION: the gate certifies the stable serving principal + epoch, not managerLifecycleUid.
 * The caller uid remains credential-bound attribution and is included in the nonce commitment. */
export async function admitManagerManagedRow(input: {
  space: string;
  caller: EpCaller;
  intent: ManagedRowIntent;
  currency: LocalManagerCurrency;
  custody: ManagerEndpointAdmissionCustody;
  readers: ManagerManagedRowAdmissionReaders;
  /** Internal boot recovery has no requester credential and the gate certifies no UID. */
  recovery?: boolean;
}): Promise<void> {
  const { caller, intent, currency, custody, readers } = input;
  if (intent.command !== "create-managed-row") throw new Error("manager endpoint-goal admission authorizes only create-managed-row");
  if (intent.space !== input.space) throw new Error("managed-row intent names a foreign space");
  if (currency.kind !== "local-manager" || typeof currency.serveActor !== "string" || currency.serveActor.length === 0 || !Number.isSafeInteger(currency.processEpoch) || currency.processEpoch < 0)
    throw new Error("local manager currency is malformed");
  if (caller.owner !== DEV_OWNER || caller.actor !== currency.serveActor || (!input.recovery && caller.uid.length === 0))
    throw new Error("managed-row requester is not the retained local manager serve identity");
  const gate = await readers.readManagerGate(currency.instanceId);
  if (!gate || gate.state !== "open") throw new Error("local manager has no current open serving registration");
  if (gate.principal !== principalKey(caller.owner, caller.actor).key) throw new Error("local manager serving gate belongs to a foreign requester principal");
  if (gate.processEpoch !== currency.processEpoch) throw new Error("local manager serving process epoch is stale");
  if (custody.kind !== "endpoint-goal" || canonicalJson(custody.target) !== canonicalJson(intent.target))
    throw new Error("managed-row target does not match retained endpoint-goal child allocation");
  if (custody.acceptingInstanceId !== currency.instanceId)
    throw new Error("managed-row currency names a foreign manager instance; restart adoption retains the persisted accepting instance id");
  const ref = { endpoint: "manager" as const, caller: custody.originalCaller, goalId: custody.goalId };
  const [index, bind, spec, status] = await Promise.all([
    readers.readGoalIndex(ref), readers.readGoalBind(ref), readers.readGoalSpec(ref), readers.readGoalStatus(ref),
  ]);
  if (!index || !index.allocated || index.endpoint !== "manager" || index.iid !== custody.acceptingInstanceId ||
      index.owner !== custody.originalCaller.owner || index.actor !== custody.originalCaller.actor || index.uid !== custody.originalCaller.uid ||
      index.goalId !== custody.goalId || index.allocated.name !== intent.target.actor || index.allocated.actor !== intent.target.actor || index.allocated.uid !== intent.target.lifecycleUid)
    throw new Error("managed-row create has no exact accepted manager goal index allocation");
  if (!bind || bind.goalId !== custody.goalId || bind.fingerprint !== custody.fingerprint)
    throw new Error("managed-row create has no matching immutable goal bind");
  if (custody.operationId !== intent.operationId) throw new Error("managed-row operation does not match retained endpoint-goal custody");
  if (!spec || spec.value.goalId !== custody.goalId || spec.value.requestId !== custody.goalId || spec.value.fingerprint !== custody.fingerprint || spec.value.command !== "spawn" ||
      spec.value.caller.id !== `${custody.originalCaller.owner}.${custody.originalCaller.actor}` || spec.value.caller.lifecycleUid !== custody.originalCaller.uid ||
      spec.value.acceptedEpoch !== custody.acceptedEpoch || custody.acceptedEpoch > currency.processEpoch || spec.value.sourceSeq !== 0)
    throw new Error("managed-row create has no matching accepted manager spawn spec");
  if (!status || status.observedSpecRevision !== spec.revision || !["accepted", "running", "waiting"].includes(status.state))
    throw new Error(`managed-row create goal is missing, cancelling, or terminal`);
  if (!sameCaller(custody.originalCaller, ref.caller)) throw new Error("managed-row original caller custody changed");
  await readers.authorizeOriginalSpawn({ caller: custody.originalCaller, intent });
}
