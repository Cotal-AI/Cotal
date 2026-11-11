import strictAssert from "node:assert/strict";
import { countedAssert, emitSentinel } from "./sentinel.mjs";
const counted = countedAssert(strictAssert);
const assert: typeof strictAssert = counted.assert as typeof strictAssert;
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = mkdtempSync(join(tmpdir(), "autoupd-cache-"));
mkdirSync(join(root, "home"));
let requests = 0, failed = false;
const registry = createServer((_req, res) => { requests++; if (failed) res.writeHead(503).end("unavailable"); else res.end(JSON.stringify({ name: "cotal-ai", "dist-tags": { latest: "99.0.0" }, versions: { "99.0.0": { name: "cotal-ai", version: "99.0.0" } } })); });
await new Promise<void>(resolve => registry.listen(0, "127.0.0.1", resolve));
const address = registry.address();
if (!address || typeof address === "string") throw new Error("fixture address missing");
const env: NodeJS.ProcessEnv = { ...process.env, HOME: join(root, "home"), COTAL_HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"), npm_config_prefix: join(root, "prefix"), npm_config_cache: join(root, "cache"), npm_config_registry: `http://127.0.0.1:${address.port}` };
delete env.COTAL_NO_UPDATE_CHECK;
async function check(extra: NodeJS.ProcessEnv = {}) {
 const child = spawn(process.execPath, [fileURLToPath(new URL("../dist/cotal.js", import.meta.url)), "__update-check"], { env: { ...env, ...extra }, cwd: root, stdio: ["ignore", "pipe", "pipe"] });
 let output = ""; child.stdout.on("data", c => output += c); child.stderr.on("data", c => output += c);
 const code = await new Promise(resolve => child.once("exit", resolve));
 assert.equal(code, 0); assert.equal(output, "");
}
try {
 await check(); assert.ok(requests > 0); const initial = requests;
 await check(); assert.equal(requests, initial);
 const file = join(root, "home/update-check.json");
 const cached = JSON.parse(readFileSync(file, "utf8"));
 writeFileSync(file, JSON.stringify({ ...cached, checkedAt: Date.now() - 86401_000, attemptedAt: Date.now() - 86401_000 }));
 failed = true; await check(); assert.ok(requests > initial);
 const after = requests; await check(); assert.equal(requests, after);
 await check({ COTAL_NO_UPDATE_CHECK: "1" }); assert.equal(requests, after);
 emitSentinel({ passed: counted.cells(), failed: 0 });
} finally { await new Promise<void>(resolve => registry.close(() => resolve())); }
