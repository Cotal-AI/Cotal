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

let ok = 0, fail = 0, gateFail = 0;
const c = (n: string, v: boolean, extra?: unknown) => {
  if (v) ok++;
  else {
    fail++;
    // The precondition cells are counted apart from the rest. A reader must be able to tell "the
    // merge gate is shut" from "some other property of the renderers is unmet" without parsing
    // names, or the two get reported as one number and the gate's status becomes a matter of
    // interpretation.
    if (n.startsWith("[GATE]")) gateFail++;
    console.log("  x FAIL:", n, extra ?? "");
  }
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

// ── The two web pages, each through whatever chain it actually ships.
const bodyText = lift(join(WEB, "app.js"), "bodyText");
const partsText = lift(join(WEB, "graph.js"), "partsText");

/** Every shipped rendering path, so each is graded on every part kind rather than on one. */
const SURFACES: readonly { name: string; render: ((p: unknown[]) => string) | null }[] = [
  { name: "cli console / join / examples-02 (core partsToText)", render: corePartsToText },
  { name: "implementations/web app.js", render: bodyText ? (p) => bodyText({ parts: p }) : null },
  { name: "implementations/web graph.js", render: partsText ? (p) => partsText({ parts: p }) : null },
];

for (const s of SURFACES) gradeSurface(s.name, s.render ? s.render(parts) : null);
const graphBody = SURFACES[2].render ? SURFACES[2].render(parts) : null;

/**
 * THE KIND EVERY OTHER CELL IS BLIND TO.
 *
 * Every assertion above uses `ag-ui.frame`, which carries NO `data` field — and on that one input
 * two materially different renderers produce byte-identical output. Core names the kind and
 * DISCARDS the payload of a data-bearing extension part; the browser copy names the kind and KEEPS
 * it. Across 9 + 8 graded assertions on two trees, nothing could tell them apart: the difference was
 * found by READING, not by grading.
 *
 * **A suite can be exhaustive across surfaces and blind across kinds.** Every cell ran, every cell
 * passed or failed for the right reason, and the whole surface exercised the single input that
 * collapses the distinction. So the discriminating kind gets its own cells, and they are kept
 * separate from the `[GATE]` cells because they grade a different property: the frame gate asks
 * whether a frame is DISPLAYED, these ask whether an extension part's payload SURVIVES.
 */
const DATA_CANARY = "CANARY-DATA-BEARING-PAYLOAD";
const DATA_KIND = "com.acme.snapshot";
const dataParts = [{ kind: DATA_KIND, data: { note: DATA_CANARY } } as unknown as { kind: string }];

for (const s of SURFACES) {
  if (!s.render) {
    c(`[data-kind] ${s.name} preserves a data-bearing extension part's payload`, false, "path not found");
    c(`[data-kind] ${s.name} names the kind of a data-bearing extension part`, false, "path not found");
    continue;
  }
  const out = s.render(dataParts);
  console.log(`  [data-kind] ${s.name} -> ${JSON.stringify(out)}`);
  // Losing the payload while printing a marker is the worse failure of the two: the output LOOKS
  // like successful rendering, which is the exact defect class this lane's gate is shut over.
  c(`[data-kind] ${s.name} preserves a data-bearing extension part's payload`, out.includes(DATA_CANARY));
  c(`[data-kind] ${s.name} names the kind of a data-bearing extension part`, out.includes(DATA_KIND));
}

// The graph's detail row substitutes a visible dash for an empty body, so an empty rendering there
// is a placeholder rather than a blank. Graded separately because it changes what an OPERATOR sees
// without changing whether the frame was displayed — overstating the defect is the same class of
// error as understating it.
if (graphBody !== null) {
  const terminal = graphBody.slice(0, 160) || "—";
  console.log(`  implementations/web graph.js detail row -> ${JSON.stringify(terminal)}`);
  c("[GATE] implementations/web graph.js detail row DISPLAYS the frame's text", terminal.includes(CANARY));
}

/**
 * THE PART THAT VANISHES BESIDE A PART THAT DOES NOT — found by fm-webconsole driving core directly
 * rather than taking this suite's row for it, and it is a gap in THIS FILE's design.
 *
 * Every cell above renders a **single-part** message, so the only failure they can see is a whole
 * rendering going empty. Real messages are mixed. Render `[frame, text]` through the vanishing form
 * and you get `" AFTER"` — **a leading space where an entire part used to be**: no marker, no kind,
 * no length anomaly, and a body that reads as a complete message with an odd bit of whitespace.
 *
 * **That is strictly worse than the empty string and it is the case a single-part cell cannot
 * produce.** An empty body is at least conspicuous; a message that lost one part among several looks
 * finished. So the assertion is not "did anything render" — it is whether the frame contributed
 * ANYTHING beside a sibling that rendered fine.
 */
const TEXT_AFTER = "AFTER-A-DROPPED-PART";
const mixed = [frame as unknown as { kind: string }, { kind: "text", text: TEXT_AFTER } as unknown as { kind: string }];
for (const s of SURFACES) {
  if (!s.render) {
    c(`[adjacency] ${s.name} does not drop the frame beside a rendering sibling`, false, "path not found");
    continue;
  }
  const out = s.render(mixed);
  console.log(`  [adjacency] ${s.name} -> ${JSON.stringify(out)}`);
  // The sibling must still be there (or the cell is measuring the wrong failure), AND the frame must
  // have left more than a separator behind.
  const siblingSurvived = out.includes(TEXT_AFTER);
  const frameLeftSomething = out.replace(TEXT_AFTER, "").trim().length > 0;
  c(`[adjacency] ${s.name} does not drop the frame beside a rendering sibling`,
    siblingSurvived && frameLeftSomething, JSON.stringify(out));
}

/**
 * THE KINDS NOBODY ENUMERATED — and the census cell that stops this file going blind again.
 *
 * Twice now this suite has been blind in a way no count of cells reduced: every cell rendered one
 * `ag-ui.frame`, then every cell rendered a SINGLE part. Both times the fixture shape was uniform
 * across the whole file, and **a uniform fixture shape is a blind spot that adding cells cannot
 * fix.** The third instance was already here waiting: core's `Part` union has FOUR arms and this
 * file exercised two of them.
 *
 * **So the kind list is DERIVED FROM THE SHIPPED TYPE, never written down here.** Hardcoding it
 * would rebuild the exact defect: a kind added to `packages/core/src/types.ts` tomorrow would be
 * ungraded, and nothing would say so. The census cell below fails when the union gains an arm this
 * file has no fixture for — so the blindness becomes a red cell instead of a silence.
 *
 * It also **refuses an arm it cannot resolve** rather than skipping it. A parser that quietly drops
 * what it does not understand is how an unenumerated kind stays unenumerated.
 */
const typesSrc = readFileSync(join(TREE, "packages", "core", "src", "types.js").replace(/\.js$/, ".ts"), "utf8");
const unionBlock = typesSrc.match(/export type Part =([\s\S]*?);\n/)?.[1] ?? "";
const derivedKinds: string[] = [];
let unresolvedArm: string | null = null;
for (const arm of unionBlock.split("|").map((a) => a.trim()).filter(Boolean)) {
  const inline = arm.match(/kind:\s*"([^"]+)"/);
  if (inline) { derivedKinds.push(inline[1]); continue; }
  // A named shape — resolve it to its own `kind` literal rather than passing over it.
  const named = arm.match(/^([A-Za-z_][A-Za-z0-9_]*)/);
  const shape = named && typesSrc.match(new RegExp(`interface ${named[1]}\\s*\\{[\\s\\S]*?kind:\\s*"([^"]+)"`));
  if (shape) { derivedKinds.push(shape[1]); continue; }
  // The open extension arm is `kind: ExtensionPartKind`, deliberately not a literal — it is already
  // graded above by BOTH of its sub-cases (data-bearing and data-less), so it is named, not skipped.
  if (/ExtensionPartKind/.test(arm)) continue;
  unresolvedArm = arm;
}
console.log(`  derived closed kinds from core's Part union: ${JSON.stringify(derivedKinds)}`);
c("[census] every arm of core's Part union resolved to a kind or a named open arm", unresolvedArm === null, unresolvedArm);

