// Run only after building the actual package. No deep compiler import or direct Ajv instance.
import * as Core from '@cotal-ai/core';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

const flags = process.argv.slice(2);
const allowed = new Set(['--gate', '--receipt', '--ordinary-reference']);
const options = {};
for (let i = 0; i < flags.length; i += 2) {
  if (!allowed.has(flags[i]) || !flags[i + 1] || Object.hasOwn(options, flags[i]))
    throw new Error('Expected unique --gate, --receipt and optional --ordinary-reference pairs');
  options[flags[i]] = flags[i + 1];
}
const gate = options['--gate'] ?? 'partial';
if (!['full', 'partial', 'controls'].includes(gate)) throw new Error('Unknown gate');
const bytes = readFileSync(new URL('./schema-own-properties.cells.json', import.meta.url));
const corpus = JSON.parse(bytes);
if (corpus.cells.length !== 20 || corpus.cells.map(c => c.id).join(',') !==
    Array.from({ length: 20 }, (_, i) => `M${String(i + 1).padStart(2, '0')}`).join(','))
  throw new Error('Exact twenty-cell census changed');
const partialIds = new Set(['M04', 'M05', 'M06', 'M07', 'M08']);
const receipt = {
  kind: 'public-compileContract-own-properties-regression', gate, node: process.version,
  publicEntry: import.meta.resolve('@cotal-ai/core'),
  corpusSha256: createHash('sha256').update(bytes).digest('hex'),
  assertions: [], cells: [], observations: [], ordinary: [], skips: [], setupErrors: [],
  qualification: 'Partial own-member repair only. Full normative gate stays red until all twenty are repaired.',
};
const clone = value => JSON.parse(JSON.stringify(value));
function errorInfo(error) {
  return { name: error?.name ?? typeof error, code: error?.code ?? null, message: String(error?.message ?? error) };
}
function check(group, name, actual, expected) {
  receipt.assertions.push({ group, name, actual, expected, passed: actual === expected });
  const selected = gate === 'full' ? /^M\d{2}$/.test(group)
    : gate === 'partial' ? partialIds.has(group) : group === 'controls';
  if (selected) console.log(`  ${actual === expected ? '✓' : '✗'} ${name}`);
}
function cellChecks(cell) {
  const group = cell.id;
  const row = { id: cell.id, case: cell.case, expected: cell.expected, actual: null, error: null };
  receipt.cells.push(row);
  const schema = clone(cell.schema), value = clone(cell.value);
  const source = JSON.stringify(schema), input = JSON.stringify(value);
  try {
    const compiled = Core.compileContract({ root: schema });
    check(group, `${group} synchronous compiled return`, compiled instanceof Promise, false);
    check(group, `${group} genuine core brand`, Core.isCompiledContract(compiled), true);
    check(group, `${group} frozen validator/digest pair`, Object.isFrozen(compiled), true);
    check(group, `${group} exact original closure digest`, compiled.closureDigest, cell.closureDigest);
    const actual = compiled.validate(value);
    row.actual = actual;
    row.errors = clone(compiled.validate.errors ?? null);
    check(group, `${group} synchronous boolean verdict`, typeof actual, 'boolean');
    check(group, `${group} schema bytes unchanged`, JSON.stringify(schema), source);
    check(group, `${group} instance bytes unchanged`, JSON.stringify(value), input);
    // Load-bearing assertion. Removing ownProperties must fail this for EACH M04-M08.
    check(group, `${group} normative verdict`, actual, cell.expected);
  } catch (error) {
    row.error = errorInfo(error);
    check(group, `${group} public compilation/validation completed`, false, true);
  }
}
for (const cell of corpus.cells) cellChecks(cell);

