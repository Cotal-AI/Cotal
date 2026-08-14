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
 * **2. It names THREE surfaces. There were FIVE.** `implementations/web/src/web/app.js` and
 * `.../graph.js` carry independent copies of the same inline expression and were not part of the
 * consolidation, and `examples/02-self-improving-console/harness/observer.ts` reaches the same
 * outcome by *filtering* non-text parts out before mapping rather than by stringifying them.
 * **The consolidation was produced by a sweep that matched the EXPRESSION**, so it missed the two
 * copies nobody had grepped for and could never have found the filter form at all.
 *
 * > **Sweep for the OUTCOME — a part kind that reaches neither a reader nor an error — not for the
 * > expression.** The stringify form leaves a stray separator behind; the filter form leaves no
 * > trace at all.
 */
import type { Part } from "./types.js";

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
  // An extension kind. Not renderable here and not silently droppable either: the marker names the
  // kind, so a reader who meets one knows exactly which renderer is missing rather than seeing a
  // message that looks like it was sent blank.
  return `[unrenderable part kind ${JSON.stringify(p.kind)} — no renderer for it on this surface]`;
}

/** A message's parts as one flat string, space-joined. */
export function partsToText(parts: readonly Part[]): string {
  return parts.map(partText).join(" ");
}