/** One fixture per closed kind, each carrying something a renderer must not lose. */
const KIND_FIXTURES: Record<string, { part: unknown; must: string }> = {
  text: { part: { kind: "text", text: "CANARY-TEXT-KIND" }, must: "CANARY-TEXT-KIND" },
  data: { part: { kind: "data", data: { note: "CANARY-DATA-KIND" } }, must: "CANARY-DATA-KIND" },
  // An artifact's digest is the only self-verifying field it has and the only handle a reader can
  // act on, so that is what must survive — not merely "something non-empty".
  artifact: {
    part: { kind: "artifact", name: "report.html", mediaType: "text/html", size: 12, digest: "sha256:CANARYDIGEST" },
    must: "sha256:CANARYDIGEST",
  },
};

c("[census] this file has a fixture for every derived kind",
  derivedKinds.every((k) => k in KIND_FIXTURES),
  `derived ${JSON.stringify(derivedKinds)} vs fixtures ${JSON.stringify(Object.keys(KIND_FIXTURES))}`);

for (const kind of derivedKinds) {
  const fx = KIND_FIXTURES[kind];
  if (!fx) continue; // already failed the census cell above; do not also report a phantom per surface
  for (const s of SURFACES) {
    if (!s.render) { c(`[kind:${kind}] ${s.name} renders it`, false, "path not found"); continue; }
    const out = s.render([fx.part as { kind: string }]);
    const held = out.includes(fx.must);
    if (!held) console.log(`  [kind:${kind}] ${s.name} -> ${JSON.stringify(out)}`);
    c(`[kind:${kind}] ${s.name} renders it without losing its identifying content`, held, JSON.stringify(out));
  }
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

console.log(`\nagui-renderer-precondition: ${ok} passed, ${fail} failed (${gateFail} of them [GATE])`);
if (gateFail > 0) {
  console.log(
    "\nTHE PRECONDITION IS NOT MET, so the AG-UI cutover does not merge. This suite is expected to\n" +
      "be red until the renderer work lands; that is what it is for. Gate it in gate-inventory when\n" +
      "it goes green.",
  );
} else if (fail > 0) {
  console.log(
    "\nThe frame precondition is MET. The remaining failures are NOT the merge gate — they are the\n" +
      "payload-preservation cells, and they must be read as their own finding rather than folded in.",
  );
}
if (fail > 0) process.exit(1);
