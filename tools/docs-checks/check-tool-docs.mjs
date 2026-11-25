import assert from 'node:assert/strict';
import { lexer } from 'marked';
import { readDocument } from '@cotal-ai/docs-content';
import { globalRegistry, safeParse } from 'zod';
import { cotalToolSpecs } from '../../extensions/connector-core/src/tool-specs.ts';

const specs = cotalToolSpecs({
  space: 'main', name: 'you', servers: 'nats://127.0.0.1:4222', tls: false,
  subscribe: ['general'], allowSubscribe: ['general'], allowPublish: ['general'], kind: 'agent',
});
const document = await readDocument(new URL('../../docs/mcp-tools.mdx', import.meta.url).pathname);
const tokens = lexer(document.markdown);
/** @param {string} text */
const normalize = text => text.replace(/\s+/g, ' ').trim();
/** @param {import('marked').Token[]} tokens @returns {string} */
const inline = tokens => tokens.map(token => {
  if ('tokens' in token && token.tokens) return inline(token.tokens);
  if ('items' in token && token.items) return token.items.map((/** @type {import('marked').Tokens.ListItem} */ item) => inline(item.tokens)).join(' ');
  if (token.type === 'table') return [...token.header, ...token.rows.flat()].map((/** @type {import('marked').Tokens.TableCell} */ cell) => inline(cell.tokens)).join(' ');
  return ('text' in token ? token.text : undefined) ?? token.raw ?? '';
}).join('');
/** @param {string} markdown */
const visible = markdown => normalize(lexer(markdown).map(token => inline([token])).join(' '));
/** @type {Map<string, import('marked').Token[]>} */
const sections = new Map();
/** @type {import('marked').Token[] | undefined} */
let section;
for (const token of tokens) {
  if (token.type === 'heading' && token.depth === 2) {
    const heading = token.tokens;
    assert(heading, 'unique generated tool heading');
    const nameToken = heading.find(token => token.type === 'codespan');
    const name = nameToken && 'text' in nameToken ? nameToken.text : undefined;
    assert(name && !sections.has(name), 'unique generated tool heading');
    assert.equal(normalize(inline(heading)), name, `clean generated tool heading: ${name}`);
    section = [];
    sections.set(name, section);
  } else if (section) section.push(token);
}
/** @param {import('marked').Token} token @returns {token is import('marked').Tokens.Table} */
const isArgumentTable = token => token.type === 'table' && inline(token.header[0].tokens) === 'Argument';
assert.deepEqual([...sections.keys()], specs.map(spec => spec.name), 'every tool appears in source order');
let argumentsChecked = 0;
for (const spec of specs) {
  const tokens = sections.get(spec.name);
  assert(tokens, `complete tool description: ${spec.name}`);
  const body = normalize(tokens.map(token => inline([token])).join(' '));
  assert(body.includes(visible(spec.description)), `complete tool description: ${spec.name}`);
  const table = tokens.find(isArgumentTable);
  const args = Object.entries(spec.schema.shape);
  if (args.length === 0) {
    assert(!table, `no argument table for an empty schema: ${spec.name}`);
    assert(body.includes('No arguments.'), `empty argument declaration: ${spec.name}`);
    continue;
  }
  assert(table, `argument table: ${spec.name}`);
  assert.equal(table.rows.length, args.length, `complete arguments: ${spec.name}`);
  for (const [index, [name, schema]] of args.entries()) {
    /** @type {import('marked').Tokens.TableCell[]} */
    const cells = table.rows[index];
    assert.equal(cells.length, 4, `four argument columns: ${spec.name}/${name}`);
    assert.equal(inline(cells[0].tokens), name);
    assert.equal(inline(cells[2].tokens), safeParse(schema, undefined).success ? 'no' : 'yes', `required status: ${spec.name}/${name}`);
    const description = globalRegistry.get(schema)?.description;
    assert(description !== undefined, `complete argument meaning: ${spec.name}/${name}`);
    assert.equal(normalize(inline(cells[3].tokens)), visible(description), `complete argument meaning: ${spec.name}/${name}`);
    argumentsChecked++;
  }
}
console.log(`check-tool-docs: ${specs.length} tools and ${argumentsChecked} arguments retain complete source descriptions and required status`);
