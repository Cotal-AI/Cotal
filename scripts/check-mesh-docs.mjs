import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { lexer } from 'marked';
import { readDocument } from '@cotal-ai/docs-content';
import { compileContract, registryClusterDocument, REGISTRY_CONTRACTS } from '../packages/core/dist/index.js';
import { managerClusterDocument, MANAGER_CONTRACTS } from '../implementations/manager/src/manager-service-contract.ts';
import { authClusterDocument, AUTH_CONTRACTS } from '../implementations/auth/src/auth-service-contract.ts';

const path = new URL('../docs/mesh-commands.mdx', import.meta.url).pathname;
assert(existsSync(path), 'built-in mesh command catalog is missing');
const document = await readDocument(path);
const sections = new Map();
let section;
for (const token of lexer(document.markdown)) {
  if (token.type === 'heading') {
    section = undefined;
    if (token.depth === 3) {
      assert(!sections.has(token.text), `unique command entry: ${token.text}`);
      section = [];
      sections.set(token.text, section);
    }
  } else if (section && token.type === 'code' && token.lang === 'json') {
    section.push(JSON.parse(token.text));
  }
}
const sources = [
  ['manager', managerClusterDocument(), MANAGER_CONTRACTS],
  ['auth', authClusterDocument(), AUTH_CONTRACTS],
  ['registry', registryClusterDocument(), REGISTRY_CONTRACTS],
];
const expected = sources.flatMap(([endpoint, cluster]) => cluster.commands.map(command => `${endpoint} ${command.name}`));
assert.deepEqual([...sections.keys()], expected, 'one complete entry per shipped command, in source order');
let schemas = 0;
for (const [endpoint, cluster, contracts] of sources) {
  for (const command of cluster.commands) {
    const blocks = sections.get(`${endpoint} ${command.name}`);
    assert.equal(blocks.length, 3, 'declaration, input and output');
    assert.deepEqual(blocks[0], command, `registered shape: ${endpoint}/${command.name}`);
    for (const [index, direction] of ['input', 'output'].entries()) {
      const compiled = compileContract({ root: blocks[index + 1] });
      assert.equal(compiled.closureDigest, command[`${direction}Digest`], `rendered ${direction} digest`);
      assert.equal(compiled.closureDigest, contracts[command.name][direction].closureDigest, 'same contract used by serving code');
      schemas++;
    }
  }
}
// A documented safe example must also be a call the CLI accepts and the input contract admits. With
// no --args the CLI sends null, and --args must be one JSON object, so `--args 'null'` was refused (#7089).
const example = lexer(document.markdown).find(token => token.type === 'code' && token.lang === 'sh');
const call = example?.text.split('\n').find(line => line.startsWith('cotal invoke manager status '));
assert(call, 'status example is present');
const args = call.match(/--args '([^']+)'/)?.[1];
const input = args === undefined ? null : JSON.parse(args);
if (args !== undefined) assert(input !== null && typeof input === 'object' && !Array.isArray(input), 'status example --args is one JSON object, as the CLI requires');
assert(MANAGER_CONTRACTS.status.input.validate(input), 'status example input');
console.log(`check:meshdocs: ${sources.length} endpoints, ${expected.length} declarations, ${schemas} compiled schemas, 1 example`);