function control(name, work) {
  try { work(); } catch (error) {
    receipt.setupErrors.push({ control: name, error: errorInfo(error) });
    check('controls', `${name} completed`, false, true);
  }
}
function verdict(name, schema, json, expected) {
  control(name, () => {
    const input = JSON.parse(json);
    const before = JSON.stringify(input);
    const compiled = Core.compileContract({ root: clone(schema) });
    check('controls', name, compiled.validate(input), expected);
    check('controls', `${name} input unchanged`, JSON.stringify(input), before);
  });
}
const properties = corpus.cells.find(c => c.id === 'M04').schema;
const required = corpus.cells.find(c => c.id === 'M05').schema;
verdict('own constructor positive', properties, '{"constructor":1}', true);
verdict('own constructor negative', properties, '{"constructor":"bad"}', false);
verdict('all three own required names positive', required,
  '{"__proto__":1,"toString":1,"constructor":1}', true);
verdict('missing own required name negative', required, '{"__proto__":1,"constructor":1}', false);
control('own __proto__ presence', () => {
  const input = JSON.parse('{"__proto__":1,"toString":1,"constructor":1}');
  check('controls', 'JSON parsed __proto__ is own', Object.hasOwn(input, '__proto__'), true);
  check('controls', 'JSON parsed __proto__ does not change prototype', Object.getPrototypeOf(input) === Object.prototype, true);
});
// Do not conceal the independent existing Ajv __proto__ schema-property filter.
control('named __proto__ schema-filter observation', () => {
  const schema = JSON.parse('{"properties":{"__proto__":{"type":"number"}}}');
  const compiled = Core.compileContract({ root: schema });
  const actual = compiled.validate(JSON.parse('{"__proto__":"bad"}'));
  receipt.observations.push({ name: 'own __proto__ properties assertion', expectedNormative: false,
    actual, repaired: actual === false, scope: 'Adjacent known filter limitation, not one of original twenty or five repaired cells' });
  check('controls', '__proto__ filter observation produced boolean', typeof actual, 'boolean');
});

control('ordinary errors and boundary behavior', () => {
  const schema = { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false };
  const compiled = Core.compileContract({ root: schema });
  for (const [json, expected] of [['{}', false], ['{"value":5}', false],
    ['{"value":"ok","extra":1}', false], ['{"value":"ok"}', true]]) {
    const actual = compiled.validate(JSON.parse(json));
    check('controls', `ordinary verdict ${json}`, actual, expected);
    receipt.ordinary.push({ json, actual, errors: clone(compiled.validate.errors ?? null) });
  }
  check('controls', 'genuine Ajv schema metadata', Object.hasOwn(compiled.validate, 'schema'), true);
  check('controls', 'genuine Ajv schemaEnv metadata', Object.hasOwn(compiled.validate, 'schemaEnv'), true);
  for (const [name, code, invoke] of [
    ['args', 'bad-request', () => Core.assertArgsValid(compiled.validate, { value: 5 })],
    ['output', 'internal', () => Core.assertOutputValid(compiled.validate, { value: 5 })],
  ]) {
    let caught;
    try { invoke(); } catch (error) { caught = error; }
    check('controls', `${name} shared public error identity`, caught instanceof Core.EpEnvelopeError, true);
    check('controls', `${name} error code`, caught?.code, code);
  }
  const voidCompiled = Core.compileContract({ root: Core.VOID_SCHEMA });
  check('controls', 'void args undefined normalizes to null', Core.assertArgsValid(voidCompiled.validate, undefined), null);
  Core.assertOutputValid(voidCompiled.validate, undefined);
  check('controls', 'void output undefined accepted', true, true);
});
if (options['--ordinary-reference']) {
  control('ordinary full errors cross-phase', () => {
    const reference = JSON.parse(readFileSync(resolve(options['--ordinary-reference']), 'utf8'));
    if (reference.setupErrors.length || reference.ordinary.length !== 4) throw new Error('Invalid ordinary reference receipt');
    check('controls', 'ordinary full errors identical to baseline', JSON.stringify(receipt.ordinary), JSON.stringify(reference.ordinary));
  });
}

