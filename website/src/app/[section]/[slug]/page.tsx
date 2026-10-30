import { notFound } from 'next/navigation';
import { source } from '@/lib/source';
import { DocsPage, DocsBody, DocsTitle } from 'fumadocs-ui/layouts/docs/page';
import { useMDXComponents } from '../../../../mdx-components';
export const dynamicParams = false;
export function generateStaticParams() { return source.getPages().map(p => ({ section: p.slugs[0], slug: p.slugs[1] })); }
type Props = { params: Promise<{ section: string; slug: string }> };
export async function generateMetadata({params}:Props) {
 const {section,slug}=await params; const page=source.getPage([section,slug]); if(!page) notFound();
 return {title: `${page.data.title} | Cotal`,description:page.data.description,alternates:{canonical:`https://docs.cotal.ai/${section}/${slug}/`,types:{'text/markdown':`/${section}/${slug}.md`}}};
}
export default async function Page({params}:Props) {
 const {section,slug}=await params; const page=source.getPage([section,slug]); if(!page) notFound();
 const Content=page.data.body;
 return <DocsPage toc={page.data.toc}><DocsTitle>{page.data.title}</DocsTitle><DocsBody><Content components={useMDXComponents({})}/></DocsBody></DocsPage>;
}
