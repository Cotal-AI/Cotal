import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { gzipSync } from "node:zlib";
import { resolveDiscoveryLogin, isDiscoveryName, DISCOVERY_LOGIN_MAX_BYTES } from "../src/discovery-login.js";

// Synthetic trust transport: real HTTP/body/decompression, with requested HTTPS hosts
// mapped explicitly to a local fixture. This does not test TLS certificate validation.
const idp = { url: "https://idp.example/tenant", issuer: "https://issuer.example/realm", audience: "cotal" };
let alias: unknown = { userAuth: { idp } };
let root: unknown = { userAuth: { idp }, discoveryNames: ["mesh.example"] };
let mode = "json";
const calls: string[] = [];
const server = createServer((req, res) => {
  if (mode === "headers-timeout") return;
  if (mode === "body-timeout") { res.writeHead(200); res.write("{"); return; }
  if (mode === "redirect") { res.writeHead(302, { location: "/followed" }); res.end(); return; }
  if (mode === "status") { res.writeHead(503); res.end(); return; }
  if (mode === "json-error") { res.end("<html>"); return; }
  if (mode === "exact-limit") {
    const body = JSON.stringify(req.headers["x-discovery-host"] === "mesh.example" ? alias : root);
    res.end(body + " ".repeat(DISCOVERY_LOGIN_MAX_BYTES - Buffer.byteLength(body)));
    return;
  }
  if (mode === "gzip-large") {
    res.writeHead(200, { "content-encoding": "gzip" });
    res.end(gzipSync(" ".repeat(DISCOVERY_LOGIN_MAX_BYTES + 1)));
    return;
  }
  res.end(JSON.stringify(req.headers["x-discovery-host"] === "mesh.example" ? alias : root));
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
assert(address && typeof address !== "string");
const transport: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  calls.push(url.href);
  assert.equal(url.protocol, "https:");
  assert.equal(url.pathname, "/.well-known/cotal-mesh");
  assert.equal(init?.redirect, "manual");
  assert(init?.signal);
  return fetch(`http://127.0.0.1:${address.port}${url.pathname}`, {
    ...init, headers: { "x-discovery-host": url.hostname },
  });
};
const resolve = (name = "mesh.example") => resolveDiscoveryLogin(name, { fetch: transport });
try {
  for (const name of ["Mesh.example", "https://mesh.example", "mesh.example:443", "mesh.example/", "u@mesh.example", "127.0.0.1", "127.1", "0x7f.1", "::1", "mesh.example.", "-mesh.example", "mesh..example", "mesh_example", " mesh.example", `${"a".repeat(64)}.example`]) {
    assert.equal(isDiscoveryName(name), false, name);
    await assert.rejects(resolve(name), /canonical lowercase DNS/);
  }
  assert.equal(calls.length, 0);
  assert.deepEqual(await resolve(), idp);
  assert.deepEqual(calls, ["https://mesh.example/.well-known/cotal-mesh", "https://issuer.example/.well-known/cotal-mesh"]);
  root = { userAuth: { idp } };
  await assert.rejects(resolve(), /does not authorize/);
  assert.deepEqual(await resolve("issuer.example"), idp);
  root = { userAuth: { idp }, discoveryNames: ["other.example"] };
  await assert.rejects(resolve(), /does not authorize/);
  for (const key of ["url", "issuer", "audience"] as const) {
    root = { userAuth: { idp: { ...idp, [key]: key === "audience" ? "other" : "https://other.example" } }, discoveryNames: ["mesh.example"] };
    await assert.rejects(resolve(), /different IdP pins/);
    const incomplete = { ...idp } as Partial<typeof idp>;
    delete incomplete[key];
    root = { userAuth: { idp: incomplete }, discoveryNames: ["mesh.example"] };
    await assert.rejects(resolve(), /requires userAuth.idp/);
    alias = root;
    const count = calls.length;
    await assert.rejects(resolve(), /requires userAuth.idp/);
    assert.equal(calls.length, count + 1);
    alias = { userAuth: { idp } };
  }
  for (const key of ["url", "issuer"] as const) {
    for (const value of ["http://idp.example", "https://u:p@idp.example", "https://idp.example?", "https://idp.example#", "not-url"]) {
      alias = { userAuth: { idp: { ...idp, [key]: value } } };
      await assert.rejects(resolve());
    }
  }
  alias = { userAuth: { idp } };
  root = { userAuth: { idp }, discoveryNames: ["mesh.example"] };
  mode = "exact-limit";
  assert.deepEqual(await resolve(), idp);
  for (const failure of ["redirect", "status", "json-error", "gzip-large", "headers-timeout", "body-timeout"]) {
    mode = failure;
    const count = calls.length;
    const start = Date.now();
    const reason = failure === "redirect" ? /HTTP 302/ : failure === "status" ? /HTTP 503/ : failure === "gzip-large" ? /exceeds 65536 decoded bytes/ : failure === "json-error" ? /JSON/ : /5000ms|abort/i;
    await assert.rejects(resolve(), reason);
    assert.equal(calls.length, count + 1, `${failure}: no retry or fallback`);
    if (failure.endsWith("timeout")) assert(Date.now() - start < 7_000, `${failure}: finite whole request deadline`);
  }
  console.log("discovery-login smoke passed (synthetic HTTPS mapping, actual HTTP fetch/body fixture)");
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
