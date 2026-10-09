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
  const connect = async (signal = opts.signal) => {
    const token = await bearer(signal);
    ({ caller, instanceId } = managerCallerBinding(token, {
      space: config.space, owner: user.owner, actor: user.actor, lifecycleUid: config.lifecycleUid!, instanceId: config.managerInstanceId,
    }));
    const connectOpts = standaloneConnectOpts({ bearer: token, sentinelCreds: user.sentinelCreds, tls: config.tls });
    nc = await dialerFor(config.servers)({
      servers: config.servers,
      ...connectOpts,
      maxReconnectAttempts: 0,
      timeout: Math.min(opts.deadlineMs ?? 10_000, 2_000),
    });
    // An in-flight dial has no connection handle to close yet. A late result never publishes, and
    // it is closed here because a follow that stopped or reached its deadline has already returned.
    if (signal?.aborted) onAbort();
    signal?.throwIfAborted();
    // Issued interactive views and eligible managed run views carry their own accepted-row read
    // (SPEC 13.15). A managed view without that issuance remains on its legacy rail: the broker
    // refuses the read as a RequestError whose cause is the permission violation.
    try {
      caller = await issuedUserCaller(nc, config.space, String(connectOpts.name), caller);
    } catch (e) {
      if (!isPermissionDenied(e)) throw e;
    }
  };
  // Nothing else bounds a followed call's preparation. The steps before the describe end at the
  // deadline, and the describe spends what is left of it, so a silent manager reports itself.
  const prepare = async (signal: AbortSignal, deadline: number) => {
    const expired = () => new EpEnvelopeError("deadline-exceeded",
      "the deadline passed before the manager was resolved; the manager request WAS NOT RUN", undefined, "not-executed");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([connect(signal), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(expired()), deadline - Date.now()); })]);
    } finally {
      clearTimeout(timer);
    }
    const left = deadline - Date.now();
    if (left <= 0) throw expired();
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
