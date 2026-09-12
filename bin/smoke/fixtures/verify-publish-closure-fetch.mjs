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
  const version = decoded.slice(decoded.lastIndexOf("/") + 1);
  if (missing.has(name)) {
    return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
  }
  // A 200 must carry a body that identifies the package at the requested version, or the gate
  // treats it as no-evidence (#1257). The fixture returns the minimum viable body.
  const body = JSON.stringify({ name, version });
  return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
};
