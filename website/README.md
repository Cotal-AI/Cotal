# Cotal docs site

Astro [Starlight](https://starlight.astro.build/) site for Cotal's documentation,
built to be **agent-native** — the docs a protocol for agents ships should be
readable by agents.

The canonical Markdown stays in [`/docs`](../docs) and [`/SPEC.md`](../SPEC.md);
this site renders it. `scripts/sync-docs.mjs` derives a frontmatter title from each
file's first H1 and rewrites `*.md` cross-links to site routes, then writes the
result into `src/content/docs/` (git-ignored). Edit the source files, not the
generated copies.

## Develop

```sh
npm install --legacy-peer-deps   # plugin's Astro peer range lags; it works on 7
npm run dev                      # syncs docs, then starts Astro
npm run build                    # syncs docs, then builds to dist/
```

## Agent-native surface

Every feature below is generated at build time, served at the edge, or drift-guarded
by `scripts/check-dist.mjs`.

| Endpoint | Source |
| --- | --- |
| `/llms.txt`, `/llms-full.txt`, `/llms-small.txt` | [`starlight-llms-txt`](https://github.com/delucis/starlight-llms-txt) plugin |
| `/<page>.md` (raw Markdown per page) | `src/pages/[...slug].md.ts` |
| `<link rel="alternate" type="text/markdown">` in each page head | `src/components/Head.astro` |
| `Accept: text/markdown` on a canonical URL → Markdown + `x-markdown-tokens` (on `/` it returns the `/llms.txt` index) | `functions/_middleware.ts` (Cloudflare Pages) |
| `Link` headers on the homepage (`service-doc`, `describedby`; RFC 8288) | `functions/_middleware.ts` |
| `/robots.txt` (wildcard crawl rules, Content Signals, sitemap pointer) | `public/robots.txt` |
| `/install.sh`, and the root of `get.cotal.ai` / `install.cotal.ai`, served as `text/plain` so it reads in a browser | `/install.sh` at the repo root, copied by `scripts/sync-docs.mjs`; host routing in `functions/_middleware.ts` |
| `/.well-known/agent-skills/` (Agent Skills + discovery index with sha256 digests) | `public/.well-known/agent-skills/` + `scripts/sync-docs.mjs` |
| `/docs-for-agents` (human/agent-readable guide to the above) | `src/content/docs/docs-for-agents.mdx` |

Verify locally against the real Pages runtime:

```sh
npm run build
npx wrangler pages dev
curl -H "Accept: text/markdown" http://127.0.0.1:8788/spec/   # -> Markdown
curl http://127.0.0.1:8788/spec.md                            # -> Markdown
curl http://127.0.0.1:8788/llms.txt                           # -> index
```

## Deploy (Cloudflare Pages)

- **Root directory:** `website`
- **Build command:** `npm run build`
- **Output directory:** `dist`
- **Install command:** `npm install --legacy-peer-deps`

`functions/` (the `Accept` negotiation) and `public/_routes.json` (which limits the
function to page routes, keeping it off static assets) are picked up automatically.
Set `site` in `astro.config.mjs` to the production origin so `llms.txt` links and the
sitemap are absolute.

## Not yet built: docs MCP server

The top tier of agent-native — letting an agent query these docs as a *tool* rather
than fetching files — is a separate remote MCP server (a Cloudflare Worker). It would
read `llms-full.txt` / the per-page `.md` and expose `search_docs` / `get_page`
tools. Tracked as a follow-up.
