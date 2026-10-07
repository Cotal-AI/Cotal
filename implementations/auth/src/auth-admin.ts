/**
 * The AUTH service's ENDPOINT listener (#29 piece 3; Cotal #350): the GENERIC "retire a lifecycle
 * (owner, actor, lifecycleUid)" operation, served by the auth plane itself — the despawn→retirement
 * trigger's serve side, and the D5 split's other half (retirement is the AUTH plane's operation; it
 * never rides the DELIVERY daemon's rail).
 *
 * THE RAIL: `ep.one.auth.retire-lifecycle.handle.<tO>.<tA>.<tUid>.<cO>.<cA>.<cUid>.<nonce>`.
 * It used to serve on `ctl.auth-admin.<owner>.<actor>`. §13.11 retires the v0 `ctl` rail in full
 * ("MUST NOT be handled") and grants it no scoping language, so the rows serving this rail there
 * were defects — new normative rows written onto a deleted rail — and #350 ruled them rewritten
 * onto the v0.4 endpoint surface rather than carved out of the cut.
 *
 * AUTHZ (RAIL-TIME, fresh per request, never mint-only):
 *  - Caller attribution is SUBJECT-derived and broker-enforced: the caller triple
 *    `<cO>.<cA>.<cUid>` rides the subject, and only a credential minted with that triple's
 *    request-publish grant can reach it (the `retirement-requester` profile).
 *  - The SERVE-ISSUANCE GATE check: the caller names a gate row by (serveEndpoint,
 *    serveInstanceId) and declares its epoch. The row must exist, not be retired, and carry the
 *    declared epoch — a superseded predecessor (a restart advanced the epoch) is refused.
 *  - THE PRINCIPAL CROSS-CHECK: the named row's `principal` must equal the SUBJECT-derived caller
 *    principal. This is what makes the two body fields safe to keep: they only SELECT a row, they
 *    no longer authorize, so naming a foreign row buys a refusal rather than an authorization.
 *    Before #350 the two-token `ctl` subject could not express the caller's identity beyond an
 *    alias, and the rail accepted ANY registered instance's gate — a holder of the manager
 *    principal could be authorized by a row belonging to someone else.
 *  - This is ALIAS-LEVEL binding, not incarnation-level: the gate row is keyed by the PERSISTED
 *    `instanceId` (stable across restarts) and its schema is closed with no uid field, while the
 *    caller triple's `<cUid>` is per-process. A same-principal zombie predecessor that learns the
 *    current epoch value still passes both checks. Binding the publishing incarnation needs a
 *    gate-row schema change — deliberately out of this cut, and its own decision.
 *  - The GENERIC surface never names a caller class (a manager despawn is ONE caller); the gate
 *    check is this service's serve-time authz, not subject grammar.
 *
 * IDEMPOTENCE (the confirmed four-outcome table, surfaced as OPERATOR results): already-retired
 * (uid match) → success; a frozen gate under the SAME opId → the barrier resumes it; a FOREIGN
 * operation holding the gate → refuse naming the operation; a different current uid → refuse
 * (stale trigger). The requester sends a STABLE opId across retries, so an epCall retry never
 * mints a second operation.
 *
 * UX (the piece-3 faces): every refusal is WHAT/WHY/NEXT in operator vocabulary — each authz
 * refusal states the despawn was a FULL NO-OP (the target is unchanged and still running,
 * nothing was applied) with `cotal supervise` → retry as the NEXT; the vocabulary bridge
 * ("despawn started this agent's retirement") lives at the CLI surface that renders these.
 *
 * SEAL COMPOSITION (critic's three checks): the listener holds NO scanner/plane authority — the
 * retirement runs through the injected {@link RetirementDeps}, whose drain rides the plane's ONE
 * sealed records scanner exactly like the boot resume; the gate read is a leader read, no
 * consumer-create anywhere; the requester credential is request + reply-inbox ONLY.
 */
