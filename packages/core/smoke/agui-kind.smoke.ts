/**
 * The frame's wire identity, graded from CORE'S OWN SOURCE.
 *
 * WHY THIS SUITE EXISTS AND IS NOT A DUPLICATE OF THE CONFORMANCE SUITE. `agui-kind.ts` lives here,
 * but its only executing cells lived in `extensions/connector-core`, and that suite reaches these
 * symbols by importing `@cotal-ai/core`, which resolves to `packages/core/dist`. Measured, not
 * argued: renaming an event literal in `packages/core/src/agui-kind.ts` and running the conformance
 * suite WITHOUT rebuilding leaves it fully green, and the same edit with a rebuild reddens three
 * cells. So a source-only change to this file had no gate at all, and CI hid it by building first.
 *
 * **A suite that audits the last build is not auditing the change in front of you.** This one
 * imports `../src/agui-kind.js`, so a mutation here is a mutation to the code these cells run.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: compare the literals to `@ag-ui/core`'s real enum. That package
 * carries a zod runtime dependency and is not resolvable from `packages/core` at all, by design, so
 * that no zod copy reaches a bundled connector. That comparison stays in the conformance suite where
 * the package IS available. The two suites cover different halves and neither substitutes for the
 * other: this one pins the values and the shape from source, that one pins them against the protocol.
 *
 * Run: pnpm smoke:agui-kind
 */
import { AGUI_EVENT_TYPE, AGUI_FRAME_KIND, isAguiFramePart } from "../src/agui-kind.js";

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => {
  if (v) ok++; else { fail++; console.log("  x FAIL:", n, extra ?? ""); }
};

// ── The wire kind, spelled out ────────────────────────────────────────────────────────────────
// A literal on one side. Comparing the constant with itself is what let a rename ship green.
c("the frame kind is the literal `ag-ui.frame`", AGUI_FRAME_KIND === "ag-ui.frame", AGUI_FRAME_KIND);

// ── The event table, spelled out ──────────────────────────────────────────────────────────────
// Every discriminator written here rather than derived from the object under test. Deriving the
// expected value from the actual one is the same vacuous shape one level down: `Object.keys(X)`
// compared against `X` agrees with any table at all.
const EXPECTED: Record<string, string> = {
  RUN_STARTED: "RUN_STARTED",
  RUN_FINISHED: "RUN_FINISHED",
  RUN_ERROR: "RUN_ERROR",
  TEXT_MESSAGE_START: "TEXT_MESSAGE_START",
  TEXT_MESSAGE_CONTENT: "TEXT_MESSAGE_CONTENT",
  TEXT_MESSAGE_END: "TEXT_MESSAGE_END",
  TOOL_CALL_START: "TOOL_CALL_START",
  TOOL_CALL_ARGS: "TOOL_CALL_ARGS",
  TOOL_CALL_END: "TOOL_CALL_END",
  TOOL_CALL_RESULT: "TOOL_CALL_RESULT",
  REASONING_MESSAGE_START: "REASONING_MESSAGE_START",
  REASONING_MESSAGE_CONTENT: "REASONING_MESSAGE_CONTENT",
  REASONING_MESSAGE_END: "REASONING_MESSAGE_END",
  CUSTOM: "CUSTOM",
};

const actual = AGUI_EVENT_TYPE as unknown as Record<string, string>;
let drift = "";
for (const [k, v] of Object.entries(EXPECTED)) if (actual[k] !== v) drift += `${k}: got ${String(actual[k])}; `;
c("every discriminator matches its spelled-out literal", drift === "", drift);

// Both directions. Checking only that each expected key is present would pass against a table that
// had grown a member nobody mapped, and an unmapped member is a frame a consumer must refuse.
const extra = Object.keys(actual).filter((k) => !(k in EXPECTED));
c("and the table carries no member this suite does not name", extra.length === 0, extra);
c("the table has exactly 14 members", Object.keys(actual).length === 14, Object.keys(actual).length);

// ── Frozen, so a consumer cannot mutate the vocabulary in place ───────────────────────────────
c("the table is frozen", Object.isFrozen(AGUI_EVENT_TYPE));
{
  // Assignment on a frozen object is a silent no-op outside strict mode; ESM is always strict, so
  // this throws. Asserting the THROW rather than re-reading the value proves the freeze rather than
  // proving that the value happens to be unchanged.
  let threw = false;
  try { (actual as Record<string, string>).RUN_STARTED = "HIJACKED"; } catch { threw = true; }
  c("writing through it is refused, not silently dropped", threw && actual.RUN_STARTED === "RUN_STARTED");
}

// ── The routing predicate NEVER throws, on anything ────────────────────────────────────────────
// Executed on the degenerate inputs rather than reasoned about. This is the function a renderer
// calls on every part of every message, so a throw here takes a surface down on someone else's mail.
const HOSTILE: [string, unknown][] = [
  ["null", null],
  ["undefined", undefined],
  ["a number", 7],
  ["a string", "ag-ui.frame"],
  ["a bare symbol", Symbol("x")],
  ["an array", []],
  ["a function", () => {}],
  ["an object with no prototype", Object.create(null)],
  ["an object whose `kind` getter throws", { get kind() { throw new Error("boom"); } }],
  ["a Proxy that throws on every get", new Proxy({}, { get() { throw new Error("boom"); } })],
];
for (const [label, value] of HOSTILE) {
  let threw = false;
  let result: unknown;
  try { result = isAguiFramePart(value); } catch { threw = true; }
  // A throwing getter is the one case where "never throws" cannot be met by reading `.kind`, so it
  // is named rather than folded in: if this cell ever fails, the predicate needs a guarded read, not
  // a caller who remembers to try/catch.
  c(`isAguiFramePart does not throw on ${label}`, !threw, threw ? "threw" : result);
  if (!threw) c(`  and returns a boolean for ${label}`, typeof result === "boolean", result);
}

// ── And it still discriminates, so the cells above cannot pass against a constant `false` ─────
c("CONTROL: a real frame part IS routed", isAguiFramePart({ kind: "ag-ui.frame", events: [] }) === true);
c("CONTROL: a text part is NOT", isAguiFramePart({ kind: "text", text: "hi" }) === false);
c("CONTROL: a part whose kind merely CONTAINS the token is NOT",
  isAguiFramePart({ kind: "ag-ui.frame.v2" }) === false);

console.log(`agui-kind smoke: ${ok} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
