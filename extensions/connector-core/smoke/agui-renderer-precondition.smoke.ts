/**
 * THE INSTRUMENT THAT RELEASES (OR HOLDS SHUT) THE AG-UI RENDERER PRECONDITION.
 *
 * THE RULE IT ENFORCES: **the Claude connector's cutover to AG-UI events does not merge until the
 * renderers can DISPLAY a frame.** Three surfaces are in scope — `cotal console`,
 * `implementations/web`, `examples/02` — and two properties: the frame part, and the `events.*`
 * filter. This file answers that question by execution. **The gate opens on a frame observed
 * rendered, never on a reading of a diff.**
 *
 * WHY A SUITE AND NOT A SCRATCH PROBE. The first version was a gitignored scratch file in a single
 * worktree, which means nobody could re-derive the verdict, the gate had no instrument once that
 * checkout was gone, and whoever owns the renderers could not self-check without a round trip. **The
 * rule has already been breached once — the transcript mirror was deleted while it was unmet — and a
 * suite is what would have caught that AT THE TIME** rather than two sessions later.
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
 * input, so a canary absent HERE is absent on the page. That is the hop the browser-side
 * suite explicitly disclaims ("not that it survives to the pixels"), and it is the one this closes.
 *
 * THE SOURCE IS LIFTED, NEVER RETYPED. `implementations/web/src/web/*.js` is plain browser JS that
 * no compiler in this repo reads (`implementations/web/tsconfig.json` excludes `src/web`), and its
 * render functions are module-scope consts with no export. So their EXACT source text is cut out of
 * the shipped file and evaluated, and every lifted line is echoed in the output. **A retyped fixture
 * grades the author's transcription and returns a plausible number about someone else's code.**
 *
 * IT GRADES THREE DIMENSIONS, AND EACH ONE WAS ADDED BECAUSE THE FILE WAS BLIND ALONG IT. Surfaces
 * (three rendering chains), part KINDS (derived from core's `Part` union), and event FAMILIES
 * (derived from `AGUI_EVENT_TYPE`). All three blindnesses had the same shape — a fixture uniform
 * across the whole file — and none of them could have been found by adding cells, because every
 * added cell inherited the uniform fixture. The two derived censuses are what stop a fourth.
 *
 * IT GRADES ANY TREE. `COTAL_RENDERER_TREE=/path/to/worktree` points it at another checkout, which
 * is how a renderer fix on an unpushed branch is verified without merging it first. Default is this
 * suite's own tree. The frame itself always comes from THIS package's `aguiFrame()` — the frame is
 * the stimulus, not the subject.
 */