import { Kvm } from "@nats-io/kv";
import {
  AUTH_ENDPOINT,
  EP_CMD_RETIRE_LIFECYCLE,
  EpEnvelopeError,
  epAuthBucket,
  epServeGrantRows,
  managedRetirementOpId,
  principalKey,
  retirementFrontierStreams,
  serveEndpoint,
  serveIssuanceGateKv,
  type EpServeContext,
  type EpServeGrant,
  type EpServeHandle,
} from "@cotal-ai/core";
import { authCommandDefs, type AuthServiceHandlers } from "./auth-service-contract.js";
import { openAuthorityClient, type AuthorityClient } from "./authority-client.js";
import { runAgentRetirementBarrier, type RetirementDeps } from "./retirement-barrier.js";
import { observeGate, readLifecycleHeadForOperation, type LifecycleRegistry } from "./lifecycle-registry.js";

/** The LISTENER profile (SPEC 13.9 "Auth endpoint rail" row): serve + bounded replies on the auth
 *  endpoint's class rail, plus the ONE leader-served gate read the authz check performs.
 *  No store writes, no consumer authority, no scanner reach. */
export function authAdminListenerGrants(
  space: string,
  connId: string,
  responder: { instanceId: string; epoch: number },
): { publish: string[]; subscribe: string[] } {
  // The generic serve rows for this instance/epoch (reply plane, events, timer schedule, record
  // writes on publish; the class/all/inst rails plus the derived `describe` and the epoch-pinned
  // timer fire row on subscribe) — the SAME assembly `serveEndpoint` callers use, replacing the
  // hand-built reply-pattern/class-rail rows above (M3, #399).
  const serveRows = epServeGrantRows(space, {
    endpoint: AUTH_ENDPOINT,
    instanceId: responder.instanceId,
    epoch: responder.epoch,
    ephemeralCommands: [EP_CMD_RETIRE_LIFECYCLE],
  });
  return {
    publish: [
      ...serveRows.pub,
      "$JS.API.INFO",
      // The ONE leader-served read the authz check performs: the serve-issuance GATE, a point-get
      // of `epgate.<endpoint>.<instanceId>` proving the requesting manager instance's serve grant
      // is CURRENT and that the row belongs to the SUBJECT-derived caller principal. No consumer
      // authority, no store writes.
      `$JS.API.STREAM.MSG.GET.KV_${epAuthBucket(space)}`,
    ],
    subscribe: [...serveRows.sub, `_INBOX_${connId}.>`],
  };
}

// The per-despawn REQUESTER profile lives in core (`mintCreds` profile "retirement-requester",
// the ONE grants source the D32 audit pins): publish exactly its OWN caller triple's request
// subject + subscribe its own reply-plane filter and inbox - request + reply ONLY.

/** One rail request's CLOSED argument shape. `serve*` names the gate row to read; it SELECTS,
 *  it does not authorize (the principal cross-check does). The target rides the SUBJECT. */
interface RetireArgs {
  opId: string;
  serveEndpoint: string;
  serveInstanceId: string;
  serveEpoch: number;
}

/** The terminal rail's operation-identity authorization. The requester credential pins the target
 * in the subject, while this check binds the body operation to that broker-authenticated target.
 * Run it before any gate/head read so a foreign operation id is a full no-op. */
export function authorizeRetirementOperation(targetLifecycleUid: string, opId: string): void {
  const expected = managedRetirementOpId(targetLifecycleUid);
  if (opId !== expected)
    throw new EpEnvelopeError("permission-denied", `retireLifecycle operation ${opId} is not the derived terminal operation ${expected} for lifecycle ${targetLifecycleUid}; nothing was applied`);
}

/** In-flight terminal retirements keyed by opId, bound to their operation coordinates. */
export type RetirementFlights = Map<string, { owner: string; actor: string; lifecycleUid: string; promise: ReturnType<typeof runAgentRetirementBarrier> }>;

/** Join the in-flight barrier for `op.opId`, or start and register it. Returns undefined when that
 *  opId is already in flight for DIFFERENT coordinates: the caller refuses, nothing is started. */
export function joinOrStartRetirement(
  flights: RetirementFlights,
  reg: LifecycleRegistry,
  op: Parameters<typeof runAgentRetirementBarrier>[1],
  retirement: RetirementDeps,
): ReturnType<typeof runAgentRetirementBarrier> | undefined {
  const existing = flights.get(op.opId);
  if (existing !== undefined)
    return existing.owner === op.owner && existing.actor === op.actor && existing.lifecycleUid === op.lifecycleUid ? existing.promise : undefined;
  const flight = runAgentRetirementBarrier(reg, op, retirement);
  void flight.catch(() => {}).finally(() => { if (flights.get(op.opId)?.promise === flight) flights.delete(op.opId); });
  flights.set(op.opId, { owner: op.owner, actor: op.actor, lifecycleUid: op.lifecycleUid, promise: flight });
  return flight;
}

