/**
 * THE INSTRUMENT THAT RELEASES (OR HOLDS SHUT) THE AG-UI RENDERER PRECONDITION.
 *
 * fm-orchestrator's ruling, unamended: **the Claude cutover does not merge until the step-4
 * renderers can DISPLAY a frame.** `agui-events.md:2146-2153` states it; step 4 (`:2288`) names the
 * surfaces — `cotal console`, `implementations/web`, `examples/02` — and the two properties: the
 * frame part and the `events.*` filter. This file is what answers that question by execution.
 * The gate opens on **a frame observed rendered**, never on a reading of a diff.
 *
 * WHY A SUITE AND NOT A SCRATCH PROBE. The first version of this was a gitignored scratch file on
 * one worktree, which means: nobody can re-derive the verdict, the gate has no instrument if that
 * seat dies, and the lane that owns the renderers cannot self-check without a round trip. The gate
 * has already been breached once — `f88d518c` deleted the transcript mirror while this was unmet —
 * and a suite is what would have caught that AT THE TIME rather than two sessions later.
 *
 * IT IS RED BY DESIGN UNTIL THE RENDERERS LAND, which is why it is UNGATED in
 * `bin/smoke/gate-inventory.smoke.ts` rather than in the `smoke:ci` chain. Asserting the CURRENT
 * (broken) state instead would invert its polarity: it would go green today and red on the day the
 * work is finished, which is a suite that fights its own fix. **Gate it when the precondition is
 * met.**
 *
 * WHAT IT GRADES, AND THE HOP IT STOPS AT. Each surface's rendering chain is driven with a real
 * `aguiFrame()` carrying a canary string, and the cells ask whether the canary survives to the
 * string that surface hands its body renderer. It does NOT open a browser and does not assert
 * rendered HTML — but neither `MD.render` nor `esc()` can invent a canary that is not in their
 * input, so a canary absent HERE is absent on the page. That is the hop the webconsole lane's own
 * suite explicitly disclaims ("not that it survives to the pixels"), and it is the one this closes.
 *
 * THE SOURCE IS LIFTED, NEVER RETYPED. `implementations/web/src/web/*.js` is plain browser JS that
 * no compiler in this repo reads (`implementations/web/tsconfig.json` excludes `src/web`), and its
 * render functions are module-scope consts with no export. So their EXACT source text is cut out of
 * the shipped file and evaluated, and every lifted line is echoed in the output. **A retyped fixture
 * grades the author's transcription and returns a plausible number about someone else's code.**
 *
 * IT GRADES ANY TREE. `COTAL_RENDERER_TREE=/path/to/worktree` points it at another checkout, which
 * is how a renderer fix on an unpushed branch is verified without merging it first. Default is this
 * suite's own tree. The frame itself always comes from THIS package's `aguiFrame()` — the frame is
 * the stimulus, not the subject.
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import {
  aguiFrame,
  textMessageStart,
  textMessageContent,
  textMessageEnd,
} from "../src/agui.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const TREE = resolve(process.env.COTAL_RENDERER_TREE ?? join(HERE, "..", "..", ".."));

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => {
  if (v) ok++; else { fail++; console.log("  x FAIL:", n, extra ?? ""); }
};

/** The canary. Chosen so it cannot occur incidentally in a marker, a path or a kind name. */
const CANARY = "CANARY-VISIBLE-FRAME-TEXT";

const frame = aguiFrame({
  threadId: "t-precondition",
  runId: "r-precondition",
  epoch: "e1",
  seq: 1,
  events: [
    textMessageStart({ messageId: "m1", role: "assistant" }),
    textMessageContent({ messageId: "m1", delta: CANARY }),
    textMessageEnd({ messageId: "m1" }),
  ],
});
const parts = [frame as unknown as { kind: string }];

console.log(`grading tree: ${TREE}`);

/**
 * Cut a module-scope arrow const out of a shipped browser file and evaluate it.
 *
 * Both shapes in the wild are covered: the inline `(msg.parts || []).map(...)` form and the
 * delegating `window.COTAL_PARTS.partsToText(msg.parts)` form. The match is deliberately anchored on
 * the declaration and terminated at the first `;\n`, so a rewrite that changes the body is picked up
 * and a rewrite that changes the NAME fails loudly here rather than silently grading nothing.
 */
function lift(file: string, name: string): ((m: unknown) => string) | null {
  if (!existsSync(file)) return null;
  const src = readFileSync(file, "utf8");
  const m = src.match(new RegExp(`const ${name} = \\((?:m|msg)\\)\\s*=>[\\s\\S]*?;\\n`));
  if (!m) return null;
  const body = m[0].replace(/^\s*const [A-Za-z]+ = /, "").replace(/;\n$/, "");
  console.log(`  lifted ${name}: ${body.trim().replace(/\s+/g, " ")}`);
  // eslint-disable-next-line no-eval
  return eval(`(${body})`) as (m: unknown) => string;
}

