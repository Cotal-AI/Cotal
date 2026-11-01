import { notFound } from 'next/navigation';
import { source } from '@/lib/source';
import { DocsPage, DocsBody, DocsTitle, MarkdownCopyButton, ViewOptionsPopover } from 'fumadocs-ui/layouts/docs/page';
import { useMDXComponents } from '../../../../mdx-components';
import { OpenAPIPage } from '@/components/api-page';
import { getHttpOperationProps } from '@/lib/openapi';
import { httpOperations } from '@/generated/http-operations.mjs';
import { httpReferences } from '@/http-references.js';
import { CodeBlock, Pre } from 'fumadocs-ui/components/codeblock';
export const dynamicParams = false;
export function generateStaticParams() { return source.getPages().map(p => ({ section: p.slugs[0], slug: p.slugs.slice(1) })); }
type Props = { params: Promise<{ section: string; slug: string[] }> };
export async function generateMetadata({params}:Props) {
 const {section,slug}=await params; const page=source.getPage([section,...slug]); if(!page) notFound();
 return {title: `${page.data.title} | Cotal`,description:page.data.description,alternates:{canonical:`https://docs.cotal.ai/${section}/${slug.join('/')}/`,types:{'text/markdown':`/${section}/${slug.join('/')}.md`}}};
}
export default async function Page({params}:Props) {
 const {section,slug}=await params; const page=source.getPage([section,...slug]); if(!page) notFound();
 const Content=page.data.body;
 const markdownUrl=`/${section}/${slug.join('/')}.md`;
 const operation = httpOperations[page.url.replace(/\/$/, '')];
 const overview = httpReferences.some(reference => page.url.replace(/\/$/, '') === `/${reference.base}`);
 const nativeProps = operation ? await getHttpOperationProps(operation) : undefined;
 return (
  <DocsPage
   full={Boolean(operation)}
   toc={operation || overview ? [] : page.data.toc}
   tableOfContent={{ enabled: overview ? false : undefined, style: 'block', list: { className: 'cotal-toc-highlight' } }}
   tableOfContentPopover={{ enabled: overview ? false : undefined, style: 'block', list: { className: 'cotal-toc-highlight' } }}
  >
   <DocsTitle>{page.data.title}</DocsTitle>
   <div className="mb-6 flex flex-wrap items-center gap-2">
    <MarkdownCopyButton markdownUrl={markdownUrl} aria-label="Copy page">Copy page</MarkdownCopyButton>
    <ViewOptionsPopover markdownUrl={markdownUrl} pageUrl={`https://docs.cotal.ai${page.url}`} />
   </div>
   <DocsBody>
    {nativeProps && operation ? <>
     <div data-native-openapi={operation.document}><OpenAPIPage {...nativeProps} /></div>
     <p>See the <a href={operation.overviewUrl}>HTTP interface overview</a> for authentication and access requirements.</p>
     {operation.eventPayloads && <section aria-labelledby="native-event-payloads">
      <h2 id="native-event-payloads">Event payloads</h2>
      <p>Each named event carries the following JSON data schema.</p>
      <CodeBlock><Pre>{operation.eventPayloads}</Pre></CodeBlock>
     </section>}
     <details className="mt-8 rounded-lg border p-4">
      <summary className="cursor-pointer font-medium">Complete HTTP contract</summary>
      <Content components={useMDXComponents({})}/>
     </details>
    </> : <Content components={useMDXComponents({})}/>}
   </DocsBody>
  </DocsPage>
 );
}
