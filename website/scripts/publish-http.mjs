import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { markdownToMdx } from '@cotal-ai/docs-content/generate';
import { httpReferences, loadReferenceSpec, referencePages, referenceOperations, schemaMarkdown } from './http-api.mjs';

export function publishHttpReferences({ outDir, pubDir, genDir, documents, rewriteMarkdown }) {
  const pages = [];
  const navigation = [];
  for (const reference of httpReferences) {
    const spec = loadReferenceSpec(reference);
    const source = documents.get(reference.docSource);
    if (!source) throw new Error(`Missing generated reference: ${reference.docSource}`);
    const json = JSON.stringify(spec, null, 2) + '\n';
    writeFileSync(join(pubDir, reference.specFile), json);
    writeFileSync(join(genDir, reference.specFile), json);
    const operations = referenceOperations(spec);
    for (const page of referencePages(reference, spec)) {
      const isOverview = page.slug === reference.base;
      const operation = operations.find(operation => page.slug.endsWith('/' + operation.operationId));
      const title = isOverview ? spec.info.title : operation.summary;
      const metadata = {
        title,
        description: isOverview ? source.metadata.description : operation.summary,
        kind: 'Reference',
        audience: 'HTTP client authors',
      };
      const frontmatter = ['---', ...Object.entries(metadata).map(([key, value]) => `${key}: ${JSON.stringify(value)}`), '---', ''].join('\n');
      let body = page.markdown.replace(/^# [^\n]+\n\n/, '');
      if (isOverview) body = body.replace(/(\]\(\/api\/[^)]+)\.md\)/g, '$1/)') + '\n' + schemaMarkdown(spec);
      let mdx = markdownToMdx(body);
      if (!isOverview) mdx = mdx.replace(/^## Endpoint$/m, `## Endpoint [#${operation.operationId}]`);
      const target = join(outDir, page.slug, 'index.mdx');
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, frontmatter + mdx);
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
  return { pages, navigation };
}
