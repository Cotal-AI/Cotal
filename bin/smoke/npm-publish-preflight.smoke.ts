/**
 * The release preflight must fail before the first registry write. This suite drives the shipped
 * preflight against a local fake registry and records every request. An all-present full-group
 * state is a no-op before credential work. Clean all-absent state passes only after an OIDC exchange
 * AND a GET-trust direct-publish census for every package. A prior partial publish, an incomplete
 * recursive publish set, a refused exchange, a
 * stage-only Allowed-actions sibling, and a stage-only this-workflow publisher next to an
 * unrelated GitHub publisher that lists createPackage all refuse without any write-shaped
 * request. An opaque HTTP 201 exchange is not treated as publish-ready.
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

const cleanEnv: NodeJS.ProcessEnv = { ...process.env };
for (const key of Object.keys(cleanEnv)) if (key.startsWith("COTAL_")) delete cleanEnv[key];

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
  environment: "npm-publish",
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

function githubPublisher(actions: string[], extra: Record<string, unknown> = {}) {
  return {
    type: "github",
    repository: "Cotal-AI/Cotal",
    workflow_filename: "changesets.yml",
    environment: "npm-publish",
    allowed_actions: actions,
    ...extra,
  };
}

function githubClaimsPublisher(permissions: string[], claims: Record<string, unknown> = {}) {
  return {
    type: "github",
    claims: {
      repository: "Cotal-AI/Cotal",
      workflow_ref: { file: "changesets.yml" },
      environment: "npm-publish",
      ...claims,
    },
    permissions,
  };
}

const thisRelease = { repository: "Cotal-AI/Cotal", workflowFilename: "changesets.yml", environment: "npm-publish" };

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
  const defaultTrust = [githubClaimsPublisher(["createPackage", "createStagedPackage"])];
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

type RegistryState = "all-present" | "mixed" | "all-absent";
async function repositoryEntrypoint(registryState: RegistryState = "all-absent") {
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
      res.end(JSON.stringify([githubClaimsPublisher(["createPackage", "createStagedPackage"])]));
    } else {
      const exact = req.url?.match(/^\/(.+)\/[^/]+$/)?.[1] ?? "";
      const name = decodeURIComponent(exact);
      const present = registryState === "all-present"
        || (registryState === "mixed" && name === "@cotal-ai/core");
      res.writeHead(present ? 200 : 404, { "content-type": "application/json" });
      res.end(JSON.stringify({ name }));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const child = spawn(process.execPath, ["scripts/preflight-npm-publish.mjs"], {
    cwd: ROOT,
    env: {
      ...cleanEnv,
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
  classifyDirectPublishPermission({ trustedPublishers: [githubPublisher([])] }, thisRelease) === "stage-only",
);
check(
  "classifier treats a stage-only GitHub publisher as stage-only",
  classifyDirectPublishPermission({ trustedPublishers: [githubPublisher(["stage"])] }, thisRelease) === "stage-only",
);
check(
  "classifier accepts npm publish as the direct Allowed action",
  classifyDirectPublishPermission({ trustedPublishers: [githubPublisher(["stage", "publish"])] }, thisRelease) === "createPackage",
);
check(
  "classifier does not treat an opaque exchange body as publish-ready",
  classifyDirectPublishPermission({ token: "opaque-exchange-token", token_type: "oidc" }, thisRelease) === "refused:malformed-trust",
);
check(
  "classifier ignores an unrelated GitHub publisher that lists createPackage",
  classifyDirectPublishPermission({
    trustedPublishers: [
      githubPublisher(["stage"]),
      githubPublisher(["createPackage"], { repository: "other/repository", workflow_filename: "release.yml" }),
    ],
  }, thisRelease) === "stage-only",
);
check(
  "classifier still accepts this workflow when an unrelated publisher is also present",
  classifyDirectPublishPermission({
    trustedPublishers: [
      githubPublisher(["stage", "publish"]),
      githubPublisher(["createPackage"], { repository: "other/repository", workflow_filename: "release.yml" }),
    ],
  }, thisRelease) === "createPackage",
);
check(
  "classifier accepts official GitHub GET trust claims with createPackage",
  classifyDirectPublishPermission([
    githubClaimsPublisher(["createPackage", "createStagedPackage"]),
  ], thisRelease) === "createPackage",
);
check(
  "classifier treats official claims with only createStagedPackage as stage-only",
  classifyDirectPublishPermission([
    githubClaimsPublisher(["createStagedPackage"]),
  ], thisRelease) === "stage-only",
);
check(
  "classifier ignores an unrelated claims publisher that lists createPackage",
  classifyDirectPublishPermission([
    githubClaimsPublisher(["createStagedPackage"]),
    githubClaimsPublisher(["createPackage"], { repository: "other/repository", workflow_ref: { file: "release.yml" } }),
  ], thisRelease) === "stage-only",
);
check(
  "classifier still accepts this workflow claims when an unrelated claims publisher is present",
  classifyDirectPublishPermission([
    githubClaimsPublisher(["createPackage", "createStagedPackage"]),
    githubClaimsPublisher(["createPackage"], { repository: "other/repository", workflow_ref: { file: "release.yml" } }),
  ], thisRelease) === "createPackage",
);
check(
  "classifier refuses official same-repo wrong-workflow claims",
  classifyDirectPublishPermission([
    githubClaimsPublisher(["createPackage"], { workflow_ref: { file: "release.yml" } }),
  ], thisRelease) === "refused:no-github-publisher",
);
check(
  "classifier refuses a same-repo same-workflow publisher with blank environment",
  classifyDirectPublishPermission([
    githubClaimsPublisher(["createPackage", "createStagedPackage"], { environment: "" }),
  ], thisRelease) === "refused:no-github-publisher",
);
check(
  "classifier refuses a same-repo same-workflow publisher with no environment field",
  classifyDirectPublishPermission({
    trustedPublishers: [{
      type: "github",
      repository: "Cotal-AI/Cotal",
      workflow_filename: "changesets.yml",
      allowed_actions: ["createPackage"],
    }],
  }, thisRelease) === "refused:no-github-publisher",
);
check(
  "classifier treats an explicit gitlab type as not this GitHub publisher",
  classifyDirectPublishPermission({
    trustedPublishers: [{
      type: "gitlab",
      repository: "Cotal-AI/Cotal",
      workflow_filename: "changesets.yml",
      allowed_actions: ["createPackage"],
    }],
  }, thisRelease) === "refused:no-github-publisher",
);

const allPresent = await repositoryEntrypoint("all-present");
check(
  "all-present repository entrypoint returns the named no-op verdict",
  allPresent.code === 0
    && allPresent.output.includes("nothing to publish: every exact version is already on the registry"),
  allPresent.output,
);
check(
  "all-present repository entrypoint prints the full fixed-group census",
  allPresent.output.split("\n").filter((line) => line.includes("\tpresent\tnot-run\tnot-run")).length === 22,
  allPresent.output,
);
check(
  "all-present repository entrypoint stops before OIDC, trust, or publish work",
  allPresent.seen.every((call) => !call.url.startsWith("/-/npm/v1/oidc/token/exchange/package/"))
    && allPresent.seen.every((call) => !call.url.includes("/trust"))
    && allPresent.seen.every((call) => !isWriteShaped(call)),
  allPresent.seen,
);

const mixedEntrypoint = await repositoryEntrypoint("mixed");
check(
  "mixed repository entrypoint preserves the partial-publication refusal",
  mixedEntrypoint.code !== 0
    && mixedEntrypoint.output.includes("publish preflight refused: 1/22 exact versions already exist"),
  mixedEntrypoint.output,
);
check(
  "mixed repository entrypoint stops before OIDC, trust, or publish work",
  mixedEntrypoint.seen.every((call) => !call.url.startsWith("/-/npm/v1/oidc/token/exchange/package/"))
    && mixedEntrypoint.seen.every((call) => !call.url.includes("/trust"))
    && mixedEntrypoint.seen.every((call) => !isWriteShaped(call)),
  mixedEntrypoint.seen,
);

const zeroPresent = await repositoryEntrypoint("all-absent");
check(
  "zero-present repository entrypoint reaches the publish authorization stage",
  zeroPresent.code === 0
    && zeroPresent.seen.some((call) => call.url.startsWith("/-/npm/v1/oidc/token/exchange/package/")),
  zeroPresent.output,
);
check(
  "zero-present repository entrypoint derives and exchanges every fixed-group package",
  zeroPresent.seen.filter((call) => call.url.startsWith("/-/npm/v1/oidc/token/exchange/package/")).length === 22,
  zeroPresent.seen,
);
check(
  "zero-present repository entrypoint GETs trust for every fixed-group package",
  zeroPresent.seen.filter((call) => call.method === "GET" && call.url.includes("/trust")).length === 22,
  zeroPresent.seen,
);
check(
  "zero-present repository entrypoint never issues a write-shaped registry call",
  zeroPresent.seen.every((call) => !isWriteShaped(call)),
  zeroPresent.seen,
);

const allPresentCensus = await scenario({ present: new Set(fixed) });
check(
  "all-present preflight returns the named no-op state",
  allPresentCensus.result?.state === "nothing-to-publish",
  allPresentCensus.error ?? allPresentCensus.result,
);

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

const mixedPublisher = await scenario({
  trust: {
    "@cotal-ai/core": {
      trustedPublishers: [
        githubPublisher(["stage"]),
        githubPublisher(["createPackage"], { repository: "other/repository", workflow_filename: "release.yml" }),
      ],
    },
    "@cotal-ai/seat": { trustedPublishers: [githubPublisher(["stage", "publish"])] },
    "cotal-ai": { trustedPublishers: [githubPublisher(["stage", "publish"])] },
  },
});
check(
  "a stage-only this-workflow publisher next to an unrelated createPackage publisher refuses",
  mixedPublisher.error instanceof Error && mixedPublisher.error.message.includes("allow only staged publish"),
  mixedPublisher.error,
);
check(
  "mixed-publisher refusal never issues a write-shaped registry call",
  mixedPublisher.seen.every((call) => !isWriteShaped(call)),
  mixedPublisher.seen,
);
check(
  "mixed-publisher refusal prints stage-only for this workflow, not createPackage",
  mixedPublisher.logs.some((line) => line.includes("@cotal-ai/core\t9.9.9\tabsent\texchanged\tstage-only")),
  mixedPublisher.logs,
);

const officialMixedPublisher = await scenario({
  trust: {
    "@cotal-ai/core": [
      githubClaimsPublisher(["createStagedPackage"]),
      githubClaimsPublisher(["createPackage"], { repository: "other/repository", workflow_ref: { file: "release.yml" } }),
    ],
    "@cotal-ai/seat": [githubClaimsPublisher(["createPackage", "createStagedPackage"])],
    "cotal-ai": [githubClaimsPublisher(["createPackage", "createStagedPackage"])],
  },
});
check(
  "official claims stage-only this-workflow next to unrelated createPackage refuses",
  officialMixedPublisher.error instanceof Error && officialMixedPublisher.error.message.includes("allow only staged publish"),
  officialMixedPublisher.error,
);
check(
  "official mixed-publisher refusal never issues a write-shaped registry call",
  officialMixedPublisher.seen.every((call) => !isWriteShaped(call)),
  officialMixedPublisher.seen,
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
  "a 401 trust read under OIDC is recorded as unverifiable and does not refuse the release",
  trustDenied.error === undefined
    && trustDenied.result !== undefined
    && trustDenied.result.rows.length > 0
    && trustDenied.result.rows.every((row) => row.oidc === "exchanged" && row.direct === "unverifiable:trust-endpoint-needs-npm-token"),
  trustDenied.error ?? trustDenied.result,
);
check(
  "a 401 trust read never issues a write-shaped registry call",
  trustDenied.seen.every((call) => !isWriteShaped(call)),
  trustDenied.seen,
);

const trustForbidden = await scenario({ trustStatus: 403 });
check(
  "a non-401 trust read failure still refuses before any publish call",
  trustForbidden.error instanceof Error && trustForbidden.error.message.includes("direct-publish authorization refused"),
  trustForbidden.error,
);
check(
  "a non-401 trust read failure never issues a write-shaped registry call",
  trustForbidden.seen.every((call) => !isWriteShaped(call)),
  trustForbidden.seen,
);

const blankEnv = await scenario({
  trust: {
    "@cotal-ai/core": [githubClaimsPublisher(["createPackage", "createStagedPackage"], { environment: "" })],
    "@cotal-ai/seat": [githubClaimsPublisher(["createPackage", "createStagedPackage"], { environment: "" })],
    "cotal-ai": [githubClaimsPublisher(["createPackage", "createStagedPackage"], { environment: "" })],
  },
});
check(
  "a publisher with blank environment refuses even with createPackage permission",
  blankEnv.error instanceof Error && blankEnv.error.message.includes("direct-publish authorization refused"),
  blankEnv.error,
);
check(
  "blank-environment refusal never issues a write-shaped registry call",
  blankEnv.seen.every((call) => !isWriteShaped(call)),
  blankEnv.seen,
);

const noEnvOidcPayload = Buffer.from(JSON.stringify({
  repository: "Cotal-AI/Cotal",
  workflow_ref: "Cotal-AI/Cotal/.github/workflows/changesets.yml@refs/heads/main",
  ref: "refs/heads/main",
  event_name: "push",
  aud: "npm:registry.npmjs.org",
  jti: "fake-jti-no-env",
})).toString("base64url");
const noEnvIdToken = `header.${noEnvOidcPayload}.signature`;
const noEnvOidc = await (async () => {
  const seen: Seen[] = [];
  const logs: string[] = [];
  const server = createServer((req, res) => {
    seen.push({ method: req.method ?? "", url: req.url ?? "" });
    if (req.url?.startsWith("/oidc?")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ value: noEnvIdToken }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end("{}");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const result = await preflightNpmPublish({
      fixedPackages: fixed,
      workspacePackages: workspace,
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
})();
check(
  "an OIDC token without the environment claim refuses the whole preflight",
  noEnvOidc.error instanceof Error
    && noEnvOidc.error.message.includes("OIDC exchange refused")
    && noEnvOidc.logs.some((line) => typeof line === "string" && line.includes("refused:GitHub OIDC identity did not match the release job: environment")),
  noEnvOidc.error,
);
check(
  "OIDC environment rejection never issues a write-shaped registry call",
  noEnvOidc.seen.every((call) => !isWriteShaped(call)),
  noEnvOidc.seen,
);

const committedDts = readFileSync(join(ROOT, "scripts/preflight-npm-publish.d.mts"), "utf8");
const freshDts = emitDeclaration();
check(
  "the committed .d.mts is byte-identical to a fresh emit from the module (run pnpm gen:npm-publish-preflight-dts)",
  committedDts === freshDts,
);

/**
 * The census state contract, graded on the DECLARATION rather than on the module.
 *
 * The skew cell above pins the declaration to the module byte for byte, and is still blind to this:
 * `tsc` widens an object-literal property to `string` on emit, so renaming a census state literal
 * leaves the declaration byte-identical and the skew cell green. Measured on the tree before this
 * check existed: both `"nothing-to-publish"` and `"ready"` could be renamed with no declaration
 * movement at all, while the same rename inside `classifyDirectPublishPermission`, which has a
 * declared return type, did move it. The contract therefore has to be read out of the declaration
 * and graded, not inferred from the two files agreeing.
 *
 * Both entry points are graded separately because they are two independently emitted widenings,
 * not one echoed twice, and every refusal names the entry point it came from so a fault on one
 * cannot be reported as the other.
 */
