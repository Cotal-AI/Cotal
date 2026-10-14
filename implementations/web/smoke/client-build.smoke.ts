/** The client build is the shipped page: it must exist after `build`, reference only files it
 *  contains, and name every third-party package it bundles with that package's license. */
import { strict as assert } from "node:assert";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
console.log(`client-build: ${n} checks passed`);