function refuses(name, bundle, needle, compile = Core.compileContract) {
  control(name, () => {
    let caught;
    try { compile(bundle); } catch (error) { caught = error; }
    check('controls', `${name} genuine ContractInvalidError`, caught instanceof Core.ContractInvalidError, true);
    check('controls', `${name} public code`, caught?.code, 'contract-invalid');
    check('controls', `${name} discriminating message`, caught?.message.includes(needle) ?? false, true);
  });
}
const member = { $id: 'https://closed.invalid/member', type: 'string', minLength: 2 };
const digest = Core.contractDigest(member);
const bundle = { root: { $ref: `cotal:${digest}` }, members: { [digest]: member } };
control('closed member and brand/cache/table', () => {
  const compiled = Core.compileContract(bundle);
  check('controls', 'closed digest member positive', compiled.validate('ok'), true);
  check('controls', 'closed digest member negative', compiled.validate('x'), false);
  check('controls', 'closed digest identity', compiled.closureDigest,
    Core.contractDigest(Core.buildContractClosureManifest(Core.contractDigest(bundle.root), [digest])));
  const cache = Core.createCompiledContractCache(2);
  const cold = cache.compile(bundle);
  check('controls', 'cold cache branded sync', Core.isCompiledContract(cold) && !(cold instanceof Promise), true);
  check('controls', 'warm cache exact pair', cache.compile(bundle) === cold, true);
  cache.compile({ root: { type: 'integer' } });
  cache.compile({ root: { type: 'boolean' } });
  check('controls', 'cache capacity', cache.size(), 2);
  check('controls', 'evicted cache recompiles', cache.compile(bundle) !== cold, true);
  const table = Core.serviceContractTable([{ name: 'probe', input: { type: 'string' }, output: Core.VOID_SCHEMA }]);
  const pair = table.contracts.probe;
  check('controls', 'table input branded sync', Core.isCompiledContract(pair.input) && !(pair.input instanceof Promise), true);
  check('controls', 'table output branded sync', Core.isCompiledContract(pair.output) && !(pair.output instanceof Promise), true);
  check('controls', 'table repeated pair stable', table.contracts.probe === pair, true);
  check('controls', 'table artifacts include void schema', table.artifactValues().some(v => Core.contractDigest(v) === Core.VOID_SCHEMA_ARTIFACT_DIGEST), true);
  check('controls', 'structural compiled pair rejected', Core.isCompiledContract({ validate: compiled.validate, closureDigest: compiled.closureDigest }), false);
  let caught;
  try { Core.assertCompiledContract({ validate: compiled.validate, closureDigest: compiled.closureDigest }, 'forged'); }
  catch (error) { caught = error; }
  check('controls', 'public compiled assertion refuses structure', caught instanceof Core.ContractInvalidError, true);
});
refuses('missing member', { root: bundle.root }, 'not present');
refuses('damaged member', { root: bundle.root, members: { [digest]: { type: 'number' } } }, 'does not hash');
refuses('extraneous member', { root: { type: 'string' }, members: bundle.members }, 'unreachable');
control('cache admission repeated on hit', () => {
  const cache = Core.createCompiledContractCache(2);
  cache.compile({ root: { type: 'string' } });
  refuses('warm-cache extras', { root: { type: 'string' }, members: bundle.members }, 'unreachable', b => cache.compile(b));
});
refuses('ambient HTTP ref', { root: { $ref: 'https://closed.invalid/ambient' } }, 'no ambient resolution');
refuses('unknown vocabulary', { root: { type: 'string', 'x-vendor': true } }, 'admitted vocabulary');
refuses('unsafe nested regex', { root: { type: 'string', pattern: '^(a+)+$' } }, 'repeats a group');
refuses('document byte bound', { root: { description: 'x'.repeat(Core.SCHEMA_PROFILE.maxDocumentBytes + 1) } }, 'document is');
let deep = { type: 'string' };
for (let i = 0; i < Core.SCHEMA_PROFILE.maxDepth + 1; i++) deep = { not: deep };
refuses('structural depth bound', { root: deep }, 'nesting');
refuses('pattern length bound', { root: { type: 'string', pattern: '^' + 'a'.repeat(Core.SCHEMA_PROFILE.maxPatternChars) + '$' } }, 'pattern');
const chainMembers = {};
let chainDigest = Core.contractDigest({ type: 'string' });
chainMembers[chainDigest] = { type: 'string' };
for (let i = 0; i <= Core.SCHEMA_PROFILE.maxRefChain; i++) {
  const next = { $ref: `cotal:${chainDigest}` };
  chainDigest = Core.contractDigest(next);
  chainMembers[chainDigest] = next;
}
refuses('digest reference chain bound', { root: { $ref: `cotal:${chainDigest}` }, members: chainMembers }, 'reference chain');
const wideMembers = {}, wideRefs = [];
for (let i = 0; i < 5; i++) {
  const next = { description: String(i) + 'x'.repeat(220 * 1024), type: 'string' };
  const key = Core.contractDigest(next);
  wideMembers[key] = next;
  wideRefs.push({ $ref: `cotal:${key}` });
}
refuses('closure byte bound', { root: { allOf: wideRefs }, members: wideMembers }, 'closure is');
verdict('legacy definitions positive', { definitions: { s: { type: 'string' } }, $ref: '#/definitions/s' }, '"s"', true);
verdict('legacy definitions negative', { definitions: { s: { type: 'string' } }, $ref: '#/definitions/s' }, '1', false);
verdict('legacy dependencies positive', { type: 'object', dependencies: { a: ['b'] } }, '{"a":1,"b":2}', true);
verdict('legacy dependencies negative', { type: 'object', dependencies: { a: ['b'] } }, '{"a":1}', false);
control('unicode and fixed formats', () => {
  const unicode = Core.compileContract({ root: { type: 'string', pattern: '^😀$' } });
  check('controls', 'unicode safe pattern positive', unicode.validate('😀'), true);
  check('controls', 'unicode safe pattern negative', unicode.validate('x'), false);
  check('controls', 'formats remain annotations', Core.compileContract({ root: { type: 'string', format: 'email' } }).validate('not-email'), true);
  check('controls', 'profile limits frozen', Object.isFrozen(Core.SCHEMA_PROFILE), true);
});

