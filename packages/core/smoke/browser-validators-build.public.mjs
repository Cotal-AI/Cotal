// Public build and runtime entries. The bundled module runs with string code generation disabled.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { singleDocumentClosure } from '@cotal-ai/core';
import { generateBrowserContracts } from '@cotal-ai/core/browser-validators-build';
const entry = fileURLToPath(import.meta.resolve('@cotal-ai/core/contract-validator'));
const dir = mkdtempSync(join(tmpdir(), 'browser-contract-conformance-'));
const corpus = JSON.parse(readFileSync(new URL('./schema-own-properties.cells.json', import.meta.url)));
const controls = JSON.parse(readFileSync(new URL('./schema-remaining15-diagnostic.cells.json', import.meta.url)));
const cases = [...corpus.cells, ...controls.independent33,
  { schema: JSON.parse('{"properties":{"__proto__":{"type":"number"}}}'), value: JSON.parse('{"__proto__":"bad"}'), expected: false },
  ...['require(', 'eval(', 'new Function', '</script>', '*/ require("node:fs") /*'].map(value => ({ schema: { const: value }, value, expected: true })),
];
const roots = cases.map(row => row.schema);
const inputDigest = singleDocumentClosure(roots[0]).closureDigest;
const document = { urn: 'com.example.conformance', revision: 1, commands: [{ name: 'echo', inputDigest, outputDigest: inputDigest }] };
const generated = generateBrowserContracts([{ label: 'conformance', clusterDigest: singleDocumentClosure(document).closureDigest, document, roots }]);
assert.ok(!generated.text.includes('<'));
const file = join(dir, 'contracts.mjs');
writeFileSync(file, generated.text.replace('"@cotal-ai/core/contract-validator"', JSON.stringify(entry)));
const bundled = join(dir, 'contracts-bundled.mjs');
await build({ entryPoints: [file], outfile: bundled, bundle: true, platform: 'browser', format: 'esm', target: 'es2022' });
const fixture = join(dir, 'cases.json');
writeFileSync(fixture, JSON.stringify(cases));
const runner = join(dir, 'check.mjs');
writeFileSync(runner, `import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {contracts} from ${JSON.stringify(pathToFileURL(bundled).href)};
const cases=JSON.parse(readFileSync(${JSON.stringify(fixture)}));
const digests=${JSON.stringify(cases.map(row => singleDocumentClosure(row.schema).closureDigest))};
for(let i=0;i<cases.length;i++) assert.equal(contracts.validators[digests[i]](cases[i].value),cases[i].expected);
console.log(cases.length+' bundled browser verdicts passed');`);
const child = spawnSync(process.execPath, ['--disallow-code-generation-from-strings', runner], { encoding: 'utf8', timeout: 30000 });
assert.equal(child.status, 0, child.stderr);
process.stdout.write(child.stdout);
assert.throws(() => generateBrowserContracts([{ label: 'bad', clusterDigest: 'bad', document, roots }]));
assert.throws(() => generateBrowserContracts([{ label: 'missing', clusterDigest: singleDocumentClosure(document).closureDigest, document, roots: [] }]));
console.log(`browser-validators-build.public: ${cases.length} verdicts and 3 generation checks passed without string code generation`);
