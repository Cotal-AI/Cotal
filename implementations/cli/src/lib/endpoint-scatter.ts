import { epScatterService, type ResolvedService } from "@cotal-ai/core";
import { jetstreamManager } from "@nats-io/jetstream";
import type { NatsConnection } from "@nats-io/transport-node";
import { CommandFailure, writeResult, type Presentation, type RefusalCode, type Report } from "@cotal-ai/workspace";
import { nativeEndpointRefusal } from "./endpoint-errors.js";

/** One native frozen-set gather, without instance probes, a bind, repair or a second publication. */
export async function invokeEndpointScatter(nc: NatsConnection, space: string, service: ResolvedService, command: string, args: Record<string, unknown> | undefined, requestId: string, deadlineMs: number) {
  const declaration = service.commands.get(command)!;
  if (service.pinnedInstanceId !== undefined || declaration.targeted) throw new CommandFailure("refused", "CONFLICT", "a class scatter cannot carry an instance pin or a per-agent target");
  const input = args === undefined && !declaration.contract.input.validate(null) && declaration.contract.input.validate({}) ? {} : args;
  const jsm = await jetstreamManager(nc, { checkAPI: false });
  const gathered = await epScatterService(nc, jsm, space, {
    endpoint: service.endpoint, command, contract: declaration.contract, caller: service.caller, id: requestId,
    ...(input === undefined ? {} : { args: input }),
  }, { deadlineMs });
  return {
    kind: "endpoint-scatter" as const, endpoint: service.endpoint, command, requestId,
    coverageComplete: gathered.complete,
    replies: [...gathered.replies].sort(([a], [b]) => a.localeCompare(b)).map(([instanceId, response]) => ({
      instanceId, responder: response.responder, requestId: response.reply.id, ok: response.reply.ok,
      dataPresent: response.reply.data !== undefined, data: response.reply.data ?? null,
      error: response.reply.error ? { code: response.reply.error.code, outcome: response.reply.error.outcome ?? null } : null,
    })),
    missing: gathered.missing, churn: gathered.churn, unexpected: gathered.unexpected,
    duplicate: gathered.duplicate, late: gathered.late,
    invalid: gathered.invalid.map(({ instanceId, epoch }) => ({ instanceId, epoch, detail: "native reply validation failed; raw diagnostic omitted" })),
    probePolicy: "no additional instance-rail grants or probes" as const,
    repairAttempted: false, retried: false,
  };
}

type ScatterResult = Awaited<ReturnType<typeof invokeEndpointScatter>>;

function scatterFailure(result: ScatterResult, target: unknown): CommandFailure | undefined {
  const successes = result.replies.filter((reply) => reply.ok).length;
  const failures = result.replies.filter((reply) => !reply.ok);
  if (result.coverageComplete && !failures.length) return undefined;
  const remedy = "inspect this original scatter and its per-instance results; do not repeat the class mutation merely to recover missing output";
  if (result.coverageComplete && failures.length === result.replies.length && failures.every((reply) => reply.error?.outcome === "not-executed")) {
    const codes = failures.map((reply) => nativeEndpointRefusal(reply.error?.code));
    const code: RefusalCode = codes[0] !== undefined && codes.every((candidate) => candidate === codes[0]) ? codes[0] : "LIFECYCLE_BLOCKED";
    return new CommandFailure("refused", code, "every frozen member refused before execution; per-member native codes are retained", { target, remedy });
  }
  if (result.coverageComplete && failures.length === result.replies.length && failures.every((reply) => reply.error?.outcome === "executed")) return new CommandFailure("failed", "OPERATION_FAILED", "every frozen member reported an executed failure", { target, remedy });
  const known = successes + failures.filter((reply) => reply.error?.outcome === "executed" || reply.error?.outcome === "not-executed").length;
  return known === 0
    ? new CommandFailure("unknown", "OPERATION_UNKNOWN", "no member's execution outcome is confirmed; missing, invalid and churn observations are not success", { target, remedy })
    : new CommandFailure("partial", "OPERATION_PARTIAL", "the class scatter has mixed or incomplete outcomes; no missing member or rejected reply was silently counted as success", { target, remedy });
}

