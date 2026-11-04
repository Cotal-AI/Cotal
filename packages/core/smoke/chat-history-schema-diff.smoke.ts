/**
 * How the space schema diff classifies the history limit of CHAT, INBOX, DLV and DM, which an
 * operator sets and `cotal up` leaves as it is. Hermetic: the diff is a pure function of observed
 * configs, so each cell hands it one stream observation.
 *
 * Run: pnpm smoke:chat-history-schema-diff
 */
import type { StreamConfig } from "@nats-io/jetstream";
import { canonicalBackupStreamConfig, diffSpaceResources, historyLimitDefault, historyLimitStreamName, taskStream, type HistoryLimit, type HistoryLimitStream } from "../src/index.js";
import { emitSentinel } from "@cotal-ai/smoke-kit";

let ok = 0, fail = 0;
const check = (name: string, pass: boolean, extra?: unknown) => {
  if (pass) { ok++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log("  ✗ FAIL:", name, extra ?? ""); }
};

const space = "schemadiff";
const DAY = 86_400_000, HOUR = 3_600_000;
const rowFor = (stream: string, config: Record<string, unknown>) => {
  const { rows } = diffSpaceResources(space, [{ kind: "stream", stream, operation: "stream-info", state: "present", config: config as unknown as StreamConfig }]);
  return rows.find((row) => row.stream === stream)!;
};
const at = (stream: HistoryLimitStream, limit: HistoryLimit) => canonicalBackupStreamConfig(space, historyLimitStreamName(space, stream), limit) as unknown as Record<string, unknown>;
const row = (stream: HistoryLimitStream, config: Record<string, unknown>) => rowFor(historyLimitStreamName(space, stream), config);

console.log("the chat stream's history limit in the space schema diff:");
const stock = row("chat", at("chat", historyLimitDefault("chat")));
check("a stream on the default limit matches its declared fields", stock.state === "declared-fields-match" && stock.reconciliation.state === "no-declared-change", { state: stock.state, reconciliation: stock.reconciliation });

const operator = row("chat", at("chat", { maxAgeMs: 7 * DAY, perSubject: 500 }));
check("an operator-set limit is its own state", operator.state === "operator-set-history-limit", operator.state);
check("...which cotal up does not change", operator.reconciliation.state === "no-declared-change" && operator.reconciliation.fields.length === 0, operator.reconciliation);
check("...and its observed values are not copied into the declared config", operator.differences.some((d) => d.field === "max_age") && operator.differences.some((d) => d.field === "max_msgs_per_subject"), operator.differences);

const customCount = row("chat", at("chat", { maxAgeMs: 0, perSubject: 500 }));
check("no age with another count is an operator-set limit, left alone", customCount.state === "operator-set-history-limit" && customCount.reconciliation.state === "no-declared-change", { state: customCount.state, reconciliation: customCount.reconciliation });

const old = row("chat", at("chat", { maxAgeMs: 0, perSubject: 1000 }));
check("no age and 1000 per sender, the settings every stream had before 0.134.0, is the declared config", old.state === "declared-fields-match" && old.reconciliation.state === "no-declared-change" && old.reconciliation.nativeGuard === null, { state: old.state, reconciliation: old.reconciliation });

const month = row("chat", at("chat", { maxAgeMs: 30 * DAY, perSubject: 1000 }));
check("30 days and 1000 per sender is an operator-set limit, left alone", month.state === "operator-set-history-limit" && month.reconciliation.state === "no-declared-change", { state: month.state, reconciliation: month.reconciliation });

const noneNone = row("chat", at("chat", { maxAgeMs: 0, perSubject: -1 }));
check("no age and no count is an operator-set limit, left alone", noneNone.state === "operator-set-history-limit" && noneNone.reconciliation.state === "no-declared-change", { state: noneNone.state, reconciliation: noneNone.reconciliation });

const drift = row("chat", { ...at("chat", { maxAgeMs: 7 * DAY, perSubject: 500 }), max_bytes: 1024 });
check("a limit beside any other drift keeps its drift classification", drift.state === "incompatible-or-drifted" && drift.reconciliation.state === "migration-required", { state: drift.state, reconciliation: drift.reconciliation });

const defaultDrift = row("chat", { ...at("chat", historyLimitDefault("chat")), max_bytes: 1024 });
check("the default limit beside other drift gets no guard", defaultDrift.state === "incompatible-or-drifted" && defaultDrift.reconciliation.state === "migration-required" && defaultDrift.reconciliation.nativeGuard === null, { state: defaultDrift.state, reconciliation: defaultDrift.reconciliation });

const invalid = row("chat", at("chat", { maxAgeMs: 60_000, perSubject: 500 }));
check("an age below the two-minute minimum is not an operator-set limit", invalid.state === "incompatible-or-drifted" && invalid.reconciliation.state === "migration-required", { state: invalid.state, reconciliation: invalid.reconciliation });

console.log("\nthe INBOX, DLV and DM history limits in the space schema diff:");
const set: Record<Exclude<HistoryLimitStream, "chat">, HistoryLimit> = { inbox: { maxAgeMs: 3 * HOUR, perSubject: 400 }, dlv: { maxAgeMs: 0, perSubject: -1 }, dm: { maxAgeMs: 30 * DAY, perSubject: 200 } };
const AN = { inbox: "an INBOX", dlv: "a DLV", dm: "a DM" } as const;
for (const stream of ["inbox", "dlv", "dm"] as const) {
  const base = row(stream, at(stream, historyLimitDefault(stream)));
  check(`${AN[stream]} stream on its default limit matches its declared fields`, base.state === "declared-fields-match" && base.reconciliation.state === "no-declared-change", { state: base.state, reconciliation: base.reconciliation });
  const own = row(stream, at(stream, set[stream]));
  check(`an operator-set ${stream.toUpperCase()} limit is its own state, which cotal up does not change`, own.state === "operator-set-history-limit" && own.reconciliation.state === "no-declared-change" && own.reconciliation.fields.length === 0, { state: own.state, reconciliation: own.reconciliation });
  const beside = row(stream, { ...at(stream, set[stream]), max_bytes: 1024 });
  check(`${AN[stream]} limit beside other drift keeps its drift classification`, beside.state === "incompatible-or-drifted" && beside.reconciliation.state === "migration-required", { state: beside.state, reconciliation: beside.reconciliation });
}
for (const stream of ["inbox", "dlv"] as const) {
  const short = row(stream, at(stream, { maxAgeMs: HOUR, perSubject: 1000 }));
  check(`${AN[stream]} age below its two-hour minimum is not an operator-set limit`, short.state === "incompatible-or-drifted" && short.reconciliation.state === "migration-required", { state: short.state, reconciliation: short.reconciliation });
}
const task = canonicalBackupStreamConfig(space, taskStream(space)) as unknown as Record<string, unknown>;
const taskLimit = rowFor(taskStream(space), { ...task, max_msgs_per_subject: 5 });
check("a count on TASK, which takes no history limit, is drift", taskLimit.state === "incompatible-or-drifted" && taskLimit.reconciliation.state === "migration-required", { state: taskLimit.state, reconciliation: taskLimit.reconciliation });

console.log(`\nchat-history-schema-diff: ${ok} passed, ${fail} failed`);
emitSentinel({ passed: ok, failed: fail });
process.exit(fail ? 1 : 0);
