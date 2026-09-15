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
import type { Subscription } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";
import {
  AUTH_ENDPOINT,
  canonicalJson,
  EP_CMD_CREATE_MANAGED_ROW,
  EP_CMD_REVOKE_MANAGED_ROW,
  EP_CMD_RETIRE_LIFECYCLE,
  EpEnvelopeError,
  assertBoundIncarnation,
  checkRequestSubjectAgreement,
  assertLifecycleToken,
  deriveReplySubject,
  endpointToken,
  epAuthBucket,
  epClassQueueGroup,
  epResponderReplyPattern,
  assertCommandToken,
  spacePrefix,
  mintLifecycleUid,
  managedRetirementOpId,
  endpointErrorReply,
  parseManagedRowReplyBytes,
  parseManagedRowRequestBytes,
  parseEpSubject,
  principalKey,
  retirementFrontierStreams,
  serveIssuanceGateKv,
  verifyManagedRowAttemptNonce,
  type ManagedRowIntent,
  type ParsedEpRequest,
} from "@cotal-ai/core";
import { openAuthorityClient, type AuthorityClient } from "./authority-client.js";
import { runAgentRetirementBarrier, type RetirementDeps } from "./retirement-barrier.js";
import { observeGate, readLifecycleHeadForOperation, type LifecycleRegistry } from "./lifecycle-registry.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

/** The auth endpoint's one class rail, per-command (never a cross-command `>`): the grant and the
 *  runtime subscription are built from THIS, so a widened subscription cannot outrun its grant. */
function authClassRail(space: string, command: string): string {
  return `${spacePrefix(space)}.ep.one.${endpointToken(AUTH_ENDPOINT)}.${assertCommandToken(command)}.>`;
}

const AUTH_COMMANDS = [EP_CMD_RETIRE_LIFECYCLE, EP_CMD_CREATE_MANAGED_ROW, EP_CMD_REVOKE_MANAGED_ROW] as const;

/** The LISTENER profile (SPEC 13.9 "Auth endpoint rail" row): serve + bounded replies on the auth
 *  endpoint's class rail, plus the ONE leader-served gate read the authz check performs.
 *  No store writes, no consumer authority, no scanner reach. */
