import {
  BASELINE_LIFECYCLE_ENDPOINT,
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
import type { AgentConfig } from "./config.js";

type ManagerConfig = Pick<AgentConfig, "space" | "servers" | "tls" | "lifecycleUid" | "userAuth" | "managerInstanceId">;

/** Runs a call's submission under a goal follow. `prepare` resolves the manager and publishes
 *  nothing, so a failure there surfaces as its own error instead of a submission that may have run. */
type UserManagerFollow = (
  submit: (signal?: AbortSignal) => Promise<EpAttributedReply>,
  prepare: (signal: AbortSignal) => Promise<void>,
) => Promise<EpAttributedReply>;

/** A control connection never replaces the seat's presence, messages or standing bearer source. */
export async function invokeUserManager(
  config: ManagerConfig,
  bearer: string,
  command: string,
  args: Record<string, unknown> | undefined,
  opts: { target?: EpVerbTarget; deadlineMs?: number; follow?: UserManagerFollow; signal?: AbortSignal } = {},
): Promise<EpAttributedReply> {
  opts.signal?.throwIfAborted();
  const user = config.userAuth!;
  const { caller: triple, instanceId } = managerCallerBinding(bearer, {
    space: config.space, owner: user.owner, actor: user.actor, lifecycleUid: config.lifecycleUid!, instanceId: config.managerInstanceId,
  });
  const connectOpts = standaloneConnectOpts({ bearer, sentinelCreds: user.sentinelCreds, tls: config.tls });
  const nc = await dialerFor(config.servers)({
    servers: config.servers,
    ...connectOpts,
    maxReconnectAttempts: 0,
    timeout: Math.min(opts.deadlineMs ?? 10_000, 2_000),
  });
  // Issued interactive views and eligible managed run views carry their own accepted-row read
  // (SPEC 13.15). A managed view without that issuance remains on its legacy rail: the broker
  // refuses the read as a RequestError whose cause is the permission violation.
  let caller: EpCaller = triple;
  try {
    caller = await issuedUserCaller(nc, config.space, String(connectOpts.name), triple);
  } catch (e) {
    if (!isPermissionDenied(e)) {
      await nc.close();
      throw e;
    }
  }
  const onAbort = () => { void nc.close(); };
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    // An in-flight dial has no connection handle to close yet. A late result never publishes.
    opts.signal?.throwIfAborted();
    const endpoint = BASELINE_LIFECYCLE_ENDPOINT;
    const resolve = (signal = opts.signal) => resolveService(nc, config.space, endpoint, caller, { instanceId, deadlineMs: opts.deadlineMs ?? 10_000, signal });
    let service: ResolvedService;
    const invoke = async (signal = opts.signal) => {
      const unfollowable = opts.follow ? goalFollowRefusal(service) : undefined;
      if (unfollowable) return unfollowable;
      const invokeOpts = { target: opts.target, deadlineMs: opts.deadlineMs, signal };
      const result = await invokeCommand(nc, config.space, service, command, args, invokeOpts);
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
        return invokeCommand(nc, config.space, service, command, args, invokeOpts);
      }
      return result;
    };
    if (opts.follow) return await opts.follow(invoke, async (signal) => { service = await resolve(signal); });
    service = await resolve();
    return await invoke();
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        nc.drain().catch(() => nc.close()),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, 2_000); timer.unref(); }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      await nc.close();
    }
  }
}
