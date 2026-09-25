import { randomUUID } from "node:crypto";
import {
  BASELINE_LIFECYCLE_ENDPOINT,
  assertLifecycleToken,
  dialerFor,
  invokeCommand,
  replyRefusedBeforeEffect,
  resolveService,
  standaloneConnectOpts,
  type EpAttributedReply,
  type EpCaller,
  type EpVerbTarget,
} from "@cotal-ai/core";
import type { AgentConfig } from "./config.js";

type ManagerConfig = Pick<AgentConfig, "space" | "servers" | "tls" | "lifecycleUid" | "userAuth" | "managerInstanceId">;

/** Decode only the routing coordinates. The broker verifies the signed bearer before any call. */
export function managerCallerBinding(bearer: string, config: ManagerConfig): { caller: EpCaller; instanceId: string } {
  let payload: { sub?: unknown; aud?: unknown; act?: Record<string, unknown> };
  try {
    const parts = bearer.split(".");
    if (parts.length !== 3) throw new Error("invalid JWT");
    payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
  } catch {
    throw new Error("manager control exchange returned an invalid bearer");
  }
  const user = config.userAuth;
  const act = payload?.act;
  if (!user || !act || act.view !== "manager-caller" || payload.sub !== user.owner ||
      act.owner !== user.owner || act.actor !== user.actor || act.lifecycleUid !== config.lifecycleUid ||
      !(payload.aud === config.space || (Array.isArray(payload.aud) && payload.aud.length === 1 && payload.aud[0] === config.space)))
    throw new Error("manager control exchange returned different space, principal, lifecycle or view coordinates");
  if (typeof act.managerInstanceId !== "string")
    throw new Error("manager control exchange returned no concrete manager instance");
  const instanceId = assertLifecycleToken(act.managerInstanceId, "managerInstanceId");
  if (config.managerInstanceId !== undefined && instanceId !== config.managerInstanceId)
    throw new Error("manager control exchange selected a different manager instance");
  if (typeof act.lifecycleUid !== "string")
    throw new Error("manager control exchange returned no lifecycle UID");
  return { caller: { owner: user.owner, actor: user.actor, uid: act.lifecycleUid }, instanceId };
}

/** A control connection never replaces the seat's presence, messages or standing bearer source. */
export async function invokeUserManager(
  config: ManagerConfig,
  bearer: string,
  command: string,
  args: Record<string, unknown> | undefined,
  opts: { target?: EpVerbTarget; deadlineMs?: number; follow?: boolean } = {},
): Promise<EpAttributedReply> {
  const { caller, instanceId } = managerCallerBinding(bearer, config);
  const nc = await dialerFor(config.servers)({
    servers: config.servers,
    ...standaloneConnectOpts({ bearer, sentinelCreds: config.userAuth!.sentinelCreds, tls: config.tls }),
    maxReconnectAttempts: 0,
  });
  try {
    const endpoint = BASELINE_LIFECYCLE_ENDPOINT;
    const resolve = () => resolveService(nc, config.space, endpoint, caller, { instanceId, deadlineMs: opts.deadlineMs ?? 10_000 });
    let service = await resolve();
    if (opts.follow && !service.commands.has("goal-result")) {
      return {
        reply: {
          v: 1,
          id: randomUUID(),
          ok: false,
          data: undefined,
          error: {
            code: "failed-precondition",
            message: `manager instance ${service.responder.instanceId} does not support "goal-result"; upgrade manager to enable durable goal following (SPEC 13.6)`,
            outcome: "not-executed",
          },
        },
        responder: { endpoint, instanceId: service.responder.instanceId, epoch: service.responder.epoch },
      };
    }
    const invoke = async () => {
      const result = await invokeCommand(nc, config.space, service, command, args, opts);
      if (result.reply.ok === false && replyRefusedBeforeEffect(result.reply.error)) {
        try {
          service = await resolve();
          if (opts.follow && !service.commands.has("goal-result")) {
            throw new Error(`manager instance ${service.responder.instanceId} does not support "goal-result"; upgrade manager to enable durable goal following (SPEC 13.6)`);
          }
        } catch (error) {
          return { ...result, reply: { ...result.reply, error: {
            ...result.reply.error!,
            message: `${command} WAS NOT RUN; manager instance ${instanceId} refused before effects, and re-resolution failed: ${error instanceof Error ? error.message : String(error)}`,
          } } };
        }
        // Keep the second invoke outside the catch: it may execute and must never inherit the
        // first attempt's not-executed verdict if its response is lost.
        return invokeCommand(nc, config.space, service, command, args, opts);
      }
      return result;
    };
    return await invoke();
  } finally {
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
