import index from '../src/generated/search-index.json';

// Documentation MCP server for docs.cotal.ai, at https://docs.cotal.ai/mcp.
// The "learn" surface next to the product server on cotal.ai/mcp (the "do"
// surface): search the docs, list the pages, read any page as markdown.
//
// Stateless Streamable HTTP (MCP 2025-03-26 and later): every POST carries one
// JSON-RPC message or a batch and gets a JSON answer; notifications get 202.
// No session, no SSE stream, no credentials. The search index is generated at
// build time by scripts/sync-docs.mjs; page bodies come from each page's .md
// twin through the static assets binding, so the server always serves the
// deployed docs.

interface Env {
  ASSETS: { fetch: (input: Request | string | URL) => Promise<Response> };
}
type Ctx = { request: Request; env: Env };

type Page = { slug: string; title: string; section: string; url: string; headings: string[]; text: string };
const PAGES = index as Page[];
const ORIGIN = 'https://docs.cotal.ai';
const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];
const SERVER_INFO = { name: 'cotal-docs', title: 'Cotal documentation', version: '1.0.0' };

const INSTRUCTIONS = [
  'Documentation server for Cotal, the open protocol that lets AI agents from any vendor work as one team over NATS + JetStream.',
  'Use search_docs to find the page that answers a question, then get_docs_page to read it. list_docs_pages gives the whole table of contents.',
  'The wire specification (/docs/spec/) is normative where other pages disagree. Roadmap content is not shipped behavior.',
  'This server only reads documentation. To act on cotal.ai (feedback, waitlist, a call with the founders) use the product server at https://cotal.ai/mcp.',
].join(' ');

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const pageResult = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Page title.' },
    section: { type: 'string', description: 'Docs section, e.g. docs or api-reference.' },
    url: { type: 'string', description: 'Canonical HTML URL.' },
    markdown_url: { type: 'string', description: 'Markdown twin of the page.' },
  },
  required: ['title', 'section', 'url', 'markdown_url'],
};

const TOOLS = [
  {
    name: 'search_docs',
    title: 'Search the Cotal docs',
    description:
      'Keyword search over every page of the Cotal documentation (guides, API reference, wire specification). Use it first to find the page that answers a question. Returns ranked pages with title, URLs, score and a short excerpt; read one with get_docs_page.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 2, maxLength: 200, description: "Search terms, e.g. 'anycast', 'identity credentials', 'define a team'." },
        limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Maximum results (default 8).' },
      },
      required: ['query'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The query as searched.' },
        results: {
          type: 'array',
          items: {
            ...pageResult,
            properties: {
              ...pageResult.properties,
              score: { type: 'number', description: 'Relevance; higher is better.' },
              excerpt: { type: 'string', description: 'Where the terms appear, or the page opening.' },
            },
            required: [...pageResult.required, 'score', 'excerpt'],
          },
        },
      },
      required: ['query', 'results'],
    },
    annotations: READ_ONLY,
  },
  {
    name: 'get_docs_page',
    title: 'Read a Cotal docs page',
    description:
      'Reads one page of the Cotal documentation as markdown. Use it after search_docs or list_docs_pages has given you a page. Accepts a slug (getting-started), a path (/docs/getting-started/) or a full docs.cotal.ai URL. Returns the title, URLs and the markdown body.',
    inputSchema: {
      type: 'object',
      properties: {
        page: { type: 'string', minLength: 1, maxLength: 300, description: "Slug, path or URL of the page, e.g. 'getting-started' or 'https://docs.cotal.ai/docs/spec/'." },
        max_chars: { type: 'integer', minimum: 1000, maximum: 200000, description: 'Cut the markdown after this many characters (default 60000); truncated is true when cut.' },
      },
      required: ['page'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        ...pageResult.properties,
        markdown: { type: 'string', description: 'The page as markdown.' },
        truncated: { type: 'boolean', description: 'true when max_chars cut the page.' },
      },
      required: [...pageResult.required, 'markdown', 'truncated'],
    },
    annotations: READ_ONLY,
  },
  {
    name: 'list_docs_pages',
    title: 'List the Cotal docs pages',
    description:
      'Lists every page of the Cotal documentation, in navigation order, optionally for one section. Use it to see what the docs cover or to pick a page by title. Returns title, section and URLs for each page.',
    inputSchema: {
      type: 'object',
      properties: {
        section: { type: 'string', description: "Only pages of this section, e.g. 'docs' or 'api-reference'. Omit for all." },
      },
    },
    outputSchema: {
      type: 'object',
      properties: {
        sections: { type: 'array', items: { type: 'string' }, description: 'Every section name.' },
        pages: { type: 'array', items: pageResult },
      },
      required: ['sections', 'pages'],
    },
    annotations: READ_ONLY,
  },
] as const;

