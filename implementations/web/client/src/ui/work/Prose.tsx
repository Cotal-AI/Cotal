import { useMemo, useState } from "react";
import { markdownSegments } from "../../lib/md.js";
import { Code } from "./Code.tsx";

/** A stretch of prose longer than this many characters of text clamps, as a prompt does. */
const CLAMP = 280;

/** The characters of text in sanitized HTML, its tags left out. Only a length is read from it. */
const textLength = (html: string): number => html.replace(/<[^>]*>/g, "").length;

/** An agent's Markdown (mock B1, `ox-said`): `markdownSegments` splits it at fenced code, each prose
 *  piece goes in as the sanitizer's HTML and each fence becomes a `Code` block drawn as text. A prose
 *  piece longer than 280 characters of text clamps, and one Show more under the whole opens every
 *  clamped piece; a code block caps its own height instead. `clamp` false (the panel) leaves the
 *  clamping to the container's CSS. `src` is already cut (`markdownCut`), so a cut stream keeps its
 *  trailing " …". */
export function Prose({ src, className, clamp = true }: { src: string; className: string; clamp?: boolean }) {
  const segments = useMemo(() => markdownSegments(src), [src]);
  const [open, setOpen] = useState(false);
  const long = clamp && segments.some((s) => s.kind === "html" && textLength(s.html) > CLAMP);
  return (
    <div className={className}>
      {segments.map((s, i) =>
        s.kind === "code" ? (
          <Code key={i} lang={s.lang} text={s.text} />
        ) : (
          <div key={i} className={long && !open && textLength(s.html) > CLAMP ? "ox-prose ui-clamp" : "ox-prose"} dangerouslySetInnerHTML={{ __html: s.html }} />
        ))}
      {long && <button type="button" className="ui-more" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "Show less" : "Show more"}</button>}
    </div>
  );
}
