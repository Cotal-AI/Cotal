/** The server serves the client build through an allow-list read from the build directory, and
 *  a missing build is a loud 503, never a blank page or a directory walk. */
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clientAssets, CLIENT_NOT_BUILT } from "../src/web.js";

let n = 0;
const ok = (name: string, cond: unknown, detail?: unknown) => {
  assert.ok(cond, `${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
  console.log(`  ok ${++n} ${name}`);
};

const dir = mkdtempSync(join(tmpdir(), "cotal-web-client-"));
ok("an empty directory yields no routes", clientAssets(dir).size === 0);

writeFileSync(join(dir, "index.html"), "<!doctype html>");
mkdirSync(join(dir, "assets"));
writeFileSync(join(dir, "assets", "index-abc.js"), "");
writeFileSync(join(dir, "assets", "index-abc.css"), "");
writeFileSync(join(dir, "assets", "inter-latin.woff2"), "");
writeFileSync(join(dir, "assets", "notes.txt"), "");
mkdirSync(join(dir, "assets", "nested"));
writeFileSync(join(dir, "bundle-licenses.json"), "{}");

const routes = clientAssets(dir);
ok("/ serves index.html without caching", routes.get("/")?.path === join(dir, "index.html") && routes.get("/")?.immutable === false);
ok("/graph serves the same page, so old links still open the app", routes.get("/graph")?.path === join(dir, "index.html"));
ok("a hashed script is served as JavaScript and cached as immutable",
  routes.get("/assets/index-abc.js")?.type === "text/javascript; charset=utf-8" && routes.get("/assets/index-abc.js")?.immutable === true);
ok("a stylesheet is served as CSS", routes.get("/assets/index-abc.css")?.type === "text/css; charset=utf-8");
ok("the font is served as font/woff2", routes.get("/assets/inter-latin.woff2")?.type === "font/woff2");
ok("a file type the client does not use is not served", !routes.has("/assets/notes.txt"));
ok("a nested directory is not walked", ![...routes.keys()].some((k) => k.includes("nested")));
ok("files outside assets/ other than the page are not served", !routes.has("/bundle-licenses.json"));
ok("the not-built message names the build command", CLIENT_NOT_BUILT.includes("pnpm --filter @cotal-ai/web build"));
console.log(`client-serving: ${n} checks passed`);
