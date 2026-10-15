// The Cotal characters as a module. `characters.js` is the brand's file, byte for byte, and when it
// runs it assigns its API to `window.CotalArt`. This seam is the one place that knows that: it loads
// the file so that it runs in a browser and under Node (where the suites draw), and it exposes the
// drawings the dashboard uses. Components import from here and never read `window.CotalArt`.
import type { CotalArtApi } from "./characters.js";

const g = globalThis as { window?: unknown; Path2D?: unknown };
// Set before the file runs, because it writes `window.CotalArt` as it evaluates. In a browser
// `window` already exists and this does nothing.
g.window ??= globalThis;
// The file also builds its canvas paths as it loads. Node has no canvas, and this seam exposes no
// canvas drawing, so off the DOM the paths only need something to be constructed from.
g.Path2D ??= class NoCanvasPath {};
await import("./characters.js");
const art = (g.window as { CotalArt: CotalArtApi }).CotalArt;

/** One character's body as SVG markup (the groups of its 116-unit box, centred on 52,52), for the
 *  caller's own `<svg>`. A vendor the file does not know draws as the guest. */
export function body(vendor: string, opts?: { look?: string; mood?: string }): string {
  return art.body(vendor, opts);
}

/** The Cotal mark as a whole `<svg>`: one fill for every path, or one fill per path. */
export function mark(fill: string | string[]): string {
  return art.mark(fill);
}
