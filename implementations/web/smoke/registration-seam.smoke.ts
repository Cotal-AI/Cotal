/** Every file the built page references is a route the server serves, so a build that renames an
 *  asset can never leave the page pointing at a 404. Runs against the real build. */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { clientAssets } from "../src/web.js";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "web");
const routes = clientAssets(out);
const html = readFileSync(join(out, "index.html"), "utf8");
const refs = [...html.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map((m) => m[1]);
assert.ok(refs.length > 0, "the built page references no files");
for (const r of refs) assert.ok(routes.has(r), `the built page references ${r}, which the server does not serve`);
console.log(`registration-seam: ${refs.length} references, all served`);
