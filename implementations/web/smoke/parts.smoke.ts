/**
 * Dashboard part-rendering coverage.
 *
 * The dashboard rendered an `artifact` part as an EMPTY MESSAGE BODY — no error, no placeholder, no
 * console warning — because two inline copies of the old renderer funnelled every non-`text` kind
 * into `JSON.stringify(p.data)`, and an artifact part has no `data` field. `JSON.stringify(undefined)`
 * returns the VALUE `undefined`, which `join` coerces to `""`.
 *
 * An empty body is indistinguishable from a message that legitimately had nothing to show, so it is
 * never reported. That is why this file asserts CONTENT rather than absence of error: a cell that
 * checks "rendering did not throw" passes just as happily on the defect.
 *
 * `packages/core/src/parts.ts` is the source of truth, but the browser half of this package is
 * loaded as plain `<script src>` tags and resolves no modules at runtime, so it cannot import it.
 * `src/web/parts.js` is therefore a deliberate second implementation, and the parity cells below are
 * what keep the two from drifting — the duplication is CHECKED, not merely documented.
 *
 * Run: pnpm smoke:web-parts
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { partsToText as corePartsToText } from "@cotal-ai/core";

let pass = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, `${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

// parts.js is a plain browser script: it assigns onto `window`. Evaluate it exactly as the page
// does, so this drives the SHIPPED artifact rather than a parallel copy.
interface PartsApi {
  partText(p: unknown): string;
  partsToText(parts: unknown): string;
}
const win: { COTAL_PARTS?: PartsApi } = {};
new Function("window", read("../src/web/parts.js"))(win);
const P = win.COTAL_PARTS;
check("parts.js defines window.COTAL_PARTS", P !== undefined);
if (!P) throw new Error("unreachable");

const ARTIFACT = { kind: "artifact", name: "coverage.html", mediaType: "text/html", size: 12, digest: "sha256:abc" };

// ── controls: establish the renderer works before asserting where it fails ──────────────────────
check("control — a text part renders its text", P.partsToText([{ kind: "text", text: "hello" }]) === "hello");
check("control — a data part renders its JSON", P.partsToText([{ kind: "data", data: { x: 1 } }]) === '{"x":1}');

// ── the defect, asserted on CONTENT ─────────────────────────────────────────────────────────────
const art = P.partsToText([ARTIFACT]);
check("an artifact part names the artifact", art.includes("coverage.html"), art);
check("an artifact part states its media type", art.includes("text/html"), art);
check("an artifact part states its size", art.includes("12"), art);
check("an artifact part carries the digest — the only self-verifying field", art.includes("sha256:abc"), art);
check("an artifact part does not render empty", art.trim().length > 0, art);

const mixed = P.partsToText([{ kind: "text", text: "see:" }, ARTIFACT]);
check("text alongside an artifact keeps the text", mixed.includes("see:"), mixed);
check("text alongside an artifact keeps the artifact", mixed.includes("coverage.html"), mixed);

// ── the rule: no part renders as nothing ────────────────────────────────────────────────────────
const unknown = P.partsToText([{ kind: "ag-ui.frame", frame: { type: "RUN_STARTED" } }]);
check("an unknown part kind does not render empty", unknown.trim().length > 0, unknown);
check("an unknown part kind names the kind it could not render", unknown.includes("ag-ui.frame"), unknown);

const emptyData = P.partsToText([{ kind: "data" }]);
check("a data part carrying no data says so rather than vanishing", emptyData.trim().length > 0, emptyData);
check("an empty data part is not confused with an unrenderable kind", !emptyData.includes("unrenderable"), emptyData);

const KINDS = [
  { label: "text", part: { kind: "text", text: "x" } },
  { label: "data", part: { kind: "data", data: { x: 1 } } },
  { label: "artifact", part: ARTIFACT },
  { label: "unknown extension kind", part: { kind: "some.future.kind" } },
  { label: "malformed", part: null },
];
check("the kind table is populated (a vacuous loop would pass every cell below)", KINDS.length === 5);
for (const { label, part } of KINDS) {
  const out = P.partsToText([part]);
  check(`no part renders as nothing — ${label}`, out.trim().length > 0, out);
}

// ── parity with core, so the duplication cannot drift silently ──────────────────────────────────
// Only over the kinds core renders non-empty at this revision; `src/web/parts.js` documents where it
// deliberately goes further. If core's format changes, these fail here rather than in a user's face.
const PARITY = [
  [{ kind: "text", text: "hello" }],
  [{ kind: "data", data: { x: 1, y: "z" } }],
  [ARTIFACT],
  [{ kind: "text", text: "see:" }, ARTIFACT],
];
check("the parity table is populated", PARITY.length === 4);
for (const parts of PARITY) {
  const mine = P.partsToText(parts);
  const theirs = corePartsToText(parts as never);
  check(`payload renderer matches core — ${parts.map((p) => p.kind).join("+")}`, mine === theirs, { mine, theirs });
}

// ── the wiring, which is what actually breaks the page ──────────────────────────────────────────
// A renderer nothing loads is worth nothing: `web.ts` serves an explicit route table, so a payload
// script with no route 404s and every consumer of it throws on the first message.
const webTs = read("../src/web.ts");
const pageBlock = webTs.slice(webTs.indexOf("const PAGE"), webTs.indexOf("};", webTs.indexOf("const PAGE")));
const routes = [...pageBlock.matchAll(/"(\/[^"]*)":/g)].map((m) => m[1]);
check("route table parsed (an empty parse would pass every cell below vacuously)", routes.length >= 5, routes);
check("route table parse found a known route — it matched CODE, not a comment", routes.includes("/app.js"), routes);

for (const page of ["index.html", "graph.html"]) {
  const html = read(`../src/web/${page}`);
  const srcs = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  check(`${page} declares scripts (empty would pass vacuously)`, srcs.length > 0, srcs);
  for (const src of srcs) check(`${page} loads ${src} and the server serves it`, routes.includes(src), routes);
  const parts = srcs.indexOf("/parts.js");
  const consumer = srcs.findIndex((s) => s === "/app.js" || s === "/graph.js");
  check(`${page} loads /parts.js`, parts !== -1, srcs);
  check(`${page} loads /parts.js BEFORE its consumer`, parts !== -1 && consumer !== -1 && parts < consumer, srcs);
}

// ── regression guard: the inline copies must not come back ──────────────────────────────────────
for (const f of ["app.js", "graph.js"]) {
  const src = read(`../src/web/${f}`);
  check(`${f} has no inline part renderer`, !src.includes("JSON.stringify(p.data)"));
  check(`${f} routes parts through the one payload renderer`, src.includes("COTAL_PARTS.partsToText"));
}

console.log(`\nweb parts smoke: ${pass} checks passed`);
