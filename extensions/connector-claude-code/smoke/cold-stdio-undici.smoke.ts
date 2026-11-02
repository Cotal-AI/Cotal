/** A cold stdio seat child does not load Node's internal undici: the ACTUAL built seat, started the way the host
 *  starts it (stock node, public SDK client over stdio), is observed through initialize, listTools and a docs search.
 *  Observation is the test-only preload in connector-core/smoke/undici-observer.cjs; nothing is added to shipped code.
 *  Controls: the observer reports undici for a child that reads global.Request, and a bare child reports none.
 *  Run: pnpm exec tsx smoke/cold-stdio-undici.smoke.ts
 */
import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = dirname(fileURLToPath(import.meta.url));
const observer = join(here, "..", "..", "connector-core", "smoke", "undici-observer.cjs");
const seat = join(here, "..", "dist", "seat.cjs");
const flags = ["--optimize-for-size", "--max-semi-space-size=1"];
const scratch = mkdtempSync(join(tmpdir(), "cu-"));
const home = mkdtempSync(join(tmpdir(), "cu-home-"));
let checks = 0;
const check = (name: string, fn: () => void) => { fn(); checks += 1; console.log(`✓ ${name}`); };
const observed = (file: string) => (JSON.parse(readFileSync(file, "utf8")) as { undici: string[] }).undici;

try {
  // ---- controls: the observer can see undici, and a bare process has none ----
  const bareOut = join(scratch, "bare.json");
  spawnSync(process.execPath, [...flags, "--require", observer, "-e", "0"], { env: { PATH: process.env.PATH, COTAL_SMOKE_UNDICI_OUT: bareOut } });
  check("control: a bare stock child loads no undici", () => assert.deepEqual(observed(bareOut), []));
  const readOut = join(scratch, "read.json");
  spawnSync(process.execPath, [...flags, "--require", observer, "-e", "void global.Request"], { env: { PATH: process.env.PATH, COTAL_SMOKE_UNDICI_OUT: readOut } });
  check("control: a child that reads global.Request is reported with undici", () => assert.ok(observed(readOut).length > 0));

  // ---- the actual seat child ----
  const refusal = createServer((socket) => socket.destroy());
  refusal.listen(0, "127.0.0.1");
  await once(refusal, "listening");
  const seatOut = join(scratch, "seat.json");
  const client = new Client({ name: "cold-stdio-undici", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [...flags, "--require", observer, seat],
    cwd: home,
    env: {
      HOME: home, TMPDIR: home, PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", DO_NOT_TRACK: "1",
      COTAL_NAME: "cold_undici", COTAL_SPACE: "cold_undici", COTAL_SERVERS: `nats://127.0.0.1:${(refusal.address() as { port: number }).port}`,
      COTAL_CONTROL_SOCKET: join(home, "control.sock"), COTAL_CONTROL_TOKEN: randomBytes(32).toString("hex"), COTAL_WORKSPACE_ROOT: home, COTAL_CHANNEL: "0",
      COTAL_SMOKE_UNDICI_OUT: seatOut,
    },
    stderr: "ignore",
  });
  const closed = new Promise<void>((resolve) => { client.onclose = () => resolve(); });
  try {
    await client.connect(transport, { timeout: 15000 });
    const tools = await client.listTools(undefined, { timeout: 15000 });
    check("the seat child initializes and lists its tools", () => assert.ok(tools.tools.length > 0));
    const docs = await client.callTool({ name: "cotal_docs", arguments: { query: "channel permissions" } }, undefined, { timeout: 30000 });
    check("a cold docs search answers", () => assert.ok(((docs.content as { text?: string }[])[0]?.text ?? "").length > 0));
  } finally {
    await client.close().catch(() => {});
    await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 10000))]);
    await new Promise((resolve) => refusal.close(resolve));
  }
  for (let i = 0; i < 100; i += 1) { try { readFileSync(seatOut); break; } catch { await new Promise((resolve) => setTimeout(resolve, 100)); } }
  check("the seat child loaded no undici through initialize, listTools and a docs search", () => assert.deepEqual(observed(seatOut), []));
  console.log(`cold-stdio-undici: ${checks} checks passed`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
}
