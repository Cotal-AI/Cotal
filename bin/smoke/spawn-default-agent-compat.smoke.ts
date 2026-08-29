/**
 * Detached spawn request compatibility with the closed 0.33.9 manager input schema.
 *
 * `invokeCommand` validates the in-memory request against the fetched manager schema before JSON
 * serialization. An own `defaultAgent: undefined` property is therefore observable and rejected by
 * a manager whose schema predates that field, even though JSON.stringify would omit it.
 *
 * Run: pnpm smoke:spawn-default-agent-compat
 */
import assert from "node:assert/strict";
import { assertArgsValid, compileContractSchema, type FlagValues } from "@cotal-ai/core";
import { detachedSpawnArgs, spawnFlags } from "@cotal-ai/cli";

const PRIOR_MANAGER_SPAWN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["name"],
  properties: {
    name: { type: "string", minLength: 1 },
    agent: { type: "string" },
    role: { type: "string" },
    config: { type: "string" },
    identity: { type: "string" },
    model: { type: "string" },
    variant: { type: "string" },
    launchOptions: { type: "object" },
    resume: { type: "string" },
    events: { type: "boolean" },
    cwd: { type: "string" },
    prompt: { type: "string" },
    subscribe: { type: "array", items: { type: "string" } },
    allowSubscribe: { type: "array", items: { type: "string" } },
    allowPublish: { type: "array", items: { type: "string" } },
    shareTools: { type: "string" },
  },
} as const;
const priorManagerSpawn = compileContractSchema({ root: PRIOR_MANAGER_SPAWN_SCHEMA });

const args = (agent: string | undefined, callerDefault: string | undefined) =>
  detachedSpawnArgs({ agent } as FlagValues<typeof spawnFlags>, "default", undefined, undefined, undefined, callerDefault);

const explicit = args("jcode", "claude");
assert.equal(explicit.agent, "jcode", "explicit --agent must remain the agent field");
assert.equal(Object.hasOwn(explicit, "defaultAgent"), false, "explicit --agent must omit the irrelevant caller default");
assert.doesNotThrow(
  () => assertArgsValid(priorManagerSpawn, explicit),
  "explicit --agent detached request must validate against the prior manager schema",
);

const unset = args(undefined, undefined);
assert.equal(Object.hasOwn(unset, "defaultAgent"), false, "an unset caller default must not create a defaultAgent own-property");
assert.doesNotThrow(
  () => assertArgsValid(priorManagerSpawn, unset),
  "detached request without a caller default must validate against the prior manager schema",
);

const callerDefault = args(undefined, "jcode");
assert.equal(callerDefault.defaultAgent, "jcode", "a non-empty caller default must remain defaultAgent");
assert.equal(Object.hasOwn(callerDefault, "agent"), false, "a caller default must not become an explicit agent override");

console.log("✓ detached spawn request omits irrelevant and undefined defaultAgent properties");
console.log("✓ explicit and no-default requests validate against the prior manager schema");
console.log("✓ a non-empty caller default remains distinct from the explicit agent field");
