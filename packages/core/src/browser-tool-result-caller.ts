/**
 * A browser caller for ONE agent incarnation's private tool results (`@cotal-ai/core/browser`,
 * SPEC 13.6 "Private tool results"): the three native `tool-results` commands, `tool-result`,
 * `tool-result-consent` and `tool-result-revoke`, called in `handle` mode on the `inst` rail of the
 * serving instance, whose id IS the target's lifecycle UID.
 *
 * Authority is the signed-in holder's own, and only the narrow one. `acquire` returns the holder's
 * stock-issued `tool-result-caller` bearer (the redeemed consent), the space's deny-all sentinel and
 * the responder epoch the host read for that instance. The bearer is checked against every pin
 * before the connection opens: the space, the holder's principal and lifecycle, the consent's exact
 * target and its holder. A `manager-caller`, agent, admin or any other bearer refuses, and nothing is
 * stored, forwarded or widened. The holder grants carry no describe and no registry read, so the
 * epoch is a pin too: a missing one refuses, and every call binds it, so a responder that is not that
 * incarnation refuses BEFORE effect.
 *
 * Contracts are the packaged `urn:cotal:tool-results` cluster this build generated from the
 * canonical `TOOL_RESULT_CONTRACTS`; a build without exactly that cluster, or a cluster missing a
 * command or changing its shape, refuses `unsupported-version`. No contract is compiled at runtime.
 *
 * Replies are returned as attributed, unchanged: every answer state, `""`, `0` and `false` included,
 * reaches the page exactly as the responder sent it, and `content` is inert text. Nothing is cached.
 * A call is repeated once only when the responder refused it before effect. A consent or revoke that
 * was accepted or whose outcome is unknown is never sent again. A reply from another epoch, a closed
 * connection or `close` invalidates the caller; `reopen` acquires fresh authority and re-checks every
 * pin, and a different viewer, space or target is a different caller.
 */
import { PACKAGED_TOOL_RESULT_CLUSTERS, packagedValidatorFor } from "./browser.js";
import { dialCalloutConnection } from "./browser-caller.js";
import { epCall, type EpAttributedReply, type EpVerbTarget } from "./endpoint-call.js";
import { EpEnvelopeError, EP_UNBOUND_RESPONDER, replyRefusedBeforeEffect } from "./endpoint-error.js";
import type { EpCaller } from "./endpoint-subjects.js";
import type { CompiledContract } from "./schema-profile.js";
import { fromBase64url } from "./base64url.js";
import { TOOL_RESULT_COMMAND, TOOL_RESULT_COMMANDS, TOOL_RESULT_CONSENT_COMMAND, TOOL_RESULT_ENDPOINT, TOOL_RESULT_REVOKE_COMMAND } from "./tool-result-contract.js";

/** The registered cluster's URN and revision (`toolResultClusterArtifacts`). */
const TOOL_RESULT_CLUSTER_URN = "urn:cotal:tool-results";
const TOOL_RESULT_CLUSTER_REVISION = 1;

/** An agent incarnation: the owner, the actor and its lifecycle UID. */
export interface ToolResultPrincipal {
  owner: string;
  actor: string;
  lifecycleUid: string;
}

/** What `acquire` returns: the signed-in holder's own authority for exactly one connection. */
export interface BrowserToolResultAuthority {
  /** The stock `tool-result-caller` view, freshly issued for the pinned target. */
  bearer: string;
  /** The space's deny-all sentinel credential; it lands the connection in the callout account. */
  sentinelCreds: string;
  /** The serving instance's current epoch, as the host read it. Required. */
  responderEpoch: number;
}

export interface BrowserToolResultCallerOptions {
  /** WebSocket URL(s) of the space's broker, `wss://` on a deployed origin. */
  servers: string | string[];
  space: string;
  /** The signed-in holder's principal and interactive lifecycle, as the issuer bound them. */
  holder: ToolResultPrincipal;
  /** The one agent incarnation whose results are read. */
  target: ToolResultPrincipal;
  /** Returns fresh authority for one connection. Called on open and on every `reopen`. */
  acquire: (signal?: AbortSignal) => Promise<BrowserToolResultAuthority>;
  deadlineMs?: number;
}

export interface BrowserToolResultCallOptions {
  deadlineMs?: number;
  signal?: AbortSignal;
}

