// Rewrite every non-ASCII character in the given CJS bundles as a \uXXXX escape.
//
// Node loads a source file as a two-byte string when it holds ANY non-ASCII character, so a single
// `µ` (in @nats-io/jetstream's duration regex) and a few `§` in kept comments double the resident
// source text of mcp.cjs: 4.2MB on disk, 8.2MB in every session's MCP server for its lifetime.
// esbuild's `--charset=ascii` escapes strings and identifiers, not regex literals or comments.
// A \u escape is the same character in a string, template, regex or comment. It is NOT in a
// String.raw template, so a bundle that carries a non-ASCII character there is refused.
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function asciiOnly(src, file = "<bundle>") {
  for (const m of src.matchAll(/String\.raw`[^`]*`/g))
    if (/[^\x00-\x7f]/.test(m[0]))
      throw new Error(`${file}: non-ASCII inside String.raw, where escaping would change it: ${m[0].slice(0, 80)}`);
  // Per UTF-16 code unit, so a character outside the BMP becomes its surrogate pair of escapes.
  return src.replace(/[^\x00-\x7f]/g, (u) => `\\u${u.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  for (const file of process.argv.slice(2)) writeFileSync(file, asciiOnly(readFileSync(file, "utf8"), file));
