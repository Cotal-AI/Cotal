/** Shared IdP policy through its workspace, manifest and auth callers. No network or state. */
import nodeAssert from "node:assert/strict";
import { normalizeIdpUrl } from "@cotal-ai/auth";
import { checkIdpUrl } from "@cotal-ai/workspace";
import { countedAssert, emitSentinel } from "@cotal-ai/smoke-kit";
import { idpUrlProblem, resolveManifest } from "../src/lib/manifest/resolve.js";

const counted = countedAssert(nodeAssert);
const assert: typeof nodeAssert = counted.assert;
const scheme = "must be https (or http on a loopback IP literal such as 127.0.0.1 for local dev)";
const query = "must not carry a query or fragment";
const source = (value: string): string =>
  `apiVersion: cotal/v1\nkind: Mesh\nspace: idp_probe\nbroker:\n  auth: user\n  idp: ${JSON.stringify(value)}\nchannels: {}\n`;

const refused = [
  { value: "not-a-url", reason: "invalid-url", manifest: "is not a valid URL (Better Auth: <origin>/api/auth)", auth: 'idp url "not-a-url" is not a valid URL' },
  ...["http://example.test/api/auth", "http://localhost/api/auth", "ftp://idp.example.invalid/api/auth"].map(value =>
    ({ value, reason: "scheme", manifest: scheme, auth: `idp url ${scheme} - got "${value}"` })),
  ...["https://idp.example.invalid/api/auth?tenant=a%2Fb#fragment", "https://idp.example.invalid/api/auth?tenant=a", "https://idp.example.invalid/api/auth#fragment"].map(value =>
    ({ value, reason: "query-or-fragment", manifest: query, auth: `idp url ${query} - got "${value}"` })),
  { value: "https://fixture:canary@idp.example.invalid/api/auth", reason: "credentials", manifest: "must not embed credentials - give the IdP base URL only", auth: 'idp url must not embed credentials before the host - the host it would actually contact is "idp.example.invalid"' },
];
for (const row of refused) {
  const checked = checkIdpUrl(row.value);
  assert.equal(checked.ok, false);
  if (checked.ok) throw new Error("expected refusal");
  assert.equal(checked.reason, row.reason);
  assert.equal(idpUrlProblem(row.value, "broker.idp"), `broker.idp ${row.manifest}`);
  assert.equal(idpUrlProblem(row.value, "--idp"), `--idp ${row.manifest}`);
  assert.throws(() => normalizeIdpUrl(row.value), { message: row.auth });
  assert.throws(() => resolveManifest(source(row.value), "fixture.yaml"), error =>
    error instanceof Error && error.message.includes(`broker.idp ${row.manifest}`));
}

for (const [value, normalized] of [
  ["https://idp.example.invalid/api/auth", "https://idp.example.invalid/api/auth"],
  ["https://idp.example.invalid/api/auth///", "https://idp.example.invalid/api/auth"],
  ["http://127.0.0.1:1234/api/auth", "http://127.0.0.1:1234/api/auth"],
  ["http://[::1]:1234/api/auth/", "http://[::1]:1234/api/auth"],
  ["HTTPS://IDP.EXAMPLE.INVALID:443/api/auth/", "https://idp.example.invalid/api/auth"],
  ["https://idp.example.invalid/api/auth?", "https://idp.example.invalid/api/auth"],
  ["https://idp.example.invalid/api/auth#", "https://idp.example.invalid/api/auth"],
]) {
  const checked = checkIdpUrl(value);
  assert.equal(checked.ok, true);
  if (!checked.ok) throw new Error("expected accepted URL");
  assert.equal(checked.url.href, new URL(value).href);
  assert.equal(idpUrlProblem(value, "broker.idp"), undefined);
  assert.equal(normalizeIdpUrl(value), normalized);
  assert.equal(resolveManifest(source(value), "fixture.yaml").broker?.idp, value);
}

// Preserve refusal precedence when more than one rule applies.
assert.deepEqual(checkIdpUrl("ftp://fixture:canary@idp.example.invalid/auth?q=1"), { ok: false, reason: "scheme" });
assert.deepEqual(checkIdpUrl("https://fixture:canary@idp.example.invalid/auth?q=1"), { ok: false, reason: "query-or-fragment" });
const credentials = checkIdpUrl("https://fixture:canary@idp.example.invalid/auth");
assert.deepEqual(credentials, { ok: false, reason: "credentials", host: "idp.example.invalid" });
assert.ok(!JSON.stringify(credentials).includes("canary"));

emitSentinel({ passed: counted.cells(), failed: 0 });
