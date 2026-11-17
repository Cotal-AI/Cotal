/** #3949: observe real Ajv meta compilation while driving the public contract compiler. */
import assert from "node:assert/strict";
import { Ajv2020 } from "ajv/dist/2020.js";
import { compileContract, ContractInvalidError, isCompiledContract } from "../src/schema-profile.js";
import { contractDigest } from "../src/canonical.js";

let checks = 0;
function check(name: string, condition: boolean): void {
  assert.ok(condition, name);
  checks++;
  console.log(`  ✓ ${name}`);
}

// A forwarding-only observer, not a replacement compiler. The positive control binds the count
// to the installed Ajv; a missing or renamed hook fails rather than reporting zero work.
const proto = Ajv2020.prototype as unknown as { _compileMetaSchema: (schema: unknown) => void };
const original = proto._compileMetaSchema;
check("installed Ajv exposes the observed meta-compile boundary", typeof original === "function");
let metaCompiles = 0;
proto._compileMetaSchema = function (schema: unknown): void {
  metaCompiles++;
  return original.call(this, schema);
};
try {
  new Ajv2020({ strict: false, allErrors: true, inlineRefs: false }).compile({ type: "string" });
  check("a fresh native Ajv compiles the built-in meta-schema once", metaCompiles === 1);
  metaCompiles = 0;
  const earlier = [];
  for (let i = 0; i < 20; i++) {
    const compiled = compileContract({ root: { $id: "urn:fixture:meta-cache-test", type: "integer", minimum: i } });
    check(`closure ${i} is branded and enforces its own bound`, isCompiledContract(compiled)
      && compiled.validate(i) === true && compiled.validate(i - 1) === false);
    earlier.push(compiled);
  }
  check("twenty independent closures compile the built-in meta-schema at most once", metaCompiles <= 1);
  check("a later same-ID closure cannot change an earlier validator", earlier[0].validate(0) === true
    && earlier[19].validate(0) === false);
} finally {
  proto._compileMetaSchema = original;
}

const meta = { $id: "urn:fixture:closure-meta-test", type: "object", properties: { type: { const: "string" } } };
const digest = contractDigest(meta);
const bundle = (type: string) => ({
  root: { $schema: meta.$id, type, $defs: { meta: { $ref: `cotal:${digest}` } } },
  members: { [digest]: meta },
});
const custom = compileContract(bundle("string"));
check("a closure-local meta-schema validates on its own instance", custom.validate("yes") === true && custom.validate(1) === false);
assert.throws(() => compileContract(bundle("number")), (error: unknown) =>
  error instanceof ContractInvalidError && error.message.includes("schema is invalid: data/type must be equal to constant"));
checks++;
assert.throws(() => compileContract({ root: { $schema: meta.$id, type: "string" } }), (error: unknown) =>
  error instanceof ContractInvalidError && error.message.includes("no schema with key or ref"));
checks++;
check("a failed custom meta-validation does not poison the next closure", compileContract({ root: { type: "string" } }).validate("yes") === true);
assert.equal(checks, 28, "all meta-cache checks ran");
console.log(`schema-meta-cache.smoke: ${checks} checks passed`);
