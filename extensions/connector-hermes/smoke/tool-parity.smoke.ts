/**
 * Tool-parity test (no test runner) — the Hermes plugin must expose EXACTLY the shared cotal_*
 * surface, never a hand-drifted subset. The connector renders its tool descriptors from
 * {@link cotalToolSpecs} (connector-core); this asserts the rendered list matches that source and
 * that the artifact the plugin actually consumes (a JSON file) is well-formed.
 *   - same tool names, same order, as cotalToolSpecs;
 *   - every descriptor carries a JSON-Schema *object* for its parameters;
 *   - cotal_inbox has no params and pulls only quiet traffic, so it can't race automatic delivery;
 *   - the whole list round-trips through JSON (it's written to COTAL_TOOLS_FILE).
 * Run: pnpm --filter @cotal-ai/connector-hermes test
 */
import { strict as assert } from "node:assert";
import { configFromEnv, cotalToolSpecs } from "@cotal-ai/connector-core";
import { hermesToolDescriptors } from "../src/tool-schema.js";

process.env.COTAL_SPACE ||= "parity";
process.env.COTAL_NAME ||= "hermes-1";
process.env.COTAL_SERVERS ||= "nats://127.0.0.1:4222";

const config = configFromEnv();
const specNames = cotalToolSpecs(config, "hermes").map((s) => s.name);
const descriptors = hermesToolDescriptors(config);
const descNames = descriptors.map((d) => d.name);

assert.deepEqual(descNames, specNames, "hermes tool descriptors drifted from cotalToolSpecs");

const inbox = descriptors.find((d) => d.name === "cotal_inbox");
assert.ok(inbox, "cotal_inbox missing from the descriptors");
const inboxProps = (inbox!.parameters as { properties?: Record<string, unknown> }).properties ?? {};
assert.equal(Object.keys(inboxProps).length, 0, "cotal_inbox must expose no params on Hermes");

for (const d of descriptors) {
  assert.equal(
    (d.parameters as { type?: string }).type,
    "object",
    `${d.name} parameters are not a JSON-Schema object`,
  );
  JSON.parse(JSON.stringify(d)); // exactly what gets written to COTAL_TOOLS_FILE
}

console.log(`✓ hermes tool parity: ${descNames.length} tools match cotalToolSpecs`);
console.log(`  ${descNames.join(", ")}`);