const TYPE_KEYWORDS = ["string", "number", "boolean", "bigint", "symbol", "object", "any", "unknown", "never", "void", "undefined", "null"];
const CENSUS_STATE_MEMBERS = ["nothing-to-publish", "ready"] as const;
const CENSUS_STATE_ENTRY_POINTS = ["preflightNpmPublish", "preflightFromRepository"] as const;

/**
 * How many times this declaration declares `fn`. More than once is refused rather than resolved.
 *
 * A self-attack found the reason: every read below took the FIRST occurrence, so appending a
 * SECOND `export function preflightFromRepository(...): Promise<{ state: string; ... }>;` after
 * the real one left this cell reading the first block and reporting no refusals, while the type a
 * consumer resolves is the later declaration. Taking the first of several is a choice this cell is
 * not entitled to make, so an ambiguous declaration fails closed instead of being silently halved.
 */
function declarationCount(dts: string, fn: string): number {
  const needle = `export function ${fn}(`;
  let count = 0;
  for (let at = dts.indexOf(needle); at >= 0; at = dts.indexOf(needle, at + needle.length)) count++;
  return count;
}

/**
 * The result object of `fn`, or `null` when this declaration does not resolve one FOR `fn`.
 *
 * The search is BOUNDED to `fn`'s own declaration: it stops at the next top-level `export`. Without
 * the bound, an entry point whose result is not an object literal (`Promise<void>`, say) reads the
 * NEXT function's result block and is graded on a contract that is not its own, which is a pass
 * reported for the wrong subject. Bounded, that case has no block and is refused by name.
 */
