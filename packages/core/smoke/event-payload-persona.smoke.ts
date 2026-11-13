import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { delegatedSeatCommand } from "../src/runtime.js";
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
  const delegated = (eventPayloads: boolean | undefined) => delegatedSeatCommand(
    { agent: "jcode", persona: "", managerInstanceId: "a".repeat(26), eventPayloads },
    { space: "payload", owner: "owner", actor: "actor", lifecycleUid: "life1" },
    { handoff: "/private/handoff", persona: "/private/persona" },
  );
  assert.equal(delegated(false).args.includes("--no-event-payloads"), true);
  assert.equal(delegated(true).args.includes("--no-event-payloads"), false);
  assert.equal(delegated(undefined).args.includes("--no-event-payloads"), false);
  console.log("PASS strict persona payload preference roundtrip and delegated command");
} finally {
  rmSync(root, { recursive: true, force: true });
}