export function writeEndpointScatter(presentation: Presentation, command: string, target: unknown, result: ScatterResult): void {
  const warnings = [
    ...(result.unexpected.length ? [{ code: "SCATTER_UNEXPECTED", target, message: `${result.unexpected.length} unexpected replies were observed and not counted.` }] : []),
    ...(result.duplicate.length ? [{ code: "SCATTER_DUPLICATE", target, message: `${result.duplicate.length} duplicate replies were observed; the first valid reply wins.` }] : []),
    ...(result.late.length ? [{ code: "SCATTER_LATE", target, message: `${result.late.length} late replies were observed and not counted.` }] : []),
    ...(result.churn.length ? [{ code: "SCATTER_CHURN", target, message: `${result.churn.length} epoch or registration changes were observed; native coverage classification is retained.` }] : []),
  ];
  writeResult(presentation, { command, target, result, completeness: result.coverageComplete ? "complete" : "partial", warnings, failure: scatterFailure(result, target) }, (data): Report => ({ sections: [
    { title: "Class scatter observed", blocks: [
      { kind: "fields", rows: [["Endpoint", data.endpoint], ["Command", data.command], ["Original request", data.requestId], ["Frozen-slot coverage", data.coverageComplete ? "complete; not a claim that every command succeeded" : { text: "incomplete", tone: "waiting" }], ["Valid replies", String(data.replies.length)], ["Missing", String(data.missing.length)], ["Churn", String(data.churn.length)], ["Invalid", String(data.invalid.length)], ["Unexpected", String(data.unexpected.length)], ["Duplicate", String(data.duplicate.length)], ["Late", String(data.late.length)]] },
      { kind: "lines", lines: [{ text: "One publication to the frozen native class set, followed by native registration reconciliation. Missing means no counted on-time response, not proof that a process is dead. No broader caller, liveness probe, repair or retry was substituted.", tone: "hint" }] },
    ] },
    { title: "Attributed member replies", blocks: [data.replies.length ? { kind: "table", columns: [{ key: "instance", label: "Full instance" }, { key: "epoch", label: "Epoch" }, { key: "outcome", label: "Native outcome" }, { key: "code", label: "Native code" }], rows: data.replies.slice(0, 100).map((reply) => ({ instance: reply.instanceId, epoch: String(reply.responder.epoch), outcome: reply.ok ? "returned success" : reply.error?.outcome ?? "unknown", code: reply.error?.code ?? "none" })) } : { kind: "lines", lines: ["No counted valid replies."] }, ...(data.replies.length > 100 ? [{ kind: "lines" as const, lines: [`${data.replies.length - 100} member rows are not shown; structured output retains all classifications.`] }] : [])] },
    { title: "Uncounted observations", blocks: [
      { kind: "table", columns: [{ key: "instance", label: "Full instance" }, { key: "kind", label: "Classification" }, { key: "epoch", label: "Epoch" }], rows: [
        ...data.missing.map((instance) => ({ instance, kind: "missing at deadline", epoch: "not returned" })),
        ...data.churn.map((row) => ({ instance: row.instanceId, kind: `${row.reason} churn`, epoch: String(row.epoch) })),
        ...data.invalid.map((row) => ({ instance: row.instanceId, kind: "invalid reply", epoch: String(row.epoch) })),
        ...data.unexpected.map((row) => ({ instance: row.instanceId, kind: "unexpected reply", epoch: String(row.epoch) })),
        ...data.duplicate.map((row) => ({ instance: row.instanceId, kind: "duplicate reply", epoch: String(row.epoch) })),
        ...data.late.map((row) => ({ instance: row.instanceId, kind: "late reply", epoch: String(row.epoch) })),
      ].slice(0, 100) },
      { kind: "lines", lines: [`${data.missing.length + data.churn.length + data.invalid.length + data.unexpected.length + data.duplicate.length + data.late.length} observations in total; the report shows at most 100. Buckets may overlap for one instance. --json retains every bucket and the native result values. Endpoint-provided results are not secret-redacted; no argument body or raw validation diagnostic is printed.`] },
    ] },
  ] }));
}
