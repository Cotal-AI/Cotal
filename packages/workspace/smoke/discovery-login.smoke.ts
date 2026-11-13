import assert from "node:assert/strict";
import { resolveDiscoveryLogin, isDiscoveryName } from "../src/discovery-login.js";

const pins = { url: "https://native.example/api/auth", issuer: "https://issuer.example/realm", audience: "resource" };
let typedPins = pins;
let root: unknown = { userAuth: { idp: pins }, discoveryNames: ["product.example"] };
const calls: string[] = [];
const transport: typeof fetch = async (input, init) => {
  const url = String(input);
  calls.push(url);
  assert.equal(init?.redirect, "manual");
  assert.equal(init?.headers, undefined);
  assert(init?.signal);
  return new Response(JSON.stringify(url.includes("product.example") ? { userAuth: { idp: typedPins } } : root));
};
const resolve = (name = "product.example") => resolveDiscoveryLogin(name, { fetch: transport });
for (const invalid of ["https://product.example", "Product.example", "product.example:443", "127.1", "0x7f.1", "product.example.", "product..example", ""]) {
  assert.equal(isDiscoveryName(invalid), false);
  await assert.rejects(resolve(invalid), /canonical lowercase DNS/);
}
assert.equal(calls.length, 0);
assert.deepEqual(await resolve(), pins, "issuer and current auth origin may differ");
assert.deepEqual(calls, ["https://product.example/.well-known/cotal-mesh", "https://issuer.example/.well-known/cotal-mesh"]);
root = { userAuth: { idp: pins } };
await assert.rejects(resolve(), /issuer https:\/\/issuer.example does not authorize discovery name product.example/);
assert.deepEqual(await resolve("issuer.example"), pins, "the issuer hostname needs no listing");
typedPins = { ...pins, url: "https://product.example/api/auth" };
root = { userAuth: { idp: pins }, discoveryNames: ["product.example"] };
assert.deepEqual(await resolve(), typedPins, "return typed-root pins on its own origin");
for (const url of ["https://third.example/api/auth", "https://product.example:8443/api/auth", "https://native.example/other"]) {
  typedPins = { ...pins, url };
  await assert.rejects(resolve(), /own origin or match issuer/);
}
typedPins = pins;
for (const key of ["issuer", "audience"] as const) {
  root = { userAuth: { idp: { ...pins, [key]: key === "audience" ? "other" : "https://other.example" } }, discoveryNames: ["product.example"] };
  await assert.rejects(resolve(), /product.example.*issuer.example.*different IdP pins/);
}
for (const response of [new Response("{}", { status: 302 }), new Response("{}", { status: 503 }), new Response(" ".repeat(65_537)), new Response("<html>")]) {
  let count = 0;
  await assert.rejects(resolveDiscoveryLogin("product.example", { fetch: async () => { count++; return response; } }));
  assert.equal(count, 1, "no retry or redirect fallback");
}
for (const phase of ["headers", "body"]) {
  const start = Date.now();
  await assert.rejects(resolveDiscoveryLogin("product.example", { fetch: async () => {
    if (phase === "headers") return new Promise<Response>(() => {});
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("{")); } }));
  } }), /exceeded 5000ms/);
  assert.ok(Date.now() - start < 7_000, `${phase} deadline is bounded`);
}
console.log("PASS credential-free issuer-endorsed discovery and canonical origin separation");
