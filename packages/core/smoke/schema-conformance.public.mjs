import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compileContract, isCompiledContract, assertArgsValid, assertOutputValid, ContractInvalidError, EpEnvelopeError, contractDigest } from '@cotal-ai/core';

const corpus = JSON.parse(readFileSync(new URL('./schema-remaining15-diagnostic.cells.json', import.meta.url)));
let checks = 0;
function check(actual, expected, name) {
  assert.equal(actual, expected, name);
  checks++;
}
const minimal = compileContract({ root: { contains: { type: 'string' }, unevaluatedItems: false } });
check(isCompiledContract(minimal), true, 'public brand');
for (const [value, expected] of [[['x'], true], [[1], false], [[1, 'x'], false]])
  check(minimal.validate(value), expected, `minimal ${JSON.stringify(value)}`);
for (const row of corpus.independent33) {
  const before = JSON.stringify(row.schema);
  const compiled = compileContract({ root: row.schema });
  check(compiled.validate(row.value), row.expected, row.id);
  check(JSON.stringify(row.schema), before, `${row.id} schema unchanged`);
}
const witness = corpus.closedPointer;
const before = JSON.stringify(witness.bundle);
const pointer = compileContract(witness.bundle);
for (let i = 0; i < witness.values.length; i++) check(pointer.validate(witness.values[i]), witness.expected[i], `closed pointer ${i}`);
check(JSON.stringify(witness.bundle), before, 'authored ID and retrieval alias unchanged');
const member = { $id: 'https://closed.invalid/anchor', $defs: { s: { $anchor: 'text', type: 'string' } } };
const digest = contractDigest(member);
const anchor = compileContract({ root: { $ref: `cotal:${digest}#text` }, members: { [digest]: member } });
check(anchor.validate('x'), true, 'closed anchor positive');
check(anchor.validate(1), false, 'closed anchor negative');
for (const member of [true, false]) {
  const digest = contractDigest(member);
  const compiled = compileContract({ root: { $ref: `cotal:${digest}` }, members: { [digest]: member } });
  check(compiled.validate(null), member, `boolean member ${member}`);
}
const leaf = { $id: 'urn:closed:leaf', type: 'integer' };
const leafDigest = contractDigest(leaf);
const parent = { $id: 'urn:closed:parent', properties: { x: { $ref: `cotal:${leafDigest}` } } };
const parentDigest = contractDigest(parent);
const chain = compileContract({ root: { $ref: `cotal:${parentDigest}` }, members: { [parentDigest]: parent, [leafDigest]: leaf } });
check(chain.validate({ x: 1 }), true, 'cross-member positive');
check(chain.validate({ x: 'bad' }), false, 'cross-member negative');
const prototype = compileContract({ root: JSON.parse('{"properties":{"__proto__":{"type":"number"}}}') });
check(prototype.validate(JSON.parse('{"__proto__":"bad"}')), false, 'own __proto__ assertion');
check(prototype.validate(JSON.parse('{"__proto__":1}')), true, 'own __proto__ positive');
const escaped = compileContract({ root: { type: 'object', properties: { 'a/b~c': { type: 'object', additionalProperties: false } } } });
const value = { 'a/b~c': { 'x/y~z': 1 } };
check(escaped.validate(value), false, 'escaped property invalid');
check(escaped.validate.errors[0].instancePath, '/a~1b~0c/x~1y~0z', 'escaped instance path');
check(escaped.validate.errors[0].additionalProperty, 'x/y~z', 'original rejected key');
check(escaped.validate.errors[0].code, 'no-additional-properties-error', 'honest engine error code');
for (const [invoke, code] of [[() => assertArgsValid(escaped.validate, value), 'bad-request'], [() => assertOutputValid(escaped.validate, value), 'internal']]) {
  assert.throws(invoke, error => error instanceof EpEnvelopeError && error.code === code && error.message.includes('"x/y~z"'));
  checks++;
}
check(escaped.validate({ 'a/b~c': {} }), true, 'valid call clears errors');
check(escaped.validate.errors, null, 'errors cleared');
for (const root of [{ $ref: '#/missing' }, { $dynamicRef: '#/missing' }, { $defs: { bad: { $ref: '#/missing' } } }]) {
  assert.throws(() => compileContract({ root }), ContractInvalidError);
  checks++;
}
console.log(`schema-conformance.public: ${checks} checks passed`);
