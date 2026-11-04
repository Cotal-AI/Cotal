import { useState } from "react";
import { renderMarkdown } from "../../lib/md.js";
import { markdownCut } from "./SaidBlock.tsx";

/** A prompt longer than this many characters of source text clamps, as a message body does. */
const CLAMP = 280;

/** The prompt that started a turn (mock S, `ui-prompt`), full view only: the label "Prompt" and the
 *  text through the sanitized Markdown, clamped past 280 characters with Show more and Show less. */
export function PromptBlock({ text, cut }: { text: string; cut: boolean }) {
  const [open, setOpen] = useState(false);
  const src = markdownCut(text, cut);
  const long = src.length > CLAMP;
  return (
    <div className="ui-prompt">
      <span>Prompt</span>
      <div className={long && !open ? "ui-tx ui-clamp" : "ui-tx"} dangerouslySetInnerHTML={{ __html: renderMarkdown(src) }} />
      {long && <button type="button" className="ui-more" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "Show less" : "Show more"}</button>}
    </div>
  );
}
