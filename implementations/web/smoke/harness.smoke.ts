/**
 * Dashboard harness-branding coverage. `client/src/lib/harness.ts` is a hand-maintained map of connector name →
 * label/colour/glyph/SVG, and nothing linked it to the actual connector set — so a new connector
 * shipped, was spawnable, appeared in the roster, and rendered with no icon and no label, with
 * every test still green. That is exactly how the codex connector shipped its first build.
 *
 * The rule: every OFFICIAL connector must have an entry. Third-party connectors deliberately must
 * NOT — the dashboard degrades to a neutral name rather than invent branding for someone else's
 * agent, so this asserts coverage of the first-party set, not of every name that could appear.
 *
 * Run: pnpm smoke:web-harness
 */
import { strict as assert } from "node:assert";
import { OFFICIAL_CONNECTORS } from "@cotal-ai/workspace";
import { HARNESS, type Harness } from "../client/src/lib/harness.js";

let pass = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, `${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

const harness: Record<string, Harness> = HARNESS;
check("HARNESS has exactly the six branded connectors",
  JSON.stringify(Object.keys(harness).sort()) === JSON.stringify(["claude", "codex", "hermes", "jcode", "opencode", "pi"]),
  Object.keys(harness));

for (const name of Object.keys(OFFICIAL_CONNECTORS)) {
  const h = harness[name];
  check(`official connector "${name}" has dashboard branding`, h !== undefined, Object.keys(harness));
  if (!h) continue;
  // Every field is load-bearing on a different surface: the DOM badge uses `svg`, the canvas graph
  // cannot draw inline SVG and falls back to `glyph`, and both use `color` + `label`. A partial
  // entry renders blank on whichever surface reads the missing one.
  check(`"${name}" branding is complete (label, color, glyph, svg)`, ["label", "color", "glyph", "svg"].every((k) => typeof h[k as keyof Harness] === "string" && h[k as keyof Harness].length > 0), h);
  check(`"${name}" svg is a self-contained inline <svg>`, h.svg.startsWith("<svg") && h.svg.endsWith("</svg>"), h.svg.slice(0, 40));
  check(`"${name}" color is a hex colour the canvas can use directly`, /^#[0-9a-fA-F]{3,8}$/.test(h.color), h.color);
}

console.log(`\nWEB HARNESS SMOKE PASSED ✅  (${pass} checks)`);
