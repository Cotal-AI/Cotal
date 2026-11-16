import assert from "node:assert/strict";
import { resolveNativeMigration } from "../src/native-migration.js";

// Synthetic fetch only. No Cloud login, tokens, DNS or live HTTPS is exercised here.
const pins = { url: "https://old.example/api/auth", issuer: "https://old.example", audience: "fixture" };
const origin = "https://canonical.example";
const old = () => ({ userAuth: { idp: { ...pins } }, nativeMigration: { version: 1, origin } });
const canonical = () => ({
  space: "fixture", server: "tls://broker.other.example:4222", tlsRequired: true, sentinelCreds: "fixture",
  userAuth: { provider: "fixture", idp: { ...pins, url: `${origin}/api/auth` }, endpoints: {
    url: `${origin}/exchange`, agentProvisioningUrl: `${origin}/agents`, managerAuthorityUrl: `${origin}/manager`,
  } }, nativeMetadata: { retained: true },
});
function adapter(first: unknown = old(), second: unknown = canonical()): typeof fetch {
  let calls = 0;
  return async (input, init) => {
    assert.equal(String(input), `${calls++ === 0 ? pins.issuer : origin}/.well-known/cotal-mesh`);
    assert.equal(init?.redirect, "manual");
    assert.equal(init?.credentials, "omit");
    assert.equal(init?.headers, undefined);
    assert.equal(init?.body, undefined);
    const value = calls === 1 ? first : second;
    return value instanceof Response ? value : Response.json(value);
  };
}
const resolved = await resolveNativeMigration(pins, adapter());
assert.deepEqual(resolved.oldRootPins, pins);
assert.deepEqual(resolved.endorsement, { version: 1, origin });
assert.deepEqual(resolved.raw.nativeMetadata, { retained: true });
assert.equal(resolved.bundle.server, canonical().server);
for (const nativeMigration of [undefined, null, {}, { version: 2, origin }, { version: 1, origin: pins.issuer },
  ...[`${origin}/`, `${origin}/path`, `${origin}?`, `${origin}#`, "http://canonical.example", "https://user:pass@canonical.example", "https://CANONICAL.example", "https://canonical.example:443"].map(origin => ({ version: 1, origin }))]) {
  await assert.rejects(resolveNativeMigration(pins, adapter({ ...old(), nativeMigration })));
}
for (const key of ["url", "issuer", "audience"] as const) {
  const doc = old();
  doc.userAuth.idp[key] += "changed";
  await assert.rejects(resolveNativeMigration(pins, adapter(doc)), /old root IdP pins/);
  const next = canonical();
  next.userAuth.idp[key] = key === "url" ? "https://outsider.example/auth" : "changed";
  await assert.rejects(resolveNativeMigration(pins, adapter(old(), next)), /canonical IdP pins/);
}
for (const key of ["url", "agentProvisioningUrl", "managerAuthorityUrl"] as const) {
  for (const endpoint of ["https://outsider.example", "http://canonical.example", "https://user@canonical.example", ""]) {
    const next = canonical();
    next.userAuth.endpoints[key] = endpoint;
    await assert.rejects(resolveNativeMigration(pins, adapter(old(), next)));
  }
}
const oldJson = JSON.stringify(old());
await resolveNativeMigration(pins, adapter(new Response(oldJson + " ".repeat(65_536 - Buffer.byteLength(oldJson)))));
await assert.rejects(resolveNativeMigration(pins, adapter(old(), new Response(" ".repeat(65_537)))), /64 KiB/);
await assert.rejects(resolveNativeMigration(pins, adapter(old(), {})), /canonical bundle/);
for (const response of [new Response("not JSON"), new Response("{}", { status: 302 }), new Response("", { status: 503 }),
  new Response("é".repeat(32_769)), new Response(" ".repeat(65_537), { headers: { "content-length": "2" } })]) {
  await assert.rejects(resolveNativeMigration(pins, adapter(response)));
}
await assert.rejects(resolveNativeMigration(pins, adapter(old(), new Response("", { status: 307 }))), /redirect/);
await assert.rejects(resolveNativeMigration({ ...pins, issuer: "http://127.0.0.1" }, adapter()), /HTTPS/);
// The full five-second body deadline, not merely a response-header timeout.
let cancelled = false;
const stalled = new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }));
await assert.rejects(resolveNativeMigration(pins, adapter(stalled)), /5s deadline/);
assert.equal(cancelled, true);
await assert.rejects(resolveNativeMigration(pins, async () => new Promise<Response>(() => {})), /5s deadline/);
console.log("PASS native migration synthetic endorsement, pins, origins, body bounds and deadlines");
