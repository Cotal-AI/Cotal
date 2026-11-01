import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checkMcpDocsStamp } from "./check-mcp-docs-stamp.mjs";

let checks = 0;
const version = "1.2.3";
for (const source of ['var DOCS_VERSION="1.2.3";', 'var other=0,DOCS_VERSION="1.2.3";']) {
  checkMcpDocsStamp(source, version);
  checks++;
}
for (const source of [
  'var data={"version":"1.2.3"};',
  'var text=\'var DOCS_VERSION="1.2.3";\';',
  'var DOCS_VERSION="1.2.2";',
  'var DOCS_VERSION="1.2.3",DOCS_VERSION="1.2.3";',
  'var DOCS_VERSION=getVersion();',
  'var DOCS_VERSION="1.2.3"; function {',
]) {
  assert.throws(() => checkMcpDocsStamp(source, version), /was not built at/);
  checks++;
}
const root = new URL("../", import.meta.url);
const built = readFileSync(fileURLToPath(new URL("extensions/connector-claude-code/dist/mcp.cjs", root)), "utf8");
const installed = JSON.parse(readFileSync(new URL("bin/package.json", root), "utf8")).version;
checkMcpDocsStamp(built, installed);
checks++;
assert.throws(() => checkMcpDocsStamp(built, `${installed}-stale-control`), /was not built at/);
checks++;
console.log(`MCP docs stamp: ${checks}/${checks} checks passed`);
