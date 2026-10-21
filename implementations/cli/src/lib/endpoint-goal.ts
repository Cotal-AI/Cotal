import { goalFollowRefusal, invokeCommand, invokeRepairingSplit, resolveService, submitAndFollowGoal, type EpAttributedReply, type EpVerbTarget, type GoalResultFact, type ResolvedService } from "@cotal-ai/core";
import type { NatsConnection } from "@nats-io/transport-node";
import { CommandFailure } from "@cotal-ai/workspace";

export interface AcceptedEndpointGoal {
  requestId: string;
  goalId: string;
  fingerprint?: string;
  responder: EpAttributedReply["responder"];
}

/** One submission and native goal observation. Ending observation never stops or resubmits the action. */
export async function followEndpointAction(nc: NatsConnection, space: string, service: ResolvedService, command: string, input: Record<string, unknown> | undefined, options: {
  requestId: string; deadlineMs: number; target?: EpVerbTarget; retainBinding: boolean; signal: AbortSignal;
  beforeSubmit(): void; accepted(value: AcceptedEndpointGoal): void;
}): Promise<EpAttributedReply> {
  if (goalFollowRefusal(service)) throw new CommandFailure("refused", "UNSUPPORTED", "this action surface has no native goal-result reconciliation command; no action was submitted");
  let accepted: AcceptedEndpointGoal | undefined;
  const invoke = options.retainBinding ? invokeCommand : invokeRepairingSplit;
  const response = await submitAndFollowGoal(nc, space, service.endpoint, service.caller, options.deadlineMs, async (signal) => {
    options.beforeSubmit();
    const reply = await invoke(nc, space, service, command, input, { id: options.requestId, deadlineMs: options.deadlineMs, ...(options.target ? { target: options.target } : {}), ...(signal ? { signal } : {}) });
    const data = reply.reply.data as { goalId?: unknown; fingerprint?: unknown } | undefined;
    if (reply.reply.ok && typeof data?.goalId === "string") {
      accepted = { requestId: reply.reply.id, goalId: data.goalId, responder: reply.responder, ...(typeof data.fingerprint === "string" ? { fingerprint: data.fingerprint } : {}) };
      options.accepted(accepted);
    }
    return reply;
  }, { signal: options.signal, reconcile: async (goalId, receipt, context) => {
    const current = await resolveService(nc, space, service.endpoint, context.caller, { instanceId: receipt.responder.instanceId, deadlineMs: context.deadlineMs, signal: context.signal });
    const reply = await invokeCommand(nc, space, current, "goal-result", { goalId }, { deadlineMs: context.deadlineMs, signal: context.signal });
    if (!reply.reply.ok) throw new Error("the accepting endpoint did not confirm the canonical goal-result read");
    return reply.reply.data as { goalId: string; result?: GoalResultFact };
  } });
  if (response.reply.ok && !accepted) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the declared action returned success without a usable accepted goal ID; terminal completion was not inferred and the call was not retried", { target: { space, endpoint: service.endpoint, command, requestId: options.requestId } });
  if (accepted && response.reply.ok === false && ["failed", "cancelled", "expired"].includes(response.reply.error?.code ?? "")) throw new CommandFailure("failed", "OPERATION_FAILED", "the accepted goal reached a native non-success terminal", { target: { space, endpoint: service.endpoint, command, accepted }, native: { code: response.reply.error!.code, outcome: "executed" } });
  return response;
}
