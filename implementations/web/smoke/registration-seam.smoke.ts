/** Every file the build emits is a route the server serves, so a build that renames or adds an
 *  asset can never leave the page pointing at a 404: the files the page references, every file in
 *  `assets/` (chunks the scripts load at runtime included), and every `url(...)` in the built CSS
 *  (the fonts). Runs against the real build. */
import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { clientAssets } from "../src/web.js";

let n = 0;
const ok = (name: string, cond: unknown, detail?: unknown) => {
  assert.ok(cond, `${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
  console.log(`  ok ${++n} ${name}`);
};

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "web");
const routes = clientAssets(out);
const html = readFileSync(join(out, "index.html"), "utf8");
const refs = [...html.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map((m) => m[1]);
ok("the built page references files", refs.length > 0, refs);
ok("the built page references a script and a stylesheet",
  refs.some((r) => r.endsWith(".js")) && refs.some((r) => r.endsWith(".css")), refs);
const unserved = refs.filter((r) => !routes.has(r));
ok("every file the built page references is served", unserved.length === 0, unserved);

const assets = readdirSync(join(out, "assets"));
ok("the build emits assets, a font among them", assets.some((a) => a.endsWith(".woff2")), assets);
const unservedAssets = assets.map((a) => `/assets/${a}`).filter((r) => !routes.has(r));
ok("every file in dist/web/assets is served", unservedAssets.length === 0, unservedAssets);

const urls: string[] = [];
for (const a of assets.filter((f) => f.endsWith(".css"))) {
  const css = readFileSync(join(out, "assets", a), "utf8");
  for (const m of css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)) if (!m[2].startsWith("data:")) urls.push(m[2]);
}
ok("the built CSS references files (the fonts)", urls.length > 0, urls);
const unservedUrls = urls.filter((u) => !routes.has(u));
ok("every url(...) in the built CSS is served", unservedUrls.length === 0, unservedUrls);
console.log(`registration-seam: ${refs.length} page references, ${assets.length} assets and ${urls.length} CSS urls, all served`);