const WEB = join(TREE, "implementations", "web", "src", "web");

// The browser copy of the renderer, when the tree carries one. It is loaded the way the pages load
// it — evaluated for its `window.COTAL_PARTS` side effect — rather than re-implemented here.
const sharedBrowserRenderer = join(WEB, "parts.js");
if (existsSync(sharedBrowserRenderer)) {
  (globalThis as { window?: unknown }).window = globalThis;
  // eslint-disable-next-line no-eval
  eval(readFileSync(sharedBrowserRenderer, "utf8"));
  console.log("  tree carries implementations/web/src/web/parts.js (shared browser renderer)");
} else {
  console.log("  tree carries NO shared browser renderer; pages hold their own copies");
}

/** One surface: does the frame's text reach the string this surface hands its body renderer? */
function gradeSurface(surface: string, rendered: string | null) {
  if (rendered === null) {
    c(`[GATE] ${surface} DISPLAYS the frame's text`, false, "rendering path not found in this tree");
    return;
  }
  console.log(`  ${surface} -> ${JSON.stringify(rendered)}  (len ${rendered.length})`);
  // THE GATE CELL. Not "did it produce something" — did it produce THE FRAME.
  c(`[GATE] ${surface} DISPLAYS the frame's text`, rendered.includes(CANARY));
  // The weaker, separately-ruled property: an undrawable part must not render as nothing. Graded as
  // its own cell because the two answers are different facts and a reader who sees one must not
  // conclude the other — a surface can be perfectly non-silent and still display no frame.
  c(`[non-silence] ${surface} does not render the frame as the empty string`, rendered.length > 0);
}

// ── The console family: cli `join`/`mesh-view` and examples/02 all render through core's shared
//    `partsToText`, so grading that function grades all three call sites at once.
const coreParts = join(TREE, "packages", "core", "src", "parts.js");
let corePartsToText: ((p: unknown[]) => string) | null = null;
try {
  ({ partsToText: corePartsToText } = (await import(coreParts)) as { partsToText: (p: unknown[]) => string });
} catch (e) {
  console.log(`  core partsToText unavailable: ${(e as Error).message}`);
}
gradeSurface("cli console / join / examples-02 (core partsToText)", corePartsToText ? corePartsToText(parts) : null);

// ── The two web pages, each through whatever chain it actually ships.
const bodyText = lift(join(WEB, "app.js"), "bodyText");
gradeSurface("implementations/web app.js", bodyText ? bodyText({ parts }) : null);

const partsText = lift(join(WEB, "graph.js"), "partsText");
const graphBody = partsText ? partsText({ parts }) : null;
gradeSurface("implementations/web graph.js", graphBody);

// The graph's detail row substitutes a visible dash for an empty body, so an empty rendering there
// is a placeholder rather than a blank. Graded separately because it changes what an OPERATOR sees
// without changing whether the frame was displayed — overstating the defect is the same class of
// error as understating it.
if (graphBody !== null) {
  const terminal = graphBody.slice(0, 160) || "—";
  console.log(`  implementations/web graph.js detail row -> ${JSON.stringify(terminal)}`);
  c("[GATE] implementations/web graph.js detail row DISPLAYS the frame's text", terminal.includes(CANARY));
}

// ── The precondition's second half. A surface that can draw a frame but never subscribes to the
//    channel carrying one has not met it either.
for (const [surface, rel] of [
  ["cli mesh-view", join("implementations", "cli", "src", "view", "mesh-view.ts")],
  ["implementations/web app.js", join("implementations", "web", "src", "web", "app.js")],
  ["examples/02 observer", join("examples", "02-self-improving-console", "harness", "observer.ts")],
] as const) {
  const p = join(TREE, rel);
  const src = existsSync(p) ? readFileSync(p, "utf8") : "";
  // Comments do not wire anything up, and this surface's history is comments DESCRIBING the missing
  // work — so they are stripped before the question is asked.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  c(`[GATE] ${surface} honours the events.* filter`, /events\.\*|eventChannel|AGUI_FRAME_KIND|ag-ui\.frame/.test(code));
}

console.log(`\nagui-renderer-precondition: ${ok} passed, ${fail} failed`);
if (fail > 0) {
  console.log(
    "\nTHE PRECONDITION IS NOT MET, so the AG-UI cutover does not merge. This suite is expected to\n" +
      "be red until the renderer work lands; that is what it is for. Gate it in gate-inventory when\n" +
      "it goes green.",
  );
  process.exit(1);
}