function resolvedResultBlock(dts: string, fn: string): string | null {
  const needle = `export function ${fn}(`;
  const start = dts.indexOf(needle);
  if (start < 0) return null;
  const next = dts.indexOf("\nexport ", start + needle.length);
  const stop = next < 0 ? dts.length : next;
  const open = dts.indexOf("): Promise<{", start);
  if (open < 0 || open > stop) return null;
  const end = dts.indexOf("\n}>;", open);
  if (end < 0 || end > stop) return null;
  return dts.slice(open, end);
}

/**
 * Every value written for a TOP-LEVEL `key` in a result block, one entry per occurrence.
 *
 * Depth is tracked over braces instead of the property being matched by a regex over the whole
 * block, because the published property is the one at the top level and a regex takes whichever
 * comes first in the text. A self-attack caught exactly that: adding `census: { state: <alias> }`
 * ABOVE a top-level `state: string;` left the old reader with ZERO refusals, so the published type
 * of a real entry point could be widened back to bare `string` with this whole suite green. A
 * nested property is not the contract, and reading one as the contract defeats the cell.
 */
function topLevelPropertyValues(block: string, key: string): string[] {
  const property = new RegExp(`^\\s*${key}\\??:\\s*(.+?);\\s*$`);
  const values: string[] = [];
  let depth = 0;
  for (const line of block.split("\n")) {
    if (depth === 1) {
      const written = property.exec(line);
      if (written) values.push(written[1].trim());
    }
    for (const character of line) {
      if (character === "{") depth++;
      else if (character === "}") depth--;
    }
  }
  return values;
}

