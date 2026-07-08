// Per-page raw Markdown endpoint: every doc page is also fetchable as `<page>.md`.
// This is mechanism A (URL suffix). Mechanism B (Accept: text/markdown on the
// canonical URL) is layered on at the edge in functions/_middleware.ts.
import type { APIRoute, GetStaticPaths } from 'astro';
import { getCollection } from 'astro:content';
import { AGENT_PROMPT } from '../prompt';

const isIndex = (id: string) => id === '' || id === 'index';

// The Quickstart is synced as MDX so its prompt fence renders as the
// interactive card; its twin must stay clean Markdown, so restore the fence.
const PROMPT_FENCE = '```text wrap\n' + AGENT_PROMPT + '\n```';
function restorePrompt(body: string): string {
  const restored = body
    .replace(/^import AgentPrompt from[^\n]*\n+/m, '')
    .replace('<AgentPrompt />', PROMPT_FENCE);
  if (restored.includes('AgentPrompt'))
    throw new Error('unrestored AgentPrompt component in a Markdown twin');
  return restored;
}

export const getStaticPaths: GetStaticPaths = async () => {
  const docs = await getCollection('docs');
  return docs
    .filter((entry) => !isIndex(entry.id))
    .map((entry) => ({ params: { slug: entry.id }, props: { entry } }));
};

export const GET: APIRoute = ({ props }) => {
  const { entry } = props as { entry: { id: string; body?: string; data: { title?: string } } };
  const title = entry.data.title ?? entry.id;
  const body = restorePrompt((entry.body ?? '').trim());
  const markdown = `# ${title}\n\n${body}\n`;
  return new Response(markdown, {
    headers: {
      'content-type': 'text/markdown; charset=utf-8',
      // Token-count metrics, mirroring Cloudflare's docs-for-agents headers.
      'x-markdown-tokens': String(estimateTokens(markdown)),
    },
  });
};

// Rough token estimate (~4 chars/token) — cheap signal for agents budgeting context.
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
