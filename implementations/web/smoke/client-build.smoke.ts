/** The client build is the shipped page: it must exist after `build`, reference only files it
 *  contains, and name every third-party package it bundles with that package's license. */
import { strict as assert } from "node:assert";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import config from "../client/vite.config.js";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(pkg, "dist", "web");
let n = 0;
const ok = (name: string, cond: unknown, detail?: unknown) => {
  assert.ok(cond, `${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
  console.log(`  ok ${++n} ${name}`);
};

ok("the build wrote dist/web/index.html", existsSync(join(out, "index.html")));
const html = readFileSync(join(out, "index.html"), "utf8");
const refs = [...html.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map((m) => m[1]);
ok("the page references at least one script and one stylesheet",
  refs.some((r) => r.endsWith(".js")) && refs.some((r) => r.endsWith(".css")), refs);
for (const r of refs) ok(`the page's reference ${r} is a file in the build`, existsSync(join(out, r)));
ok("every asset sits under /assets/", refs.every((r) => r.startsWith("/assets/")), refs);
ok("the page loads no script from another origin", !/src="https?:/.test(html));

const licenses = JSON.parse(readFileSync(join(out, "bundle-licenses.json"), "utf8")) as {
  bundled: { package: string; version: string; license: string }[];
};
const names = licenses.bundled.map((b) => b.package);
for (const want of ["react", "react-dom", "@fontsource-variable/inter"])
  ok(`bundle-licenses.json names ${want}`, names.includes(want), names);
ok("every bundled package carries a version and a license",
  licenses.bundled.every((b) => b.version && b.license), licenses.bundled);
ok("bundle-licenses.json is sorted by package", names.join() === [...names].sort().join());

const assets = readdirSync(join(out, "assets"));
ok("the font ships as a local woff2 file", assets.some((a) => a.endsWith(".woff2")), assets);
// The manifest's writer, driven directly. The cells above read what one build wrote; these load the
// build config itself and hand its plugin a chunk, so the rule "a bundled module names its package"
// is checked on a known input as well as on whatever the last build happened to bundle.
type Emitted = { fileName: string; source: string };
type LicensesPlugin = { name?: string; generateBundle?: (this: { emitFile(f: Emitted): void }, o: unknown, b: unknown) => void };
const plugins = ((config.plugins ?? []) as unknown[]).flat(3) as LicensesPlugin[];
const licensesPlugin = plugins.find((p) => p?.name === "cotal-bundle-licenses");
ok("the build config carries the bundle-licenses plugin", typeof licensesPlugin?.generateBundle === "function");
const reactEntry = createRequire(join(pkg, "package.json")).resolve("react");
const reactMeta = JSON.parse(readFileSync(join(dirname(reactEntry), "package.json"), "utf8")) as { version: string; license: string };
let emitted: Emitted | undefined;
licensesPlugin!.generateBundle!.call({ emitFile: (f) => { emitted = f; } }, {}, { "index.js": { type: "chunk", moduleIds: [reactEntry] } });
const driven = emitted ? (JSON.parse(emitted.source) as { bundled: { package: string; version: string; license: string }[] }).bundled : [];
ok("given a chunk holding react, the plugin writes bundle-licenses.json naming react with its own version and license",
  emitted?.fileName === "bundle-licenses.json" && driven.length === 1 && driven[0].package === "react"
    && driven[0].version === reactMeta.version && driven[0].license === reactMeta.license, { emitted: emitted?.fileName, driven });
console.log(`client-build: ${n} checks passed`);
