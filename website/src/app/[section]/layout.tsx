import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { source } from '@/lib/source';

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <DocsLayout
      tree={source.getPageTree()}
      tabMode="top"
      tabs={[
        { title: 'Docs', url: '/docs/what-is-cotal/', urls: new Set(source.getPages().filter(page => page.slugs[0] === 'docs').map(page => page.url)) },
        { title: 'API Reference', url: '/api-reference/cli/', urls: new Set(source.getPages().filter(page => page.slugs[0] === 'api-reference').map(page => page.url)) },
      ]}
      nav={{
        title: <><img src="/favicon.svg" width="24" height="24" alt="" /> Cotal</>,
        url: '/docs/what-is-cotal/',
      }}
      githubUrl="https://github.com/Cotal-AI/Cotal"
    >
      {children}
    </DocsLayout>
  );
}