/**
 * An identifier is followed to its exported alias; `null` means the declaration never defines it.
 *
 * A built-in type keyword denotes ITSELF and is never looked up. `string` is identifier-shaped, so
 * without this the widened form `state: string;` resolved to `null` and was refused as "a type this
 * declaration never defines" -- a refusal for the wrong reason, and it left the one branch whose
 * message names the actual defect of this cell, "not a union of the census literals", unreached by
 * any fixture. A branch no refusing case reaches is an untested branch, and the untested one here
 * was the one guarding the exact regression the cell exists to catch.
 *
 * The alias may itself be an indexed access over an exported const array, which is the form the
 * module uses so that the member names live in CODE rather than in a JSDoc comment. `tsc` emits
 * that as `export const X: readonly ["a", "b"];`, so the tuple is followed one further hop and
 * rewritten into the union it denotes. Without this the cell reads the alias as a non-literal
 * type and refuses a declaration that in fact pins the contract exactly.
 */
function followAlias(dts: string, written: string): string | null {
  if (!/^[A-Za-z_$][\w$]*$/.test(written)) return written;
  if (TYPE_KEYWORDS.includes(written)) return written;
  const alias = new RegExp(`^export type ${written} = ([^;]+);`, "m").exec(dts);
  if (!alias) return null;
  return followTupleIndex(dts, alias[1].trim());
}

