import { readFile, readdir } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkMdx from 'remark-mdx';
import remarkGfm from 'remark-gfm';
import { frontmatter } from 'fumadocs-core/content/md/frontmatter';
import { remarkLLMs } from 'fumadocs-core/mdx-plugins/remark-llms';
import { replaceSource } from 'fumadocs-core/mdx-plugins/stringifier';

/** @typedef {import('./index.d.ts').Document} Document */
/** @typedef {import('mdast').Nodes} Node */
/** @typedef {import('mdast-util-mdx').MdxJsxFlowElement | import('mdast-util-mdx').MdxJsxTextElement} Element */
/** @typedef {Record<string, string | number | boolean | string[]>} Attributes */

/** @type {Record<string, { module: string; attributes: string[] }>} */
const components = {
  Card: { module: 'fumadocs-ui/components/card', attributes: ['title', 'href'] },
  Cards: { module: 'fumadocs-ui/components/card', attributes: [] },
  Step: { module: 'fumadocs-ui/components/steps', attributes: [] },
  Steps: { module: 'fumadocs-ui/components/steps', attributes: [] },
  Tab: { module: 'fumadocs-ui/components/tabs', attributes: ['value'] },
  Tabs: { module: 'fumadocs-ui/components/tabs', attributes: ['items', 'defaultIndex', 'groupId', 'persist'] },
  Callout: { module: 'fumadocs-ui/components/callout', attributes: ['title', 'type'] },
};
/** @type {Record<string, string>} */
const calloutLabels = { info: 'Note', warn: 'Warning', warning: 'Warning', error: 'Error', success: 'Success', idea: 'Idea' };

/** @param {string} path @param {Node} node @param {string} message @returns {never} */
function fail(path, node, message) {
  throw new Error(`${path}:${node.position?.start.line ?? 1}: ${message}`);
}

/** @param {Element} node @param {string} path @returns {Attributes} */
function attributes(node, path) {
  /** @type {Attributes} */
  const result = {};
  const allowed = components[node.name ?? ''].attributes;
  for (const attr of node.attributes) {
    if (attr.type !== 'mdxJsxAttribute') fail(path, node, 'spread attributes cannot be exported');
    if (!allowed.includes(attr.name)) fail(path, node, `unsupported attribute ${attr.name} on ${node.name}`);
    if (Object.hasOwn(result, attr.name)) fail(path, node, `duplicate attribute ${attr.name}`);
    if (typeof attr.value === 'string') result[attr.name] = attr.value;
    else if (attr.value === null) result[attr.name] = true;
    else {
      const statements = attr.value?.data?.estree?.body;
      const expression = statements?.length === 1 && statements[0].type === 'ExpressionStatement' ? statements[0].expression : undefined;
      if (node.name === 'Tabs' && attr.name === 'items' && expression?.type === 'ArrayExpression' && expression.elements.every(item => item?.type === 'Literal' && typeof item.value === 'string')) {
        result[attr.name] = expression.elements.map(item => {
          if (item?.type !== 'Literal' || typeof item.value !== 'string') fail(path, node, 'Tabs items must be static strings');
          return item.value;
        });
      } else if (node.name === 'Tabs' && attr.name === 'defaultIndex' && expression?.type === 'Literal' && typeof expression.value === 'number') {
        result[attr.name] = expression.value;
      } else if (node.name === 'Tabs' && attr.name === 'persist' && expression?.type === 'Literal' && typeof expression.value === 'boolean') {
        result[attr.name] = expression.value;
      } else fail(path, node, `attribute ${attr.name} must be static; JavaScript expressions cannot be exported`);
    }
  }
  if (node.name === 'Tabs') {
    if (result.groupId !== undefined && typeof result.groupId !== 'string') fail(path, node, 'Tabs groupId must be a static string');
    if (result.persist !== undefined && typeof result.persist !== 'boolean') fail(path, node, 'Tabs persist must be a static boolean');
  }
  return result;
}

/** @param {Attributes} attrs @param {string} name @param {Element} node @param {string} path */
function requiredText(attrs, name, node, path) {
  const value = attrs[name];
  if (typeof value !== 'string' || !value.trim()) fail(path, node, `${node.name} needs a static ${name}`);
  return value;
}

