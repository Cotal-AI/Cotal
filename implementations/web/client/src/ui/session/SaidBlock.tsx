import { renderMarkdown } from "../../lib/md.js";

/** A stream with no END, shown with the trailing " …" the renderers add. */
export const withCut = (text: string, cut: boolean): string => (cut ? `${text} …` : text);

/** The agent's prose (mock S, `ui-said`), whole paragraphs through the sanitized Markdown. The panel
 *  clamps it to three lines from its `ui-lt` container in CSS, so the part itself has no compact form. */
export function SaidBlock({ text, cut }: { text: string; cut: boolean }) {
  return <div className="ui-said" dangerouslySetInnerHTML={{ __html: renderMarkdown(withCut(text, cut)) }} />;
}