/**
 * `(typeof X)[number]` is resolved to the union of X's emitted tuple members. Any other type is
 * returned unchanged, so a plain literal union still reads exactly as it did before.
 */
function followTupleIndex(dts: string, type: string): string | null {
  const indexed = /^\(typeof ([A-Za-z_$][\w$]*)\)\[number\]$/.exec(type);
  if (!indexed) return type;
  const tuple = new RegExp(`^export const ${indexed[1]}: readonly \\[([^\\]]*)\\];`, "m").exec(dts);
  if (!tuple) return null;
  return tuple[1].split(",").map((part) => part.trim()).join(" | ");
}

/** `null` means the type is not a union of string literals at all, which is what `string` is. */
function literalMembers(type: string): string[] | null {
  const parts = type.split("|").map((part) => part.trim());
  const members: string[] = [];
  for (const part of parts) {
    const literal = /^"([^"]*)"$/.exec(part);
    if (!literal) return null;
    members.push(literal[1]);
  }
  return members;
}

/** Every reason this declaration fails to pin the census state contract. Empty means it pins it. */
function censusStateRefusals(dts: string): string[] {
  const refusals: string[] = [];
  for (const fn of CENSUS_STATE_ENTRY_POINTS) {
    const declared = declarationCount(dts, fn);
    if (declared === 0) { refusals.push(`${fn}: the declaration never declares this entry point`); continue; }
    if (declared > 1) { refusals.push(`${fn}: declared ${declared} times, so which result a caller resolves is ambiguous`); continue; }
    const block = resolvedResultBlock(dts, fn);
    if (block === null) { refusals.push(`${fn}: no resolved result object in the declaration`); continue; }
    const written = topLevelPropertyValues(block, "state");
    if (written.length === 0) { refusals.push(`${fn}: the result carries no top-level state property`); continue; }
    if (written.length > 1) { refusals.push(`${fn}: carries ${written.length} top-level state properties: ${written.join(", ")}`); continue; }
    const type = written[0];
    const resolved = followAlias(dts, type);
    if (resolved === null) { refusals.push(`${fn}: state is ${type}, which this declaration never defines`); continue; }
    const members = literalMembers(resolved);
    if (members === null) { refusals.push(`${fn}: state is ${resolved}, not a union of the census literals`); continue; }
    const missing = CENSUS_STATE_MEMBERS.filter((member) => !members.includes(member));
    if (missing.length) { refusals.push(`${fn}: state union is missing ${missing.join(", ")}`); continue; }
    const extra = members.filter((member) => !CENSUS_STATE_MEMBERS.includes(member as typeof CENSUS_STATE_MEMBERS[number]));
    if (extra.length) refusals.push(`${fn}: state union carries ${extra.join(", ")}, which the census never returns`);
  }
  return refusals;
}

