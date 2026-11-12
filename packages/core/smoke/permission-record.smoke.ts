/**
 * The permission record, graded from core's source: its state machine, its boundary parser, the
 * schema property readers rely on, and the one `gone` rule.
 *
 * Every expected value is written out from the design table, never derived from a run of the code.
 * The 25 state and event cells are graded by count, so a cell the table loses, or a branch that stops
 * matching its row, fails here. Each parser refusal starts from a record the parser accepts and
 * changes one field, so a refusal can only come from that field.
 *
 * The schema cells exist because an interactive reader's consumer can push stored record bytes to any
 * subject. No record the parser accepts may validate as a CotalMessage under spec/cotal.schema.json,
 * and a value that does validate as one is refused by the parser.
 *
 * Run: pnpm smoke:permission-record
 */
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { Ajv } from "ajv";
import { createSuite } from "@cotal-ai/smoke-kit";
import {
  holderLiveness,
  parsePermissionRecord,
  permissionKey,
  principalId,
  stepPermission,
  type PermissionEvent,
  type PermissionState,
  type PermissionStep,
} from "../src/permissions.js";

const { check, finish } = createSuite();

const OWNER = `u_${"a".repeat(26)}`;
const AGENT = principalId(OWNER, "coder");
const WEB = principalId(OWNER, "web");
const CLI = principalId(OWNER, "cli");
const ID = "abcdefghijklmnopqrstuvwxyz";
const T = 1_800_000_000_000;
const LATER = T + 5;

check("a principal id is the owner and actor dot form", AGENT === `${OWNER}.coder`, AGENT);
let badPrincipal = "";
try { principalId(OWNER, "*"); } catch (e) { badPrincipal = (e as Error).message; }
check("a principal id refuses a wildcard actor", badPrincipal !== "", badPrincipal);

// ── stepPermission: the 25 cells ──────────────────────────────────────────────────────────────

const STATES: { [K in PermissionState["kind"]]: Extract<PermissionState, { kind: K }> } = {
  pending: { kind: "pending" },
  approved: { kind: "approved", by: WEB, at: T },
  denied: { kind: "denied", by: WEB, at: T },
  "answered-on-machine": { kind: "answered-on-machine", at: T, outcome: "allowed" },
  expired: { kind: "expired", at: T },
};
const EVENTS: { [K in PermissionEvent["kind"]]: Extract<PermissionEvent, { kind: K }> } = {
  answer: { kind: "answer", by: WEB, at: LATER, decision: "approve" },
  "tool-ran": { kind: "tool-ran", at: LATER },
  withdrawn: { kind: "withdrawn", at: LATER },
  deadline: { kind: "deadline", at: LATER },
  undelivered: { kind: "undelivered", at: LATER },
};
const IGNORE: PermissionStep = { kind: "ignore" };
const WITHDRAWN_ON_MACHINE: PermissionStep = { kind: "move", next: { kind: "answered-on-machine", at: LATER, outcome: "withdrawn" } };
const EXPECTED: Record<PermissionState["kind"], Record<PermissionEvent["kind"], PermissionStep>> = {
  pending: {
    answer: { kind: "move", next: { kind: "approved", by: WEB, at: LATER } },
    "tool-ran": { kind: "move", next: { kind: "answered-on-machine", at: LATER, outcome: "allowed" } },
    withdrawn: WITHDRAWN_ON_MACHINE,
    deadline: { kind: "move", next: { kind: "expired", at: LATER } },
    undelivered: IGNORE,
  },
  approved: { answer: { kind: "repeat" }, "tool-ran": IGNORE, withdrawn: IGNORE, deadline: IGNORE, undelivered: WITHDRAWN_ON_MACHINE },
  denied: { answer: { kind: "refuse", code: "answered" }, "tool-ran": IGNORE, withdrawn: IGNORE, deadline: IGNORE, undelivered: WITHDRAWN_ON_MACHINE },
  "answered-on-machine": { answer: { kind: "refuse", code: "answered" }, "tool-ran": IGNORE, withdrawn: IGNORE, deadline: IGNORE, undelivered: IGNORE },
  expired: { answer: { kind: "refuse", code: "expired" }, "tool-ran": IGNORE, withdrawn: IGNORE, deadline: IGNORE, undelivered: IGNORE },
};

