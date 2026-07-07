// Cloudflare Pages middleware: content negotiation for agents.
// A request to a canonical page URL (e.g. /spec/) carrying `Accept: text/markdown`
// is served the page's Markdown twin instead of HTML — same URL, no .md suffix
// needed. Mirrors Cloudflare's own docs-for-agents behaviour, including the
// x-markdown-tokens hint. Everything else passes straight through.

interface Env {
  ASSETS: { fetch: (input: Request | string | URL) => Promise<Response> };
}
type Ctx = {
  request: Request;
  env: Env;
  next: () => Promise<Response>;
};

const prefersMarkdown = (accept: string | null): boolean =>
  !!accept && /\btext\/markdown\b/i.test(accept);

export const onRequest = async (context: Ctx): Promise<Response> => {
  const { request, env, next } = context;

  if (request.method === 'GET' && prefersMarkdown(request.headers.get('accept'))) {
    const url = new URL(request.url);
    const slug = url.pathname.replace(/^\/+|\/+$/g, '');
    // Only page routes — skip the root splash and any path that's already a file.
    if (slug && !slug.includes('.')) {
      const md = await env.ASSETS.fetch(new URL(`/${slug}.md`, url.origin));
      if (md.ok) {
        const body = await md.text();
        return new Response(body, {
          status: 200,
          headers: {
            'content-type': 'text/markdown; charset=utf-8',
            'x-markdown-tokens': String(Math.ceil(body.length / 4)),
            vary: 'Accept',
            'cache-control': 'public, max-age=3600',
          },
        });
      }
    }
  }

  return next();
};