function replaceNth(text: string, needle: string, replacement: string, nth: number): string {
  let index = -1;
  for (let seen = 0; seen < nth; seen++) {
    index = text.indexOf(needle, index + 1);
    if (index < 0) throw new Error(`fixture is stale: occurrence ${nth} of ${needle} is not in the declaration`);
  }
  return text.slice(0, index) + replacement + text.slice(index + needle.length);
}

check(
  "the committed .d.mts pins the census state union on both entry points",
  censusStateRefusals(committedDts).length === 0,
  censusStateRefusals(committedDts),
);
check(
  "a fresh emit from the module pins the census state union on both entry points",
  censusStateRefusals(freshDts).length === 0,
  censusStateRefusals(freshDts),
);

/**
 * One refusing fixture per accepting branch of the grader above, each derived from the real
 * declaration by a single substitution so it differs from an accepting input only in the one
 * context under test. A grader with no refusing case is green on everything, including `string`.
 *
 * The fixtures are derived from an accepting base rather than straight from the committed file, so
 * that carrying this cell back onto a declaration that does NOT pin the contract still grades the
 * grader instead of throwing on a missing substring. That matters: the pre-fix control for this
 * check runs exactly that way, and a crash there would red the suite without saying why.
 */
const stateProperty = "state: NpmPublishPreflightState;";
/**
 * The fallback base STRIPS any existing alias and tuple before appending its own.
 *
 * Appending blindly was wrong, and a self-attack caught it: widening only ONE entry point leaves
 * a declaration that still defines the alias, so the fallback produced a base with TWO competing
 * `export type NpmPublishPreflightState = ...` lines. The fixtures that rewrite "the" alias then
 * edited one copy while the grader matched the other, and three refusing cells reported a fault
 * that was an artefact of the malformed base rather than of the thing under test. A fixture that
 * can red for a reason other than the one it names is not evidence, so the base is normalised to
 * exactly one definition of each and asserted below.
 */
