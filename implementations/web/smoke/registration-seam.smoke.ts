/** Every file the built page references is a route the server serves, so a build that renames an
 *  asset can never leave the page pointing at a 404. Runs against the real build. */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
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
console.log(`registration-seam: ${refs.length} references, all served`);
