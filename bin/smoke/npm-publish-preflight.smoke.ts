/**
 * The release preflight must fail before the first registry write. This suite drives the shipped
 * preflight against a local fake registry and records every request. Clean all-absent full-group
 * state passes only after an OIDC exchange AND a GET-trust direct-publish census for every package.
 * A prior partial publish, an incomplete recursive publish set, a refused exchange, and a
 * stage-only Allowed-actions sibling all refuse without any write-shaped request. An opaque HTTP
 * 201 exchange is not treated as publish-ready.
 *
 * Run: pnpm smoke:npm-publish-preflight
 * Prove: pnpm mutation-proof --config bin/smoke/mutations/npm-publish-preflight.json
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { classifyDirectPublishPermission, preflightNpmPublish } from "../../scripts/preflight-npm-publish.mjs";
import { emitDeclaration } from "./gen-npm-publish-preflight-dts.mjs";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

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

function githubPublisher(actions: string[]) {
  return {
    type: "github",
    repository: "Cotal-AI/Cotal",
    workflow_filename: "changesets.yml",
    allowed_actions: actions,
  };
}

function isWriteShaped(call: Seen): boolean {
  return call.method === "PUT"
    || call.method === "DELETE"
    || call.url.includes("/-/pnpm/v1/publish")
    || call.url.startsWith("/-/stage/")
    || (call.method === "POST" && !call.url.startsWith("/-/npm/v1/oidc/token/exchange/package/"));
}

type Seen = { method: string; url: string };
type ScenarioOpts = {
  present?: Set<string>;
  workspacePackages?: typeof workspace;
  exchangeStatus?: number;
  trust?: Record<string, unknown>;
  trustStatus?: number | ((name: string) => number);
};
async function scenario({
  present = new Set(),
  workspacePackages = workspace,
  exchangeStatus = 201,
  trust,
  trustStatus = 200,
}: ScenarioOpts = {}) {
  const seen: Seen[] = [];
  const logs: string[] = [];
  const defaultTrust = { trustedPublishers: [githubPublisher(["stage", "publish"])] };
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
    const trustMatch = req.url?.match(/^\/-\/package\/(.+)\/trust$/);
    if (trustMatch) {
      const name = decodeURIComponent(trustMatch[1]);
      const status = typeof trustStatus === "function" ? trustStatus(name) : trustStatus;
      const body = trust && Object.prototype.hasOwnProperty.call(trust, name) ? trust[name] : defaultTrust;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
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
      log: (line) => logs.push(line),
    });
    return { result, seen, logs, error: undefined };
  } catch (error) {
    return { result: undefined, seen, logs, error };
  } finally {
    server.close();
    await once(server, "close");
  }
}

async function repositoryEntrypoint() {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    seen.push({ method: req.method ?? "", url: req.url ?? "" });
    if (req.url?.startsWith("/oidc?")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ value: idToken }));
    } else if (req.url?.startsWith("/-/npm/v1/oidc/token/exchange/package/")) {
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ token: "opaque-exchange-token" }));
    } else if (req.url?.includes("/trust")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ trustedPublishers: [githubPublisher(["stage", "publish"])] }));
    } else {
      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const child = spawn(process.execPath, ["scripts/preflight-npm-publish.mjs"], {
    cwd: ROOT,
    env: {
      ...process.env,
      ...env,
      npm_config_registry: base,
      ACTIONS_ID_TOKEN_REQUEST_URL: `${base}/oidc`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const [code] = await once(child, "close") as [number];
  server.close();
  await once(server, "close");
  return { code, output, seen };
}

check(
  "classifier treats an empty Allowed-actions list as stage-only",
  classifyDirectPublishPermission({ trustedPublishers: [githubPublisher([])] }) === "stage-only",
);
check(
  "classifier treats a stage-only GitHub publisher as stage-only",
  classifyDirectPublishPermission({ trustedPublishers: [githubPublisher(["stage"])] }) === "stage-only",
);
check(
  "classifier accepts npm publish as the direct Allowed action",
  classifyDirectPublishPermission({ trustedPublishers: [githubPublisher(["stage", "publish"])] }) === "createPackage",
);
check(
  "classifier does not treat an opaque exchange body as publish-ready",
  classifyDirectPublishPermission({ token: "opaque-exchange-token", token_type: "oidc" }) === "refused:malformed-trust",
);

const cli = await repositoryEntrypoint();
check("the shipped repository entrypoint passes a clean full fixed group", cli.code === 0, cli.output);
check(
  "the repository entrypoint derives and exchanges every fixed-group package",
  cli.seen.filter((call) => call.url.startsWith("/-/npm/v1/oidc/token/exchange/package/")).length === 22,
  cli.seen,
);
check(
  "the repository entrypoint GETs trust for every fixed-group package",
  cli.seen.filter((call) => call.method === "GET" && call.url.includes("/trust")).length === 22,
  cli.seen,
);
check("the repository entrypoint never issues a write-shaped registry call", cli.seen.every((call) => !isWriteShaped(call)), cli.seen);

const clean = await scenario();
check("clean full-group census passes", clean.result?.state === "ready", clean.error);
check(
  "clean preflight exchanges OIDC for every package before publishing",
  clean.seen.filter((call) => call.url.startsWith("/-/npm/v1/oidc/token/exchange/package/")).length === fixed.length,
  clean.seen,
);
check(
  "clean preflight GETs trust for every package before publishing",
  clean.seen.filter((call) => call.method === "GET" && call.url.includes("/trust")).length === fixed.length,
  clean.seen,
);
check(
  "clean preflight never sends a registry publish request",
  clean.seen.every((call) => !isWriteShaped(call)),
  clean.seen,
);
check(
  "clean preflight records createPackage, not OIDC 201, as the publish-ready proof",
  clean.result?.rows.every((row) => row.oidc === "exchanged" && row.direct === "createPackage") === true,
  clean.result,
);

const manual = await preflightNpmPublish({
  fixedPackages: fixed,
  workspacePackages: workspace,
  registryBase: "https://fake.registry",
  env: { NPM_TOKEN: "test-only" },
  fetchImpl: (async () => ({ status: 404 })) as unknown as typeof fetch,
  log: () => {},
});
check(
  "manual token escape hatch keeps the fixed-group census without requiring GitHub OIDC",
  manual.state === "ready"
    && manual.rows.every((row) => row.oidc === "not-available:classic-token" && row.direct === "not-available:classic-token"),
  manual,
);

const partial = await scenario({ present: new Set(["@cotal-ai/seat"]) });
check(
  "one already-published package refuses the whole preflight",
  partial.error instanceof Error && partial.error.message.includes("exact versions already exist"),
  partial.error,
);
check(
  "partial prior publish refuses before any OIDC exchange, trust GET, or publish call",
  partial.seen.every((call) => !call.url.startsWith("/-/npm/v1/oidc/token/exchange/package/"))
    && partial.seen.every((call) => !call.url.includes("/trust"))
    && partial.seen.every((call) => !isWriteShaped(call)),
  partial.seen,
);
check(
  "partial prior publish prints the complete package and version census",
  fixed.every((name) => partial.logs.some((line) => line.includes(`${name}\t9.9.9\t`))),
  partial.logs,
);

const incomplete = await scenario({ workspacePackages: workspace.filter((pkg) => pkg.name !== "@cotal-ai/seat") });
check(
  "one fixed-group package missing from the recursive publish set refuses",
  incomplete.error instanceof Error && incomplete.error.message.includes("fixed packages missing from workspace publish set"),
  incomplete.error,
);
check("incomplete publish set refuses before the fake registry sees any call", incomplete.seen.length === 0, incomplete.seen);

const oidcRefused = await scenario({ exchangeStatus: 401 });
check(
  "one refused OIDC exchange refuses the full release",
  oidcRefused.error instanceof Error && oidcRefused.error.message.includes("npm OIDC exchange refused"),
  oidcRefused.error,
);
check(
  "OIDC refusal prints the complete census before exiting non-zero",
  fixed.every((name) => oidcRefused.logs.some((line) => line.includes(`${name}\t9.9.9\t`))),
  oidcRefused.logs,
);
check(
  "OIDC refusal never issues a write-shaped registry call",
  oidcRefused.seen.every((call) => !isWriteShaped(call)),
  oidcRefused.seen,
);

const stageOnly = await scenario({
  trust: {
    "@cotal-ai/core": { trustedPublishers: [githubPublisher(["stage", "publish"])] },
    "@cotal-ai/seat": { trustedPublishers: [githubPublisher(["stage"])] },
    "cotal-ai": { trustedPublishers: [githubPublisher(["stage", "publish"])] },
  },
});
check(
  "one stage-only Allowed-actions sibling refuses the whole preflight",
  stageOnly.error instanceof Error && stageOnly.error.message.includes("allow only staged publish"),
  stageOnly.error,
);
check(
  "stage-only sibling still exchanged OIDC 201 for every package",
  stageOnly.seen.filter((call) => call.url.startsWith("/-/npm/v1/oidc/token/exchange/package/")).length === fixed.length,
  stageOnly.seen,
);
check(
  "stage-only sibling never issues a write-shaped registry call",
  stageOnly.seen.every((call) => !isWriteShaped(call)),
  stageOnly.seen,
);
check(
  "stage-only refusal prints the complete census including the stage-only row",
  stageOnly.logs.some((line) => line.includes("@cotal-ai/seat\t9.9.9\tabsent\texchanged\tstage-only")),
  stageOnly.logs,
);

const opaque201 = await scenario({
  trustStatus: 200,
  trust: {
    "@cotal-ai/core": { token: "opaque-exchange-token" },
    "@cotal-ai/seat": { token: "opaque-exchange-token" },
    "cotal-ai": { token: "opaque-exchange-token" },
  },
});
check(
  "an opaque HTTP 201 exchange is not treated as direct-publish proof",
  opaque201.error instanceof Error && opaque201.error.message.includes("direct-publish authorization refused"),
  opaque201.error,
);

const trustDenied = await scenario({ trustStatus: 401 });
check(
  "a 401 trust census refuses before any publish call",
  trustDenied.error instanceof Error && trustDenied.error.message.includes("direct-publish authorization refused"),
  trustDenied.error,
);
check(
  "a 401 trust census never issues a write-shaped registry call",
  trustDenied.seen.every((call) => !isWriteShaped(call)),
  trustDenied.seen,
);

const committedDts = readFileSync(join(ROOT, "scripts/preflight-npm-publish.d.mts"), "utf8");
check(
  "the committed .d.mts is byte-identical to a fresh emit from the module (run pnpm gen:npm-publish-preflight-dts)",
  committedDts === emitDeclaration(),
);

console.log(`\nSUITE COMPLETE: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
