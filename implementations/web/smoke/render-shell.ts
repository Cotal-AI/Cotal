/** Server-renders the phase 1 shell from a seeded store, so a suite asserts on what the shell
 *  actually draws instead of on its source text. `Shell` reads only the store, so the HTML is a
 *  pure function of the state handed in.
 *
 *  The import names `Shell.tsx` with its extension: the suites load it under tsx, and the
 *  coverage gate resolves an import to the file it names. */
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { Shell } from "../client/src/Shell.tsx";
import { createStore } from "../client/src/state/store.js";
import { initialState, type DashboardState } from "../client/src/state/types.js";

/** The shell's HTML for the initial state with `patch` applied. */
export function renderShell(patch: Partial<DashboardState> = {}): string {
  const store = createStore<DashboardState>({ ...initialState, ...patch });
  return renderToString(createElement(Shell, { store, controller: null }));
}

/** Undo the escaping React applies to text and attribute values. */
export const unescapeHtml = (s: string): string =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&");

/** The first `<p id="…">` element in `html`: its attributes and its text, unescaped. */
export function paragraph(html: string, id: string): { attrs: Record<string, string>; text: string } | undefined {
  const m = new RegExp(`<p id="${id}"([^>]*)>([^<]*)</p>`).exec(html);
  if (!m) return undefined;
  const attrs: Record<string, string> = {};
  for (const a of m[1].matchAll(/\s([a-z-]+)(?:="([^"]*)")?/g)) attrs[a[1]] = unescapeHtml(a[2] ?? "");
  return { attrs, text: unescapeHtml(m[2]) };
}
