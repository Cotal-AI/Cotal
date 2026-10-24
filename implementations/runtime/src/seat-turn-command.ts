import {
  assertLifecycleToken, BASELINE_LIFECYCLE_ENDPOINT, dialerFor, invokeRepairingSplit,
  resolveService, standaloneConnectOpts,
} from "@cotal-ai/core";
import {
  CommandFailure, controlCaller, presentationOf, resolveSeatControlTarget, writeResult,
  type ConnectFlags, type RefusalCode,
} from "@cotal-ai/workspace";

export interface TurnValues extends ConnectFlags {
  json?: boolean;
  plain?: boolean;
  status?: string;
  to?: string;
  note?: string;
}

/** These calls never substitute an operator identity for the seat whose turn is being handled. */
export async function seatTurnCommand(mode: "turns" | "yield", goalId: string | undefined, values: TurnValues): Promise<void> {
  const pin = process.env.COTAL_MANAGER_INSTANCE?.trim();
  const space = process.env.COTAL_SPACE?.trim();
  if (!pin || !space) throw new CommandFailure("refused", "UNSUPPORTED", "run turns/yield require a manager-launched seat's own shell and manager attribution", { remedy: "run the command inside the managed seat; do not supply another caller's credentials" });
  try { assertLifecycleToken(pin, "manager instance"); }
  catch { throw new CommandFailure("refused", "AUTH_REQUIRED", "the managed seat's manager attribution is invalid"); }
  let seat: Awaited<ReturnType<typeof resolveSeatControlTarget>>;
  try { seat = await resolveSeatControlTarget({ ...values, space: values.space ?? space }, pin); }
  catch { throw new CommandFailure("refused", "AUTH_REQUIRED", "the managed seat's own credential could not be verified; no operator identity was substituted"); }
  if (!seat) throw new CommandFailure("refused", "UNSUPPORTED", "self-only workflow turns are not available from this caller; user-auth seats cannot act as themselves through this CLI");
  const who = controlCaller(seat.auth);
  if ("refusal" in who) throw new CommandFailure("refused", "AUTH_REQUIRED", "the seat has no verified native endpoint caller");
  const nc = await dialerFor(seat.server)({ servers: seat.server, ...standaloneConnectOpts({ ...seat.auth, tls: seat.auth.tls === true }), maxReconnectAttempts: 0 });
  const target = { space: seat.space, managerInstanceId: pin };
  let data: unknown;
  try {
    const service = await resolveService(nc, seat.space, BASELINE_LIFECYCLE_ENDPOINT, who.caller, { instanceId: pin, deadlineMs: 10_000 });
    const response = await invokeRepairingSplit(nc, seat.space, service, mode === "turns" ? "turn-pending" : "turn-yield", mode === "turns" ? undefined : {
      goalId, status: values.status, ...(values.to === undefined ? {} : { to: values.to }), ...(values.note === undefined ? {} : { note: values.note }),
    }, { target: { mode: "self" }, deadlineMs: 10_000 });
    if (!response.reply.ok) {
      const native = response.reply.error?.code;
      const known: Record<string, RefusalCode> = { "permission-denied": "PERMISSION_DENIED", "not-found": "TARGET_NOT_FOUND", "expired": "LIFECYCLE_BLOCKED", "failed-precondition": "LIFECYCLE_BLOCKED", "invalid-argument": "SCHEMA_INVALID", "unavailable": "TARGET_UNAVAILABLE" };
      const code = native === undefined ? undefined : known[native];
      if (code) throw new CommandFailure("refused", code, "the manager refused this self-only workflow request", { target, native: { code: native } });
      throw new CommandFailure(mode === "yield" ? "unknown" : "failed", mode === "yield" ? "OPERATION_UNKNOWN" : "OPERATION_FAILED", "the native workflow-turn request did not return a confirmed outcome; it was not retried", { target, native: { code: native } });
    }
    data = response.reply.data;
  } finally { await nc.drain().catch(() => nc.close()); }
  if (mode === "yield") {
    writeResult(presentationOf(values), { command: "run", target, result: { kind: "turn-yield", goalId, status: values.status, result: data } }, () => ({ sections: [
      { title: "Turn yield accepted", blocks: [{ kind: "fields", rows: [["Turn", goalId!], ["Status", values.status!]] }, { kind: "lines", lines: [{ text: "This settles the assigned turn, not the entire workflow.", tone: "hint" }] }] },
    ] }));
    return;
  }
  const turns = data && typeof data === "object" ? (data as { turns?: unknown }).turns : undefined;
  if (!Array.isArray(turns)) throw new CommandFailure("failed", "OPERATION_FAILED", "the manager returned no valid pending-turn snapshot", { target });
  const items = turns.map((value) => {
    const row = value as { goalId?: unknown; deadlineAt?: unknown; acceptedAt?: unknown; payload?: unknown } | null;
    if (!row || typeof row.goalId !== "string" || typeof row.deadlineAt !== "number" || !Number.isFinite(row.deadlineAt) || typeof row.acceptedAt !== "number" || !Number.isFinite(row.acceptedAt))
      throw new CommandFailure("failed", "OPERATION_FAILED", "the manager returned an incomplete pending-turn record", { target });
    return { goalId: row.goalId, deadlineAt: row.deadlineAt, acceptedAt: row.acceptedAt, payload: row.payload };
  });
  writeResult(presentationOf(values), { command: "run", target, result: { kind: "turns", items } }, (result) => ({ sections: [
    { title: "Assigned workflow turns", blocks: [result.items.length ? { kind: "table", columns: [{ key: "id", label: "Turn" }, { key: "accepted", label: "Accepted" }, { key: "deadline", label: "Deadline" }], rows: result.items.map((row) => ({ id: row.goalId, accepted: new Date(row.acceptedAt).toISOString(), deadline: new Date(row.deadlineAt).toISOString() })) } : { kind: "lines", lines: ["No pending turns in this seat's manager snapshot."] }, { kind: "lines", lines: [{ text: "Only this seat's assigned turns. A completed work item still needs its native yield.", tone: "hint" }] }] },
    { title: "Next", blocks: [{ kind: "commands", items: [{ command: "cotal r yield <turn-id> --status <done|blocked|handoff>", description: "Report the actual outcome of an assigned turn" }] }] },
  ] }));
}
