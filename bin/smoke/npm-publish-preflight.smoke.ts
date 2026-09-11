/**
 * The release preflight must fail before the first registry write. This suite drives the shipped
 * preflight against a local fake registry and records every request. Clean all-absent full-group
 * state passes after one OIDC exchange per package. A prior partial publish and an incomplete
 * recursive publish set both refuse without any write-shaped request.
 *
 * Run: pnpm smoke:npm-publish-preflight
 * Prove: pnpm mutation-proof --config bin/smoke/mutations/npm-publish-preflight.json
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { preflightNpmPublish } from "../../scripts/preflight-npm-publish.mjs";

let passed = 0;
let failed = 0;
function check(name: string, condition: unknown, detail?: unknown): void {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ FAIL: ${name}`, detail ?? ""); }
}

const fixed = ["@cotal-ai/core", "@cotal-ai/seat", "cotal-ai"];
const workspace = fixed.map((name) => ({ name, version: "9.9.9", path: `/workspace/${name}` }));
const oidcPayload = Buffer.from(JSON.stringify({
  repository: "Cotal-AI/Cotal",
  workflow_ref: "Cotal-AI/Cotal/.github/workflows/changesets.yml@refs/heads/main",
  ref: "refs/heads/main",
  event_name: "push",
  aud: "npm:registry.npmjs.org",
  jti: "fake-jti",
})).toString("base64url");
const idToken = `header.${oidcPayload}.signature`;
const env = {
  GITHUB_REPOSITORY: "Cotal-AI/Cotal",
  GITHUB_REF: "refs/heads/main",
  GITHUB_EVENT_NAME: "push",
  ACTIONS_ID_TOKEN_REQUEST_URL: "",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
};

type Seen = { method: string; url: string };
async function scenario(present: Set<string>, workspacePackages = workspace, exchangeStatus = 201) {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    seen.push({ method: req.method ?? "", url: req.url ?? "" });
    if (req.url?.startsWith("/oidc?")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ value: idToken }));
      return;
    }
    if (req.url?.startsWith("/-/npm/v1/oidc/token/exchange/package/")) {
      res.writeHead(exchangeStatus, { "content-type": "application/json" });
      res.end(JSON.stringify({ token: "opaque-exchange-token" }));
      return;
    }
    const exact = req.url?.match(/^\/(.+)\/9\.9\.9$/)?.[1] ?? "";
    const name = decodeURIComponent(exact);
    res.writeHead(present.has(name) ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify({ name }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const result = await preflightNpmPublish({
      fixedPackages: fixed,
      workspacePackages,
      registryBase: base,
      env: { ...env, ACTIONS_ID_TOKEN_REQUEST_URL: `${base}/oidc` },
      log: () => {},
    });
    return { result, seen, error: undefined };
  } catch (error) {
    return { result: undefined, seen, error };
  } finally {
    server.close();
    await once(server, "close");
  }
}

const clean = await scenario(new Set());
check("clean full-group census passes", clean.result?.state === "ready", clean.error);
check(
  "clean preflight exchanges OIDC for every package before publishing",
  clean.seen.filter((call) => call.url.startsWith("/-/npm/v1/oidc/token/exchange/package/")).length === fixed.length,
  clean.seen,
);
check(
  "clean preflight never sends a registry publish request",
  clean.seen.every((call) => call.method === "GET" || call.method === "POST")
    && clean.seen.every((call) => !call.url.includes("/-/pnpm/v1/publish")),
  clean.seen,
);

const partial = await scenario(new Set(["@cotal-ai/seat"]));
check(
  "one already-published package refuses the whole preflight",
  partial.error instanceof Error && partial.error.message.includes("partial prior publish detected"),
  partial.error,
);
check(
  "partial prior publish refuses before any OIDC exchange or publish call",
  partial.seen.every((call) => !call.url.startsWith("/-/npm/v1/oidc/token/exchange/package/"))
    && partial.seen.every((call) => !call.url.includes("/-/pnpm/v1/publish")),
  partial.seen,
);

const incomplete = await scenario(new Set(), workspace.filter((pkg) => pkg.name !== "@cotal-ai/seat"));
check(
  "one fixed-group package missing from the recursive publish set refuses",
  incomplete.error instanceof Error && incomplete.error.message.includes("fixed packages missing from workspace publish set"),
  incomplete.error,
);
check("incomplete publish set refuses before the fake registry sees any call", incomplete.seen.length === 0, incomplete.seen);

const oidcRefused = await scenario(new Set(), workspace, 401);
check(
  "one refused OIDC exchange refuses the full release",
  oidcRefused.error instanceof Error && oidcRefused.error.message.includes("npm OIDC exchange refused"),
  oidcRefused.error,
);

console.log(`\n${failed === 0 ? "SUITE COMPLETE" : "SUITE FAILED"}: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
