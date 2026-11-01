import { source } from '@/lib/source';
import { createFromSource } from 'fumadocs-core/search/server';
export const dynamic = 'force-static';
export const { staticGET: GET } = createFromSource(source, {
 buildIndex: page => ({ id: page.url, title: page.data.title, description: page.data.description,
 breadcrumbs: [page.slugs[0] === 'api-reference' ? 'API Reference' : 'Docs'],
 structuredData: page.data.structuredData, url: page.url }),
});