const RESOURCES = [
  { uri: `${ORIGIN}/llms.txt`, name: 'llms-txt', title: 'Cotal docs index (llms.txt)', description: 'Every page with its markdown URL, and task routing.', mimeType: 'text/plain' },
  { uri: `${ORIGIN}/prompt.md`, name: 'agent-setup-prompt', title: 'Agent setup prompt', description: 'Instructions an agent follows to install Cotal and put itself on a mesh.', mimeType: 'text/markdown' },
];

const describe = (page: Page) => ({
  title: page.title,
  section: page.section,
  url: `${ORIGIN}${page.url}`,
  markdown_url: `${ORIGIN}${page.url.slice(0, -1)}.md`,
});

function search(query: string, limit: number) {
  const terms = query.toLowerCase().split(/[^a-z0-9_.-]+/).filter(term => term.length > 1);
  if (!terms.length) return [];
  const scored = PAGES.map(page => {
    const title = page.title.toLowerCase();
    const headings = page.headings.join(' \n ').toLowerCase();
    const text = page.text.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (title.includes(term)) score += 6;
      if (page.slug.includes(term)) score += 3;
      if (headings.includes(term)) score += 3;
      let at = text.indexOf(term), hits = 0;
      while (at >= 0 && hits < 10) { hits++; at = text.indexOf(term, at + term.length); }
      score += hits;
    }
    if (terms.length > 1 && text.includes(terms.join(' '))) score += 4;
    return { page, score };
  }).filter(hit => hit.score > 0);
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(({ page, score }) => {
    const at = page.text.toLowerCase().indexOf(terms[0]);
    const start = Math.max(0, at - 80);
    const excerpt = (at >= 0 ? (start ? '…' : '') + page.text.slice(start, start + 240) : page.text.slice(0, 240)) + '…';
    return { ...describe(page), score, excerpt };
  });
}

