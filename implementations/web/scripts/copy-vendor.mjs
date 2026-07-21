// Copy the browser builds of marked + DOMPurify into dist/web/vendor, so the dashboard serves them
// from its OWN published files (`files: ["dist"]`) instead of resolving node_modules at runtime. This
// is what makes @cotal-ai/web a self-contained, dependency-free payload that the seed reconcile can
// bundle + stage exactly like a first-party connector (marked/dompurify stay devDependencies: needed
// here at build, never at runtime). Run AFTER `cp -R src/web dist/web`. Fails loud if a source is
// missing, so a broken build can never ship a dashboard that 404s its markdown libs.
//
// It also emits `vendor-manifest.json` next to the copied files: the exact name, version, license and
// sha512 of every vendored browser lib. Because these ship as opaque bytes in `dist` (not as runtime
// deps), that manifest is the auditable inventory an SBOM / advisory check consumes to know precisely
// what shipped; the seed-tarball smoke gates it (each sha512 must match the shipped file).
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require_ = createRequire(import.meta.url);
const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "web", "vendor");
mkdirSync(outDir, { recursive: true });

// A package's own `package.json` is often NOT exported (an `exports` map with no `./package.json`), so
// resolve it by walking up from the vendored file to the package root whose name matches.
function readPkgMeta(fromFile, pkg) {
  let dir = dirname(fromFile);
  for (;;) {
    const pj = join(dir, "package.json");
    if (existsSync(pj)) {
      const meta = JSON.parse(readFileSync(pj, "utf8"));
      if (meta.name === pkg) return meta;
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`could not locate ${pkg}'s package.json above ${fromFile}`);
    dir = parent;
  }
}

// marked exports only its ESM entry, so reach the sibling UMD build; DOMPurify exports the minified
// browser bundle directly.
const sources = {
  "marked.umd.js": { pkg: "marked", src: join(dirname(require_.resolve("marked")), "marked.umd.js") },
  "purify.min.js": { pkg: "dompurify", src: require_.resolve("dompurify/dist/purify.min.js") },
};

const entries = [];
for (const [name, { pkg, src }] of Object.entries(sources)) {
  const bytes = readFileSync(src);
  copyFileSync(src, join(outDir, name));
  const meta = readPkgMeta(src, pkg);
  if (!meta.version || !meta.license) {
    throw new Error(`vendored lib ${pkg} is missing a version or license in its package.json - cannot emit a complete vendor manifest`);
  }
  entries.push({
    file: name,
    package: pkg,
    version: meta.version,
    license: meta.license,
    sha512: createHash("sha512").update(bytes).digest("hex"),
  });
  console.log(`dist/web/vendor/${name}  <-  ${src}`);
}

writeFileSync(join(outDir, "vendor-manifest.json"), `${JSON.stringify({ vendored: entries }, null, 2)}\n`);
console.log(`dist/web/vendor/vendor-manifest.json  (${entries.length} libs)`);
