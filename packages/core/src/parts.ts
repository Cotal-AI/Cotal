/**
 * Rendering message parts as the flat text a human or a model reads.
 *
 * This exists because the expression it replaces was copied verbatim into three surfaces (the
 * connector inbox, `cotal join`, and the mesh view), and adding the `artifact` core kind broke all
 * three the same way: an artifact part has no `data` field, so the old `JSON.stringify(p.data)`
 * fallback rendered it as the literal string "undefined". One renderer means a new core part kind
 * is legible everywhere at once, or nowhere — never in two surfaces out of three.
 */
import type { Part } from "./types.js";

/** One part as display text. An unknown extension kind still falls back to its `data`, which is
 *  the pre-existing behaviour and deliberately unchanged: extensions are opaque here. */
function partText(p: Part): string {
  if (p.kind === "text") return p.text;
  // The digest is verbose, and it is not optional: it is the only handle a reader can act on to
  // actually fetch the bytes. Name and size come from the publisher, so they are shown as the
  // claims they are, not as facts the reader should size a buffer from.
  if (p.kind === "artifact") return `[artifact ${p.name} (${p.mediaType}, ${p.size} bytes) ${p.digest}]`;
  return JSON.stringify((p as { data?: unknown }).data);
}

/** A message's parts as one flat string, space-joined. */
export function partsToText(parts: readonly Part[]): string {
  return parts.map(partText).join(" ");
}
