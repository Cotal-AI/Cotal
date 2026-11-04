import { Prose } from "../work/Prose.tsx";

/** A stream with no END, shown with the trailing " …" the renderers add. For plain text. */
export const withCut = (text: string, cut: boolean): string => (cut ? `${text} …` : text);

/** A code fence: three backticks at the start of a line, after at most three spaces. */
const FENCE = /^ {0,3}```/gm;

/** `withCut` for Markdown source. A stream cut inside an open code fence (an odd count of fences) has
 *  the fence closed first, so the mark lands after the code block and is never read as the agent's
 *  own output. */
export function markdownCut(text: string, cut: boolean): string {
  if (!cut) return text;
  const open = (text.match(FENCE) ?? []).length % 2 === 1;
  return open ? `${text}\n\`\`\`\n …` : `${text} …`;
}

/** The agent's prose (mock B1, `ox-said`), whole paragraphs through `Prose`, with the trailing " …"
 *  when its stream was cut. The panel (`compact`) clamps it to three lines in CSS rather than with
 *  Show more. */
export function SaidBlock({ text, cut, compact = false }: { text: string; cut: boolean; compact?: boolean }) {
  return <Prose className="ox-said" src={markdownCut(text, cut)} clamp={!compact} />;
}