export interface BrowserToolResultCaller {
  readonly caller: EpCaller;
  readonly target: Readonly<ToolResultPrincipal>;
  readonly responderEpoch: number;
  /** The signed consent the bearer redeems, as issued. Present it with `consent`. */
  readonly grant: Readonly<Record<string, unknown>>;
  /** Read one result by the exact native pair. The reply is returned unchanged. */
  read(pair: { threadId: string; toolCallId: string }, opts?: BrowserToolResultCallOptions): Promise<EpAttributedReply>;
  /** Present the redeemed consent to the serving instance. Sent once; never repeated after effect. */
  consent(opts?: BrowserToolResultCallOptions): Promise<EpAttributedReply>;
  /** Withdraw the redeemed consent. Sent once; never repeated after effect. */
  revoke(opts?: BrowserToolResultCallOptions): Promise<EpAttributedReply>;
  /** Close this connection and open a new one through `acquire`, re-checking every pin. */
  reopen(signal?: AbortSignal): Promise<BrowserToolResultCaller>;
  close(): Promise<void>;
}

const isRec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const refused = (message: string): never => { throw new EpEnvelopeError("failed-precondition", message); };

/** Refuse a bearer that is not a `tool-result-caller` view bound to this space, this holder and a
 *  consent for exactly this target, and return the caller triple and the redeemed consent. Only the
 *  routing coordinates are decoded: the broker verifies the signed bearer before any call. */
export function toolResultCallerBinding(
  bearer: string,
  expected: { space: string; holder: ToolResultPrincipal; target: ToolResultPrincipal },
): { caller: EpCaller; grant: Record<string, unknown> } {
  let payload: { sub?: unknown; aud?: unknown; act?: unknown };
  try {
    const parts = bearer.split(".");
    if (parts.length !== 3) throw new Error("invalid JWT");
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(fromBase64url(parts[1]!)));
  } catch {
    return refused("tool-result exchange returned an invalid bearer");
  }
  const { holder, target, space } = expected;
  const act = isRec(payload) ? payload.act : undefined;
  if (!isRec(act) || act.view !== "tool-result-caller")
    return refused("tool-result exchange returned a bearer that is not the tool-result-caller view; no other authority is used");
  if (payload.sub !== holder.owner || act.owner !== holder.owner || act.actor !== holder.actor || act.lifecycleUid !== holder.lifecycleUid ||
      !(payload.aud === space || (Array.isArray(payload.aud) && payload.aud.length === 1 && payload.aud[0] === space)))
    return refused("tool-result exchange returned different space, holder principal or lifecycle coordinates");
  const grant = act.toolResult;
  const t = isRec(grant) ? grant.target : undefined;
  const h = isRec(grant) ? grant.holder : undefined;
  if (!isRec(grant) || grant.v !== 1 || grant.space !== space || grant.scope !== "tool-results" || typeof grant.id !== "string")
    return refused("tool-result exchange returned a bearer without a tool-results consent for this space");
  if (!isRec(t) || t.owner !== target.owner || t.actor !== target.actor || t.lifecycleUid !== target.lifecycleUid)
    return refused("tool-result exchange returned a consent for a different target owner, actor or lifecycle");
  if (!isRec(h) || h.id !== `${holder.owner}.${holder.actor}` || target.owner !== holder.owner)
    return refused("tool-result exchange returned a consent naming a different holder");
  return { caller: { owner: holder.owner, actor: holder.actor, uid: holder.lifecycleUid }, grant };
}

const contractOf = (closureDigest: string): CompiledContract =>
  ({ validate: packagedValidatorFor(closureDigest), closureDigest }) as unknown as CompiledContract;

/** The packaged tool-results surface: exactly one cluster at the registered URN and revision, every
 *  command present, targeted and `handle`-only, each closure packaged. Anything else refuses. */
