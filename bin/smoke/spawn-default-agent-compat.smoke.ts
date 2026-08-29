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
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { assertArgsValid, compileContractSchema, type FlagValues } from "@cotal-ai/core";
import { detachedSpawnArgs, spawnFlags } from "../../implementations/cli/src/commands/spawn.ts";

const PRE_DEFAULT_AGENT_CONTRACT_COMMIT = "d643dd56c9196fcfaf784b080bbd3f23475803ce";
const PRE_DEFAULT_AGENT_SCHEMA_SHA256 = "058b983b443b750aa31ab0f7f9dea5ddd6d761da21c6b8d869c9b59eba5a9ccc";

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

// Positive-control the frozen fixture against the repository's actual manager contract immediately
// before defaultAgent was introduced. CI checks out full history, so a missing object is a failure.
const historicalSource = execFileSync(
  "git",
  ["show", `${PRE_DEFAULT_AGENT_CONTRACT_COMMIT}:implementations/manager/src/manager-service-contract.ts`],
  { encoding: "utf8", cwd: new URL("../..", import.meta.url) },
);
const historicalBlock = historicalSource.match(/const SPAWN_INPUT_SCHEMA = \{[\s\S]*?\n\} as const;/)?.[0];
assert.ok(historicalBlock, "the pre-defaultAgent manager spawn schema block must be present in git history");
assert.equal(
  createHash("sha256").update(historicalBlock).digest("hex"),
  PRE_DEFAULT_AGENT_SCHEMA_SHA256,
  "the frozen prior-manager fixture must remain bound to the actual pre-defaultAgent contract bytes",
);
const historicalProperties = [...historicalBlock.matchAll(/^    ([A-Za-z][A-Za-z0-9]*): \{/gm)].map((match) => match[1]);
assert.deepEqual(
  Object.keys(PRIOR_MANAGER_SPAWN_SCHEMA.properties),
  historicalProperties,
  "the frozen prior-manager property set must match the actual pre-defaultAgent contract",
);
const historicalSchema = Function(`"use strict"; return (${historicalBlock
  .replace(/^const SPAWN_INPUT_SCHEMA = /, "")
  .replace(/ as const;$/, "")})`)() as unknown;
assert.deepEqual(
  PRIOR_MANAGER_SPAWN_SCHEMA,
  historicalSchema,
  "the frozen prior-manager schema must equal the actual pre-defaultAgent manager contract",
);
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

console.log("✓ frozen prior-manager schema matches the actual pre-defaultAgent contract");
console.log("✓ detached spawn request omits irrelevant and undefined defaultAgent properties");
console.log("✓ explicit and no-default requests validate against the prior manager schema");
console.log("✓ a non-empty caller default remains distinct from the explicit agent field");