export function authAdminListenerGrants(
  space: string,
  connId: string,
  responder: { instanceId: string; epoch: number },
): { publish: string[]; subscribe: string[] } {
  return {
    publish: [
      // REPLIES ONLY, and on the REPLY PLANE — which is a stronger statement than the `ctl` rail
      // could make. There, request and reply shared one subtree, so the grant had to carve replies
      // out of it by shape (`*.*.reply.>`) to stop a compromised listener self-publishing a request
      // as the lease holder and passing its own subject-derived check (self-forge). Here the planes
      // are DISJOINT: `ep.reply.…` cannot express a request subject at all, so the self-forge is
      // closed by the grammar rather than by a pattern. The instance triple and epoch are pinned;
      // only the caller suffixes span (addressing is confined by nonce possession, §13.2).
      epResponderReplyPattern(space, AUTH_ENDPOINT, responder.instanceId, responder.epoch),
      "$JS.API.INFO",
      // The ONE leader-served read the authz check performs: the serve-issuance GATE, a point-get
      // of `epgate.<endpoint>.<instanceId>` proving the requesting manager instance's serve grant
      // is CURRENT and that the row belongs to the SUBJECT-derived caller principal. No consumer
      // authority, no store writes.
      `$JS.API.STREAM.MSG.GET.KV_${epAuthBucket(space)}`,
    ],
    // The class rail, QUEUE-QUALIFIED and per-command (§13.9, `endpoint-grants.ts:293-300`): the
    // NATS `"<subject> <queue>"` grant form. A PLAIN subject row would let this credential
    // plain-subscribe the class rail and observe EVERY request's nonce — the property the queue
    // qualification exists to protect. The runtime's queue subscription is not a substitute: it
    // constrains what this process does, not what the credential permits.
    subscribe: [...AUTH_COMMANDS.map((command) => `${authClassRail(space, command)} ${epClassQueueGroup(AUTH_ENDPOINT)}`), `_INBOX_${connId}.>`],
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

export interface ManagedRowListenerDeps {
  /** Fresh trusted-host admission. `phase:"final"` is the last check before effect. */
  admit(input: { caller: ParsedEpRequest["caller"]; intent: ManagedRowIntent; authority?: import("@cotal-ai/core").ManagedRowAttemptAuthority; phase: "initial" | "final" }): Promise<void>;
  resolveTarget(input: { owner: string; actor: string }): Promise<{ lifecycleUid: string; mappingRevision: number } | undefined>;
  execute(input: { wireId: string; intent: ManagedRowIntent; finalAdmission(): Promise<void>; assertPreEffectOpen(): void }): Promise<Uint8Array>;
}

export interface ManagedRowDeadlineClock {
  now(): number;
  setTimer(run: () => void, delayMs: number): unknown;
  clearTimer(handle: unknown): void;
}
const SYSTEM_MANAGED_ROW_CLOCK: ManagedRowDeadlineClock = {
  now: () => performance.now(),
  setTimer: (run, delayMs) => setTimeout(run, delayMs),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

async function withinManagedRowDeadline<T>(
  budgetMs: number,
  clock: ManagedRowDeadlineClock,
  run: (latch: { assertOpen(): void; assertPreEffectOpen(): void }) => Promise<T>,
): Promise<T> {
  const startedAt = clock.now();
  let closed = false;
  let effectStarted = false;
  let timer: unknown;
  const assertOpen = () => {
    if (closed) throw new EpEnvelopeError("deadline-exceeded", "managed-row pre-effect latch is closed; no mutation may begin", undefined, "not-executed");
  };
  const operation = run({
    assertOpen,
    assertPreEffectOpen() { assertOpen(); effectStarted = true; },
  });
  void operation.catch(() => {});
  const deadline = new Promise<never>((_, reject) => {
    timer = clock.setTimer(() => {
      closed = true;
      reject(new EpEnvelopeError("deadline-exceeded",
        effectStarted
          ? "managed-row deadline elapsed after effect dispatch; caller outcome is unknown until retained truth is observed"
          : "managed-row deadline elapsed before effect dispatch; the pre-effect latch is permanently closed",
        undefined, effectStarted ? "unknown" : "not-executed"));
    }, Math.max(0, budgetMs - (clock.now() - startedAt)));
  });
  try { return await Promise.race([operation, deadline]); }
  finally { clock.clearTimer(timer); }
}

export async function handleManagedRowNativeRequest(
  space: string,
  request: ParsedEpRequest,
  body: Uint8Array,
  deps: ManagedRowListenerDeps,
  opts: { responder: { endpoint: "auth"; instanceId: string; epoch: number }; clock?: ManagedRowDeadlineClock } = {
    responder: { endpoint: "auth", instanceId: "unbound", epoch: 0 },
  },
): Promise<Uint8Array> {
  if (request.command !== EP_CMD_CREATE_MANAGED_ROW && request.command !== EP_CMD_REVOKE_MANAGED_ROW)
    throw new EpEnvelopeError("failed-precondition", `command ${request.command} is not a managed-row command`);
  const parsed = parseManagedRowRequestBytes(body);
  const envelope = parsed.envelope;
  const intent = parsed.args.intent;
  checkRequestSubjectAgreement(envelope, request);
  assertBoundIncarnation(envelope, opts.responder);
  if (intent.command !== request.command || intent.space !== space)
    throw new EpEnvelopeError("permission-denied", "managed-row body command or space disagrees with the authenticated request subject");
  const assertTargetCurrent = async () => {
    if (intent.command === "create-managed-row") {
      if (envelope.target !== undefined) throw new EpEnvelopeError("target-mismatch", "create-managed-row is untargeted and must not carry an envelope target", undefined, "not-executed");
      return;
    }
    if (request.target === null || request.target.mode !== "ledger" || envelope.target === undefined ||
        canonicalJson({ owner: envelope.target.owner, actor: envelope.target.actor, lifecycleUid: envelope.target.lifecycleUid }) !== canonicalJson(intent.target))
      throw new EpEnvelopeError("target-mismatch", "revoke-managed-row requires complete envelope-target equality with immutable intent", undefined, "not-executed");
    const current = await deps.resolveTarget({ owner: intent.target.owner, actor: intent.target.actor });
    if (current === undefined || current.lifecycleUid !== intent.target.lifecycleUid)
      throw new EpEnvelopeError("expired", "revoke-managed-row target does not equal the authoritative current lifecycle mapping", undefined, "not-executed");
    if (envelope.target.mappingRevision !== undefined && current.mappingRevision !== envelope.target.mappingRevision)
      throw new EpEnvelopeError("expired", `revoke-managed-row target mapping revision ${envelope.target.mappingRevision} is not current revision ${current.mappingRevision}`, undefined, "not-executed");
  };
  verifyManagedRowAttemptNonce(request.nonce, request.caller, intent, parsed.args.authority, envelope.bind, envelope.target?.mappingRevision);
  return withinManagedRowDeadline(envelope.deadlineMs!, opts.clock ?? SYSTEM_MANAGED_ROW_CLOCK, async (latch) => {
    await assertTargetCurrent();
    await deps.admit({ caller: request.caller, intent, authority: parsed.args.authority, phase: "initial" });
    await assertTargetCurrent();
    latch.assertOpen();
    const exact = await deps.execute({
      wireId: envelope.id,
      intent,
      finalAdmission: async () => {
        await deps.admit({ caller: request.caller, intent, authority: parsed.args.authority, phase: "final" });
        await assertTargetCurrent();
      },
      assertPreEffectOpen: latch.assertPreEffectOpen,
    });
    const reply = parseManagedRowReplyBytes(exact, envelope.id, intent);
    if (!reply.ok) throw new EpEnvelopeError("internal", "managed-row executor returned a failure reply instead of committed success", undefined, "unknown");
    return exact;
  });
}

const RETIRE_ARG_KEYS = ["opId", "serveEndpoint", "serveInstanceId", "serveEpoch"];

/** The request id a reply MUST echo. This is the MINIMAL correctness guard from the full
 *  `EndpointRequest`/`EndpointReply` envelope, which this rail does NOT yet carry (named residual:
 *  the rail moved to `ep` SUBJECTS while still exchanging the ctl-era `{op,args}` / `{ok,data,error}`
 *  bodies, and SPEC 1421 states those envelopes are DELETED). Without the echo, a caller binding a
 *  reply on (endpoint, nonce) alone can accept a malformed or WRONG-ID `{ok:true}` and clear a
 *  retirement hold on it. The full envelope migration is its own cut; this edge is not deferrable. */
function parseRequestId(raw: unknown): string {
  if (typeof raw !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(raw))
    throw new EpEnvelopeError("failed-precondition", `the request requires an "id" ([A-Za-z0-9_-]{1,64}); the reply echoes it so a caller cannot accept another request's answer`);
  return raw;
}

function parseRetireArgs(raw: unknown): RetireArgs {
  const shape = "{ opId, serveEndpoint, serveInstanceId, serveEpoch }";
  if (raw === null || typeof raw !== "object")
    throw new EpEnvelopeError("failed-precondition", `retireLifecycle requires args ${shape}`);
  const a = raw as Record<string, unknown>;
  // The TARGET (owner, actor, lifecycleUid) is no longer an argument: `handle` mode carries it in
  // the subject, broker-enforced and grant-pinned, so the handler reads it from there. Sending it
  // in the body is now a CLOSED-SHAPE violation rather than a redundancy to reconcile — which
  // removes the whole body-vs-subject mismatch class instead of managing it.
  for (const k of Object.keys(a)) if (!RETIRE_ARG_KEYS.includes(k))
    throw new EpEnvelopeError("failed-precondition", `retireLifecycle args carry the unknown field "${k}" (closed shape; the target rides the SUBJECT)`);
  if (typeof a.opId !== "string" ||
      typeof a.serveEndpoint !== "string" || typeof a.serveInstanceId !== "string" ||
      typeof a.serveEpoch !== "number" || !Number.isInteger(a.serveEpoch) || a.serveEpoch < 0)
    throw new EpEnvelopeError("failed-precondition", `retireLifecycle requires args ${shape} (serveEpoch a non-negative integer)`);
  return {
    // opId is OPERATION IDENTITY, not an authz input: the terminal rail independently derives it
    // from the broker-pinned lifecycle target below. This parse only enforces the token grammar.
    opId: assertLifecycleToken(a.opId, "opId"),
    // LOOKUP COORDINATES, not authz inputs: they select WHICH gate row to read. The row they
    // select must then survive the principal cross-check below, so naming a foreign row buys a
    // refusal, never an authorization.
    serveEndpoint: endpointToken(a.serveEndpoint),
    serveInstanceId: assertLifecycleToken(a.serveInstanceId, "serveInstanceId"),
    serveEpoch: a.serveEpoch,
  };
}

/** The terminal rail's operation-identity authorization. The requester credential pins the target
 * in the subject, while this check binds the body operation to that broker-authenticated target.
 * Run it before any gate/head read so a foreign operation id is a full no-op. */
export function authorizeRetirementOperation(targetLifecycleUid: string, opId: string): void {
  const expected = managedRetirementOpId(targetLifecycleUid);
  if (opId !== expected)
    throw new EpEnvelopeError("permission-denied", `retireLifecycle operation ${opId} is not the derived terminal operation ${expected} for lifecycle ${targetLifecycleUid}; nothing was applied`);
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
  managedRow?: ManagedRowListenerDeps;
  log: (line: string) => void;
}): Promise<AuthAdminListener> {
  const { space, log } = opts;
  // The auth plane's responder identity. The plane is SINGLE per space by construction (§13.13:
  // at most one authority plane holds the sealed scanners, by a broker-visible claim), so the
  // instance id is per-process and the epoch is fixed: there is no successor to fence and no
  // registration whose epoch could advance beneath us. It exists because the reply plane pins the
  // responder triple in the grant; callers read replies through a filter that wildcards these
  // positions (`ep.reply.*.*.*.<cO>.<cA>.<cUid>.*`), so they never need to learn it.
  const responder = { instanceId: mintLifecycleUid(), epoch: 0 };
  const client: AuthorityClient = await openAuthorityClient({
    server: opts.server, space, dataAccount: opts.dataAccount,
    label: `cotal:auth-admin:${space}`,
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
  const subscriptions: Subscription[] = AUTH_COMMANDS.map((command) => client.nc.subscribe(authClassRail(space, command), {
    queue: epClassQueueGroup(AUTH_ENDPOINT), callback: (err, msg) => {
      if (err) return;
      void (async () => {
        // The reply target is DERIVED from the parsed request, never taken from the wire. On the
        // `ctl` rail this was a guard: the listener held a subtree-wide reply grant, so a
        // caller-selected foreign reply target had to be refused by inspecting `msg.reply`. Here
        // there is no argument through which a payload-supplied reply target could arrive — the
        // guard became structural, so the check it replaced cannot be forgotten.
        const parsed = parseEpSubject(msg.subject);
        if (parsed === null || parsed.plane !== "request") {
          // null = MUST NOT handle (§13.2). Never a reply: an unparseable subject has no
          // derivable reply target, and answering one would be the confused deputy itself.
          log(`auth-admin: dropped an unparseable request subject ${msg.subject}`);
          return;
        }
        const request: ParsedEpRequest = parsed;
        // The echoed id is stamped HERE, outside the handler, so EVERY reply carries it - including
        // the thrown-error path. A reply the caller cannot bind to its own request is one it must
        // ignore, so an unstamped error reply would silently become a timeout instead of a refusal.
        let echoId: string | undefined;
        try {
          echoId = request.command === EP_CMD_CREATE_MANAGED_ROW || request.command === EP_CMD_REVOKE_MANAGED_ROW
            ? parseManagedRowRequestBytes(msg.data).envelope.id
            : parseRequestId((JSON.parse(dec.decode(msg.data)) as { id?: unknown }).id);
        }
        catch { echoId = undefined; }
        let replyBytes: Uint8Array;
        try {
          const reply = await handle(request, msg.data);
          replyBytes = reply instanceof Uint8Array ? reply : enc.encode(JSON.stringify(echoId === undefined ? reply : { ...reply, id: echoId }));
        } catch (e) {
          replyBytes = request.command === EP_CMD_CREATE_MANAGED_ROW || request.command === EP_CMD_REVOKE_MANAGED_ROW
            ? enc.encode(JSON.stringify(endpointErrorReply(echoId ?? "invalid", e)))
            : enc.encode(JSON.stringify({ ok: false, ...(echoId !== undefined ? { id: echoId } : {}), error: e instanceof Error ? e.message : String(e) }));
        }
        const target = deriveReplySubject(space, request, responder);
        try {
          client.nc.publish(target, replyBytes);
        } catch (e) {
          log(`auth-admin: reply publish failed on ${target}: ${e instanceof Error ? e.message : String(e)}`);
        }
      })();
    },
  }));
  try { await client.nc.flush(); }
  catch (error) {
    for (const sub of subscriptions) try { sub.unsubscribe(); } catch {}
    await client.close();
    throw error;
  }

  // SINGLE-FLIGHT the barrier EXECUTION per opId (audit #1): each request still runs its OWN fresh
  // lease re-check + idempotence, but concurrent same-opId requests (a manager nudge + a retry, or a boot
  // resume racing the rail) share ONE runAgentRetirementBarrier, so the barrier body never dual-executes
  // (dual contain/drain mutating past a frontier the other task closes). A joiner awaits the same result.
  //
  // The flight remains BOUND to its operation coordinates (owner, actor, lifecycleUid) as defense in
  // depth. The rail now derives one opId per target before this map, so different lifecycles cannot
  // collide here. A coordinate-identical nudge, retry, or boot race still joins the one barrier run.
  const barrierFlight = new Map<string, { owner: string; actor: string; lifecycleUid: string; promise: ReturnType<typeof runAgentRetirementBarrier> }>();

  const handle = async (request: ParsedEpRequest, body: Uint8Array): Promise<{ ok: boolean; id?: string; data?: unknown; error?: string } | Uint8Array> => {
    if (request.command === EP_CMD_CREATE_MANAGED_ROW || request.command === EP_CMD_REVOKE_MANAGED_ROW) {
      if (!opts.managedRow) return { ok: false, error: "managed-row native mutation is unavailable in this auth service composition" };
      return handleManagedRowNativeRequest(space, request, body, opts.managedRow, { responder: { endpoint: AUTH_ENDPOINT, ...responder } });
    }
    if (request.command !== EP_CMD_RETIRE_LIFECYCLE)
      return { ok: false, error: `command "${request.command}" not supported on the auth endpoint` };
    // The TARGET comes from the subject (`handle` mode, arity 3) — broker-enforced and
    // grant-pinned, so it is not a claim the caller can vary independently of what it may publish.
    if (request.target === null || request.target.mode !== "handle")
      return { ok: false, error: `retire-lifecycle requires a handle target (<owner>.<actor>.<lifecycleUid>) in the subject` };
    const target = { owner: request.target.tOwner, actor: request.target.tActor, lifecycleUid: request.target.tUid };
    // The CALLER principal likewise comes from the subject, and is now an AUTHZ INPUT (the
    // cross-check below), not just the audit line it was on the `ctl` rail.
    const requester = principalKey(request.caller.owner, request.caller.actor).key;
    let req: { id?: unknown; op?: unknown; args?: unknown };
    try {
      req = JSON.parse(dec.decode(body)) as { op?: unknown; args?: unknown };
    } catch {
      return { ok: false, error: "auth-admin: the request body is not JSON" };
    }
    if (req.op !== "retireLifecycle")
      return { ok: false, error: `op "${String(req.op)}" not supported on the auth admin service` };
    const args = parseRetireArgs(req.args);
    // TARGET comes from the broker-authorized subject. Bind the body's opId to it BEFORE the serve
    // gate, lifecycle head, intent, or barrier is touched, so mint-time validation is not the only
    // fence and the same target can never start a second durable terminal operation.
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
      return { ok: false, error: `the retirement request cannot be authorized right now: the manager serve-issuance gate could not be read (${e instanceof Error ? e.message : String(e)}). Nothing was applied - the agent is unchanged. NEXT: check the broker and retry the despawn.` };
    }
    if (serveGate === null || serveGate.state === "retired")
      return { ok: false, error: `no manager instance currently holds a serve registration for "${space}" (instance ${args.serveInstanceId} is ${serveGate === null ? "unregistered" : "retired"}), so nothing may retire agents. The despawn was a FULL no-op - the agent is unchanged and still running. NEXT: start or recover the manager (\`cotal supervise\`), then retry the despawn.` };
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
      return { ok: false, error: `the retirement request was REFUSED: the serve registration named (${args.serveEndpoint}/${args.serveInstanceId}) belongs to ${serveGate.principal}, not to the requesting principal ${requester}. A caller may only be authorized by its OWN serve registration. The despawn was a FULL no-op - the agent is unchanged and still running. NEXT: name your OWN principal's serve registration (any current instance of ${requester} will do), or call as the principal that owns this one.` };
    if (serveGate.processEpoch !== args.serveEpoch)
      return { ok: false, error: `the requesting manager instance ${args.serveInstanceId} was SUPERSEDED (it registered at epoch ${args.serveEpoch}, the current serve grant is epoch ${serveGate.processEpoch}), so this despawn was REFUSED as a FULL no-op - the agent is unchanged and still running, nothing was torn down. NEXT: recover the manager (\`cotal supervise\`), then retry the despawn under the current serving instance.` };

    // IDEMPOTENCE (the four-outcome table, in operator vocabulary).
    const head = await readLifecycleHeadForOperation(opts.reg, target.owner, target.actor);
    if (head === undefined)
      return { ok: false, error: `no lifecycle exists for "${target.owner}/${target.actor}"; there is nothing to retire.` };
    if (head.mapping.state === "retired" && head.mapping.lifecycleUid === target.lifecycleUid)
      return { ok: true, data: { alreadyRetired: true, lifecycleUid: target.lifecycleUid } };
    if (head.mapping.lifecycleUid !== target.lifecycleUid)
      return { ok: false, error: `the despawn names a stale incarnation of "${target.owner}/${target.actor}" (current is ${head.mapping.lifecycleUid}); nothing was retired. NEXT: refresh the agent list and retry against the current incarnation.` };
    const gate = await observeGate(opts.reg, target.lifecycleUid);
    if (gate !== undefined && gate.row.state === "frozen" && gate.row.op !== undefined && gate.row.op.opId !== args.opId)
      return { ok: false, error: `another operation (${gate.row.op.kind} ${gate.row.op.opId}) already holds "${target.owner}/${target.actor}"; this despawn did not start a second one. NEXT: wait for that operation to finish (or its resume on the next auth-service boot), then retry.` };

    // EXECUTE (create-or-resume: the barrier's own freeze CAS + durable intent make the same
    // opId resumable and a re-request idempotent). The drain, cleaner, and repair credentials
    // all come from the plane's reviewed deps - this listener holds none of those rights.
    const existing = barrierFlight.get(args.opId);
    if (existing !== undefined &&
        (existing.owner !== target.owner || existing.actor !== target.actor || existing.lifecycleUid !== target.lifecycleUid))
      return { ok: false, error: `operation id ${args.opId} is already in flight for a different lifecycle (${existing.owner}/${existing.actor} ${existing.lifecycleUid}); this despawn of "${target.owner}/${target.actor}" (${target.lifecycleUid}) was a FULL no-op - nothing was retired and it is still running. NEXT: retry the despawn (the manager derives a distinct operation id per lifecycle).` };
    let flight = existing?.promise;
    if (flight === undefined) {
      // A despawn cannot know the target's pool work, and the barrier never takes a pool hint: it
      // DISCOVERS the real (endpoint, pools) cleaner inventory from the target's own accepted pool
      // obligations (#F). Discovery is never a gap - the barrier never closes a frontier over
      // un-cleaned accepted pool work (SPEC 13.1/13.9).
      flight = runAgentRetirementBarrier(opts.reg, {
        owner: target.owner, actor: target.actor, lifecycleUid: target.lifecycleUid, opId: args.opId,
        frontierStreams: retirementFrontierStreams(space),
      }, opts.retirement);
      const settle = flight;
      void settle.catch(() => {}).finally(() => { if (barrierFlight.get(args.opId)?.promise === settle) barrierFlight.delete(args.opId); });
      barrierFlight.set(args.opId, { owner: target.owner, actor: target.actor, lifecycleUid: target.lifecycleUid, promise: flight });
    }
    const result = await flight;
    log(`auth-admin: retired ${target.owner}/${target.actor} (${target.lifecycleUid}) by despawn request from ${requester} (op ${args.opId})`);
    return { ok: true, data: { retired: true, lifecycleUid: target.lifecycleUid, opId: result.opId, evictedPrincipals: result.evictedPrincipals } };
  };

  return {
    close: async () => {
      for (const sub of subscriptions) try { sub.unsubscribe(); } catch { /* connection already down */ }
      await client.close();
    },
  };
}