import { readFileSync, existsSync } from "node:fs";
import ts from "typescript";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import {
  aguiFrame,
  textMessageStart,
  textMessageContent,
  textMessageEnd,
  runStarted,
  runFinished,
  runError,
  toolCallStart,
  toolCallArgs,
  toolCallEnd,
  toolCallResult,
  reasoningMessageStart,
  reasoningMessageContent,
  reasoningMessageEnd,
  AGUI_EVENT_TYPE,
  COTAL_CUSTOM_EVENTS,
  type AguiEvent,
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
    // `timestamp` is REQUIRED by all three of these constructors and this file omitted it on all
    // three. THREE INDEPENDENT GUARDS, NONE OF WHICH HAD JURISDICTION over this file:
    //   - `tsx` strips types without checking them;
    //   - this package's tsconfig is `"include": ["src"]`, so `smoke/` is outside its typecheck;
    //   - the suite is deliberately ungated, so no gate run exercises it.
    // Not one failure of care — an uncovered intersection nothing was ever responsible for, in the
    // file that IS the merge gate.
    //
    // AND NEITHER VOCABULARY VALIDATOR WOULD HAVE CAUGHT IT, which is a separate fact and is not
    // part of the set above: `aguiFrame` validates the ENVELOPE only (`:449-466`), and
    // `parseAguiFrame` validates each event's `type` against `AGUI_EVENT_TYPE` and nothing else
    // (`:542-553`). A frame of structurally invalid events passes producer and consumer alike.
    textMessageStart({ messageId: "m1", role: "assistant", timestamp: 1 }),
    textMessageContent({ messageId: "m1", delta: CANARY, timestamp: 2 }),
    textMessageEnd({ messageId: "m1", timestamp: 3 }),
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

/**
 * ── The console family, GRADED THROUGH THE PRODUCTION MODULE GRAPH ──────────────────────────────
 *
 * **THIS IMPORT USED TO BE `await import(`${TREE}/packages/core/src/parts.js`)` AND THAT WAS A
 * DEFECT IN THIS FILE, NOT A STYLE CHOICE.**
 *
 * `implementations/cli` does `import { partsToText } from "@cotal-ai/core"`, and core's `exports`
 * map sends `"."` to `./dist/index.js`. **So the CLI runs `dist/parts.js` while this suite graded
 * `src/parts.js` — two different files, and more importantly two different MODULE INSTANCES.**
 *
 * While the only thing under test was a pure function of its arguments, that was harmless: `dist` is
 * compiled from `src`, so a fresh build makes them agree, and grading the source graded the source
 * of truth. **It stopped being harmless the moment rendering depended on module IDENTITY rather
 * than on behaviour** — a renderer registered into the package's `registry` singleton is invisible
 * to a path-imported copy of core, which has a singleton of its own.
 *
 * ***That produced a FALSE FAILURE: the renderer worked, and this suite reported the gate shut.***
 * Not the usual direction. An instrument that fails toward permissiveness gets caught by the next
 * reader; one that fails toward refusal is believed, because a red gate looks like diligence. It was
 * caught only because it was predicted before the code was written.
 *
 * **Content agreement is not identity agreement, and they must not be merged.** That `src` and
 * `dist` compile byte-idempotently — measured on three trees — says the two files AGREE. It says
 * nothing about whether they are the SAME module, and identity is the axis this depends on.
 *
 * So the console family is now driven exactly as production drives it: `partsToText` from the
 * PACKAGE, and the provider imported for its registration side effect, the way a composition root
 * imports a connector.
 */
import { partsToText as corePartsToText } from "@cotal-ai/core";
// Registers the `ag-ui.frame` part renderer into the SAME core instance the line above resolved.
// Importing for a side effect is the point, not an accident of ordering.
import "../src/agui-render.js";

// ── The two web pages, each through whatever chain it actually ships.
const bodyText = lift(join(WEB, "app.js"), "bodyText");
const partsText = lift(join(WEB, "graph.js"), "partsText");

/** Every shipped rendering path, so each is graded on every part kind rather than on one. */
/**
 * THE SCOPE THIS FILE CANNOT SILENTLY SATISFY, so it is printed and asserted instead.
 *
 * `COTAL_RENDERER_TREE` points the WEB surfaces at another checkout — they are plain browser JS read
 * off disk, so any tree can be graded. **The console surface cannot follow it.** It is resolved
 * through package resolution (`@cotal-ai/core`), which is a property of THIS package's
 * `node_modules`, and no environment variable redirects that. Grading another tree's console surface
 * would need a suite run from inside that tree.
 *
 * **Left implicit, this is precisely the wrong-subject defect** — a reader would see one tree named
 * at the top of the output and assume all three surfaces came from it. So the mismatch is stated on
 * every run where it exists, and it is a CELL rather than a log line, because a log line is a claim
 * nobody re-derives.
 */
const OWN_TREE = resolve(join(HERE, "..", "..", ".."));
const GRADING_FOREIGN_TREE = TREE !== OWN_TREE;
if (GRADING_FOREIGN_TREE)
  console.log(
    `  NOTE: web surfaces graded from ${TREE}; the console surface is resolved through THIS package ` +
      `(${OWN_TREE}) and does NOT follow COTAL_RENDERER_TREE.`,
  );
const SURFACES: readonly { name: string; render: ((p: unknown[]) => string) | null }[] = [
  {
    name: GRADING_FOREIGN_TREE
      ? "cli console / join / examples-02 (core partsToText, THIS package — not the graded tree)"
      : "cli console / join / examples-02 (core partsToText)",
    render: (p) => corePartsToText(p as never),
  },
  { name: "implementations/web app.js", render: bodyText ? (p) => bodyText({ parts: p }) : null },
  { name: "implementations/web graph.js", render: partsText ? (p) => partsText({ parts: p }) : null },
];

// FALSIFIABLE, not decorative: when a foreign tree is being graded, the console surface's LABEL must
// say it did not come from that tree. An always-true cell would assert nothing; this one goes red if
// someone drops the disclaimer from the name while the mismatch still exists.
c("[scope] the console surface names its own tree when it differs from the graded tree",
  !GRADING_FOREIGN_TREE || SURFACES[0].name.includes("not the graded tree"), SURFACES[0].name);

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
  // like successful rendering, which is the exact defect class this gate is shut over.
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
 * THE PART THAT VANISHES BESIDE A PART THAT DOES NOT — found in review, by driving core directly
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
// GUARDED, AND THE REASON IS THE WHOLE POINT OF THIS FILE. Unguarded, a tree without this path
// killed the run with a stack trace BEFORE the three events-filter gates were evaluated: three
// [GATE] cells silently never ran, no summary line, and exit 1 — byte-for-byte indistinguishable
// from "the gate is shut". That is the failure the gateFail counter exists to prevent, arriving one
// layer earlier than the counter can see. A missing input is a FAILED CELL, never a dead run.
// (Found in review, when an independent run crashed here.)
const typesPath = join(TREE, "packages", "core", "src", "types.ts");
const typesSrc = existsSync(typesPath) ? readFileSync(typesPath, "utf8") : "";
c("[census] core's Part union is readable in this tree", typesSrc.length > 0, typesPath);
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

/**
 * THE ATTACK EVERY CELL ABOVE PASSES BLIND — raised in review against this file and left
 * open by it rather than by them.
 *
 * **Every `[GATE]` cell above carries its canary in a `TEXT_MESSAGE_CONTENT` delta.** So a renderer
 * that special-cases text deltas — concatenates them, draws the prose, and drops `TOOL_CALL_*`,
 * `RUN_*`, `REASONING_*` on the floor — displays that canary and **passes the entire merge gate**.
 * What it ships is a surface where an operator watching a session sees the model's prose and no
 * evidence that it ran anything.
 *
 * That is not a hypothetical regression. **It is the `tr-` mirror reborn under a new vocabulary** —
 * the exact defect the directive abolished, since `tr-`'s failure was precisely that it condensed a
 * session to the text a human could read and dropped the structure. A gate that a text-only renderer
 * passes does not hold the line the directive drew.
 *
 * SAME BLINDNESS CLASS, THIRD INSTANCE. Uniform fixtures: one `ag-ui.frame`, then one part, then one
 * event family. Each time, adding cells could not have found it — every new cell inherited the
 * uniform shape. So, as with the kind census, **the family list is checked against the SHIPPED
 * vocabulary** rather than written down here: a member added to `AGUI_EVENT_TYPE` tomorrow with no
 * fixture becomes a red cell instead of a silence.
 *
 * WHY THE ENVELOPES ARE BYTE-IDENTICAL. Every family frame below shares one `threadId`, `runId`,
 * `epoch` and `seq`, so the ONLY thing that can differ between two renderings is the events. Without
 * that, a renderer printing the frame's `seq` would make every family render differently while
 * displaying no event at all, and the distinctness cell would certify it.
 *
 * > ***A distinctness assertion is only as good as the sameness of everything else.*** The envelope
 * > is not incidental setup — it is the control the distinctness cell is measured against, and any
 * > future field added to `aguiFrame`'s envelope must be held constant here or that cell silently
 * > stops testing what its name says.
 */
const FAMILY_ENVELOPE = { threadId: "t-family", runId: "r-family", epoch: "e1", seq: 1 } as const;
const TS = 1;

/**
 * `must` is the family's PAYLOAD — the content a renderer cannot invent and must not lose. `types`
 * is the weaker property: whether the surface says which event happened at all.
 *
 * `run` has an empty `must` and that is a property of the vocabulary, not an omission: `RUN_STARTED`
 * and `RUN_FINISHED` carry ids and a type and nothing else, so there is no payload to preserve. Its
 * gate is the distinctness cell below instead, and it is named here rather than skipped.
 */
const FAMILIES: readonly { name: string; events: AguiEvent[]; must: string[]; types: string[] }[] = [
  {
    name: "run",
    events: [
      runStarted({ ...FAMILY_ENVELOPE, timestamp: TS }),
      runFinished({ ...FAMILY_ENVELOPE, timestamp: TS, outcome: { type: "success" } }),
    ],
    must: [],
    types: [AGUI_EVENT_TYPE.RUN_STARTED, AGUI_EVENT_TYPE.RUN_FINISHED],
  },
  {
    name: "text",
    events: [
      textMessageStart({ messageId: "m-text", role: "assistant", timestamp: TS }),
      textMessageContent({ messageId: "m-text", delta: "CANARY-FAMILY-TEXT", timestamp: TS }),
      textMessageEnd({ messageId: "m-text", timestamp: TS }),
    ],
    must: ["CANARY-FAMILY-TEXT"],
    types: [AGUI_EVENT_TYPE.TEXT_MESSAGE_START, AGUI_EVENT_TYPE.TEXT_MESSAGE_CONTENT, AGUI_EVENT_TYPE.TEXT_MESSAGE_END],
  },
  {
    name: "tool",
    events: [
      toolCallStart({ toolCallId: "tc1", toolCallName: "CANARY-FAMILY-TOOLNAME", timestamp: TS }),
      toolCallArgs({ toolCallId: "tc1", delta: '{"path":"CANARY-FAMILY-TOOLARGS"}', timestamp: TS }),
      toolCallEnd({ toolCallId: "tc1", timestamp: TS }),
      toolCallResult({ messageId: "m-tool", toolCallId: "tc1", content: "CANARY-FAMILY-TOOLRESULT", timestamp: TS }),
    ],
    // All three, not one: the tool NAME, its ARGUMENTS and its RESULT are three separate things a
    // reader needs, and `tr-`'s `salient()` died specifically by keeping one and dropping the rest.
    must: ["CANARY-FAMILY-TOOLNAME", "CANARY-FAMILY-TOOLARGS", "CANARY-FAMILY-TOOLRESULT"],
    types: [
      AGUI_EVENT_TYPE.TOOL_CALL_START, AGUI_EVENT_TYPE.TOOL_CALL_ARGS,
      AGUI_EVENT_TYPE.TOOL_CALL_END, AGUI_EVENT_TYPE.TOOL_CALL_RESULT,
    ],
  },
  {
    name: "reasoning",
    events: [
      reasoningMessageStart({ messageId: "m-reason", timestamp: TS }),
      reasoningMessageContent({ messageId: "m-reason", delta: "CANARY-FAMILY-REASONING", timestamp: TS }),
      reasoningMessageEnd({ messageId: "m-reason", timestamp: TS }),
    ],
    must: ["CANARY-FAMILY-REASONING"],
    types: [
      AGUI_EVENT_TYPE.REASONING_MESSAGE_START, AGUI_EVENT_TYPE.REASONING_MESSAGE_CONTENT,
      AGUI_EVENT_TYPE.REASONING_MESSAGE_END,
    ],
  },
  {
    name: "error",
    events: [runError({ message: "CANARY-FAMILY-ERROR", code: "E_CANARY", timestamp: TS })],
    must: ["CANARY-FAMILY-ERROR"],
    types: [AGUI_EVENT_TYPE.RUN_ERROR],
  },
];

// THE CENSUS, against the shipped vocabulary. `CUSTOM` is the one member with no fixture, and the
// justification is DERIVED rather than asserted in prose: `COTAL_CUSTOM_EVENTS` is the list of custom
// events this connector may emit, and while it is empty a `CUSTOM` frame cannot occur. If that list
// ever gains a member, this cell goes red and the family list must gain a fixture — which is the
// difference between a reason and an excuse.
const coveredTypes = new Set(FAMILIES.flatMap((f) => f.types));
const uncoveredTypes = Object.values(AGUI_EVENT_TYPE).filter(
  (t) => !coveredTypes.has(t) && !(t === AGUI_EVENT_TYPE.CUSTOM && COTAL_CUSTOM_EVENTS.length === 0),
);
c("[census] every member of AGUI_EVENT_TYPE has a family fixture (or is provably unemittable)",
  uncoveredTypes.length === 0, JSON.stringify(uncoveredTypes));

const familyRenderings = new Map<string, Map<string, string>>();
for (const s of SURFACES) {
  const perFamily = new Map<string, string>();
  familyRenderings.set(s.name, perFamily);
  for (const fam of FAMILIES) {
    if (!s.render) {
      if (fam.must.length > 0)
        c(`[GATE] ${s.name} DISPLAYS a ${fam.name}-event frame's payload`, false, "path not found");
      c(`[event-family:${fam.name}] ${s.name} names the events it drew`, false, "path not found");
      continue;
    }
    const framed = aguiFrame({ ...FAMILY_ENVELOPE, events: fam.events }) as unknown as { kind: string };
    const out = s.render([framed]);
    perFamily.set(fam.name, out);
    const missing = fam.must.filter((m) => !out.includes(m));
    if (missing.length > 0) console.log(`  [family:${fam.name}] ${s.name} -> ${JSON.stringify(out)}`);
    // The GATE cell, for every family that HAS a payload. This is the cell a text-only renderer
    // fails and every cell above it passes.
    if (fam.must.length > 0)
      c(`[GATE] ${s.name} DISPLAYS a ${fam.name}-event frame's payload`, missing.length === 0,
        `missing ${JSON.stringify(missing)}`);
    // Deliberately NOT a gate. A good renderer may draw a tool call as `Bash(ls)` and never print the
    // literal `TOOL_CALL_START`, so gating on the type name would fail a CORRECT surface. It is still
    // asserted, because a surface that names neither the payload nor the event is drawing nothing —
    // it is reported as its own finding, the way `[non-silence]` is.
    c(`[event-family:${fam.name}] ${s.name} names the events it drew`,
      fam.types.every((t) => out.includes(t)), JSON.stringify(out));
  }
}

/**
 * THE `run` FAMILY'S GATE, and the general trap the payload cells cannot catch.
 *
 * A renderer that collapses every frame to one marker — `[unrenderable part kind "ag-ui.frame"]` is
 * today's — renders all five families to the SAME string. Since the envelopes are byte-identical,
 * two families rendering alike means the events did not reach the output at all. This is the only
 * gate `run` can have (it carries no payload to preserve), and it is the cell that catches a
 * surface which draws SOMETHING for every frame while distinguishing none of them.
 */
for (const s of SURFACES) {
  const perFamily = familyRenderings.get(s.name);
  if (!perFamily || perFamily.size === 0) {
    c(`[GATE] ${s.name} renders different event families differently`, false, "path not found");
    continue;
  }
  const collisions: string[] = [];
  const seenBy = new Map<string, string>();
  for (const [fam, out] of perFamily) {
    const prior = seenBy.get(out);
    if (prior) collisions.push(`${prior}==${fam}`);
    else seenBy.set(out, fam);
  }
  c(`[GATE] ${s.name} renders different event families differently`,
    collisions.length === 0, `collisions ${JSON.stringify(collisions)}`);
}

// ── The precondition's second half. A surface that can draw a frame but never subscribes to the
//    channel carrying one has not met it either.
/**
 * THIS CELL WAS DEFECTIVE AND IT WAS DEFECTIVE WHERE ITS AUTHOR BELIEVED IT WAS CLOSED.
 *
 * It used to blank comments with `/^\s*\/\/.*$/gm` and then substring-search the result. That regex
 * only strips a line comment that STARTS a line, so `const wired = false; // nothing handles
 * ag-ui.frame yet` **opened the gate** — and so did a declared-but-unused constant, and so did
 * `export const help = "we do not support ag-ui.frame yet"`. **A string telling the user the
 * feature is absent certified it present.** Executed five ways in review, with a count-diff
 * proving exactly one cell changed state and that it was this one.
 *
 * > **The cell's name claimed a behaviour; the assertion tested whether four bytes appeared in a
 * > file. Everything between those two was ungraded.**
 *
 * The repair is not a longer list of spellings — that is the loop this class wins. **The source is
 * PARSED, and the question is whether an identifier is REFERENCED.** Comments and string literals
 * are not identifiers, so they stop being findable by construction rather than by exclusion. And
 * `ag-ui.frame` / `events.*` are dropped from the vocabulary entirely: they can only ever occur as
 * string CONTENT, so searching for them was always searching for text.
 *
 * A declaration is not a reference: `const AGUI_FRAME_KIND = "ag-ui.frame"` sitting unused is dead
 * code, so a use must exceed the declarations of that name.
 *
 * NAMED RESIDUAL, because this closes a family and not the world: a reference inside a function
 * nothing calls is still a reference, so **dead code that is syntactically live still passes.**
 * Closing that needs reachability, which needs a broker and a running renderer — and this suite
 * deliberately needs neither. The cell is now honest about what it grades, which is what it was not.
 */
const FRAME_IDENTS = ["AGUI_FRAME_KIND", "isAguiFramePart", "parseAguiFrame", "aguiFrame", "eventChannel"] as const;

function referencesFrameVocabulary(src: string, fileName: string): boolean {
  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true, undefined);
  let referenced = false;
  const visit = (node: ts.Node): void => {
    if (referenced) return;
    if (ts.isIdentifier(node) && (FRAME_IDENTS as readonly string[]).includes(node.text)) {
      // The NAME position of a declaration is not a use of the thing.
      const p = node.parent;
      const isDeclName =
        (ts.isVariableDeclaration(p) || ts.isFunctionDeclaration(p) || ts.isClassDeclaration(p) ||
          ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p) || ts.isImportSpecifier(p)) &&
        (p as { name?: ts.Node }).name === node;
      if (!isDeclName) referenced = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return referenced;
}

// The attack corpus that found the defect, kept as cells so the repair cannot silently regress.
// The POSITIVE control is not optional: a predicate that refuses everything passes every negative
// cell here and is indistinguishable from a correct one from the refusing side.
for (const [label, src, expected] of [
  ["trailing comment (the case the old regex missed)", `const wired = false; // TODO: nothing handles ag-ui.frame yet`, false],
  ["leading comment", `// TODO: nothing handles ag-ui.frame yet`, false],
  ["declared but never used", `const AGUI_FRAME_KIND = "ag-ui.frame";`, false],
  ["a string saying the feature is ABSENT", `export const help = "we do not support ag-ui.frame yet";`, false],
  ["unrelated code (negative control)", `const wired = false;`, false],
  ["CONTROL: a real reference must PASS", `if (isAguiFramePart(p)) draw(p);`, true],
] as const) {
  c(`[filter-predicate] ${label}`, referencesFrameVocabulary(src, "probe.ts") === expected);
}

for (const [surface, rel] of [
  ["cli mesh-view", join("implementations", "cli", "src", "view", "mesh-view.ts")],
  ["implementations/web app.js", join("implementations", "web", "src", "web", "app.js")],
  ["examples/02 observer", join("examples", "02-self-improving-console", "harness", "observer.ts")],
] as const) {
  const p = join(TREE, rel);
  const src = existsSync(p) ? readFileSync(p, "utf8") : "";
  c(`[GATE] ${surface} honours the events.* filter`, src.length > 0 && referencesFrameVocabulary(src, p));
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
