import assert from "node:assert/strict";
import { HarnessError } from "@1jehuang/jcode-sdk";
import { JcodeEffortRefusal, JcodeEffortUnsupported, jcodeEffortRefusal } from "../src/startup-diagnostics.js";

let pass = 0;
const check = (name: string, condition: boolean): void => {
  assert.ok(condition, name);
  pass++;
  console.log(`  ✓ ${name}`);
};

const identity = { model: "model", provider: "profile", apiMethod: "openai-compatible:profile" };
const exactCapability = new HarnessError(
  "invalid_request",
  "Reasoning effort is not supported by the current model/profile. It works for OpenRouter, DeepSeek-family and GPT-family reasoning models, and profiles with supports_reasoning_effort = true.",
);
check("the exact Harness invalid_request capability refusal is classified separately", jcodeEffortRefusal(exactCapability, "high", identity) instanceof JcodeEffortUnsupported);

check("a plain Error with copied capability text stays a generic refusal", jcodeEffortRefusal(new Error(exactCapability.message), "high", identity) instanceof JcodeEffortRefusal);
check("a different Harness code with copied capability text stays a generic refusal", jcodeEffortRefusal(new HarnessError("internal", exactCapability.message.replace(/^invalid_request: /, "")), "high", identity) instanceof JcodeEffortRefusal);
check("a near-miss invalid_request message stays a generic refusal", jcodeEffortRefusal(new HarnessError("invalid_request", "Reasoning effort is not supported by this route."), "high", identity) instanceof JcodeEffortRefusal);

console.log(`JCODE EFFORT CONTRACT PASSED (${pass} checks)`);
