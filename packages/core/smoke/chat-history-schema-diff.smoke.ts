/**
 * How the space schema diff classifies the chat stream's history limit, which an operator sets and
 * `cotal up` migrates only from the legacy pair. Hermetic: the diff is a pure function of observed
 * configs, so each cell hands it one chat stream observation.
 *
 * Run: pnpm smoke:chat-history-schema-diff
 */
import type { StreamConfig } from "@nats-io/jetstream";
import { CHAT_HISTORY_DEFAULT, LEGACY_CHAT_HISTORY, canonicalBackupStreamConfig, chatStream, diffSpaceResources, type ChatHistoryLimit } from "../src/index.js";
import { emitSentinel } from "@cotal-ai/smoke-kit";

let ok = 0, fail = 0;
const check = (name: string, pass: boolean, extra?: unknown) => {
  if (pass) { ok++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log("  ✗ FAIL:", name, extra ?? ""); }
};

const space = "schemadiff";
const stream = chatStream(space);
const rowFor = (config: Record<string, unknown>) => {
  const { rows } = diffSpaceResources(space, [{ kind: "stream", stream, operation: "stream-info", state: "present", config: config as unknown as StreamConfig }]);
  return rows.find((row) => row.stream === stream)!;
};
const chat = (limit: ChatHistoryLimit) => canonicalBackupStreamConfig(space, stream, limit) as unknown as Record<string, unknown>;

console.log("the chat stream's history limit in the space schema diff:");
const stock = rowFor(chat(CHAT_HISTORY_DEFAULT));
check("a stream on the default limit matches its declared fields", stock.state === "declared-fields-match" && stock.reconciliation.state === "no-declared-change", { state: stock.state, reconciliation: stock.reconciliation });

const operator = rowFor(chat({ maxAgeMs: 7 * 86_400_000, perSender: 500 }));
check("an operator-set limit is its own state", operator.state === "operator-set-history-limit", operator.state);
check("...which cotal up does not change", operator.reconciliation.state === "no-declared-change" && operator.reconciliation.fields.length === 0, operator.reconciliation);
check("...and its observed values are not copied into the declared config", operator.differences.some((d) => d.field === "max_age") && operator.differences.some((d) => d.field === "max_msgs_per_subject"), operator.differences);

const customCount = rowFor(chat({ maxAgeMs: 0, perSender: 500 }));
check("no age with another count is an operator-set limit, left alone", customCount.state === "operator-set-history-limit" && customCount.reconciliation.state === "no-declared-change", { state: customCount.state, reconciliation: customCount.reconciliation });

const legacy = rowFor(chat(LEGACY_CHAT_HISTORY));
check("the legacy pair stays a declared difference", legacy.state === "incompatible-or-drifted", legacy.state);
check("...behind the chat-legacy-history guard", legacy.reconciliation.state === "native-guard-required" && legacy.reconciliation.nativeGuard === "chat-legacy-history" && legacy.reconciliation.fields.includes("max_age"), legacy.reconciliation);

const drift = rowFor({ ...chat({ maxAgeMs: 7 * 86_400_000, perSender: 500 }), max_bytes: 1024 });
check("a limit beside any other drift keeps its drift classification", drift.state === "incompatible-or-drifted" && drift.reconciliation.state === "migration-required", { state: drift.state, reconciliation: drift.reconciliation });

const legacyDrift = rowFor({ ...chat(LEGACY_CHAT_HISTORY), max_bytes: 1024 });
check("the legacy pair beside other drift gets no guard", legacyDrift.reconciliation.state === "migration-required" && legacyDrift.reconciliation.nativeGuard === null, legacyDrift.reconciliation);

const invalid = rowFor(chat({ maxAgeMs: 60_000, perSender: 500 }));
check("an age below the two-minute minimum is not an operator-set limit", invalid.state === "incompatible-or-drifted" && invalid.reconciliation.state === "migration-required", { state: invalid.state, reconciliation: invalid.reconciliation });

console.log(`\nchat-history-schema-diff: ${ok} passed, ${fail} failed`);
emitSentinel({ passed: ok, failed: fail });
process.exit(fail ? 1 : 0);
