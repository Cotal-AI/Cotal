/** Round-trip + safety proof for the yaml-backed agent-file parser (launchOptions map support). */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAgentFile, saveAgentFile, type AgentDef } from "../src/agent-file.js";

let pass = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) throw new Error(`FAIL: ${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};
const dir = mkdtempSync(join(tmpdir(), "agentfile-yaml-"));

// 1) Full round-trip incl. a nested launchOptions map and tricky scalar values.
const def: AgentDef = {
  name: "builder",
  role: "builder",
  description: "handles: config, deploy # careful",      // colon + hash — the old parser would misread
  tags: ["edit", "test"],
  subscribe: ["general", "ops"],
  allowSubscribe: ["general", "ops"],
  allowPublish: ["ops"],
  model: "opus",
  variant: "high",
  launchOptions: { temperature: "0.2", reasoning: "high", verbose: true, retries: 3 },
  capabilities: ["spawn"],
  meta: { theme: "dark" },
  persona: "You build things.",
};
const p = join(dir, "builder.md");
saveAgentFile(p, def);
const back = loadAgentFile(p);
ok("round-trips name/role/model/variant", back.name === "builder" && back.role === "builder" && back.model === "opus" && back.variant === "high");
ok("round-trips tricky description with : and #", back.description === "handles: config, deploy # careful", back.description);
ok("round-trips list fields", JSON.stringify(back.subscribe) === JSON.stringify(["general", "ops"]) && JSON.stringify(back.allowPublish) === JSON.stringify(["ops"]));
ok("round-trips launchOptions map (typed values preserved)", JSON.stringify(back.launchOptions) === JSON.stringify({ temperature: "0.2", reasoning: "high", verbose: true, retries: 3 }), back.launchOptions);
ok("round-trips meta + persona + capabilities", back.meta?.theme === "dark" && back.persona === "You build things." && JSON.stringify(back.capabilities) === JSON.stringify(["spawn"]));

// 2) Block-style lists + nested launchOptions parse (impossible for the old subset parser).
writeFileSync(join(dir, "blk.md"), [
  "---",
  "name: blocky",
  "subscribe:",
  "  - general",
  "  - team",
  "launchOptions:",
  "  model-args: --fast",
  "  depth: 4",
  "---",
  "body",
].join("\n"));
const blk = loadAgentFile(join(dir, "blk.md"));
ok("block-style list parses", JSON.stringify(blk.subscribe) === JSON.stringify(["general", "team"]), blk.subscribe);
ok("block-style launchOptions map parses", JSON.stringify(blk.launchOptions) === JSON.stringify({ "model-args": "--fast", depth: 4 }), blk.launchOptions);

// 3) Fail-loud cases.
const throws = (name: string, body: string) => {
  writeFileSync(join(dir, "bad.md"), body);
  let threw = false;
  try { loadAgentFile(join(dir, "bad.md")); } catch { threw = true; }
  ok(name, threw);
};
throws("launchOptions as scalar throws", "---\nname: x\nlaunchOptions: nope\n---\n");
throws("launchOptions as sequence throws", "---\nname: x\nlaunchOptions:\n  - a\n---\n");
throws("renamed field 'channels' still fails loud", "---\nname: x\nchannels: [general]\n---\n");
throws("malformed YAML fails loud", "---\nname: x\n  bad: : indent\n\t- weird\n---\n");

console.log(`\nagent-file yaml smoke: ${pass} checks passed`);
