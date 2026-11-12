import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAgentFile, saveAgentFile } from "../src/agent-file.js";
const root = mkdtempSync(join(tmpdir(), "payload-persona-"));
try {
  const file = join(root, "probe.md");
  for (const eventPayloads of [false, true, undefined]) {
    saveAgentFile(file, { name: "probe", subscribe: [], eventPayloads });
    assert.equal(loadAgentFile(file).eventPayloads, eventPayloads);
  }
  writeFileSync(file, '---\nname: probe\nsubscribe: []\neventPayloads: "false"\n---\n');
  assert.throws(() => loadAgentFile(file), /eventPayloads.*boolean/);
  console.log("PASS strict persona payload preference roundtrip");
} finally {
  rmSync(root, { recursive: true, force: true });
}