const aliasDefinition = /^export (type NpmPublishPreflightState|const NPM_PUBLISH_PREFLIGHT_STATES) = .*$|^export (type NpmPublishPreflightState|const NPM_PUBLISH_PREFLIGHT_STATES): .*$/gm;
const acceptingBase = censusStateRefusals(committedDts).length === 0
  ? committedDts
  : `${committedDts.replaceAll("state: string;", stateProperty).replace(aliasDefinition, "")}\n`
    + `export type NpmPublishPreflightState = "nothing-to-publish" | "ready";\n`;
check(
  "the census state grader accepts a declaration that pins the contract",
  censusStateRefusals(acceptingBase).length === 0,
  censusStateRefusals(acceptingBase),
);
check(
  "the fixture base defines the state alias exactly once, so a fixture edits what the grader reads",
  (acceptingBase.match(/^export type NpmPublishPreflightState\b/gm) ?? []).length === 1,
  (acceptingBase.match(/^export type NpmPublishPreflightState .*$/gm) ?? []),
);
const stateFixtures: Array<{ name: string; dts: string; names: string; branch: string }> = [
  {
    name: "state widened back to string on preflightNpmPublish",
    branch: "not a union of the census literals",
    dts: replaceNth(acceptingBase, stateProperty, "state: string;", 1),
    names: "preflightNpmPublish",
  },
  {
    name: "state widened back to string on preflightFromRepository",
    branch: "not a union of the census literals",
    dts: replaceNth(acceptingBase, stateProperty, "state: string;", 2),
    names: "preflightFromRepository",
  },
  {
    name: "a state property dropped from the result object",
    branch: "no top-level state property",
    dts: replaceNth(acceptingBase, `    ${stateProperty}\n`, "", 1),
    names: "preflightNpmPublish",
  },
  {
    name: "an entry point the declaration never declares",
    branch: "the declaration never declares this entry point",
    dts: replaceNth(acceptingBase, "export function preflightFromRepository(", "export function preflightElsewhere(", 1),
    names: "preflightFromRepository",
  },
  {
    name: "a state alias this declaration never defines",
    branch: "which this declaration never defines",
    dts: acceptingBase.replace(/^export type NpmPublishPreflightState = .*$/m, ""),
    names: "preflightNpmPublish",
  },
  {
    name: "a census member dropped from the union",
    branch: "state union is missing",
    dts: acceptingBase.replace(/^export type NpmPublishPreflightState = .*$/m, 'export type NpmPublishPreflightState = "nothing-to-publish";'),
    names: "preflightNpmPublish",
  },
  {
    name: "a state the census can never return added to the union",
    branch: "which the census never returns",
    dts: acceptingBase.replace(/^export type NpmPublishPreflightState = .*$/m, 'export type NpmPublishPreflightState = "nothing-to-publish" | "ready" | "inconclusive";'),
    names: "preflightNpmPublish",
  },
  {
    name: "a tuple the declaration never defines behind the state alias",
    branch: "which this declaration never defines",
    dts: `${acceptingBase.replace(/^export const NPM_PUBLISH_PREFLIGHT_STATES: .*$/m, "")
      .replace(/^export type NpmPublishPreflightState = .*$/m, "")}\nexport type NpmPublishPreflightState = (typeof NPM_PUBLISH_PREFLIGHT_STATES)[number];\n`,
    names: "preflightNpmPublish",
  },
  {
    name: "a census member dropped from the tuple behind the state alias",
    branch: "state union is missing",
    dts: `${acceptingBase.replace(/^export const NPM_PUBLISH_PREFLIGHT_STATES: .*$/m, "")
      .replace(/^export type NpmPublishPreflightState = .*$/m, "")}\nexport const NPM_PUBLISH_PREFLIGHT_STATES: readonly ["nothing-to-publish"];\nexport type NpmPublishPreflightState = (typeof NPM_PUBLISH_PREFLIGHT_STATES)[number];\n`,
    names: "preflightNpmPublish",
  },
  {
    name: "a nested state read instead of the widened top-level one",
    dts: replaceNth(acceptingBase, `    ${stateProperty}\n`,
      `    census: {\n        ${stateProperty}\n    };\n    state: string;\n`, 1),
    names: "preflightNpmPublish",
    branch: "not a union of the census literals",
  },
  {
    name: "two top-level state properties, so which one publishes is ambiguous",
    dts: replaceNth(acceptingBase, `    ${stateProperty}\n`, `    ${stateProperty}\n    state: string;\n`, 1),
    names: "preflightNpmPublish",
    branch: "top-level state properties",
  },
  {
    name: "a second declaration of the same entry point appended after the first",
    dts: `${acceptingBase}\nexport function preflightFromRepository(options?: any): Promise<{\n    state: string;\n    rows: any[];\n}>;\n`,
    names: "preflightFromRepository",
    branch: "so which result a caller resolves is ambiguous",
  },
  {
    name: "an entry point whose result object is not resolved in its own declaration",
    dts: replaceNth(acceptingBase, "): Promise<{", "): Promise<any>;", 1),
    names: "preflightNpmPublish",
    branch: "no resolved result object in the declaration",
  },
];
for (const fixture of stateFixtures) {
  const refusals = censusStateRefusals(fixture.dts);
  check(
    `the census state grader refuses ${fixture.name}`,
    fixture.dts !== acceptingBase
      && refusals.length > 0
      && refusals.some((refusal) => refusal.startsWith(`${fixture.names}:`) && refusal.includes(fixture.branch)),
    { refusals, expectedBranch: fixture.branch },
  );
}

