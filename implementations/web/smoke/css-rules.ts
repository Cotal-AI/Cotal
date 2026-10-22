/** The style rules of a stylesheet, source or built, for the suites that check where a rule sits.
 *  Comments are dropped and statement at-rules such as `@layer a, b;` are skipped. Each rule keeps
 *  the `@media`, `@layer` and `@supports` heads around it, outermost first, and its selector list
 *  split on top-level commas, with quotes removed and whitespace collapsed, so a minifier that
 *  merges two rules into one comma list does not hide either selector. */
export type CssRule = { selectors: string[]; body: string; within: string[] };

/** `selector` split on the commas outside any parentheses or brackets. */
const splitSelectors = (selector: string): string[] => {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < selector.length; i++) {
    const c = selector[i];
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === "," && depth === 0) {
      parts.push(selector.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(selector.slice(start));
  return parts.map((p) => p.replace(/["']/g, "").replace(/\s+/g, " ").replace(/\s*,\s*/g, ",").trim());
};

const walk = (text: string, within: string[]): CssRule[] => {
  const found: CssRule[] = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("{", i);
    if (open < 0) break;
    const semi = text.indexOf(";", i);
    if (semi >= 0 && semi < open) {
      i = semi + 1;
      continue;
    }
    let depth = 0;
    let close = open;
    for (; close < text.length; close++) {
      if (text[close] === "{") depth++;
      else if (text[close] === "}" && --depth === 0) break;
    }
    const head = text.slice(i, open).trim();
    const inner = text.slice(open + 1, close);
    if (/^@(?:media|layer|supports)\b/.test(head)) found.push(...walk(inner, [...within, head]));
    else if (!head.startsWith("@")) found.push({ selectors: splitSelectors(head), body: inner, within });
    i = close + 1;
  }
  return found;
};

export const cssRules = (css: string): CssRule[] => walk(css.replace(/\/\*[\s\S]*?\*\//g, ""), []);
