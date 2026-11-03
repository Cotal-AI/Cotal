/** Check the source and shipped stdio bridge through real MCP initialize, without a host relay. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { configFromEnv, DOCS_VERSION } from "@cotal-ai/connector-core";

const root = mkdtempSync(join(tmpdir(), "mcp-version-"));
const config = configFromEnv({ COTAL_NAME: "version-fixture", COTAL_SPACE: "versionfixture", COTAL_SERVERS: "nats://127.0.0.1:1" });
let checked = 0;
let failed = 0;
const check = (name: string, value: unknown, expected: unknown) => {
  checked++;
  try { assert.deepEqual(value, expected); console.log(`ok ${name}`); }
  catch { failed++; console.log(`FAIL ${name}: ${JSON.stringify({ value, expected })}`); }
};
try {
  for (const entry of ["../src/mcp-main.ts", "../dist/mcp.js"]) {
    const client = new Client({ name: "version-fixture", version: "1" });
    try {
      await client.connect(new StdioClientTransport({
        command: process.execPath,
        args: [...(entry.endsWith(".ts") ? ["--import", import.meta.resolve("tsx")] : []), fileURLToPath(new URL(entry, import.meta.url))],
        cwd: root,
        env: { ...(process.env.PATH ? { PATH: process.env.PATH } : {}), HOME: root, TMPDIR: root,
          COTAL_JCODE_MCP_CONFIG: JSON.stringify(config) },
        stderr: "pipe",
      }));
      check(`${entry}: loaded release in serverInfo`, client.getServerVersion(), { name: "cotal", version: DOCS_VERSION });
      check(`${entry}: orientation remains discoverable`, (await client.listTools()).tools.some(tool => tool.name === "cotal_orientation"), true);
    } finally { await client.close(); }
  }
} finally { rmSync(root, { recursive: true, force: true }); }
assert.equal(checked, 4);
console.log(`JCODE MCP VERSION: ${checked - failed}/${checked} passed`);
process.exitCode = failed ? 1 : 0;
