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

/** Credentials whose manager-call view the broker refused an accepted row for. Successful legacy
 *  calls skip that read until {@link LEGACY_RAIL_RECHECK_MS}; a permission-failed resolve rechecks
 *  its own connection, whose issued view may have changed with the direct parent's grant.
 *  Keyed by the credential the bearer was minted from (its renewals keep it), else by the bearer. */
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
  let skippedAcceptedRead: { key: string; connId: string } | undefined;
  const onAbort = () => { void nc?.close(); };
  const resolve = (signal = opts.signal, deadlineMs = opts.deadlineMs ?? 10_000) => resolveService(nc!, config.space, endpoint, caller, {
    instanceId, deadlineMs, signal, commands: opts.follow ? [command, "goal-result"] : [command],
    ...(opts.follow && command !== "goal-result" ? { optionalCommands: ["goal-result"] } : {}),
  });
  const resolvePrepared = async (signal = opts.signal, deadline = Date.now() + (opts.deadlineMs ?? 10_000)) => {
    const remaining = () => {
      signal?.throwIfAborted();
      const left = deadline - Date.now();
      if (left <= 0) throw new EpEnvelopeError("deadline-exceeded",
        "the deadline passed before the manager was resolved; the manager request WAS NOT RUN", undefined, "not-executed");
      return left;
    };
    try {
      return await resolve(signal, remaining());
    } catch (error) {
      if (!skippedAcceptedRead || !isPermissionDenied(error)) throw error;
      const { key, connId } = skippedAcceptedRead;
      skippedAcceptedRead = undefined;
      remaining();
      // Only discovery failed: no command has been submitted. A fresh accepted row binds this
      // connection to the issuer's current view without replaying a write or changing the pin.
      caller = await issuedUserCaller(nc!, config.space, connId, caller);
      legacyRail.delete(key);
      return resolve(signal, remaining());
    }
  };
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
    // (SPEC 13.15). Memoize genuine legacy refusals to avoid one denied read per polling turn
    // (#5040), but recheck a skipped read if this connection cannot resolve on the legacy rail.
    const railKey = credentialId ?? token;
    if (onLegacyRail(railKey)) {
      skippedAcceptedRead = { key: railKey, connId: String(connectOpts.name) };
    } else {
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
    service = await resolvePrepared(signal, deadline);
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
    service = await resolvePrepared();
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