/**
 * Every refusing branch of the grader is reached by at least one fixture above.
 *
 * This assertion is here because the fixture table LOOKED complete and was not. Tracing which
 * branch each of the nine original fixtures actually landed on found five branches hit and one
 * never reached: "not a union of the census literals", the single branch whose message names the
 * defect this cell exists to catch. Both "widened back to string" fixtures exited earlier, at the
 * undefined-alias branch, so they passed for a reason unrelated to the widening they were named
 * for. One refusing case per BRANCH is the property that matters, and counting fixtures cannot
 * establish it, so the branch set is enumerated here and the fixtures are graded against it.
 */
const CENSUS_STATE_BRANCHES = [
  "the declaration never declares this entry point",
  "so which result a caller resolves is ambiguous",
  "no resolved result object in the declaration",
  "no top-level state property",
  "top-level state properties",
  "which this declaration never defines",
  "not a union of the census literals",
  "state union is missing",
  "which the census never returns",
];
const branchesHit = new Set(stateFixtures.map((fixture) => fixture.branch));
const branchesUnreached = CENSUS_STATE_BRANCHES.filter((branch) => !branchesHit.has(branch));
/**
 * The enumerated set is itself checked against the GRADER'S SOURCE, because a hand-maintained
 * list of branches is exactly the kind of second copy that rots: adding a tenth `refusals.push`
 * without extending the list would leave the coverage cell above reporting full coverage of a set
 * that no longer describes the grader. Counting the pushes in the source closes that, so the
 * coverage claim degrades into a red rather than into a silent overstatement.
 */
const graderSource = readFileSync(new URL(import.meta.url), "utf8");
const graderBody = graderSource.slice(
  graderSource.indexOf("function censusStateRefusals"),
  graderSource.indexOf("function replaceNth"),
);
const graderPushes = graderBody.match(/refusals\.push\(/g) ?? [];
check(
  "the enumerated branch set has one entry per refusal in the grader, so the list cannot rot",
  graderPushes.length === CENSUS_STATE_BRANCHES.length,
  { refusalsInGrader: graderPushes.length, enumerated: CENSUS_STATE_BRANCHES.length },
);
check(
  "every enumerated branch string appears in the grader source, so a reworded branch is caught",
  CENSUS_STATE_BRANCHES.every((branch) => graderBody.includes(branch)),
  CENSUS_STATE_BRANCHES.filter((branch) => !graderBody.includes(branch)),
);
check(
  `every one of the ${CENSUS_STATE_BRANCHES.length} census state refusal branches has a refusing fixture`,
  branchesUnreached.length === 0,
  { branchesUnreached, fixtures: stateFixtures.length },
);
check(
  "every fixture branch tag names a real refusal branch, so a typo cannot fake coverage",
  [...branchesHit].every((branch) => CENSUS_STATE_BRANCHES.includes(branch)),
  [...branchesHit].filter((branch) => !CENSUS_STATE_BRANCHES.includes(branch)),
);

console.log(`\nSUITE COMPLETE: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
