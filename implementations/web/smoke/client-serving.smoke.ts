/** The server serves the client build through an allow-list read from the build directory, and
 *  a missing build is a loud 503, never a blank page or a directory walk. */
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clientAssets, clientResponse, CLIENT_NOT_BUILT } from "../src/web.js";

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
const built = clientResponse(routes, "/");
ok("a built map gives 200 for / and for a hashed asset",
  built.status === 200 && clientResponse(routes, "/assets/index-abc.js").status === 200);
const none = clientAssets(mkdtempSync(join(tmpdir(), "cotal-web-client-empty-")));
const emptyPage = clientResponse(none, "/");
const emptyGraph = clientResponse(none, "/graph");
ok("an empty map gives 503 with the not-built message for / and /graph",
  emptyPage.status === 503 && emptyPage.body.error === CLIENT_NOT_BUILT && emptyGraph.status === 503 && emptyGraph.body.error === CLIENT_NOT_BUILT);
// What the 503 says, read off the answer itself. Two readers meet it: a source checkout that has
// not built the page, and an installed package, which always ships its page, so for it the install
// is broken.
const said = emptyPage.status === 503 ? emptyPage.body.error : "";
ok("the not-built message names the build command", said.includes("pnpm --filter @cotal-ai/web build"), said);
ok("the not-built message tells an installed package it is a broken install and how to reinstall it",
  said.includes("broken install") && said.includes("`cotal ext seed --force`"), said);
ok("an empty map gives 404 for /assets/x.js", clientResponse(none, "/assets/x.js").status === 404);
ok("a built map gives 404 for an unknown path", clientResponse(routes, "/nope").status === 404);
console.log(`client-serving: ${n} checks passed`);