/** @param {string} text */
function escapeLabel(text) { return text.replace(/[\\[\]*_`<>&]/g, '\\$&'); }

/** @param {string} text */
function linkTarget(text) { return text.replace(/[\\()\s]/g, value => encodeURIComponent(value)); }

/** @param {string} path @returns {import('unified').Plugin<[], import('mdast').Root>} */
function semanticComponents(path) {
  return () => (tree, file) => {
    const imported = new Set();
    for (const node of tree.children) {
      if (node.type !== 'mdxjsEsm') continue;
      for (const statement of node.data?.estree?.body ?? []) {
        if (statement.type !== 'ImportDeclaration' || typeof statement.source.value !== 'string' || statement.specifiers.length === 0) fail(path, node, 'only supported native component imports can be exported');
        for (const specifier of statement.specifiers) {
          if (specifier.type !== 'ImportSpecifier' || specifier.imported.type !== 'Identifier') fail(path, node, 'only named native component imports can be exported');
          const name = specifier.imported.name;
          if (specifier.local.name !== name) fail(path, node, 'component import aliases cannot be exported');
          if (components[name]?.module !== statement.source.value) fail(path, node, `unsupported component import ${name}`);
          imported.add(name);
        }
      }
    }
    /** @param {Node[]} nodes @param {Element | undefined} parent */
    const visit = (nodes, parent) => {
      for (const node of nodes) {
        if (node.type === 'heading' && node.depth === 1) fail(path, node, 'prose H1 is not supported; use title frontmatter');
        if (node.type === 'mdxFlowExpression' || node.type === 'mdxTextExpression') fail(path, node, 'body expressions cannot be exported');
        if (node.type === 'mdxJsxFlowElement' || node.type === 'mdxJsxTextElement') {
          if (!node.name || !Object.hasOwn(components, node.name)) fail(path, node, `unsupported component ${node.name ?? 'fragment'}`);
          if (!imported.has(node.name)) fail(path, node, `component ${node.name} needs its native import`);
          const attrs = attributes(node, path);
          if (node.name === 'Card') {
            const title = requiredText(attrs, 'title', node, path);
            const href = attrs.href === undefined ? undefined : requiredText(attrs, 'href', node, path);
            const label = href ? `[${escapeLabel(title)}](${linkTarget(href)})` : `**${escapeLabel(title)}**`;
            replaceSource(file, node, s => `${label}\n\n${s.inner(node).trim()}\n\n`);
          } else if (node.name === 'Tab') {
            if (parent?.name !== 'Tabs') fail(path, node, 'Tab must be a direct child of Tabs');
            const label = requiredText(attrs, 'value', node, path);
            replaceSource(file, node, s => `**${escapeLabel(label)}**\n\n${s.inner(node).trim()}\n\n`);
          } else if (node.name === 'Callout') {
            const type = attrs.type ?? 'info';
            if (typeof type !== 'string' || !Object.hasOwn(calloutLabels, type)) fail(path, node, 'Callout type is unsupported');
            const label = calloutLabels[type];
            const title = attrs.title === undefined ? '' : requiredText(attrs, 'title', node, path);
            replaceSource(file, node, s => `> **${label}${title ? `: ${escapeLabel(title)}` : ''}**\n>\n${s.inner(node).trim().split('\n').map(line => `> ${line}`).join('\n')}\n\n`);
          } else {
            if (node.name === 'Tabs') {
              const items = attrs.items;
              const children = node.children.flatMap(child => child.type === 'paragraph' ? child.children : [child]).filter(child => child.type !== 'text' || child.value.trim());
              const tabs = children.filter(isElement);
              const values = tabs.map(tab => attributes(tab, path).value);
              if (children.length !== tabs.length || !Array.isArray(items) || items.length === 0 || new Set(items).size !== items.length || values.length !== items.length || values.some((value, index) => value !== items[index]) || tabs.some(tab => tab.name !== 'Tab')) fail(path, node, 'Tabs items must match all direct Tab values in order');
              if (attrs.defaultIndex !== undefined && (!Number.isInteger(attrs.defaultIndex) || Number(attrs.defaultIndex) < 0 || Number(attrs.defaultIndex) >= items.length)) fail(path, node, 'Tabs defaultIndex is outside its items');
            }
            if (node.name === 'Step' && parent?.name !== 'Steps') fail(path, node, 'Step must be a direct child of Steps');
            replaceSource(file, node, s => `${s.inner(node).trim()}\n\n`);
          }
          visit(node.children, node);
        } else if ('children' in node) visit(node.children, parent);
      }
    };
    visit(tree.children, undefined);
  };
}

/** @param {Node} node @returns {node is Element} */
function isElement(node) { return node.type === 'mdxJsxFlowElement' || node.type === 'mdxJsxTextElement'; }

/** @param {string} body */
function firstParagraph(body) {
  const root = unified().use(remarkParse).use(remarkGfm).parse(body);
  const paragraph = root.children.find(node => node.type === 'paragraph' && node.children.some(child => child.type !== 'image'));
  if (!paragraph || !('children' in paragraph)) return '';
  /** @param {Node} node @returns {string} */
  const text = node => 'value' in node ? node.value : 'children' in node ? node.children.map(text).join('') : '';
  return text(paragraph).replace(/\s+/g, ' ').trim();
}

/** @param {string} sourcePath @returns {Promise<Document>} */
export async function readDocument(sourcePath) {
  const source = (await readFile(sourcePath, 'utf8')).replace(/\r\n?/g, '\n');
  if (!source.trim()) throw new Error(`${sourcePath} is empty`);
  const format = extname(sourcePath).slice(1);
  if (format !== 'md' && format !== 'mdx') throw new Error(`unsupported document format: ${sourcePath}`);
  if (format === 'md') {
    const title = /^#\s+(.+?)\s*$/m.exec(source)?.[1];
    if (!title) throw new Error(`${sourcePath} has no H1 title`);
    const content = source.replace(/^#\s+.+?\s*\n/m, '').trimStart();
    const description = firstParagraph(content);
    if (!description) throw new Error(`${sourcePath} has no summary paragraph`);
    const kind = /^>\s*(.+?)\s*$/m.exec(content)?.[1]?.split('·')[0].replace(/\*\*|[[\]]/g, '').trim() ?? '';
    return { sourcePath, format, metadata: { title, description, kind }, content, markdown: source };
  }
  const parsed = frontmatter(source);
  const data = parsed.data;
  /** @param {string} key */
  const required = key => {
    if (typeof data[key] !== 'string' || !data[key].trim()) throw new Error(`${sourcePath} needs ${key} frontmatter`);
    return data[key].trim();
  };
  const metadata = { title: required('title'), description: required('description'), kind: required('kind'), audience: required('audience') };
  const content = parsed.content.trimStart();
  if (!content.trim()) throw new Error(`${sourcePath} is empty`);
  const processor = unified().use(remarkParse).use(remarkMdx).use(remarkGfm).use(semanticComponents(sourcePath)).use(remarkLLMs, { _data: true, headingIds: false });
  const offset = parsed.matter.length + parsed.content.length - content.length;
  const exportSource = '\n'.repeat(source.slice(0, offset).split('\n').length - 1) + content;
  const file = { value: exportSource, data: { markdown: /** @type {unknown} */ (undefined) } };
  const tree = processor.parse(exportSource);
  await processor.run(tree, file);
  const body = file.data.markdown;
  if (typeof body !== 'string' || !body.trim()) throw new Error(`${sourcePath} produced empty Markdown`);
  return { sourcePath, format, metadata, content, markdown: `# ${metadata.title}\n\n${body}` };
}

/** @param {string} directory @returns {Promise<string[]>} */
export async function discoverDocuments(directory) {
  const files = (await readdir(directory, { withFileTypes: true })).filter(entry => entry.isFile() && /\.mdx?$/.test(entry.name) && !/^README\.mdx?$/i.test(entry.name)).map(entry => entry.name).sort();
  const slugs = new Set();
  for (const file of files) {
    const slug = basename(file, extname(file)).toLowerCase();
    if (slugs.has(slug)) throw new Error(`${directory}: duplicate document slug ${slug}`);
    slugs.add(slug);
  }
  return files.map(file => join(directory, file));
}
