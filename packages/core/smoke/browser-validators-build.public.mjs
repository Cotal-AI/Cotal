// Run only after building the actual package: node packages/core/smoke/browser-validators-build.public.mjs
// Public entries only. Schema data that reads like code must generate a browser validator that
// agrees with the runtime compiler; actual residual require, eval or Function code must still refuse.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compileContract, singleDocumentClosure } from '@cotal-ai/core';
import { generateBrowserContracts } from '@cotal-ai/core/browser-validators-build';

const coreRequire = createRequire(fileURLToPath(import.meta.resolve('@cotal-ai/core')));
const results = [];
function check(name, actual, expected) {
  const passed = Object.is(actual, expected);
  results.push(passed);
  console.log(`  ${passed ? '✓' : '✗'} ${name}${passed ? '' : ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
}

const objectOf = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
function sources(root) {
  const output = { type: 'null' };
  const inputDigest = singleDocumentClosure(root).closureDigest;
  const outputDigest = singleDocumentClosure(output).closureDigest;
  const document = { urn: 'com.example.literal', revision: 1, attributes: [], events: [],
    commands: [{ name: 'echo', class: 'ephemeral', targeted: false, capability: 'literal.read', inputDigest, outputDigest }] };
  return [{ label: 'literal', clusterDigest: singleDocumentClosure(document).closureDigest, document, roots: [root, output] }];
}
function generate(root) {
  try {
    return { text: generateBrowserContracts(sources(root)).text };
  } catch (error) {
    return { error: String(error?.message ?? error) };
  }
}

// The shipped profile emits no residual code of its own, so these controls append a statement to
// Ajv's real standalone output, the generator's actual input, and restore it afterwards.
const standalone = coreRequire('ajv/dist/standalone/index.js');
const shipped = standalone.default;
function generateWith(statement, root) {
  standalone.default = (...args) => `${shipped(...args)}\n${statement}`;
  try {
    return generate(root);
  } finally {
    standalone.default = shipped;
  }
}

const dir = mkdtempSync(join(tmpdir(), 'browser-validators-'));
let modules = 0;
/** The generated module's contracts, with its Ajv helper imports resolved from core as a host bundler would. */
async function load(text) {
  const resolved = text.split('\n').map((line) => {
    const helper = /^import \* as (__rt_\w+) from "(ajv\/dist\/runtime\/\w+\.js)";$/.exec(line);
    return helper ? `import * as ${helper[1]} from ${JSON.stringify(pathToFileURL(coreRequire.resolve(helper[2])).href)};` : line;
  }).join('\n');
  const file = join(dir, `contracts-${modules++}.mjs`);
  writeFileSync(file, resolved);
  return (await import(pathToFileURL(file).href)).contracts;
}

const ORDINARY = objectOf({ value: { const: 'ordinary literal' } });
const LITERALS = [
  ['L01', 'a const of require(', objectOf({ value: { const: 'require(' } }), { value: 'require(' }, { value: 'other' }],
  ['L02', 'a const of eval(', objectOf({ value: { const: 'eval(' } }), { value: 'eval(' }, { value: 'eval' }],
  ['L03', 'a const of new Function', objectOf({ value: { const: 'new Function' } }), { value: 'new Function' }, { value: 'Function' }],
  ['L04', 'a const naming an Ajv runtime require', objectOf({ value: { const: 'require("ajv/dist/runtime/equal").default' } }),
    { value: 'require("ajv/dist/runtime/equal").default' }, { value: 'require("ajv/dist/runtime/equal")' }],
  ['L05', 'property names require( and eval with a length bound',
    objectOf({ 'require(': { type: 'string', minLength: 1 }, eval: { type: 'string', minLength: 1 } }),
    { 'require(': 'x', eval: 'y' }, { 'require(': '', eval: 'y' }],
  ['L06', 'an enum of call and comment text', objectOf({ value: { enum: ['Function("return 1")()', 'globalThis.eval(1)', '*/ require("node:fs") /*'] } }),
    { value: '*/ require("node:fs") /*' }, { value: 'require("node:fs")' }],
  ['O01', 'an ordinary const (control)', ORDINARY, { value: 'ordinary literal' }, { value: 'other' }],
];

console.log('Schema data that reads like code:');
for (const [id, label, root, accepted, rejected] of LITERALS) {
  const runtime = compileContract({ root }).validate;
  check(`${id} runtime compiler accepts ${label}`, runtime(accepted), true);
  check(`${id} runtime compiler rejects another value`, runtime(rejected), false);
  const generated = generate(root);
  check(`${id} browser generation succeeds`, generated.error ?? 'generated', 'generated');
  const validate = generated.text && (await load(generated.text)).validators[singleDocumentClosure(root).closureDigest];
  check(`${id} generated validator accepts the same value`, validate ? validate(accepted) : 'not generated', true);
  check(`${id} generated validator rejects the other value`, validate ? validate(rejected) : 'not generated', false);
}

console.log('A comment and a string in the validator body:');
const note = '/* require("node:fs"); eval("1"); new Function("") */ const note0 = "require( eval( new Function";';
const commented = generateWith(note, ORDINARY);
check('K01 browser generation succeeds', commented.error ?? 'generated', 'generated');
check('K02 the appended statement reached the generator', commented.text?.includes(note) ?? false, true);

console.log('Residual code refuses:');
const REFUSAL = /: standalone output still needs require or runtime evaluation$/;
const RESIDUAL = [
  ['F01', 'a require call', 'require("node:fs");'],
  ['F02', 'an eval call', 'eval("1");'],
  ['F03', 'a Function constructor', 'new Function("return 1");'],
  ['F04', 'a Function call', 'Function("return 1")();'],
  ['F05', 'an aliased require', 'const load0 = require; load0("node:fs");'],
  ['F06', 'eval through a member', 'globalThis.eval("1");'],
  ['F07', 'Function through a computed member', 'new globalThis["Function"]("return 1");'],
  ['F08', 'an unknown Ajv runtime helper', 'const func9 = require("ajv/dist/runtime/unknown").default;'],
  ['F09', 'a known Ajv runtime helper without its member read', 'require("ajv/dist/runtime/equal");'],
];
for (const [id, label, statement] of RESIDUAL) check(`${id} ${label} refuses`, REFUSAL.test(generateWith(statement, ORDINARY).error ?? ''), true);
const moduleSyntax = generateWith('import "node:fs";', ORDINARY).error ?? '';
check('F10 module syntax in a validator body refuses', /: standalone output does not parse: /.test(moduleSyntax), true);

rmSync(dir, { recursive: true, force: true });
const expected = LITERALS.length * 5 + 2 + RESIDUAL.length + 1;
const passed = results.filter(Boolean).length;
console.log(`${passed}/${results.length} checks passed (expected ${expected})`);
if (results.length !== expected || passed !== expected) process.exit(1);
