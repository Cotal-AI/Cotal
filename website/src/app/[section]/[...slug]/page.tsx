import { notFound } from 'next/navigation';
import { source } from '@/lib/source';
import { DocsPage, DocsBody, DocsTitle, MarkdownCopyButton, ViewOptionsPopover } from 'fumadocs-ui/layouts/docs/page';
import { useMDXComponents } from '../../../../mdx-components';
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
 return (
  <DocsPage
   toc={page.data.toc}
   tableOfContent={{ style: 'block', list: { className: 'cotal-toc-highlight' } }}
   tableOfContentPopover={{ style: 'block', list: { className: 'cotal-toc-highlight' } }}
  >
   <DocsTitle>{page.data.title}</DocsTitle>
   <div className="mb-6 flex flex-wrap items-center gap-2">
    <MarkdownCopyButton markdownUrl={markdownUrl} aria-label="Copy page">Copy page</MarkdownCopyButton>
    <ViewOptionsPopover markdownUrl={markdownUrl} pageUrl={`https://docs.cotal.ai${page.url}`} />
   </div>
   <DocsBody><Content components={useMDXComponents({})}/></DocsBody>
  </DocsPage>
 );
}