/** Freeze a value and everything under it, so a step that writes to its input throws. */
function deepFreeze<V>(value: V): V {
  if (value !== null && typeof value === "object") {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

let graded = 0;
const mismatches: unknown[] = [];
for (const [s, state] of Object.entries(STATES) as [PermissionState["kind"], PermissionState][])
  for (const [e, event] of Object.entries(EVENTS) as [PermissionEvent["kind"], PermissionEvent][]) {
    graded++;
    const got = stepPermission(deepFreeze(state), deepFreeze(event));
    if (!isDeepStrictEqual(got, EXPECTED[s][e])) mismatches.push({ state: s, event: e, got, want: EXPECTED[s][e] });
  }
check(`all ${graded} state x event cells match the design table (${graded - mismatches.length} of 25)`,
  graded === 25 && mismatches.length === 0, mismatches);

// The answer column's other branches: a repeat needs the same answerer, decision and note.
const deny = (by: typeof WEB, note?: string): PermissionEvent =>
  ({ kind: "answer", by, at: LATER, decision: "deny", ...(note === undefined ? {} : { note }) });
const approve = (by: typeof WEB): PermissionEvent => ({ kind: "answer", by, at: LATER, decision: "approve" });
const deniedBy = (by: typeof WEB, note?: string): PermissionState =>
  ({ kind: "denied", by, at: T, ...(note === undefined ? {} : { note }) });
const REFUSE_ANSWERED: PermissionStep = { kind: "refuse", code: "answered" };
const BRANCHES: [string, PermissionState, PermissionEvent, PermissionStep][] = [
  ["pending, deny with a note: denied keeps the note", STATES.pending, deny(WEB, "Use staging."),
    { kind: "move", next: { kind: "denied", by: WEB, at: LATER, note: "Use staging." } }],
  ["pending, deny without a note: denied carries no note field", STATES.pending, deny(WEB),
    { kind: "move", next: { kind: "denied", by: WEB, at: LATER } }],
  ["approved, the same approval from another principal: refused", STATES.approved, approve(CLI), REFUSE_ANSWERED],
  ["approved, a denial from the same principal: refused", STATES.approved, deny(WEB), REFUSE_ANSWERED],
  ["denied, the same denial again: repeats", deniedBy(WEB), deny(WEB), { kind: "repeat" }],
  ["denied with a note, the same note again: repeats", deniedBy(WEB, "Use staging."), deny(WEB, "Use staging."), { kind: "repeat" }],
  ["denied with a note, another note: refused", deniedBy(WEB, "Use staging."), deny(WEB, "Not now."), REFUSE_ANSWERED],
  ["denied with a note, no note: refused", deniedBy(WEB, "Use staging."), deny(WEB), REFUSE_ANSWERED],
  ["denied, the same denial from another principal: refused", deniedBy(WEB), deny(CLI), REFUSE_ANSWERED],
  ["answered on the machine as withdrawn, a denial: refused", { kind: "answered-on-machine", at: T, outcome: "withdrawn" }, deny(WEB), REFUSE_ANSWERED],
  ["expired, a denial: refused as expired", STATES.expired, deny(WEB), { kind: "refuse", code: "expired" }],
];
const branchMisses = BRANCHES.filter(([, s, e, want]) => !isDeepStrictEqual(stepPermission(deepFreeze(s), deepFreeze(e)), want)).map(([name]) => name);
check(`all ${BRANCHES.length} answer-branch cells match (${BRANCHES.length - branchMisses.length} of ${BRANCHES.length})`,
  BRANCHES.length === 11 && branchMisses.length === 0, branchMisses);

// ── parsePermissionRecord: the closed schema of a stored record ─────────────────────────────

const KEY = `${OWNER}.coder.${ID}`;
const HOLDER ={ lifecycleUid: "l".repeat(26), runtimeId: "0f0e2d4c-5b6a-4978-8a1b-2c3d4e5f6a7b" };
const base = (): Record<string, unknown> => ({
  v: 1, id: ID, agent: `${OWNER}.coder`, holder: { ...HOLDER }, tool: "Bash",
  input: { kind: "shown", value: { command: "npm test", description: "Run the tests" } },
  cwd: "/home/dev/app", askedAt: T, state: { kind: "pending" },
});
const shapes: [string, Record<string, unknown>][] = [
  ["pending, shown input, cwd", base()],
  ["pending without cwd", (({ cwd: _cwd, ...rest }) => rest)(base())],
  ["pending with a deadline", { ...base(), deadline: T + 60_000 }],
  ["pending, withheld input", { ...base(), input: { kind: "withheld", bytes: 300_000 } }],
  ["pending, a shown input that is a bare string", { ...base(), input: { kind: "shown", value: "ls" } }],
  ["approved", { ...base(), state: { kind: "approved", by: `${OWNER}.web`, at: LATER } }],
  ["denied without a note", { ...base(), state: { kind: "denied", by: `${OWNER}.web`, at: LATER } }],
  ["denied with a note", { ...base(), state: { kind: "denied", by: `${OWNER}.web`, at: LATER, note: "Use staging." } }],
  ["answered on the machine, allowed", { ...base(), state: { kind: "answered-on-machine", at: LATER, outcome: "allowed" } }],
  ["answered on the machine, withdrawn", { ...base(), state: { kind: "answered-on-machine", at: LATER, outcome: "withdrawn" } }],
  ["expired", { ...base(), deadline: T + 1, state: { kind: "expired", at: LATER } }],
  ["withheld input, denied with a note", { ...base(), input: { kind: "withheld", bytes: 300_000 }, state: { kind: "denied", by: `${OWNER}.cli`, at: LATER, note: "Too large to read." } }],
];
const unread = shapes.filter(([, record]) => !isDeepStrictEqual(parsePermissionRecord(JSON.parse(JSON.stringify(record)), KEY), record)).map(([name]) => name);
check(`every stored shape round-trips through its bytes (${shapes.length - unread.length} of ${shapes.length})`,
  shapes.length === 12 && unread.length === 0, unread);

type Edit = (r: Record<string, unknown>) => unknown;
const set = (field: string, value: unknown): Edit => (r) => ({ ...r, [field]: value });
const drop = (field: string): Edit => (r) => { const { [field]: _gone, ...rest } = r; return rest; };
const within = (field: string, edit: Edit): Edit => (r) => ({ ...r, [field]: edit(r[field] as Record<string, unknown>) });
const REFUSALS: [string, Edit, string?][] = [
  ["null", () => null],
  ["an array", () => [base()]],
  ["a JSON string of a record", () => JSON.stringify(base())],
  ["version 2", set("v", 2)],
  ["version as a string", set("v", "1")],
  ["no tool", drop("tool")],
  ["an empty tool", set("tool", "")],
  ["an unknown top-level field", set("note", "x")],
  ["a top-level `from`", set("from", { id: `${OWNER}.coder`, name: "coder" })],
  ["an id with uppercase letters", set("id", ID.toUpperCase()), `${OWNER}.coder.${ID.toUpperCase()}`],
  ["an id one character short", set("id", ID.slice(1)), `${OWNER}.coder.${ID.slice(1)}`],
  ["a key naming another id", (r) => r, `${OWNER}.coder.${"b".repeat(26)}`],
  ["a key naming a sibling agent", (r) => r, `${OWNER}.helper.${ID}`],
  ["an agent with a wildcard actor", set("agent", `${OWNER}.*`), `${OWNER}.*.${ID}`],
  ["an agent of three tokens", set("agent", `${OWNER}.coder.x`), `${OWNER}.coder.x.${ID}`],
  ["a holder without a runtime id", within("holder", drop("runtimeId"))],
  ["a holder with an empty runtime id", within("holder", set("runtimeId", ""))],
  ["a holder lifecycle that is not a lifecycle token", within("holder", set("lifecycleUid", "NOT-A-UID"))],
  ["a holder lifecycle given as an array of one token", within("holder", set("lifecycleUid", ["l".repeat(26)]))],
  ["a holder with an extra field", within("holder", set("pid", 42))],
  ["an input of unknown kind", set("input", { kind: "elided" })],
  ["a shown input without a value", set("input", { kind: "shown" })],
  ["a withheld input that carries the value", set("input", { kind: "withheld", bytes: 300_000, value: "x" })],
  ["a withheld input of negative size", set("input", { kind: "withheld", bytes: -1 })],
  ["a withheld input of fractional size", set("input", { kind: "withheld", bytes: 1.5 })],
  ["a stored `gone` state", set("state", { kind: "gone" })],
  ["an approval without its answerer", set("state", { kind: "approved", at: LATER })],
  ["an approval by a non-principal", set("state", { kind: "approved", by: "web", at: LATER })],
  ["a denial with a numeric note", set("state", { kind: "denied", by: `${OWNER}.web`, at: LATER, note: 7 })],
  ["a pending state that names an answerer", set("state", { kind: "pending", by: `${OWNER}.web` })],
  ["an on-machine outcome that is not allowed or withdrawn", set("state", { kind: "answered-on-machine", at: LATER, outcome: "denied" })],
  ["an expiry at a negative time", set("state", { kind: "expired", at: -1 })],
  ["an askedAt that is a string", set("askedAt", String(T))],
  ["a fractional askedAt", set("askedAt", T + 0.5)],
  ["an empty cwd", set("cwd", "")],
  ["a deadline as an ISO string", set("deadline", new Date(T).toISOString())],
];
const parsedBase = parsePermissionRecord(base(), KEY);
check("positive control: the base record the refusals edit parses", parsedBase !== undefined);
check("the record key is <owner>.<actor>.<id>",
  parsedBase !== undefined && permissionKey(parsedBase.agent, parsedBase.id) === KEY, parsedBase && permissionKey(parsedBase.agent, parsedBase.id));
const admitted = REFUSALS.filter(([, edit, key]) => parsePermissionRecord(edit(base()), key ?? KEY) !== undefined).map(([name]) => name);
check(`every malformed record is refused (${REFUSALS.length - admitted.length} of ${REFUSALS.length})`,
  REFUSALS.length === 36 && admitted.length === 0, admitted);

// ── No record is a CotalMessage ───────────────────────────────────────────────────────────────

const schema = JSON.parse(readFileSync(new URL("../../../spec/cotal.schema.json", import.meta.url), "utf8")) as object;
const isCotalMessage = new Ajv({ strict: false }).compile(schema);
const message = { id: "m1", ts: T, space: "dev", channel: "general", from: { id: `${OWNER}.coder`, name: "coder" }, parts: [{ kind: "text", text: "hi" }] };
check("positive control: a channel message validates as a CotalMessage", isCotalMessage(message) === true, isCotalMessage.errors);
const asMessages = shapes.filter(([, record]) => isCotalMessage(record)).map(([name]) => name);
check(`no stored record shape validates as a CotalMessage (${shapes.length - asMessages.length} of ${shapes.length} refused by the schema)`,
  asMessages.length === 0, asMessages);
const hybrid = { ...base(), ...message, id: ID };
check("a record carrying a message envelope validates as a CotalMessage...", isCotalMessage(hybrid) === true, isCotalMessage.errors);
check("...and the record parser refuses it", parsePermissionRecord(hybrid, KEY) === undefined);

// ── Browser-safe: what a browser loads through `./permissions` ────────────────────────────────

// Runtime imports only: under verbatimModuleSyntax an `import type` is erased and loads nothing.
const graph: string[] = [];
const packages: string[] = [];
const walk = (file: string): void => {
  if (graph.includes(file)) return;
  graph.push(file);
  const source = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
  for (const [, spec] of source.matchAll(/^\s*(?:import|export)\s+(?!type\b)[^;]*?\bfrom\s+["']([^"']+)["']/gm)) {
    if (spec!.startsWith("./")) walk(spec!.slice(2).replace(/\.js$/, ".ts"));
    else packages.push(spec!);
  }
};
walk("permissions.ts");
const nodeOnly = packages.filter((spec) => spec.startsWith("node:") || spec === "@nats-io/transport-node");
check(`the runtime module graph behind ./permissions loads nothing from Node (${graph.length} modules; packages: ${packages.join(", ") || "none"})`,
  graph.length > 1 && nodeOnly.length === 0, { graph, packages });

// ── holderLiveness: the one `gone` rule ───────────────────────────────────────────────────────

const H = { lifecycleUid: HOLDER.lifecycleUid, runtimeId: HOLDER.runtimeId };
const LIVENESS: [string, Parameters<typeof holderLiveness>[1], ReturnType<typeof holderLiveness>][] = [
  ["the roster is unreadable", "unavailable", "unknown"],
  ["no presence row", undefined, "gone"],
  ["an offline row", { online: false, ...H }, "gone"],
  ["another lifecycle", { online: true, lifecycleUid: "m".repeat(26), runtimeId: H.runtimeId }, "gone"],
  ["a row without a lifecycle", { online: true, runtimeId: H.runtimeId }, "gone"],
  ["a row without a runtime", { online: true, lifecycleUid: H.lifecycleUid }, "unknown"],
  ["another runtime of the same lifecycle", { online: true, lifecycleUid: H.lifecycleUid, runtimeId: "another-process" }, "gone"],
  ["the holder's own live process", { online: true, ...H }, "live"],
];
const livenessMisses = LIVENESS.filter(([, seen, want]) => holderLiveness(H, seen) !== want).map(([name, seen]) => ({ name, got: holderLiveness(H, seen) }));
check(`every liveness rule answers as designed (${LIVENESS.length - livenessMisses.length} of ${LIVENESS.length})`,
  LIVENESS.length === 8 && livenessMisses.length === 0, livenessMisses);

finish();