export interface AuthAdminListener {
  close(): Promise<void>;
}

/**
 * Open the rail: subscribe the auth-admin control subtree on a dedicated minimal listener
 * credential and serve `retireLifecycle`. Every executing right stays with the injected
 * registry + {@link RetirementDeps} (the plane's own, sealed-scanner-threaded mechanics).
 */
export async function openAuthAdminListener(opts: {
  server: string;
  space: string;
  dataAccount: { pub: string; signingSeed: string };
  reg: LifecycleRegistry;
  retirement: RetirementDeps;
  barrierFlight: RetirementFlights;
  /** The plane's #399 M2-registered instance id and current process epoch (`authServeGrant.epoch`)
   *  — the SAME instance/epoch the registration ceremony fenced. The gate's process-epoch reader is
   *  the fence now; there is no separate fixed responder identity to mint. */
  instanceId: string;
  epoch: number;
  /** The M2-authorized serve artifact for this instance/epoch (`authServeGrant`, `service.ts:513`)
   *  — `serveEndpoint` consumes it directly; it is the ONE authority source for what this
   *  credential may serve (SPEC 13.9). */
  grant: EpServeGrant;
  onConnection?: import("./authority-client.js").AuthorityClientOpts["onConnection"];
  log: (line: string) => void;
}): Promise<AuthAdminListener> {
  const { space, log } = opts;
  // The auth plane's responder identity is the #399 M2-registered instance/epoch (the SAME triple
  // `registerServiceInstance` fenced and `authorizeServeGrant` minted a serve grant for). The reply
  // plane pins this triple in the grant; callers read replies through a filter that wildcards the
  // caller-suffix positions (`ep.reply.*.*.*.<cO>.<cA>.<cUid>.*`), so they never need to learn it.
  const responder = { instanceId: opts.instanceId, epoch: opts.epoch };
  const client: AuthorityClient = await openAuthorityClient({
    server: opts.server, space, dataAccount: opts.dataAccount,
    label: `cotal:auth-admin:${space}`,
    onConnection: opts.onConnection,
    grants: (id) => authAdminListenerGrants(space, id, responder),
    log,
  });
  let epAuthKv: import("@nats-io/kv").KV;
  try {
    // Bind the endpoint-auth bucket once for the 3b-3 serve-issuance-gate holder check (point-get,
    // no consumer). Lazy bind (kvm.open) — the space's stores are pre-created at `cotal up`.
    epAuthKv = await new Kvm(client.nc).open(epAuthBucket(space));
  } catch (e) {
    await client.close();
    throw e;
  }
  // SINGLE-FLIGHT the barrier EXECUTION per opId (audit #1): each request still runs its OWN fresh
  // lease re-check + idempotence, but concurrent same-opId requests (a manager nudge + a retry, or a boot
  // resume racing the rail) share ONE runAgentRetirementBarrier, so the barrier body never dual-executes
  // (dual contain/drain mutating past a frontier the other task closes). A joiner awaits the same result.
  //
  // The flight remains BOUND to its operation coordinates (owner, actor, lifecycleUid) as defense in
  // depth. The rail now derives one opId per target before this map, so different lifecycles cannot
  // collide here. A coordinate-identical nudge, retry, or boot race still joins the one barrier run.
  // Owned by the plane and shared with the loopback managed-retire door, so the rail and the door
  // never run two barrier executions of one opId in this process (#2070).
  const barrierFlight = opts.barrierFlight;

  // The FRESH target resolver (§13.3/§13.9) for the `exact`-mode `retire-lifecycle` target: the
  // lifecycle registry's own leader-served mapping read is the current-mapping authority.
  const resolveTarget = async (t: { owner: string; actor: string }): Promise<{ lifecycleUid: string; mappingRevision: number } | undefined> => {
    const head = await readLifecycleHeadForOperation(opts.reg, t.owner, t.actor);
    return head === undefined ? undefined : { lifecycleUid: head.mapping.lifecycleUid, mappingRevision: head.revision };
  };

  const handlers: AuthServiceHandlers = {
    retireLifecycle: async (ctx: EpServeContext) => {
      // The TARGET comes from the subject (`exact` mode, arity 3) — broker-enforced and
      // grant-pinned, not a claim the caller can vary independently of what it may publish.
      const t = ctx.subject.target;
      if (t === null || t.mode !== "exact")
        throw new EpEnvelopeError("failed-precondition", `retire-lifecycle requires an exact target (<owner>.<actor>.<lifecycleUid>) in the subject`);
      const target = { owner: t.tOwner, actor: t.tActor, lifecycleUid: t.tUid };
      // The CALLER principal likewise comes from the subject, and is an AUTHZ INPUT (the
      // cross-check below), not just an audit line.
      const requester = principalKey(ctx.subject.caller.owner, ctx.subject.caller.actor).key;
      const args = ctx.request.args as unknown as RetireArgs;
      // TARGET comes from the broker-authorized subject. Bind the body's opId to it BEFORE the
      // serve gate, lifecycle head, intent, or barrier is touched, so mint-time validation is not
      // the only fence and the same target can never start a second durable terminal operation.
      authorizeRetirementOperation(target.lifecycleUid, args.opId);

      // THE RAIL-TIME REGISTRATION RE-CHECK (fresh, leader-served, fail-closed) — P2 item 3 (3b-3):
      // the requesting manager instance's SERVE GRANT must be current. Read the serve-issuance gate
      // (registration-record-derived, REPLACING the old name-derived manager-lease holder check): the
      // requester declares its (serveEndpoint, serveInstanceId, serveEpoch); an absent/retired gate means
      // no registered instance, and a gate whose current processEpoch moved past the declared one means
      // the requester was SUPERSEDED (a deposed predecessor after a restart) — refused as a full no-op.
      // The row this NAMES must also BELONG to the subject-derived caller principal (the cross-check
      // below). Before #350 it did not have to: every instance of one space shares the manager
      // principal, and the two-token `ctl` subject could not express the caller beyond that alias, so
      // any current instance's gate authorized. That is no longer true, and the coordinates above no
      // longer authorize — they only select which row to read.
      // ALIAS-LEVEL, not incarnation-level: a DIFFERENT INSTANCE OF THE SAME PRINCIPAL still passes
      // (the gate is keyed by the persisted instanceId and its row carries no lifecycle uid). What is
      // refused is a row belonging to a DIFFERENT PRINCIPAL.
      let serveGate: Awaited<ReturnType<ReturnType<typeof serveIssuanceGateKv>["observe"]>>;
      try {
        serveGate = await serveIssuanceGateKv(epAuthKv, space, { endpoint: args.serveEndpoint, instanceId: args.serveInstanceId }).observe();
      } catch (e) {
        throw new EpEnvelopeError("unavailable", `the retirement request cannot be authorized right now: the manager serve-issuance gate could not be read (${e instanceof Error ? e.message : String(e)}). Nothing was applied - the agent is unchanged. NEXT: check the broker and retry the despawn.`);
      }
      if (serveGate === null || serveGate.state === "retired")
        throw new EpEnvelopeError("failed-precondition", `no manager instance currently holds a serve registration for "${space}" (instance ${args.serveInstanceId} is ${serveGate === null ? "unregistered" : "retired"}), so nothing may retire agents. The despawn was a FULL no-op - the agent is unchanged and still running. NEXT: start or recover the manager (\`cotal supervise\`), then retry the despawn.`);
      // THE PRINCIPAL CROSS-CHECK (#350). The two serve coordinates above only SELECTED this row;
      // they do not authorize. The row must belong to the SUBJECT-derived caller principal — which
      // the broker enforced when it admitted the publish. Without this, naming any currently
      // registered instance's row authorizes the caller, which is what the `ctl` rail did: its
      // two-token subject could not express the caller beyond an alias, so there was nothing to
      // compare the row against.
      // ALIAS-LEVEL, not incarnation-level: the gate is keyed by the PERSISTED instanceId and its
      // schema carries no uid, while the caller triple's uid is per-process. A same-principal zombie
      // predecessor holding the current epoch value still passes. Closing that needs a gate-row
      // schema change; it is deliberately not in this cut.
      if (serveGate.principal !== requester)
        throw new EpEnvelopeError("permission-denied", `the retirement request was REFUSED: the serve registration named (${args.serveEndpoint}/${args.serveInstanceId}) belongs to ${serveGate.principal}, not to the requesting principal ${requester}. A caller may only be authorized by its OWN serve registration. The despawn was a FULL no-op - the agent is unchanged and still running. NEXT: name your OWN principal's serve registration (any current instance of ${requester} will do), or call as the principal that owns this one.`);
      if (serveGate.processEpoch !== args.serveEpoch)
        throw new EpEnvelopeError("expired", `the requesting manager instance ${args.serveInstanceId} was SUPERSEDED (it registered at epoch ${args.serveEpoch}, the current serve grant is epoch ${serveGate.processEpoch}), so this despawn was REFUSED as a FULL no-op - the agent is unchanged and still running, nothing was torn down. NEXT: recover the manager (\`cotal supervise\`), then retry the despawn under the current serving instance.`);

      // IDEMPOTENCE (the four-outcome table, in operator vocabulary).
      const head = await readLifecycleHeadForOperation(opts.reg, target.owner, target.actor);
      if (head === undefined)
        throw new EpEnvelopeError("failed-precondition", `no lifecycle exists for "${target.owner}/${target.actor}"; there is nothing to retire.`);
      if (head.mapping.state === "retired" && head.mapping.lifecycleUid === target.lifecycleUid)
        return { retired: true, lifecycleUid: target.lifecycleUid, opId: args.opId, evictedPrincipals: [] };
      if (head.mapping.lifecycleUid !== target.lifecycleUid)
        throw new EpEnvelopeError("expired", `the despawn names a stale incarnation of "${target.owner}/${target.actor}" (current is ${head.mapping.lifecycleUid}); nothing was retired. NEXT: refresh the agent list and retry against the current incarnation.`);
      const gate = await observeGate(opts.reg, target.lifecycleUid);
      if (gate !== undefined && gate.row.state === "frozen" && gate.row.op.opId !== args.opId)
        throw new EpEnvelopeError("conflict", `another operation (${gate.row.op.kind} ${gate.row.op.opId}) already holds "${target.owner}/${target.actor}"; this despawn did not start a second one. NEXT: wait for that operation to finish (or its resume on the next auth-service boot), then retry.`);

      // EXECUTE (create-or-resume: the barrier's own freeze CAS + durable intent make the same
      // opId resumable and a re-request idempotent). The drain, cleaner, and repair credentials
      // all come from the plane's reviewed deps - this listener holds none of those rights.
      const existing = barrierFlight.get(args.opId);
      // A despawn cannot know the target's pool work, and the barrier never takes a pool hint: it
      // DISCOVERS the real (endpoint, pools) cleaner inventory from the target's own accepted pool
      // obligations (#F). Discovery is never a gap - the barrier never closes a frontier over
      // un-cleaned accepted pool work (SPEC 13.1/13.9).
      const flight = joinOrStartRetirement(barrierFlight, opts.reg, {
        owner: target.owner, actor: target.actor, lifecycleUid: target.lifecycleUid, opId: args.opId,
        frontierStreams: retirementFrontierStreams(space),
      }, opts.retirement);
      if (flight === undefined)
        throw new EpEnvelopeError("conflict", `operation id ${args.opId} is already in flight for a different lifecycle (${existing?.owner}/${existing?.actor} ${existing?.lifecycleUid}); this despawn of "${target.owner}/${target.actor}" (${target.lifecycleUid}) was a FULL no-op - nothing was retired and it is still running. NEXT: retry the despawn (the manager derives a distinct operation id per lifecycle).`);
      const result = await flight;
      log(`auth-admin: retired ${target.owner}/${target.actor} (${target.lifecycleUid}) by despawn request from ${requester} (op ${args.opId})`);
      return { retired: true, lifecycleUid: target.lifecycleUid, opId: result.opId, evictedPrincipals: result.evictedPrincipals };
    },
  };

  // §13.9: the descriptor is PUBLIC. The broker grant on the request subject (who holds the
  // caller triple's request-publish row, minted only by the `retirement-requester` profile) is the
  // load-bearing authority tier; describe merely lists command names/schemas, which leaks nothing
  // a holder of that grant does not already need to know to call successfully.
  const handle: import("@cotal-ai/core").EpServeHandle = serveEndpoint(
    client.nc, space, opts.grant, authCommandDefs(handlers), { public: true }, { resolveTarget },
  );

  return {
    close: async () => {
      await handle.stop();
      await client.close();
    },
  };
}
