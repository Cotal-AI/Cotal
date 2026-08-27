import assert from "node:assert/strict";
import { agentIdentity } from "../src/commands/agents.js";

let pass = 0;
let fail = 0;
const check = (name: string, actual: string, expected: string): void => {
  try {
    assert.equal(actual, expected, `${name}: ${JSON.stringify(actual)}`);
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    fail++;
    console.error(`  ✗ ${name}: ${(error as Error).message}`);
  }
};

check(
  "default ps identity includes the model and requested variant",
  agentIdentity({ agent: "jcode", model: "gpt-5.6-sol", variant: "high", mode: "pty" }),
  "jcode · gpt-5.6-sol (high) · pty",
);
check(
  "default ps identity keeps an omitted variant visibly absent",
  agentIdentity({ agent: "jcode", model: "opus-5", mode: "pty" }),
  "jcode · opus-5 · pty",
);
check(
  "default ps identity preserves a requested variant without a model",
  agentIdentity({ agent: "custom", variant: "low", mode: "pty" }),
  "custom · variant low · pty",
);
check(
  "default ps identity still supports rows with no model provenance",
  agentIdentity({ agent: "claude", mode: "tmux" }),
  "claude · tmux",
);

console.log(`\nPS PROVENANCE SMOKE PASSED (${pass} checks, ${fail} failed)`);
if (fail) process.exitCode = 1;