function findPage(ref: string): Page | undefined {
  let path = ref.trim();
  try { if (/^https?:\/\//.test(path)) path = new URL(path).pathname; } catch { /* keep as is */ }
  path = path.replace(/\.md$/, '').replace(/^\/+|\/+$/g, '');
  return PAGES.find(page => page.slug === path || page.url === `/${path}/` || page.url.endsWith(`/${path}/`));
}

class ToolError extends Error {}

async function callTool(env: Env, name: string, args: Record<string, unknown>) {
  switch (name) {
    case 'search_docs': {
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      if (query.length < 2) throw new ToolError('query must be at least 2 characters');
      const limit = Math.min(Math.max(Number(args.limit) || 8, 1), 20);
      return { query, results: search(query, limit) };
    }
    case 'get_docs_page': {
      const ref = typeof args.page === 'string' ? args.page : '';
      const page = ref && findPage(ref);
      if (!page) throw new ToolError(`no docs page matches "${ref}"; find one with search_docs or list_docs_pages`);
      const res = await env.ASSETS.fetch(new URL(`${page.url.slice(0, -1)}.md`, ORIGIN));
      if (!res.ok) throw new ToolError(`could not read ${page.url} (HTTP ${res.status})`);
      const markdown = await res.text();
      const max = Math.min(Math.max(Number(args.max_chars) || 60000, 1000), 200000);
      return { ...describe(page), markdown: markdown.slice(0, max), truncated: markdown.length > max };
    }
    case 'list_docs_pages': {
      const sections = [...new Set(PAGES.map(page => page.section))];
      const section = typeof args.section === 'string' && args.section ? args.section : undefined;
      if (section && !sections.includes(section)) throw new ToolError(`unknown section "${section}"; sections: ${sections.join(', ')}`);
      return { sections, pages: PAGES.filter(page => !section || page.section === section).map(describe) };
    }
    default:
      return undefined;
  }
}

type RpcMessage = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };

async function handle(env: Env, msg: RpcMessage): Promise<object | null> {
  const isRequest = msg.id !== undefined && msg.id !== null;
  const ok = (result: object) => ({ jsonrpc: '2.0', id: msg.id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: '2.0', id: msg.id ?? null, error: { code, message } });
  if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return fail(-32600, 'Invalid Request');
  if (!isRequest) return null; // notifications (initialized, cancelled…) need no answer

  const params = msg.params ?? {};
  switch (msg.method) {
    case 'initialize': {
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      return ok({
        protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[1],
        capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: TOOLS });
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments && typeof params.arguments === 'object' ? params.arguments : {}) as Record<string, unknown>;
      try {
        const result = await callTool(env, name, args);
        if (result === undefined) return fail(-32602, `Unknown tool: ${name}`);
        const text = name === 'get_docs_page' && 'markdown' in result ? (result.markdown as string) : JSON.stringify(result, null, 2);
        return ok({ content: [{ type: 'text', text }], structuredContent: result, isError: false });
      } catch (error) {
        if (error instanceof ToolError) return ok({ content: [{ type: 'text', text: error.message }], isError: true });
        throw error;
      }
    }
    case 'resources/list':
      return ok({ resources: RESOURCES });
    case 'resources/read': {
      const uri = typeof params.uri === 'string' ? params.uri : '';
      const resource = RESOURCES.find(r => r.uri === uri);
      if (!resource) return fail(-32602, `Unknown resource: ${uri}`);
      const res = await env.ASSETS.fetch(new URL(new URL(uri).pathname, ORIGIN));
      return ok({ contents: [{ uri, mimeType: resource.mimeType, text: await res.text() }] });
    }
    case 'prompts/list':
      return ok({ prompts: [] });
    default:
      return fail(-32601, `Method not found: ${msg.method}`);
  }
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, GET, OPTIONS',
  'access-control-allow-headers': 'content-type, accept, authorization, mcp-session-id, mcp-protocol-version, last-event-id',
  'access-control-expose-headers': 'mcp-session-id, mcp-protocol-version',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS } });

export const onRequest = async ({ request, env }: Ctx): Promise<Response> => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...CORS, 'access-control-max-age': '86400' } });
  if (request.method !== 'POST') {
    // No server-initiated stream: Streamable HTTP lets a server answer GET with 405.
    return new Response(
      'Cotal documentation MCP server (Streamable HTTP). POST JSON-RPC to this URL; tools: search_docs, get_docs_page, list_docs_pages. Index: https://docs.cotal.ai/llms.txt\n',
      { status: 405, headers: { allow: 'POST, OPTIONS', 'content-type': 'text/plain; charset=utf-8', ...CORS } },
    );
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400);
  }
  try {
    if (Array.isArray(body)) {
      const answers = (await Promise.all(body.map(msg => handle(env, msg as RpcMessage)))).filter(Boolean);
      return answers.length ? json(answers) : new Response(null, { status: 202, headers: CORS });
    }
    const answer = await handle(env, body as RpcMessage);
    return answer ? json(answer) : new Response(null, { status: 202, headers: CORS });
  } catch {
    return json({ jsonrpc: '2.0', id: (body as RpcMessage)?.id ?? null, error: { code: -32603, message: 'Internal error' } }, 500);
  }
};
