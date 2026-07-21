// Copy the browser builds of marked + DOMPurify into dist/web/vendor, so the dashboard serves them
// from its OWN published files (`files: ["dist"]`) instead of resolving node_modules at runtime. This
// is what makes @cotal-ai/web a self-contained, dependency-free payload that the seed reconcile can
// bundle + stage exactly like a first-party connector (marked/dompurify stay devDependencies: needed
// here at build, never at runtime). Run AFTER `cp -R src/web dist/web`. Fails loud if a source is
// missing, so a broken build can never ship a dashboard that 404s its markdown libs.
import { createRequire } from "node:module";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require_ = createRequire(import.meta.url);
const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "web", "vendor");
mkdirSync(outDir, { recursive: true });

// marked exports only its ESM entry, so reach the sibling UMD build; DOMPurify exports the minified
// browser bundle directly.
const sources = {
  "marked.umd.js": join(dirname(require_.resolve("marked")), "marked.umd.js"),
  "purify.min.js": require_.resolve("dompurify/dist/purify.min.js"),
};
for (const [name, src] of Object.entries(sources)) {
  copyFileSync(src, join(outDir, name));
  console.log(`dist/web/vendor/${name}  <-  ${src}`);
}
