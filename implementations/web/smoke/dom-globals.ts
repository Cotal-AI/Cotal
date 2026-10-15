/** Gives this suite's process a DOM from jsdom, a test-only devDependency that client source never
 *  imports. jsdom is DOMPurify's own test environment: it parses with parse5 as HTML5 says and its
 *  NodeIterator has the standard's pre-removing steps, so the sanitizer runs as it does in a page.
 *
 *  Import it FIRST, before any module that renders Markdown or mounts React: `lib/md.ts` builds its
 *  sanitizer from the `window` it finds on the first render, and React's client reads `window` and
 *  `document` when it loads. Every name the window carries that Node does not already define is
 *  copied onto `globalThis`, so `document`, `HTMLElement`, `Node` and the event classes resolve as
 *  they do in a page. `window` and `document` are set unconditionally, because the art seam may
 *  already have pointed `window` at `globalThis` when it loaded first, and so is Web Storage. */
import { JSDOM } from "jsdom";

export const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
const win = dom.window as unknown as Record<string, unknown>;

const g = globalThis as Record<string, unknown>;
for (const key of Object.getOwnPropertyNames(win)) {
  if (key in g) continue;
  let value: unknown;
  try { value = win[key]; } catch { continue; }
  // A method such as `getComputedStyle` reads `this`; a class (capitalised) must stay unbound.
  if (typeof value === "function" && /^[a-z]/.test(key)) value = (value as (...a: unknown[]) => unknown).bind(win);
  Object.defineProperty(g, key, { value, configurable: true, writable: true });
}
g.window = win;
g.document = win.document;
// Node defines Web Storage of its own, which without --localstorage-file is a stub that warns on
// every read, so the page's storage replaces it.
for (const key of ["localStorage", "sessionStorage"]) Object.defineProperty(g, key, { value: win[key], configurable: true, writable: true });
// jsdom has no `matchMedia`, and the app reads it to choose the phone layout. The window answers as a
// wide screen, where no query matches; a suite that draws the phone layout installs its own.
if (typeof win.matchMedia !== "function") {
  win.matchMedia = (media: string) => ({ matches: false, media, addEventListener: () => undefined, removeEventListener: () => undefined });
  g.matchMedia = win.matchMedia;
}

/** Close the window's timers and handles, so the suite's process can exit.
 *
 *  It waits a moment first. d3-force starts a timer when a simulation is built, and the topology
 *  graph stops it at once, but d3's timer wakes one more time on the next animation frame to retire
 *  its own polling interval. Closing the window first cancels that frame, and the interval then
 *  holds the process open for good. */
export const closeDom = async (): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, 100));
  dom.window.close();
};
