// Build the PR packet from a public GitHub PR URL (ported and simplified from the benchmark
// harness). GITHUB_TOKEN is used when present to lift the rate limit, but public PRs work without.
import type { PrPacket } from "./contracts.js";

function parseGithubPr(url: string): { owner: string; repo: string; number: number } {
  const m = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!m) throw new Error(`not a GitHub PR URL: ${url}`);
  return { owner: m[1], repo: m[2], number: Number(m[3]) };
}

async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 3): Promise<T> {
  let last: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (i === attempts) break;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** (i - 1)));
    }
  }
  throw last;
}

const authHeader = (): Record<string, string> =>
  process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {};

/** Fetch PR metadata + the unified patch, capped to the input contract's bounds. */
export async function fetchPrPacket(url: string, maxFindings = 8): Promise<PrPacket> {
  const { owner, repo, number } = parseGithubPr(url);
  const meta = await withRetry(`meta ${url}`, async () => {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${number}`, {
      headers: { Accept: "application/vnd.github+json", ...authHeader() },
    });
    if (!res.ok) throw new Error(`GitHub ${res.status} for ${url}`);
    return (await res.json()) as { title?: string; body?: string };
  });
  const patch = await withRetry(`patch ${url}`, async () => {
    const res = await fetch(`${url}.patch`, { headers: authHeader() });
    if (!res.ok) throw new Error(`GitHub ${res.status} for ${url}.patch`);
    return res.text();
  });
  return {
    prUrl: url,
    title: (meta.title || "").slice(0, 1024),
    body: (meta.body || "").slice(0, 8192),
    patch: patch.slice(0, 400_000),
    maxFindings,
  };
}
