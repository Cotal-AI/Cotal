/**
 * Rendering message parts as the flat text a human or a model reads.
 *
 * This exists because the expression it replaces was copied verbatim into three surfaces (the
 * connector inbox, `cotal join`, and the mesh view), and adding the `artifact` core kind broke all
 * three the same way: an artifact part has no `data` field, so the old `JSON.stringify(p.data)`
 * fallback rendered it as an EMPTY STRING. One renderer means a new core part kind is legible
 * everywhere at once, or nowhere — never in two surfaces out of three.
 *
 * **TWO CORRECTIONS TO THAT PARAGRAPH, BOTH MEASURED, BOTH THE REASON THIS FILE CHANGED AGAIN.**
 *
 * **1. It said the old fallback "rendered it as the literal string `undefined`". It did not.**
 * `JSON.stringify(undefined)` returns the *value* `undefined`, and `Array.prototype.join` coerces
 * that to `""`. **A literal `"undefined"` in a message body is visible and gets reported the same
 * day; an empty body never does.** The comment understated the defect it was written to fix, and
 * understating it is part of why the shape survived — a defect described as more visible than it is
 * gets prioritised as though somebody would have noticed.
 *
 * **2. It names THREE surfaces. There are SEVEN.** **The consolidation was produced by a sweep that
 * matched the EXPRESSION**, so it missed the copies nobody had grepped for and could never have
 * found the filter form at all. Measured at `7cc74f50`, by the outcome predicate below:
 *
 *   - **3 ADOPTED** this function — `connector-core/src/agent.ts`, `cli/src/commands/join.ts`,
 *     `cli/src/view/mesh-view.ts`. These are the only three, and so they are the only three a fix
 *     here reaches.
 *   - **2 STRINGIFY-FORM copies** — `implementations/web/src/web/app.js` and `.../graph.js`.
 *   - **2 FILTER-FORM** — `examples/02-self-improving-console/harness/observer.ts` and
 *     `examples/04-frontier-faces/tools/studio.mjs`, which drop non-text parts before mapping.
 *
 * ***A fix to the shared renderer cannot reach a surface whose defect is that it does not use the
 * shared renderer.*** The four it misses are exactly the four that never adopted it — that is the
 * definition of the set, not bad luck. **This function closes THREE OF SEVEN and nothing wider, and
 * that is the number to check the box against.**
 *
 * > **Sweep for the OUTCOME — a part kind that reaches neither a reader nor an error — not for the
 * > expression.** The stringify form leaves a stray separator behind; the filter form leaves no
 * > trace at all. Re-run it with the disjunction, not one arm:
 * > `kind === "text"` alongside `JSON.stringify(p.data)`.
 *
 * ⚠️ **THE OUTCOME SWEEP HAS ITS OWN ELSE-BRANCH: it mints LOOKALIKES, and only a TYPE check
 * excludes them.** `examples/04-frontier-faces/web/studio.html:477` iterates `m.parts` and reads
 * like an eighth instance. It is not one: those are OpenCode session parts, discriminated on
 * `p.type` (`reasoning` / `text` / `tool`), not Cotal `Part` values, which discriminate on `p.kind`.
 * Different type, different producer. **A count inflated by a lookalike is as wrong as one deflated
 * by a miss, and it is the more tempting error, because it makes the finding look bigger.**
 * Excluded deliberately; the exclusion is evidence and is recorded rather than dropped.
 *
 * **A separate class, named because it is the instrument rather than the product: the SUITES render
 * a non-text part as `""` too — 23 sites across 20 files**, spanning `packages/core`'s own smoke
 * suites, the CLI's, the codex and opencode connectors', and `bin/smoke`. They are harnesses, not
 * reader-facing surfaces, so they are not part of the seven. But it means **the suites cannot see a
 * part that vanishes**: a cell asserting on received text passes identically whether the non-text
 * part arrived or was dropped. Left as found and flagged here rather than changed, because widening
 * this commit into the suites that grade it is how a fix stops being reviewable.
 *
 * ⚠️ **THAT NUMBER WAS FIRST WRITTEN HERE AS "FOUR", AND THE WAY IT WAS WRONG IS THE POINT.** The
 * sweep that produced it piped through `grep -v "/smoke/"` — **an exclusion that removed exactly the
 * population being counted.** The habit is sound (test files are noise when you are sweeping for a
 * product defect) and it was carried, unexamined, into the one sweep whose subject was the tests.
 *
 * > ***An exclusion inherited from the previous sweep is a filter nobody re-justified. Check what a
 * > sweep DROPS against what it is looking for, not against what the last one was looking for.***
 *
 * **Second correction, from the same re-run:** on these seats `grep` is a **shell function** wrapping
 * ugrep with `--ignore-files`, so a bare `grep -r` is blind to everything gitignored. Two-arm control:
 * one marker in a tracked file and one in a gitignored file is found **once** by bare `grep -r` and
 * **twice** by `/usr/bin/grep -r`. **The three-call-site count above is unaffected and was re-derived
 * both ways** — pinned `/usr/bin/grep` and `git grep` agree exactly — because those files are all
 * tracked. **Sweeps that conclude an ABSENCE want the pinned binary or `git grep`.**
 */
