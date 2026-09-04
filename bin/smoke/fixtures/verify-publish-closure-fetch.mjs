/**
 * Fixture registry for the shipped `verify-publish-closure` command, loaded into the child with
 * `--import` so the gate's real entry point runs against a controlled registry rather than npm.
 *
 * An in-process HTTP server cannot serve this: the suite drives the gate with `spawnSync`, which
 * blocks the parent's event loop, so a server in the parent would never answer and the child would
 * poll until its deadline. Patching `fetch` in the child avoids that entirely and keeps the
 * production code free of any test-only seam.
 *
 * SMOKE_CLOSURE_MISSING — comma-separated package names that answer 404. Everything else answers
 * 200. Empty or unset means the whole closure is live.
 */
const missing = new Set(
  (process.env.SMOKE_CLOSURE_MISSING ?? "").split(",").map((s) => s.trim()).filter(Boolean),
);

globalThis.fetch = async (url) => {
  const path = String(url);
  // The gate percent-encodes a scoped name into the path; decode so the fixture can match on the
  // package name the test actually named.
  const decoded = decodeURIComponent(path.slice(path.indexOf("/", path.indexOf("://") + 3)));
  const name = decoded.slice(1, decoded.lastIndexOf("/"));
  return new Response("{}", {
    status: missing.has(name) ? 404 : 200,
    headers: { "content-type": "application/json" },
  });
};
