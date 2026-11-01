/** The gateway's HTTP transport loads on the first POST, not with the module. Every case runs in its own child
 *  process and reads Node's `process.moduleLoadList` for undici, the internal HTTP client that Node loads when
 *  a web global such as `Request` is first read, through the test-only preload undici-observer.cjs or a fixture.
 *  Controls: a bare `global.Request` read loads it (the observer sees it), the real HTTP gateway entry serves a
 *  real SDK client and loads it on use, and the real feedback sender's `fetch` loads it on use against a
 *  private loopback server. No network beyond loopback, no mocks, forced GC, or timing/memory assertions. */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const here = (name: string): string => fileURLToPath(new URL(name, import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "lazy-http-"));
let checks = 0;
const check = (label: string, run: () => void): void => { run(); checks++; console.log(`✓ ${label}`); };
const observed = (out: string): string[] => (JSON.parse(readFileSync(out, "utf8")) as { undici: string[] }).undici;
const status = (port: number, path: string): Promise<{ code: number; body: string }> => new Promise((resolve, reject) => {
  get({ host: "127.0.0.1", port, path }, (res) => { let body = ""; res.on("data", (c: Buffer) => (body += c)); res.on("end", () => resolve({ code: res.statusCode ?? 0, body })); }).on("error", reject);
});

try {
  // ---- the observer sees undici when it loads ----
  const out = join(scratch, "control.json");
  const run = spawnSync(process.execPath, ["--require", here("undici-observer.cjs"), "-e", "void global.Request"], { env: { ...process.env, COTAL_SMOKE_UNDICI_OUT: out }, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  check("control: reading global.Request loads undici and the observer reports it", () => assert.ok(observed(out).length > 0));
  const bare = join(scratch, "bare.json");
  assert.equal(spawnSync(process.execPath, ["--require", here("undici-observer.cjs"), "-e", "0"], { env: { ...process.env, COTAL_SMOKE_UNDICI_OUT: bare } }).status, 0);
  check("control: a bare process loads no undici", () => assert.deepEqual(observed(bare), []));

  // ---- importing the gateway module loads no undici; GET answers 405 without it; the first POST serves and loads it ----
  const child = spawn(process.execPath, [here("lazy-http-gateway.fixture.mjs")], { stdio: ["ignore", "pipe", "inherit"] });
  try {
    const ready = await new Promise<{ port: number; undiciAtReady: number }>((resolve, reject) => {
      let line = "";
      child.stdout.on("data", (c: Buffer) => { line += c; if (line.includes("\n")) resolve(JSON.parse(line)); });
      child.on("exit", (code) => reject(new Error(`gateway fixture exited ${code}`)));
    });
    check("importing the built gateway module and starting its HTTP listener loads no undici", () => assert.equal(ready.undiciAtReady, 0));
    const refused = await status(ready.port, "/mcp");
    check("a GET gets the 405 answer and still loads no undici", () => { assert.equal(refused.code, 405); });
    assert.equal((await status(ready.port, "/__undici")).body, "0");
    const client = new Client({ name: "lazy-http-smoke", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${ready.port}/mcp`)));
    const tools = await client.listTools();
    await client.close();
    check("the real HTTP gateway entry serves a real SDK client (initialize, tools/list)", () => {
      assert.ok(tools.tools.length > 0);
      assert.ok(tools.tools.some((tool) => tool.name === "cotal_orientation"));
    });
    const after = Number((await status(ready.port, "/__undici")).body);
    check("serving over HTTP loads undici, as a genuine HTTP consumer expects", () => assert.ok(after > 0, `undici modules after the first POST: ${after}`));
  } finally { child.kill(); }

  // ---- real fetch-on-use ----
  const fetched = spawnSync(process.execPath, [here("lazy-fetch.fixture.mjs")], { encoding: "utf8" });
  assert.equal(fetched.status, 0, fetched.stderr);
  const result = JSON.parse(fetched.stdout.trim().split("\n").pop()!) as { before: number; after: number; text: string; isError: boolean };
  check("the real feedback sender: no undici before its fetch, undici after, and the call succeeds against a loopback server", () => {
    assert.equal(result.before, 0);
    assert.ok(result.after > 0);
    assert.equal(result.isError, false);
    assert.match(result.text, /Feedback sent \(id fixture-1\)/);
  });
  console.log(`lazy-http-transport: ${checks} checks passed`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
