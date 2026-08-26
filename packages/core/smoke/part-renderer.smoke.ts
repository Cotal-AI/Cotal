/**
 * `PartRenderer` — the seam that lets a surface draw a part kind core does not know.
 *
 * The contract these cells hold is that NO PART RENDERS AS NOTHING, and that the three ways a part
 * can fail to draw stay TELLABLE APART: no renderer, a renderer that threw, and a data part with
 * nothing in it. Collapsing any two would let a reader conclude the wrong one, which is the failure
 * a single "[unrenderable]" marker would hide.
 *
 * Run: pnpm smoke:part-renderer
 */
import { registry } from "../src/registry.js";
import { partsToText, type PartRenderer } from "../src/parts.js";
import type { Part } from "../src/types.js";

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => {
  if (v) ok++; else { fail++; console.log("  x FAIL:", n, extra ?? ""); }
};

const part = (kind: string, extra: Record<string, unknown> = {}) => ({ kind, ...extra }) as unknown as Part;
const renderer = (name: string, render: (p: Part) => string): PartRenderer =>
  ({ kind: "part-renderer", name, render });

/** Registration is scoped: `register` throws on a duplicate, so a leaked one would fail a LATER
 *  cell and read as a defect in whatever ran next. */
const withRenderer = <T>(r: PartRenderer, body: () => T): T => {
  registry.register(r);
  try { return body(); } finally { registry.unregister("part-renderer", r.name); }
};

// ── The kinds core knows itself ───────────────────────────────────────────────────────────────
c("a text part renders its text", partsToText([{ kind: "text", text: "hello" }]).includes("hello"));
c("a data part renders its data", partsToText([{ kind: "data", data: { a: 1 } }]).includes('{"a":1}'));

const EMPTY = partsToText([{ kind: "data", data: undefined }]);
c("a data part with nothing in it says so", EMPTY.includes("[empty data part]"), EMPTY);

// ── No renderer ───────────────────────────────────────────────────────────────────────────────
const NONE = partsToText([part("chart")]);
c("an unknown kind renders a marker naming the kind", NONE.includes("unrenderable part kind") && NONE.includes("chart"), NONE);
c("the no-renderer marker is not empty", NONE.trim().length > 0, NONE);
c("no renderer and empty data are different markers", NONE !== EMPTY, `${NONE} / ${EMPTY}`);

// ── A renderer that works ─────────────────────────────────────────────────────────────────────
withRenderer(renderer("chart", (p) => `CHART:${(p as { title?: string }).title ?? ""}`), () => {
  const out = partsToText([part("chart", { title: "load" })]);
  c("a registered renderer draws the part", out.includes("CHART:load"), out);
  c("a drawn part no longer reports as unrenderable", !out.includes("unrenderable"), out);
  // Resolved by the part's own `kind`, so core never learns what any kind means.
  const other = partsToText([part("table")]);
  c("a renderer draws only the kind it is registered for", other.includes("unrenderable part kind") && other.includes("table"), other);
});
c("unregistering restores the no-renderer marker", partsToText([part("chart")]).includes("unrenderable part kind"));

// ── A renderer that throws ────────────────────────────────────────────────────────────────────
withRenderer(renderer("chart", () => { throw new Error("boom"); }), () => {
  let out = "", threw: unknown;
  try { out = partsToText([{ kind: "text", text: "before" }, part("chart"), { kind: "text", text: "after" }]); }
  catch (e) { threw = e; }

  c("a throwing renderer does not take the surface down", threw === undefined, threw);
  c("the failure marker names the kind and carries the reason", out.includes("chart") && out.includes("boom"), out);
  c("a throwing renderer is not reported as a missing one", !out.includes("unrenderable part kind"), out);
  // The message is not blanked: the parts that CAN draw still do.
  c("sibling parts survive a renderer that threw", out.includes("before") && out.includes("after"), out);
});

console.log(`part-renderer smoke: ${ok} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
