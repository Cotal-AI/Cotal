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
// `||=` KEEPS an already-set value, so this suite is loopback only where nothing set the
// variable. In any shell that already exports COTAL_SERVERS — an agent's, an operator's — it
// resolves to that instead, and an archived run gave no way to tell which. It names its target
// now: a suite that names its target cannot silently change it. Measured, and true today: this
// suite opens no TCP connection to the value at all (verified against a listener that counted
// zero accepts), so the line discloses a CONFIG input, not traffic. If that ever stops being
// true, this line is already where a reader would look.
// This file reaches CI by a DIFFERENT ROAD from its six siblings: it is not a `smoke:*` script
// and no root script names it, so an audit that sweeps the `smoke:ci` chain concludes it is
// unreachable. It runs through this package's own `test` script, which `pnpm -r --if-present
// test` picks up — the repo's `test` root, invoked by `check` and by CI's unit job. Gated, just
// not by the chain. Do not delete this pattern here on the grounds that the file looks dead.
const brokerFromEnv = process.env.COTAL_SERVERS !== undefined;
process.env.COTAL_SERVERS ||= "nats://127.0.0.1:4222";
console.log(`• broker: ${process.env.COTAL_SERVERS} (${brokerFromEnv ? "INHERITED from the environment" : "suite default"})`);

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
