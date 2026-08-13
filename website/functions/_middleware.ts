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

// The hosts whose whole purpose is `curl -fsSL https://get.cotal.ai | sh`. Their root is
// the installer, not a docs page.
const INSTALLER_HOSTS = new Set(['get.cotal.ai', 'install.cotal.ai']);

// Served as text/plain on purpose: a browser renders the installer instead of downloading
// it, so "read it before you pipe it into your shell" is one click, not a saved file.
const installerResponse = (body: string): Response =>
  new Response(body, {
    status: 200,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      // Short, so a fix reaches people quickly; long enough that a launch does not
      // hammer the origin.
      'cache-control': 'public, max-age=300',
      'x-content-type-options': 'nosniff',
      'content-disposition': 'inline; filename="install.sh"',
    },
  });

export const onRequest = async (context: Ctx): Promise<Response> => {
  const { request, env, next } = context;
  const url = new URL(request.url);
  const slug = url.pathname.replace(/^\/+|\/+$/g, '');

  // get.cotal.ai/ and install.cotal.ai/ are the installer. Checked before content
  // negotiation so a client sending `Accept: text/markdown` still gets the script.
  if (INSTALLER_HOSTS.has(url.hostname) && (slug === '' || slug === 'install.sh')) {
    const sh = await env.ASSETS.fetch(new URL('/install.sh', url.origin));
    if (sh.ok) return installerResponse(await sh.text());
  }

  // /install.sh on any host: same script, same readable content type.
  if (slug === 'install.sh') {
    const sh = await next();
    if (sh.ok) return installerResponse(await sh.text());
    return sh;
  }

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
