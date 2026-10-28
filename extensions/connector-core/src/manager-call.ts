import {
  BASELINE_LIFECYCLE_ENDPOINT,
  EpEnvelopeError,
  dialerFor,
  goalFollowRefusal,
  invokeCommand,
  isPermissionDenied,
  issuedUserCaller,
  managerCallerBinding,
  replyRefusedBeforeEffect,
  resolveService,
  standaloneConnectOpts,
  type EpAttributedReply,
  type EpCaller,
  type EpVerbTarget,
  type ResolvedService,
} from "@cotal-ai/core";
import type { NatsConnection } from "@nats-io/transport-node";
import type { AgentConfig } from "./config.js";

type ManagerConfig = Pick<AgentConfig, "space" | "servers" | "tls" | "lifecycleUid" | "userAuth" | "managerInstanceId">;

/** Credentials whose manager-call view the broker refused an accepted row for: legacy-rail views,
 *  asked once per credential per {@link LEGACY_RAIL_RECHECK_MS}. Keyed by the credential the bearer
 *  was minted from (its renewals keep it), else by the bearer itself. The recheck is what lets an
 *  issuer that starts issuing for this credential be noticed without a seat restart. */
const legacyRail = new Map<string, number>();
const LEGACY_RAIL_RECHECK_MS = 60 * 60_000;
const LEGACY_RAIL_MAX = 32;
function onLegacyRail(key: string): boolean {
  const until = legacyRail.get(key);
  if (until === undefined) return false;
  if (Date.now() < until) return true;
  legacyRail.delete(key);
  return false;
}
function rememberLegacyRail(key: string): void {
  legacyRail.set(key, Date.now() + LEGACY_RAIL_RECHECK_MS);
  if (legacyRail.size > LEGACY_RAIL_MAX) legacyRail.delete(legacyRail.keys().next().value!);
}

/** Forget every remembered legacy-rail verdict. For tests that reuse a process across stacks. */
export function forgetLegacyRail(): void { legacyRail.clear(); }

/** Runs a call's submission under a goal follow. `prepare` runs the bearer command, opens the
 *  control connection and resolves the manager by the follow's deadline. It publishes nothing, so
 *  its failures surface as their own: a describe that draws no reply reports itself as unanswered,
 *  and a stop, or the deadline before the describe, reports the call as not run. */
type UserManagerFollow = (
  submit: (signal?: AbortSignal) => Promise<EpAttributedReply>,
  prepare: (signal: AbortSignal, deadline: number) => Promise<void>,
) => Promise<EpAttributedReply>;

/** A control connection never replaces the seat's presence, messages or standing bearer source. */
export async function invokeUserManager(
  config: ManagerConfig,
  bearer: (signal?: AbortSignal) => Promise<string>,
  command: string,
  args: Record<string, unknown> | undefined,
  opts: { target?: EpVerbTarget; deadlineMs?: number; follow?: UserManagerFollow; signal?: AbortSignal } = {},
): Promise<EpAttributedReply> {
  opts.signal?.throwIfAborted();
  const user = config.userAuth!;
  const endpoint = BASELINE_LIFECYCLE_ENDPOINT;
  let nc: NatsConnection | undefined;
  let caller: EpCaller;
  let instanceId: string;
  let service: ResolvedService;
  const onAbort = () => { void nc?.close(); };
  const resolve = (signal = opts.signal, deadlineMs = opts.deadlineMs ?? 10_000) => resolveService(nc!, config.space, endpoint, caller, { instanceId, deadlineMs, signal });
  const connect = async (signal = opts.signal, deadline = Date.now() + (opts.deadlineMs ?? 10_000)) => {
    const token = await bearer(signal);
    let credentialId: string | undefined;
    ({ caller, instanceId, credentialId } = managerCallerBinding(token, {
      space: config.space, owner: user.owner, actor: user.actor, lifecycleUid: config.lifecycleUid!, instanceId: config.managerInstanceId,
    }));
    const connectOpts = standaloneConnectOpts({ bearer: token, sentinelCreds: user.sentinelCreds, tls: config.tls });
    signal?.throwIfAborted();
    const left = deadline - Date.now();
    if (left <= 0) throw new EpEnvelopeError("deadline-exceeded",
      "the deadline passed before the manager was connected; the manager request WAS NOT RUN", undefined, "not-executed");
    nc = await dialerFor(config.servers)({
      servers: config.servers,
      ...connectOpts,
      maxReconnectAttempts: 0,
      timeout: left,
    });
    // An in-flight dial has no connection handle to close yet. A late result never publishes, and
    // it is closed here because a follow that stopped or reached its deadline has already returned.
    if (signal?.aborted) onAbort();
    signal?.throwIfAborted();
    // Issued interactive views and eligible managed run views carry their own accepted-row read
    // (SPEC 13.15). A managed view without that issuance remains on its legacy rail: the broker
    // refuses the read as a RequestError whose cause is the permission violation. That verdict is
    // the credential's, not the connection's (the issuer wrote a row for an issued view at every
    // callout, and never for a legacy one), so it is asked once per credential and rechecked
    // hourly: a seat that pulls its turns every 15 s on a legacy view used to put one refused
    // request in the broker's log each time, forever (#5040).
    const railKey = credentialId ?? token;
    if (!onLegacyRail(railKey)) {
      try {
        caller = await issuedUserCaller(nc, config.space, String(connectOpts.name), caller);
      } catch (e) {
        if (!isPermissionDenied(e)) throw e;
        rememberLegacyRail(railKey);
      }
    }
  };
  // The describe spends what is left of the follow's deadline, so a silent manager reports itself.
  // With nothing left it would report a silence it had no time to observe.
  const prepare = async (signal: AbortSignal, deadline: number) => {
    await connect(signal, deadline);
    const left = deadline - Date.now();
    if (left <= 0) throw new EpEnvelopeError("deadline-exceeded",
      "the deadline passed before the manager was resolved; the manager request WAS NOT RUN", undefined, "not-executed");
    service = await resolve(signal, left);
  };
  const invoke = async (signal = opts.signal) => {
    const unfollowable = opts.follow ? goalFollowRefusal(service) : undefined;
    if (unfollowable) return unfollowable;
    const invokeOpts = { target: opts.target, deadlineMs: opts.deadlineMs, signal };
    const result = await invokeCommand(nc!, config.space, service, command, args, invokeOpts);
    if (result.reply.ok === false && replyRefusedBeforeEffect(result.reply.error)) {
      try {
        service = await resolve(signal);
        const unfollowable = opts.follow ? goalFollowRefusal(service) : undefined;
        if (unfollowable) throw new Error(unfollowable.reply.error!.message);
      } catch (error) {
        return { ...result, reply: { ...result.reply, error: {
          ...result.reply.error!,
          message: `${command} WAS NOT RUN; manager instance ${instanceId} refused before effects, and re-resolution failed: ${error instanceof Error ? error.message : String(error)}`,
        } } };
      }
      // Keep the second invoke outside the catch: it may execute and must never inherit the
      // first attempt's not-executed verdict if its response is lost.
      return invokeCommand(nc!, config.space, service, command, args, invokeOpts);
    }
    return result;
  };
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (opts.follow) return await opts.follow(invoke, prepare);
    await connect();
    service = await resolve();
    return await invoke();
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
    const control = nc;
    if (control) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          control.drain().catch(() => control.close()),
          new Promise<void>((resolve) => { timer = setTimeout(resolve, 2_000); timer.unref(); }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        await control.close();
      }
    }
  }
}