function summary(groups) {
  const assertions = receipt.assertions.filter(a => groups.has(a.group));
  return { assertions: assertions.length, passed: assertions.filter(a => a.passed).length,
    failed: assertions.filter(a => !a.passed).length,
    failures: assertions.filter(a => !a.passed).map(a => a.name), exit: assertions.every(a => a.passed) ? 0 : 1 };
}
receipt.gates = {
  full: summary(new Set(corpus.cells.map(c => c.id))),
  partial: summary(partialIds),
  controls: summary(new Set(['controls'])),
};
receipt.cellOutcomes = { attempted: receipt.cells.length,
  correct: receipt.cells.filter(c => c.error === null && c.actual === c.expected).length,
  wrong: receipt.cells.filter(c => c.error === null && c.actual !== c.expected).length,
  errors: receipt.cells.filter(c => c.error !== null).length };
receipt.integrity = {
  completeTwenty: receipt.cells.length === 20 && receipt.assertions.filter(a => /^M\d{2}$/.test(a.group)).length === 160,
  noCellErrors: receipt.cellOutcomes.errors === 0,
  nonNormativeFailures: receipt.assertions.filter(a => /^M\d{2}$/.test(a.group)
    && !a.name.endsWith(' normative verdict') && !a.passed).map(a => a.name),
  expectedControlAssertions: options['--ordinary-reference'] ? 85 : 84,
};
receipt.integrity.completeControls = receipt.gates.controls.assertions === receipt.integrity.expectedControlAssertions;
receipt.exit = receipt.gates[gate].exit;
if (receipt.setupErrors.length || !receipt.integrity.completeTwenty || !receipt.integrity.noCellErrors
    || !receipt.integrity.completeControls || receipt.integrity.nonNormativeFailures.length) receipt.exit = 1;
if (options['--receipt']) writeFileSync(resolve(options['--receipt']), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ gate, ...receipt.gates[gate], cellOutcomes: receipt.cellOutcomes,
  fullGateExit: receipt.gates.full.exit, partialGateExit: receipt.gates.partial.exit,
  controlsGateExit: receipt.gates.controls.exit, adjacentObservations: receipt.observations }));
console.log('schema-own-properties completed');
process.exitCode = receipt.exit;
