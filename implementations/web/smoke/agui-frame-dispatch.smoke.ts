/**
 * The dashboard can DISPLAY an AG-UI frame: registered, dispatched, and failing safely.
 *
 * `parts.ts` names a kind it cannot draw; that is a refusal, not a rendering, and it was never the
 * end state. `aguiFrame.ts` teaches this surface to draw `ag-ui.frame` by registering a renderer
 * with `registerPartRenderer`, which `partsToText` consults before its fallbacks. This suite
 * measures the SEAM: that the module registers under the right kind, is actually reached by the
 * dispatcher, and how the seam fails.
 *
 * THE SPLIT, because three suites now touch this path and each owns exactly one claim:
 *   · `parts-non-silence.smoke.ts` owns the NO-RENDERER fallbacks (a kind nothing taught this surface).
 *   · `bin/smoke/agui-render-parity.smoke.ts` owns that the text produced here is BYTE-IDENTICAL to
 *     the renderer every other surface uses. No parity cell lives in this file.
 *   · this file owns that a frame reaches the renderer at all on this surface.
 * A single suite asserting all three would let one green light stand for three different facts.
 *
 * WHAT IT DRIVES. Both modules are imported as the client bundle imports them. The registry is
 * module state, so the order of the cells matters: the bare control runs BEFORE `aguiFrame.js` is
 * imported, and the cells that replace the frame renderer put the real one back afterwards.
 *
 * WHAT IT DOES NOT CLAIM. It does not open a browser and asserts no DOM. It shows that the text is
 * produced and the producer is wired in, not that it survives to the pixels. The script-order and
 * build-copy cells are gone: the bundle orders its imports and ships its modules.
 *
 * Run: pnpm smoke:agui-frame-dispatch
 */
import assert from "node:assert/strict";
import { partsToText, registerPartRenderer, type PartRenderer } from "../client/src/lib/parts.js";

