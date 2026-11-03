// Syntax highlighting for code in an agent's prose, as tokens a component draws as text. Shiki loads
// on the first highlight and each language on its first use, all through dynamic imports, so none of
// it is in the first load. It is never imported from the package root `shiki`, which bundles every
// grammar and theme.
//
// The theme is Shiki's CSS-variables theme: a token's colour is `var(--shiki-…)`, and tokens.css sets
// those variables from our inks, so Night follows the page. The JavaScript regex engine needs no WASM.
import type { HighlighterCore, LanguageInput } from "shiki/core";

/** Shiki's core and its JavaScript regex engine, loaded on the first highlight. */
const loadShiki = () => Promise.all([import("shiki/core"), import("shiki/engine/javascript")]);

/** One token: its text and its colour, a `var(--shiki-…)` reference. */
export interface CodeToken { content: string; color?: string }

/** The grammars, one lazy chunk each. Written out so the bundler sees every path. */
const GRAMMARS = new Map<string, LanguageInput>([
  ["javascript", () => import("shiki/langs/javascript.mjs")],
  ["typescript", () => import("shiki/langs/typescript.mjs")],
  ["json", () => import("shiki/langs/json.mjs")],
  ["bash", () => import("shiki/langs/bash.mjs")],
  ["diff", () => import("shiki/langs/diff.mjs")],
  ["python", () => import("shiki/langs/python.mjs")],
  ["yaml", () => import("shiki/langs/yaml.mjs")],
  ["markdown", () => import("shiki/langs/markdown.mjs")],
]);

/** A fence's language, lower-cased, to its grammar. Anything else stays plain. */
const NAMES = new Map<string, string>([
  ["js", "javascript"], ["javascript", "javascript"],
  ["ts", "typescript"], ["typescript", "typescript"],
  ["json", "json"],
  ["bash", "bash"], ["sh", "bash"], ["shell", "bash"], ["zsh", "bash"],
  ["diff", "diff"],
  ["python", "python"], ["py", "python"],
  ["yaml", "yaml"], ["yml", "yaml"],
  ["markdown", "markdown"], ["md", "markdown"],
]);

const THEME = "cotal";

/** Code longer than this many characters stays plain: Shiki tokenizes on the main thread, and an
 *  agent's text is untrusted, so its size is too. */
export const HIGHLIGHT_CAP = 20_000;
/** A line longer than this is not tokenized past it. */
const LINE_CAP = 1000;

let core: Promise<HighlighterCore> | undefined;
const loading = new Map<string, Promise<void>>();

/** The highlighter, made once. A load that fails is forgotten, so a later block tries again. */
function highlighter(): Promise<HighlighterCore> {
  core ??= loadShiki()
    .then(([{ createHighlighterCore, createCssVariablesTheme }, { createJavaScriptRegexEngine }]) =>
      createHighlighterCore({
        themes: [createCssVariablesTheme({ name: THEME, variablePrefix: "--shiki-", fontStyle: false })],
        langs: [],
        engine: createJavaScriptRegexEngine({ forgiving: true }),
      }))
    .catch((err: unknown) => {
      core = undefined;
      throw err;
    });
  return core;
}

/** `lang`'s grammar loaded into `shiki`, once. */
function grammar(shiki: HighlighterCore, lang: string): Promise<void> {
  let p = loading.get(lang);
  if (!p) {
    p = shiki.loadLanguage(GRAMMARS.get(lang)!).catch((err: unknown) => {
      loading.delete(lang);
      throw err;
    });
    loading.set(lang, p);
  }
  return p;
}

/** Tokens for `text` in `lang`, loading Shiki and the language on first use, one array per line.
 *  Undefined for a language outside the eight, for code over `HIGHLIGHT_CAP` characters (Shiki is
 *  not loaded for it), or when loading fails: the block stays plain. */
export async function highlight(text: string, lang: string): Promise<CodeToken[][] | undefined> {
  const name = NAMES.get(lang.toLowerCase());
  if (name === undefined) return undefined;
  if (text.length > HIGHLIGHT_CAP) return undefined;
  try {
    const shiki = await highlighter();
    await grammar(shiki, name);
    return shiki.codeToTokens(text, { lang: name, theme: THEME, tokenizeMaxLineLength: LINE_CAP }).tokens.map((line) =>
      line.map((t) => (t.color === undefined ? { content: t.content } : { content: t.content, color: t.color })));
  } catch (err) {
    console.error("highlighting a code block failed, so it stays plain:", err);
    return undefined;
  }
}
