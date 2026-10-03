// Bundle the connector: dist/index.js (the ESM entry the CLI loads) and dist/mcp.cjs + dist/hook.cjs
// (the self-contained scripts a Claude session runs). Called by `pnpm run bundle`.
//
// The CJS bundles go through `asciiOnly`. Node loads a source file two bytes per character when it
// holds ANY non-ASCII character, and every managed session runs its own `node dist/mcp.cjs`. A single
// `µ` in @nats-io/jetstream's duration regex therefore made the 4.2MB bundle cost 8.2MB resident in
// every agent. esbuild already escapes strings and identifiers. It does not escape regex literals or
// kept comments, so the plugin escapes whatever is left in the output.
import { writeFileSync } from "node:fs";
import { build } from "esbuild";
import { isMainEntry } from "../../scripts/main-entry.mjs";

/** Escape every non-ASCII UTF-16 code unit as \uXXXX: the same character in a string, template,
 *  regex or comment, and a surrogate pair for a character outside the BMP. A String.raw template is
 *  the exception, since there an escape stays a literal backslash, so it is refused, not rewritten. */
export function asciiOnly(src, file = "<bundle>") {
  for (const m of src.matchAll(/String\.raw`[^`]*`/g))
    if (/[^\x00-\x7f]/.test(m[0]))
      throw new Error(`${file}: non-ASCII inside String.raw, where escaping would change it: ${m[0].slice(0, 80)}`);
  return src.replace(/[^\x00-\x7f]/g, (u) => `\\u${u.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** Requires `write: false`: rewrites each output file's text, then writes it. */
const asciiOnlyPlugin = {
  name: "ascii-only",
  setup(b) {
    b.onEnd((result) => {
      if (result.errors.length) return;
      for (const out of result.outputFiles ?? []) writeFileSync(out.path, asciiOnly(out.text, out.path));
    });
  },
};

// Legal comments stay (esbuild's default, gathered at the end of the file): the bundles ship
// third-party code, and the MIT notices travel with it. They are ASCII, and the plugin escapes
// anything that is not.
const common = { bundle: true, platform: "node", target: "node20", logLevel: "info" };

export async function bundle() {
  await build({ ...common, entryPoints: ["src/index.ts"], format: "esm", outfile: "dist/index.js", external: ["@cotal-ai/core"] });
  await build({
    ...common,
    entryPoints: ["src/mcp.ts", "src/hook.ts"],
    format: "cjs",
    outdir: "dist",
    outExtension: { ".js": ".cjs" },
    write: false,
    plugins: [asciiOnlyPlugin],
  });
}

if (isMainEntry(import.meta.url)) await bundle();