export function packagedToolResultSurface(): ReadonlyMap<string, { input: CompiledContract; output: CompiledContract }> {
  const matches = PACKAGED_TOOL_RESULT_CLUSTERS.filter((c) => c.urn === TOOL_RESULT_CLUSTER_URN && c.revision === TOOL_RESULT_CLUSTER_REVISION);
  if (matches.length !== 1)
    throw new EpEnvelopeError("unsupported-version", `this browser build packages ${matches.length} ${TOOL_RESULT_CLUSTER_URN} r${TOOL_RESULT_CLUSTER_REVISION} cluster documents, not exactly one`);
  const surface = new Map<string, { input: CompiledContract; output: CompiledContract }>();
  for (const name of TOOL_RESULT_COMMANDS) {
    const cmd = matches[0]!.commands.find((c) => c.name === name);
    if (!cmd || !cmd.targeted || cmd.modes.length !== 1 || cmd.modes[0] !== "handle")
      throw new EpEnvelopeError("unsupported-version", `the packaged ${TOOL_RESULT_CLUSTER_URN} cluster does not serve ${name} as a targeted handle-only command`);
    surface.set(name, { input: contractOf(cmd.inputDigest), output: contractOf(cmd.outputDigest) });
  }
  return surface;
}

const epochPin = (raw: unknown): number => {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0)
    return refused("tool-result authority carried no responder epoch; the caller binds one incarnation and never guesses it");
  return raw;
};

/** Open a caller for one agent incarnation's tool results. */
export async function openBrowserToolResultCaller(opts: BrowserToolResultCallerOptions, signal?: AbortSignal): Promise<BrowserToolResultCaller> {
  signal?.throwIfAborted();
  const deadlineMs = opts.deadlineMs ?? 10_000;
  const surface = packagedToolResultSurface();
  const authority = await opts.acquire(signal);
  const bound = toolResultCallerBinding(authority.bearer, { space: opts.space, holder: opts.holder, target: opts.target });
  const epoch = epochPin(authority.responderEpoch);
  const target = Object.freeze({ ...opts.target });
  const instanceId = target.lifecycleUid;
  const { nc } = await dialCalloutConnection(opts.servers, authority, deadlineMs);
  let invalid: string | undefined;
  void nc.closed().then(() => { invalid ??= "the connection closed"; });
  const onAbort = () => { invalid ??= "the open was aborted"; void nc.close(); };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    signal?.throwIfAborted();
    const handleTarget: EpVerbTarget = { mode: "handle", owner: target.owner, actor: target.actor, lifecycleUid: instanceId };
    const once = (command: string, args: Record<string, unknown>, o: BrowserToolResultCallOptions) => {
      if (invalid !== undefined) refused(`this tool-result caller is invalid (${invalid}); reopen it`);
      return epCall(nc, opts.space, { mode: "inst", instanceId, epoch }, {
        endpoint: TOOL_RESULT_ENDPOINT, command, contract: surface.get(command)!, caller: bound.caller, args,
        target: handleTarget, bind: { instanceId, epoch },
      }, { deadlineMs: o.deadlineMs ?? deadlineMs, ...(o.signal ? { signal: o.signal } : {}) });
    };
    const call = async (command: string, args: Record<string, unknown>, o: BrowserToolResultCallOptions = {}): Promise<EpAttributedReply> => {
      try {
        const result = await once(command, args, o);
        if (result.reply.ok !== false || !replyRefusedBeforeEffect(result.reply.error)) return result;
        // Refused before effect: the command did not run, so it is sent once more and no more.
        return await once(command, args, o);
      } catch (e) {
        // Another epoch answered: this caller's incarnation pin no longer holds. Nothing is resent.
        if (e instanceof EpEnvelopeError && (e.details ?? []).some((d) => d.kind === EP_UNBOUND_RESPONDER)) invalid ??= "the responder epoch changed";
        throw e;
      }
    };
    const handle: BrowserToolResultCaller = {
      caller: bound.caller,
      target,
      responderEpoch: epoch,
      grant: Object.freeze({ ...bound.grant }),
      read: (pair, o) => call(TOOL_RESULT_COMMAND, { threadId: pair.threadId, toolCallId: pair.toolCallId }, o),
      consent: (o) => call(TOOL_RESULT_CONSENT_COMMAND, { consent: bound.grant }, o),
      revoke: (o) => call(TOOL_RESULT_REVOKE_COMMAND, { id: bound.grant.id as string }, o),
      async reopen(s) {
        await handle.close();
        return openBrowserToolResultCaller(opts, s);
      },
      async close() {
        invalid ??= "it was closed";
        signal?.removeEventListener("abort", onAbort);
        if (!nc.isClosed()) await nc.close();
      },
    };
    return handle;
  } catch (e) {
    signal?.removeEventListener("abort", onAbort);
    await nc.close();
    throw e;
  }
}