let cells = 0;
const ok = (name: string, cond: boolean, detail?: unknown) => {
  cells++;
  assert.ok(cond, `${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  console.log(`  ok  ${name}`);
};

const KIND = "ag-ui.frame";
const MARKER = `[unrenderable part kind ${JSON.stringify(KIND)} — no renderer for it on this surface]`;
const render = (parts: unknown[]) => partsToText(parts);

const FRAME = {
  kind: KIND, protocol: "ag-ui/1", threadId: "t1", runId: "r1", epoch: 3, seq: 7,
  events: [
    { type: "RUN_STARTED", runId: "r1" },
    { type: "TEXT_MESSAGE_START", messageId: "m1" },
    { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "hello" },
    { type: "TEXT_MESSAGE_END", messageId: "m1" },
    { type: "RUN_FINISHED", runId: "r1", outcome: { type: "success" } },
  ],
};

// ── NEGATIVE CONTROL FIRST: the surface WITHOUT the renderer ─────────────────────────────────────
// This is the state main shipped in, and it is the control that gives every cell below its meaning.
// Without it, "a frame renders its text" could be true because parts.ts was always able to draw one,
// which would make the new module decorative. The refusal must be real before the fix can be. It
// runs before `aguiFrame.js` is imported because the registry is module state.
ok("CONTROL: with aguiFrame.js NOT loaded, a frame is refused by name (the state before this change)",
  render([FRAME]) === MARKER, { got: render([FRAME]) });

// ── The seam, loaded as the bundle loads it ──────────────────────────────────────────────────────
const { renderAguiFrame } = await import("../client/src/lib/aguiFrame.js");
ok("aguiFrame.js registers a function under EXACTLY the frame kind",
  render([FRAME]) !== MARKER, { drawn: render([FRAME]) !== MARKER });

const drawn = render([FRAME]);
ok("a frame is now DRAWN, not refused (the marker is gone)", drawn !== MARKER, { isMarker: drawn === MARKER });
ok("and the drawing carries the frame's actual content",
  drawn.includes("hello") && drawn.includes("r1"), { len: drawn.length });
ok("the run is bracketed — started and finished both visible",
  drawn.includes("started") && drawn.includes("finished"), { len: drawn.length });

// A frame carries NO text part by design, so this is the whole point of the file: content that was
// unreachable through `parts.ts` alone is now reachable.
ok("REGRESSION ORACLE: the frame carries no `text` part, so nothing else could have shown this",
  !("text" in FRAME) && (FRAME as { data?: unknown }).data === undefined);

// ── REGISTRATION TIMING MUST NOT MATTER, and that is a property of the code, not a hope ─────────
// `partsToText` reads the registry at CALL time, so a renderer registered after a part was first
// refused still takes effect. The bundle's import order cannot be reordered into a bug, but a lookup
// cached at module load could, and this cell is what would see it.
const LATE = "com.acme.late";
ok("CONTROL: a kind nothing has registered yet is refused by name",
  render([{ kind: LATE }]) === `[unrenderable part kind ${JSON.stringify(LATE)} — no renderer for it on this surface]`);
registerPartRenderer(LATE, () => "late renderer");
ok("registration AFTER the first render still takes effect (lookup is at call time)",
  render([{ kind: LATE }]) === "late renderer");

// ── THE INHERITED-PROPERTY DOOR, which a plain-object lookup opens and a Map does not ───────────
// `p.kind` comes off the wire. A plain object inherits `toString`, `valueOf` and `constructor` from
// `Object.prototype`, and every one of them is a function, so an unguarded `renderers[p.kind]`
// RESOLVES for a part whose kind is `"toString"`, passes the `typeof === "function"` test, and gets
// called unbound. The body then renders `[object Undefined]` or similar: no kind named, no failure
// reported, which is the vanishing act in a new costume. The registry is a `Map` and keyed lookups
// go through `has`, so the door stays shut; these cells hold it shut.
for (const inherited of ["toString", "valueOf", "constructor", "hasOwnProperty", "__proto__"]) {
  const got = render([{ kind: inherited }]);
  ok(`an inherited property name (\`${inherited}\`) is NOT mistaken for a registered renderer`,
    got === `[unrenderable part kind ${JSON.stringify(inherited)} — no renderer for it on this surface]`,
    { got });
}
// The control: the guard must not have broken ordinary resolution on the way past.
ok("CONTROL: an OWN registration still resolves after the inherited-property guard",
  render([FRAME]) === drawn);

// ── OTHER KINDS ARE UNAFFECTED, so the seam did not become a new vanishing act ───────────────────
ok("a plain text part is untouched by the lookup", render([{ kind: "text", text: "hi" }]) === "hi");
ok("a data-bearing extension kind still keeps its data and its name",
  render([{ kind: "com.acme.snapshot", data: { x: 1 } }]) === '[com.acme.snapshot] {"x":1}',
  { got: render([{ kind: "com.acme.snapshot", data: { x: 1 } }]) });
ok("an unknown kind with no data is still refused by name",
  render([{ kind: "com.acme.void" }])
    === '[unrenderable part kind "com.acme.void" — no renderer for it on this surface]');
ok("a frame between text parts is drawn in place, neighbours intact",
  render([{ kind: "text", text: "A" }, FRAME, { kind: "text", text: "B" }])
    === `A ${drawn} B`);

// ── HOW THE SEAM FAILS, which is the half nobody writes ──────────────────────────────────────────
// These cells REPLACE the frame renderer to make it fail, so they run last and the real one is put
// back at the end.
// A renderer that throws must not blank the body: that is the exact failure `parts.ts` exists to
// remove, and re-introducing it through the extension seam would be the same bug with a new door.
registerPartRenderer(KIND, () => { throw new Error("renderer exploded"); });
const boomed = render([FRAME]);
ok("a THROWING renderer degrades to a named marker, not a blank body",
  boomed.includes(KIND) && boomed.includes("failed"), { got: boomed });
ok("and it does not fall through to the raw-data fallback (a different fact, wrongly reported)",
  !boomed.includes("RUN_STARTED"), { got: boomed });
ok("a throwing renderer does not take the whole message down (neighbouring text survives)",
  render([{ kind: "text", text: "before" }, FRAME]).startsWith("before "));

registerPartRenderer(KIND, () => ({ not: "a string" }) as unknown as string);
const wronged = render([FRAME]);
ok("a renderer returning a NON-STRING is named, not coerced into [object Object]",
  wronged.includes(KIND) && wronged.includes("expected a string") && !wronged.includes("[object Object]"),
  { got: wronged });

// A registered non-function must not be called, and must not be mistaken for a renderer.
registerPartRenderer(KIND, "nope" as unknown as PartRenderer);
ok("a non-function registration falls through to the fallbacks instead of throwing",
  render([FRAME]) === MARKER, { got: render([FRAME]) });

registerPartRenderer(KIND, renderAguiFrame);
ok("CONTROL: putting the real renderer back restores the drawing", render([FRAME]) === drawn);

console.log(`\n${cells} cells green`);