import type { Part } from "./types.js";
import { registry, type Extension } from "./registry.js";

/**
 * A renderer for ONE extension part kind — an {@link Extension} of kind `"part-renderer"`, whose
 * `name` is the part kind it draws (e.g. `"ag-ui.frame"`).
 *
 * **THIS IS A SEAM, NOT KNOWLEDGE.** Core cannot render an extension's part: it does not know what
 * the payload means, and `AGENTS.md` is explicit that an adapter's concepts must not leak in here.
 * But the alternative that was shipping — every extension part rendering as a marker on every
 * surface — means an extension can put a part on the wire that **nothing in the standard can ever
 * display.** So core declares the contract and stays ignorant of who fills it, exactly as
 * {@link TerminalLayout} does for terminal backends: the provider self-registers on import, and the
 * consumer here resolves by kind without ever importing the extension package.
 *
 * **THE MARKER IS NOT REMOVED, AND THAT MATTERS.** A kind with no registered renderer still renders
 * `[unrenderable part kind …]`. This makes the marker RARER; it does not make absence quiet again.
 */
export interface PartRenderer extends Extension {
  readonly kind: "part-renderer";
  /** The part kind this draws — the `kind` field of the parts it is resolved for. */
  readonly name: string;
  render(part: Part): string;
}

/**
 * One part as display text.
 *
 * **NO PART RENDERS AS NOTHING.** That is the rule this function now enforces, and it is
 * `AGENTS.md`'s "No fallbacks. Throw if something is not supported in the current environment or
 * config, rather than silently degrading" applied at the only layer that can see every kind at
 * once. It is a visible marker rather than a throw ON PURPOSE: **a throw here is swallowable.** A
 * caller that wraps this in a try/catch and skips the message reinstates exactly the silence being
 * removed, one layer further up, where it is harder to see. *A refusal that is not delivered is not
 * a refusal* — so the refusal is delivered as content, into the same string the reader is already
 * looking at.
 *
 * Extension kinds stay OPAQUE here, which is unchanged and deliberate: core does not know how to
 * render `ag-ui.frame` or anything else an extension defines, and it must not pretend to. What
 * changes is that not knowing now says so.
 */
function partText(p: Part): string {
  if (p.kind === "text") return p.text;
  // The digest is verbose, and it is not optional: it is the only handle a reader can act on to
  // actually fetch the bytes. Name and size come from the publisher, so they are shown as the
  // claims they are, not as facts the reader should size a buffer from.
  if (p.kind === "artifact") return `[artifact ${p.name} (${p.mediaType}, ${p.size} bytes) ${p.digest}]`;
  if (p.kind === "data") {
    const encoded = JSON.stringify((p as { data?: unknown }).data);
    // `JSON.stringify(undefined)` returns `undefined`, so a `data` part carrying no data hits the
    // same vanishing act as an unknown kind. Named separately from the kind marker below, because
    // "a data part with nothing in it" and "a kind this build cannot render" are different facts
    // and a reader who sees one must not conclude the other.
    return encoded === undefined ? `[empty data part]` : encoded;
  }
  // An extension kind. Core cannot draw it, but a registered {@link PartRenderer} can — resolved by
  // the part's own kind, so core never learns what any of them mean.
  if (registry.has("part-renderer", p.kind)) {
    const renderer = registry.resolve<PartRenderer>("part-renderer", p.kind);
    try {
      return renderer.render(p);
    } catch (e) {
      // A THROWING RENDERER MUST NOT SILENCE THE MESSAGE, AND MUST NOT TAKE THE SURFACE DOWN.
      //
      // This is the same reasoning that makes the marker below a string rather than a `throw`: a
      // refusal that is not delivered is not a refusal. A renderer that throws is a DIFFERENT fact
      // from a kind nobody renders, so it gets its own marker and names the reason — a reader who
      // sees this must not conclude "no renderer exists", which is what a shared marker would tell
      // them. It is deliberately NOT swallowed into the plain marker for exactly that reason.
      return `[part renderer for ${JSON.stringify(p.kind)} failed: ${(e as Error).message}]`;
    }
  }
  // No renderer registered. The marker names the kind, so a reader who meets one knows exactly which
  // renderer is missing rather than seeing a message that looks like it was sent blank.
  return `[unrenderable part kind ${JSON.stringify(p.kind)} — no renderer for it on this surface]`;
}

/** A message's parts as one flat string, space-joined. */
export function partsToText(parts: readonly Part[]): string {
  return parts.map(partText).join(" ");
}
