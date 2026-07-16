// Cloudflare Pages middleware: content negotiation for agents.
// A request to a canonical page URL (e.g. /spec/) carrying `Accept: text/markdown`
// is served the page's Markdown twin instead of HTML — same URL, no .md suffix
// needed. The root splash has no .md twin; its Markdown representation is
// /llms.txt (the docs index). Mirrors Cloudflare's own docs-for-agents
// behaviour, including the x-markdown-tokens hint. The homepage also carries
// Link headers (RFC 8288) pointing agents at the machine-readable entry points.
// Everything else passes straight through.

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
  const url = new URL(request.url);
  const slug = url.pathname.replace(/^\/+|\/+$/g, '');

  // Only page routes — skip any path that's already a file.
  if (
    request.method === 'GET' &&
    prefersMarkdown(request.headers.get('accept')) &&
    !slug.includes('.')
  ) {
    const twin = slug ? `/${slug}.md` : '/llms.txt';
    const md = await env.ASSETS.fetch(new URL(twin, url.origin));
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

  const response = await next();
  if (url.pathname === '/') {
    const out = new Response(response.body, response);
    out.headers.set(
      'link',
      '</llms.txt>; rel="service-doc", </cotal.schema.json>; rel="describedby"',
    );
    // The homepage now negotiates on Accept, so both variants must say so.
    out.headers.append('vary', 'Accept');
    return out;
  }
  return response;
};
