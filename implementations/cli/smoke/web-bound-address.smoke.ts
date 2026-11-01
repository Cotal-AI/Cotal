/** Recorded dashboard URLs used by status and its readiness probe. No listener or broker starts. */
import nodeAssert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countedAssert, emitSentinel } from "@cotal-ai/smoke-kit";
import { webBoundAddress } from "../src/lib/status.js";

const counted = countedAssert(nodeAssert);
const assert: typeof nodeAssert = counted.assert;
const root = mkdtempSync(join(tmpdir(), "cotal-web-bound-address-"));
const path = join(root, "web.session");
try {
  assert.equal(webBoundAddress(path), undefined, "an absent session has no invented URL");
  for (const [host, port, url] of [
    ["127.0.0.1", 8123, "http://127.0.0.1:8123/"],
    ["dashboard.example", 8123, "http://dashboard.example:8123/"],
    ["::1", 8123, "http://[::1]:8123/"],
    ["2001:db8::10", 8123, "http://[2001:db8::10]:8123/"],
    ["127.0.0.1", 7799, "http://127.0.0.1:7799/"],
  ] as const) {
    writeFileSync(path, JSON.stringify({ host, port, readiness: "fixture-readiness", launchUrl: `${url}?k=fixture` }), { mode: 0o600 });
    const bound = webBoundAddress(path);
    assert.deepEqual(bound, { host, port, url, readiness: "fixture-readiness" }, `${host}:${port} preserves its recorded address and readiness`);
    assert.equal(new URL("api/meta", bound!.url).href, `${url}api/meta`, "the bound URL remains a base for the readiness path");
  }
  writeFileSync(path, "");
  assert.equal(webBoundAddress(path), undefined, "a truncated session has no URL");
  writeFileSync(path, JSON.stringify({ host: "::1", port: 8123 }));
  assert.equal(webBoundAddress(path), undefined, "a session without readiness is incomplete");
  assert.throws(() => webBoundAddress(root), "an unreadable session is not treated as absent");
} finally {
  rmSync(root, { recursive: true, force: true });
}
emitSentinel({ passed: counted.cells(), failed: 0 });
