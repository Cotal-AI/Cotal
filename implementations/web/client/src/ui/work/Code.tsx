import { Copy01Icon } from "@hugeicons/core-free-icons";
import { useEffect, useRef, useState } from "react";
import { Icon } from "../../icons/Icon.tsx";
import { highlight, type CodeToken } from "../../lib/highlight.js";
import { shownName } from "../../lib/session.js";
import { copy } from "../CopyCommand.tsx";
import { Button } from "../shadcn/button.tsx";
import { CodeBlock, CodeBlockActions, CodeBlockContent, CodeBlockHeader, CodeBlockLine } from "../shadcn/code-block.tsx";

/** The part of IntersectionObserver this part uses. Spelled out rather than taken from the DOM lib,
 *  because the suites typecheck the components that render on the server with no DOM lib. */
type Watcher = { observe(el: unknown): void; disconnect(): void };
type WatcherClass = new (cb: (entries: { isIntersecting: boolean }[]) => void) => Watcher;

/** The most characters of a fence's language word the header draws. The word is agent text of any
 *  length, so it is cut here and the whole word stays in the label's `title`. */
export const LANG_CAP = 24;

/** A fenced block from an agent's prose (mock B1 and C, `sh-code`): its language as text, a Copy
 *  button, and the code capped in height and scrolling. The text renders plain at once. Once the block
 *  is on screen (at mount where the browser has no IntersectionObserver), `highlight` loads Shiki and
 *  the language and the plain text is swapped for its tokens, each a span whose colour is a
 *  `var(--shiki-…)` reference. Shiki's HTML is never used. A language outside the eight, or a failed
 *  load, leaves the block plain. */
export function Code({ lang, text }: { lang: string; text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [tokens, setTokens] = useState<{ text: string; lang: string; lines: CodeToken[][] } | undefined>(undefined);
  useEffect(() => {
    let live = true;
    const run = () => void highlight(text, lang).then((lines) => {
      if (live && lines) setTokens({ text, lang, lines });
    });
    const Observer = (globalThis as { IntersectionObserver?: WatcherClass }).IntersectionObserver;
    if (!Observer || !ref.current) {
      run();
      return () => { live = false; };
    }
    const watch = new Observer((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      watch.disconnect();
      run();
    });
    watch.observe(ref.current);
    return () => {
      live = false;
      watch.disconnect();
    };
  }, [text, lang]);
  const lines = tokens?.text === text && tokens.lang === lang ? tokens.lines : undefined;
  return (
    <CodeBlock ref={ref} size="sm" className="ox-code">
      <CodeBlockHeader className="ox-code-h">
        {lang && <span title={lang}>{shownName(lang, LANG_CAP)}</span>}
        {" "}
        <CodeBlockActions className="ox-code-acts">
          <Button type="button" variant="ghost" size="xs" className="ox-copy" onClick={() => copy(text)}>
            <Icon icon={Copy01Icon} size={16} />
            Copy
          </Button>
        </CodeBlockActions>
      </CodeBlockHeader>
      <CodeBlockContent className="ox-code-c">
        {lines
          ? lines.map((line, i) => (
              <CodeBlockLine key={i}>
                {line.map((t, j) => <span key={j} style={t.color === undefined ? undefined : { color: t.color }}>{t.content}</span>)}
              </CodeBlockLine>
            ))
          : text}
      </CodeBlockContent>
    </CodeBlock>
  );
}
