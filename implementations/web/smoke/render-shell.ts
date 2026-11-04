/** Server-renders the phase 1 shell from a seeded store, so a suite asserts on what the shell
 *  actually draws instead of on its source text. `Shell` reads only the store, so the HTML is a
 *  pure function of the state handed in.
 *
 *  The import names `Shell.tsx` with its extension: the suites load it under tsx, and the
 *  coverage gate resolves an import to the file it names. For the same reason `Shell.tsx` and
 *  `ui/AppShell.tsx` name the `.tsx` files they import, so a mutation in them is reachable. */
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { Shell } from "../client/src/Shell.tsx";
import { createStore } from "../client/src/state/store.js";
import { initialState, type DashboardState } from "../client/src/state/types.js";
import { DEFAULT_ROUTE, type Route } from "../client/src/lib/route.js";

/** The shell's HTML for the initial state with `patch` applied, at `route`, with the details panel
 *  open or closed. The controller is null, as it is before the dashboard has started. The sidebar's
 *  Activity row reads `msgPerSecond`, which says no messages unless a suite hands it a rate. */
export function renderShell(patch: Partial<DashboardState> = {}, route: Route = DEFAULT_ROUTE, paneOpen = false, msgPerSecond: () => number = () => 0): string {
  const store = createStore<DashboardState>({ ...initialState, ...patch });
  return renderToString(createElement(Shell, { store, controller: null, route, paneOpen, msgPerSecond }));
}

/** The attributes of every `<name ...>` start tag in `html`, in document order, unescaped. */
export function startTags(html: string, name: string): Record<string, string>[] {
  return [...html.matchAll(new RegExp(`<${name}\\b([^>]*)>`, "g"))].map((m) => {
    const attrs: Record<string, string> = {};
    for (const a of m[1].matchAll(/\s([a-zA-Z][\w:-]*)(?:="([^"]*)")?/g)) attrs[a[1]] = unescapeHtml(a[2] ?? "");
    return attrs;
  });
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

/** The stale marker (`ui/StaleMarker.tsx`) in `html`: the attributes of its box and the text of its
 *  bold label, unescaped. */
export function staleMarker(html: string): { attrs: Record<string, string>; text: string } | undefined {
  const m = /(<div class="ui-stale" id="stale"[^>]*>)[\s\S]*?<b>([^<]*)<\/b>/.exec(html);
  if (!m) return undefined;
  return { attrs: startTags(m[1], "div")[0], text: unescapeHtml(m[2]) };
}
