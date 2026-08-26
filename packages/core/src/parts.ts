/**
 * Rendering message parts as the flat text a human or a model reads.
 *
 * One renderer, so a new core part kind is legible on every surface at once or on none — the
 * copied-out expression it replaces broke on `artifact` in three places the same way, rendering it
 * as an empty string rather than anything a reader could notice.
 *
 * It reaches only the three surfaces that call it (the connector inbox, `cotal join`, the mesh
 * view). Four others still carry their own copy — two stringify, two filter non-text parts out
 * before mapping — and a fix here cannot reach a surface whose defect is that it does not use this.
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
