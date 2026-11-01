import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { markdownToMdx } from '@cotal-ai/docs-content/generate';
import { httpReferences, loadReferenceSpec, referencePages, referenceOperations } from './http-api.mjs';
import { httpSidebarTitles } from './http-navigation.mjs';

function schemaIndex(reference, spec, operations) {
  return ['## Schemas', '',
    'Expand request and response schemas on an operation page. The complete definitions are also available in the OpenAPI download and Markdown reference.', '',
    ...Object.keys(spec.components.schemas).filter(name => !name.startsWith('Wire')).flatMap(name => {
      const pointer = `#/components/schemas/${name}`;
      const uses = operations.filter(operation => JSON.stringify(operation).includes(`"${pointer}"`));
      return [`### ${name}`, '', uses.length
        ? uses.map(operation => `[${operation.summary}](/${reference.base}/operations/${operation.operationId}/)`).join(' · ')
        : `[OpenAPI definition](https://docs.cotal.ai/${reference.specFile}) · [Complete Markdown reference](/${reference.base}.md)`, ''];
    }),
  ].join('\n');
}

export function publishHttpReferences({ outDir, pubDir, genDir, documents, rewriteMarkdown }) {
  const pages = [];
  const navigation = [];
  const operationPages = {};
  const referenceIds = new Set(httpReferences.map(reference => reference.id));
  for (const id of Object.keys(httpSidebarTitles)) assert(referenceIds.has(id), `Remove obsolete HTTP reference labels for ${id} from website/scripts/http-navigation.mjs`);
  for (const reference of httpReferences) {
    const spec = loadReferenceSpec(reference);
    const source = documents.get(reference.docSource);
    if (!source) throw new Error(`Missing generated reference: ${reference.docSource}`);
    const json = JSON.stringify(spec, null, 2) + '\n';
    writeFileSync(join(pubDir, reference.specFile), json);
    writeFileSync(join(genDir, reference.specFile), json);
    const operations = referenceOperations(spec);
    const sidebarTitles = httpSidebarTitles[reference.id];
    assert(sidebarTitles, `Add HTTP sidebar labels for ${reference.id} to website/scripts/http-navigation.mjs`);
    const operationIds = new Set(operations.map(operation => operation.operationId));
    for (const id of Object.keys(sidebarTitles)) assert(operationIds.has(id), `Remove obsolete HTTP sidebar label ${reference.id}/${id} from website/scripts/http-navigation.mjs`);
    for (const id of operationIds) assert(typeof sidebarTitles[id] === 'string' && sidebarTitles[id].trim(), `Add a nonempty HTTP sidebar label for ${reference.id}/${id} to website/scripts/http-navigation.mjs`);
    for (const page of referencePages(reference, spec)) {
      const isOverview = page.slug === reference.base;
      const operation = operations.find(operation => page.slug.endsWith('/' + operation.operationId));
      const title = isOverview ? spec.info.title : operation.summary;
      const metadata = {
        title,
        description: isOverview ? source.metadata.description : operation.summary,
        kind: 'Reference',
        audience: 'HTTP client authors',
        ...(!isOverview ? { _openapi: { method: operation.method.toLowerCase() } } : {}),
      };
      const frontmatter = ['---', ...Object.entries(metadata).map(([key, value]) => `${key}: ${JSON.stringify(value)}`), '---', ''].join('\n');
      let body = page.markdown.replace(/^# [^\n]+\n\n/, '');
      if (isOverview) {
        body = readFileSync(new URL(`../src/content/api-overviews/${reference.id}.md`, import.meta.url), 'utf8') +
          `\n## Reference downloads\n\n[OpenAPI specification](/${reference.specFile}) · [Complete Markdown reference](/${reference.base}.md)\n`;
      }
      let mdx = markdownToMdx(body);
      if (isOverview) mdx += '\n<details>\n<summary>Schema reference links</summary>\n\n' + markdownToMdx(schemaIndex(reference, spec, operations)) + '\n</details>\n';
      if (!isOverview) {
        mdx = mdx.replace(/^## Endpoint$/m, `## Endpoint [#${operation.operationId}]`);
        if (operation.requestBody) mdx = mdx.replace(/^### Request body$/m, '### Request body [#complete-request-body]');
      }
      const target = join(outDir, page.slug, 'index.mdx');
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, frontmatter + mdx);
      if (!isOverview) {
        operationPages[`/${page.slug}`] = {
          document: reference.id,
          path: operation.path,
          method: operation.method.toLowerCase(),
          sidebarTitle: sidebarTitles[operation.operationId],
          overviewUrl: `/${reference.base}/`,
          ...(operation['x-sse-events'] ? { eventPayloads: JSON.stringify(operation['x-sse-events'], null, 2) } : {}),
        };
      }
      pages.push({
        slug: page.slug,
        title,
        section: 'api',
        url: `/${page.slug}/`,
        markdown: isOverview ? rewriteMarkdown(source.markdown, reference.docSource) : page.markdown,
      });
    }
    navigation.push({
      kind: 'group',
      title: reference.label,
      children: pages.filter(page => page.slug.startsWith(reference.base + '/') || page.slug === reference.base)
        .map(page => ({ kind: 'page', url: page.url })),
    });
  }
  writeFileSync(join(genDir, 'http-operations.mjs'), `// @ts-check\n/** @type {Record<string, import('../lib/openapi').HttpOperation>} */\nexport const httpOperations = ${JSON.stringify(operationPages, null, 2)};\n`);
  return { pages, navigation };
}
