import assert from "node:assert/strict";
import { agentIdentity, agentWideFacts } from "../src/commands/agents.js";
import { modelVariantsLine } from "../src/commands/models.js";

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
check(
  "wide facts do not repeat model or requested variant from the identity row",
  agentWideFacts({
    cwd: "/workspace",
    pid: 42,
    spawner: "owner",
    lifecycleUid: "life",
    instanceId: "instance",
    host: "host",
  }).join(" | "),
  "cwd /workspace | pid 42 | spawner owner | uid life | instance instance | host host",
);
check(
  "declared Jcode caveat appears where variants print",
  modelVariantsLine({
    id: "model",
    variants: ["low", "high"].map((name) => ({
      name,
      options: {
        provenance: "declared-config",
        authoritative: false,
        warning: "declared by Jcode config; provider acceptance is validated only at launch",
      },
    })),
  }, 5) ?? "",
  "         variants (declared, not provider-verified): low, high",
);
check(
  "ordinary connector variants keep the ordinary label",
  modelVariantsLine({ id: "model", variants: [{ name: "fast" }] }, 5) ?? "",
  "         variants: fast",
);

console.log(`\nPS PROVENANCE SMOKE PASSED: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
