/**
 * The release preflight must fail before the first registry write. This suite drives the shipped
 * preflight against a local fake registry and records every request. An all-present full-group
 * state is a no-op before credential work. Clean all-absent state passes only after an OIDC exchange
 * AND a GET-trust direct-publish census for every package. A prior partial publish, an incomplete
 * recursive publish set, a refused exchange, a
 * stage-only Allowed-actions sibling, and a stage-only this-workflow publisher next to an
 * unrelated GitHub publisher that lists createPackage all refuse without any write-shaped
 * request. An opaque HTTP 201 exchange is not treated as publish-ready. A registry that answers
 * the exact-version read with neither 200 nor 404, and a transport that throws instead of
 * answering, both leave the census unable to say whether a version is already published, and
 * both refuse as inconclusive before any credential or write work.
 *
 * Run: pnpm smoke:npm-publish-preflight
 * Prove: pnpm mutation-proof --config bin/smoke/mutations/npm-publish-preflight.json
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { CENSUS_BUCKETS, classifyDirectPublishPermission, isAbsentRegistry, isPresentRegistry, isUnknownRegistry, preflightNpmPublish } from "../../scripts/preflight-npm-publish.mjs";
import { emitDeclaration } from "./gen-npm-publish-preflight-dts.mjs";
import ts from "typescript";
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
  exactStatus?: (name: string) => number | undefined;
};
async function scenario({
  present = new Set(),
  workspacePackages = workspace,
  exchangeStatus = 201,
  trust,
  trustStatus = 200,
  exactStatus,
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
    const forced = exactStatus?.(name);
    res.writeHead(forced ?? (present.has(name) ? 200 : 404), { "content-type": "application/json" });
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
async function repositoryEntrypoint(
  registryState: RegistryState = "all-absent",
  credentialEnv: NodeJS.ProcessEnv = {},
) {
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
      ...credentialEnv,
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
  "accept control: a token-free repository entrypoint reaches the publish authorization stage",
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

const npmAccessTokenVariables = [
  "NPM_TOKEN",
  "NODE_AUTH_TOKEN",
  "npm_config__authToken",
  "pnpm_config__auth",
  "PNPM_CONFIG__AUTH",
  "npm_config_//registry.npmjs.org/:_authToken",
  "pnpm_config_//registry.npmjs.org/:_authToken",
];
for (const variable of npmAccessTokenVariables) {
  const tokenRefusal = await repositoryEntrypoint("all-absent", { [variable]: "test-only" });
  check(
    `${variable} refuses before the spawned repository entrypoint requests OIDC`,
    tokenRefusal.code !== 0
      && tokenRefusal.output.includes(`publish preflight refused: ${variable} is set; release publishes through OIDC only`)
      && tokenRefusal.seen.length === 0,
    { code: tokenRefusal.code, output: tokenRefusal.output, seen: tokenRefusal.seen },
  );
}

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

// A registry that answers the exact-version read with neither 200 nor 404 leaves the census
// unable to say whether the version is already published. Publishing on an unreadable census
// risks a partial recursive publish that cannot be rolled back, so the preflight must refuse.
const serviceUnavailable = await scenario({ exactStatus: (name) => (name === "@cotal-ai/seat" ? 503 : undefined) });
check(
  "a 503 on one exact-version read refuses the release as inconclusive",
  serviceUnavailable.error instanceof Error
    && serviceUnavailable.error.message.includes("registry census was inconclusive for 1/3 packages"),
  serviceUnavailable.error,
);
check(
  "the inconclusive census names the unreadable package and carries its registry status",
  serviceUnavailable.logs.some((line) => line.includes("@cotal-ai/seat\t9.9.9\tunknown:503")),
  serviceUnavailable.logs,
);
check(
  "an inconclusive census refuses before any OIDC exchange, trust GET, or publish call",
  serviceUnavailable.seen.every((call) => !call.url.startsWith("/-/npm/v1/oidc/token/exchange/package/"))
    && serviceUnavailable.seen.every((call) => !call.url.includes("/trust"))
    && serviceUnavailable.seen.every((call) => !isWriteShaped(call)),
  serviceUnavailable.seen,
);
check(
  "an inconclusive census prints the complete package and version census before exiting",
  fixed.every((name) => serviceUnavailable.logs.some((line) => line.includes(`${name}\t9.9.9\t`))),
  serviceUnavailable.logs,
);

// A redirect is not an answer either: `redirect: "manual"` means a 3xx arrives as a status,
// not as a followed response, and it must not be read as absent.
const redirected = await scenario({ exactStatus: () => 302 });
check(
  "a 302 on every exact-version read refuses the release rather than reading as absent",
  redirected.error instanceof Error
    && redirected.error.message.includes("registry census was inconclusive for 3/3 packages"),
  redirected.error,
);

// A transport failure reaches the same refusal by the other branch of readExactVersion,
// and the census must carry the thrown message rather than a bare status.
const transportFailure = await (async () => {
  const logs: string[] = [];
  const attempted: string[] = [];
  try {
    const result = await preflightNpmPublish({
      fixedPackages: fixed,
      workspacePackages: workspace,
      registryBase: "https://fake.registry",
      env: {},
      fetchImpl: (async (url: unknown) => {
        attempted.push(String(url));
        throw new Error("ECONNREFUSED 127.0.0.1:443");
      }) as unknown as typeof fetch,
      log: (line: string) => logs.push(line),
    });
    return { result, logs, attempted, error: undefined };
  } catch (error) {
    return { result: undefined, logs, attempted, error };
  }
})();
check(
  "a thrown fetch on the exact-version read refuses the release as inconclusive",
  transportFailure.error instanceof Error
    && transportFailure.error.message.includes("registry census was inconclusive for 3/3 packages"),
  transportFailure.error,
);
check(
  "the inconclusive census carries the thrown transport message, not a bare status",
  fixed.every((name) => transportFailure.logs.some((line) => line.includes(`${name}\t9.9.9\tunknown:ECONNREFUSED 127.0.0.1:443`))),
  transportFailure.logs,
);
check(
  "a thrown exact-version read stops after the census and never reaches OIDC or trust work",
  transportFailure.attempted.every((url) => !url.includes("/-/npm/v1/oidc/token/exchange/package/"))
    && transportFailure.attempted.every((url) => !url.includes("/trust")),
  transportFailure.attempted,
);

// Accept control for the three cells above: an all-200 census must still reach the named
// no-op and must NOT be dragged into the inconclusive refusal by the new fixture plumbing.
const inconclusiveAcceptControl = await scenario({ present: new Set(fixed), exactStatus: () => undefined });
check(
  "accept control: an all-present census still reports the no-op and is not read as inconclusive",
  inconclusiveAcceptControl.error === undefined
    && inconclusiveAcceptControl.result?.state === "nothing-to-publish",
  inconclusiveAcceptControl.error ?? inconclusiveAcceptControl.result,
);

// The `incomplete` rung is a backstop for a registry state the current status domain cannot
// produce: with no unknown rows, zero present rows forces absent === rows, which the earlier
// all-absent rung already claims. Two cells pin that domain, and they pin different halves of
// it. The first drives three registry answers and records what the census actually carried. It
// is an OBSERVATION over the statuses it happens to send, so on its own it cannot see a fourth
// outcome that only fires on a status it never sends: a branch returning something new on HTTP
// 418 escapes it completely. The second cell closes that hole by reading the shipped source and
// enumerating EVERY return in readExactVersion rather than sampling its behaviour.
const domainProbe: Array<{ label: string; exact: (name: string) => number | undefined }> = [
  { label: "all-200", exact: () => 200 },
  { label: "all-404", exact: () => 404 },
  { label: "all-503", exact: () => 503 },
];
const observedRegistryValues = new Set<string>();
for (const probe of domainProbe) {
  const run = await scenario({ exactStatus: probe.exact });
  for (const line of run.logs) {
    const [name, version, field] = line.split("\t");
    if (!fixed.includes(name) || version !== "9.9.9" || !field) continue;
    observedRegistryValues.add(field.startsWith("unknown:") ? "unknown:*" : field);
  }
}
check(
  "the census values observed across the 200, 404 and 503 answers are present, absent and unknown only",
  observedRegistryValues.size > 0
    && [...observedRegistryValues].every((value) => value === "present" || value === "absent" || value === "unknown:*"),
  [...observedRegistryValues],
);

// Structural half of the domain pin. Every `return` inside readExactVersion must produce one of
// the three values the verdict ladder buckets on. Enumerating the returns rather than sampling
// statuses is what makes a fourth outcome unmissable: a new branch is a new return whatever
// status guards it. The extractor fails RED rather than quietly green if it ever stops finding
// the function or its returns, because an extractor that reports nothing is indistinguishable
// from a source with nothing wrong.
//
// The returns are enumerated by the TYPESCRIPT COMPILER, not by a regex over the text. The
// previous revision matched /\breturn\s+([^;]+);/g against a brace-walked body, and a panel
// killed it with shapes that regex cannot represent: a bare `return;` carries no expression to
// capture, so it was invisible, and a return with no semicolon terminator was swallowed into
// the NEXT return's captured text, laundering an out-of-domain value into a domain-looking
// blob. Both parse cleanly, both change what the function returns, and both left the cell
// green. That is the defect this rewrite exists to remove: a test that cannot fail is not
// evidence, and the universal claim in this cell's name is worth exactly what the instrument
// behind it enumerates.
//
// What the parser gives that the regex could not: statement structure. A `return` is a
// ReturnStatement node whether or not a semicolon follows it, whether or not it carries an
// expression, and whatever a string, template or regex literal nearby happens to contain,
// because the lexer resolves those before the parser ever sees a statement. Nested functions
// are excluded by walking into them not at all, so a helper closure's own return is not
// mistaken for the outer function's.
const preflightSource = readFileSync(join(ROOT, "scripts/preflight-npm-publish.mjs"), "utf8");

// Which declaration the enumerator grades is itself a claim, and it used to be an unguarded one.
// The retired lookup was a recursive `forEachChild` that assigned to `target` on every match, so
// the LAST declaration named `readExactVersion` anywhere in the file won. A second declaration
// nested inside any other function therefore replaced the real one silently, and a panel drove
// exactly that: appending a nested same-name helper with four in-domain returns made the cell
// read the clean decoy while the real, poisoned function returned an out-of-domain value. The
// enumeration stayed at four returns, so the printed count offered no signal either.
//
// The shipped function is a TOP-LEVEL declaration, so the lookup is restricted to
// `parsed.statements`. Nothing nested can be selected, because nothing nested is looked at. Zero
// matches and more than one match are both refusals rather than a silent pick, and the COUNT goes
// into the reason, because "not found" and "found three" send a reader to different repairs.
type TopLevelLookup =
  | { fn: ts.FunctionDeclaration; why: null }
  | { fn: null; why: string };
function soleTopLevelFunction(parsed: ts.SourceFile, name: string): TopLevelLookup {
  const declared = parsed.statements.filter(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  );
  if (declared.length !== 1) {
    return {
      fn: null,
      why: `${name}: ${declared.length} top-level function declarations found, and exactly 1 is required`
        + ` (0 means the enumerator grades nothing; 2 or more means which one ships is ambiguous)`,
    };
  }
  const [only] = declared;
  if (!only.body) return { fn: null, why: `${name}: 1 top-level function declaration found, but it has no body to enumerate` };
  return { fn: only, why: null };
}

// The boundary the return walk stops at, pinned in ONE place so both halves of the claim are the
// same predicate. The retired version was a hand-rolled six-way union that omitted
// `ConstructorDeclaration` and `ClassStaticBlockDeclaration`, so a return inside a local class
// constructor was attributed to the enclosing function and counted as one of its returns. That is
// the false-positive direction: it reds a clean source for a value the function never returns.
// `ts.isFunctionLike` is the compiler's own answer and covers constructors, methods, accessors,
// function declarations and expressions and arrows. A class static block is NOT function-like to
// the compiler and so is named separately.
const isReturnScopeBoundary = (node: ts.Node): boolean =>
  ts.isFunctionLike(node) || ts.isClassStaticBlockDeclaration(node);

// A return is IN DOMAIN only if the parser can prove its value from the syntax alone:
//   - a string literal exactly "present" or "absent"; or
//   - any template whose HEAD text begins "unknown:", which is a static prefix guarantee. The
//     shipped unknown returns interpolate (`unknown:${response.status}`), and the head is
//     emitted verbatim before any substitution, so the runtime string starts with "unknown:"
//     whatever the substitution evaluates to. A template with an EMPTY head proves nothing and
//     is therefore out of domain.
// Everything else, including a bare return, an identifier, a call, or a conditional, is OUT OF
// DOMAIN and reds. Refusing to reason about values the syntax does not pin is the point: an
// extractor that guesses is an extractor that can be fooled.
type CensusReturn = { text: string; inDomain: boolean; why: string };
type CensusEnumeration =
  | { returns: CensusReturn[]; why: null }
  | { returns: null; why: string };
function censusReturnsOf(source: string): CensusEnumeration {
  const parsed = ts.createSourceFile("preflight-npm-publish.mjs", source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  const located = soleTopLevelFunction(parsed, "readExactVersion");
  if (located.fn === null) return { returns: null, why: located.why };
  const target = located.fn;
  const found: ts.ReturnStatement[] = [];
  const walk = (node: ts.Node): void => {
    if (isReturnScopeBoundary(node)) return;
    if (ts.isReturnStatement(node)) found.push(node);
    node.forEachChild(walk);
  };
  target.body!.forEachChild(walk);
  const returns = found.map((statement) => {
    const text = statement.getText(parsed);
    const expression = statement.expression;
    if (!expression) return { text, inDomain: false, why: "bare return: yields undefined, which no census bucket claims" };
    if (ts.isStringLiteral(expression)) {
      const ok = expression.text === "present" || expression.text === "absent";
      return { text, inDomain: ok, why: ok ? `string literal ${JSON.stringify(expression.text)}` : `string literal ${JSON.stringify(expression.text)} is not present or absent` };
    }
    if (ts.isNoSubstitutionTemplateLiteral(expression)) {
      const ok = expression.text.startsWith("unknown:");
      return { text, inDomain: ok, why: ok ? `template literal ${JSON.stringify(expression.text)}` : `template literal ${JSON.stringify(expression.text)} does not begin unknown:` };
    }
    if (ts.isTemplateExpression(expression)) {
      const head = expression.head.text;
      const ok = head.startsWith("unknown:");
      return { text, inDomain: ok, why: ok ? `template head ${JSON.stringify(head)} is a static unknown: prefix` : `template head ${JSON.stringify(head)} does not begin unknown:` };
    }
    return { text, inDomain: false, why: `${ts.SyntaxKind[expression.kind]}: the syntax does not pin the value, so it cannot be proved to land in a bucket` };
  });
  return { returns, why: null };
}

const censusEnumeration = censusReturnsOf(preflightSource);
const censusReturns = censusEnumeration.returns;
const outOfDomainReturns = (censusReturns ?? []).filter((entry) => !entry.inDomain).map((entry) => `${entry.text} -- ${entry.why}`);
check(
  `the ${censusReturns?.length ?? 0} return statements the compiler finds in readExactVersion each yield present, absent or an unknown: value, so no fourth census outcome reaches the verdict ladder unbucketed`,
  censusReturns !== null && censusReturns.length >= 4 && outOfDomainReturns.length === 0,
  censusReturns === null ? censusEnumeration.why : outOfDomainReturns,
);

// The extractor is itself an instrument, so it is graded here rather than trusted. Each case
// below is a shape the RETIRED regex passed clean and this parser must refuse, plus a positive
// control so a parser that refused EVERYTHING could not pose as rigour. These run against
// synthetic sources, not the shipped file, because the point is what the instrument does with
// input the shipped file does not contain. The shipped file is graded by the cell above.
//
// Each case is built by injecting a line into a faithful copy of the shipped function. The
// copy is asserted to be in domain on its own first: if the skeleton drifted from the real
// function, these cases would grade a strawman.
function skeleton(inject: string): string {
  return [
    "async function readExactVersion(pkg, registryBase, fetchImpl) {",
    "  try {",
    "    const response = await fetchImpl(versionUrl(registryBase, pkg.name, pkg.version), {",
    "      method: \"GET\",",
    "      redirect: \"manual\",",
    "    });",
    inject,
    "    if (response.status === 200) return \"present\";",
    "    if (response.status === 404) return \"absent\";",
    "    return `unknown:${response.status}`;",
    "  } catch (error) {",
    "    return `unknown:${error instanceof Error ? error.message : String(error)}`;",
    "  }",
    "}",
  ].join("\n");
}
const cleanSkeleton = censusReturnsOf(skeleton("    // nothing injected")).returns;
check(
  "positive control: the unmodified skeleton parses to exactly the shipped function's four in-domain returns, so the escape cases below grade a faithful copy",
  cleanSkeleton !== null && cleanSkeleton.length === 4 && cleanSkeleton.every((entry) => entry.inDomain),
  cleanSkeleton,
);

// The escapes. Each names the shape, the line that produces it, and what the retired regex did
// with it. `seen` is what the parser must now report.
const escapes: Array<{ shape: string; inject: string; retired: string }> = [
  {
    shape: "a bare return, which yields undefined",
    inject: "    if (response.status === 418) return;",
    retired: "invisible: /\\breturn\\s+([^;]+);/ requires a non-empty expression, so it matched nothing here",
  },
  {
    shape: "a return with no semicolon terminator, closed by ASI",
    inject: "    if (response.status === 418) return \"outside-domain\"",
    retired: "swallowed: the capture ran past the newline into the next return, laundering the value into a domain-looking blob",
  },
  {
    shape: "two semicolon-free template returns above a terminated one",
    inject: "    if (response.status === 418) return `unknown:x`\n    if (response.status === 419) return `outside-domain`",
    retired: "laundered: one capture began `unknown: and ended `, so the out-of-domain second return was read as in domain",
  },
  {
    shape: "an out-of-domain return whose string contains a semicolon",
    inject: "    if (response.status === 418) return \"outside;domain\";",
    retired: "truncated: the capture stopped at the semicolon INSIDE the string literal",
  },
  {
    shape: "an out-of-domain return whose template contains a semicolon",
    inject: "    if (response.status === 418) return `outside;${response.status}`;",
    retired: "truncated: the capture stopped at the semicolon inside the template",
  },
  {
    shape: "a regex literal holding close braces above an out-of-domain return",
    inject: "    const closeBraces = /}}/;\n    if (response.status === 418) return \"outside-domain\";",
    retired: "desynchronised: the brace walker does not lex regex literals, so the extracted body ended early",
  },
  {
    shape: "a return of an identifier the syntax cannot pin",
    inject: "    if (response.status === 418) return response.statusText;",
    retired: "accepted as text: the regex captured the expression source, and any value-shaped text passed the string compare",
  },
  {
    shape: "a return whose value is a call the syntax cannot pin",
    inject: "    if (response.status === 418) return String(response.status);",
    retired: "accepted as text: same failure, an expression is not a value",
  },
];
const escapeResults = escapes.map((escape) => {
  const source = skeleton(escape.inject);
  const parsedForCheck = ts.createSourceFile("x.mjs", source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  const parses = ((parsedForCheck as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics ?? []).length === 0;
  const returns = censusReturnsOf(source).returns;
  const caught = (returns ?? []).some((entry) => !entry.inDomain);
  return { ...escape, parses, caught, returns };
});
for (const result of escapeResults) {
  check(
    `the return enumerator refuses ${result.shape}, a shape the retired regex ${result.retired.split(":")[0]}`,
    result.parses && result.caught,
    { parses: result.parses, returns: result.returns?.map((entry) => `${entry.text} -- ${entry.why}`) },
  );
}
check(
  `all ${escapes.length} enumerated escape shapes are valid JavaScript, so each is a change a commit could really land rather than a syntax error the parser rejects for the wrong reason`,
  escapeResults.every((result) => result.parses),
  escapeResults.filter((result) => !result.parses).map((result) => result.shape),
);
// A nested function's return belongs to the nested function. Enumerating it would red the
// shipped source for a value readExactVersion never returns, so the walk must stop at any
// function boundary. This is the FALSE-POSITIVE half of the extractor's grading.
const nestedOnly = censusReturnsOf(skeleton("    const helper = () => \"nested-out-of-domain\";\n    const helper2 = function () { return \"also-nested\"; };\n    void helper; void helper2;")).returns;
check(
  "a return inside a nested function is not attributed to readExactVersion, so the enumerator does not red on a value the function never returns",
  nestedOnly !== null && nestedOnly.length === 4 && nestedOnly.every((entry) => entry.inDomain),
  nestedOnly,
);

// Location, graded four ways. The three cases below are the shapes that defeated the retired
// last-match-wins lookup, plus the boundary shapes the retired hand-rolled union missed. Each is
// a source the parser accepts, so none of them is refused for the wrong reason.
//
// 1. THE SHADOW. A second `readExactVersion` nested inside another function, carrying four
// in-domain returns, while the real one returns an out-of-domain value. Under the retired lookup
// the decoy won and the cell read four clean returns; under the top-level pin the decoy is never
// looked at and the real function's poisoned return is enumerated and refused.
const shadowedCensus = censusReturnsOf(
  skeleton("    if (response.status === 418) return \"outside-domain\";")
  + "\nfunction wrapper() {\n"
  + "  async function readExactVersion(pkg, registryBase, fetchImpl) {\n"
  + "    if (pkg) return \"present\";\n"
  + "    if (registryBase) return \"absent\";\n"
  + "    if (fetchImpl) return `unknown:decoy`;\n"
  + "    return `unknown:decoy-tail`;\n"
  + "  }\n"
  + "  return readExactVersion;\n"
  + "}\n",
);
check(
  "a nested same-name readExactVersion decoy cannot replace the shipped declaration, so a poisoned real function is still enumerated and refused",
  shadowedCensus.returns !== null
    && shadowedCensus.returns.some((entry) => !entry.inDomain && entry.text.includes("outside-domain")),
  { why: shadowedCensus.why, returns: shadowedCensus.returns?.map((entry) => `${entry.text} -- ${entry.why}`) },
);

// 2. A constructor is a function boundary. `ts.isFunctionLike` says so; the retired six-way union
// did not, so a local class constructor's return was counted as one of readExactVersion's and the
// clean skeleton reddened with five enumerated returns. This is the FALSE-POSITIVE direction.
const constructorReturn = censusReturnsOf(
  skeleton("    class Local { constructor() { return \"ctor-out-of-domain\"; } }\n    void Local;"),
).returns;
check(
  "a return inside a constructor is not attributed to readExactVersion, so a local class does not red the enumerator with a value the function never returns",
  constructorReturn !== null && constructorReturn.length === 4 && constructorReturn.every((entry) => entry.inDomain),
  constructorReturn,
);

// 3. A class static block is also a boundary, and it is the one `ts.isFunctionLike` does NOT
// cover, which is why the boundary predicate names it separately. Disclosed limitation: a
// `return` inside a static block is accepted by the TypeScript parser but REJECTED by node as an
// illegal return statement, so this shape is not a commit that could really land. It grades the
// boundary predicate, not a reachable production defect, and is kept for that reason alone.
const staticBlockReturn = censusReturnsOf(
  skeleton("    class Local { static { return \"static-out-of-domain\"; } }\n    void Local;"),
).returns;
check(
  "a return inside a class static block is not attributed to readExactVersion, so the boundary covers the one shape ts.isFunctionLike does not",
  staticBlockReturn !== null && staticBlockReturn.length === 4 && staticBlockReturn.every((entry) => entry.inDomain),
  staticBlockReturn,
);

// 4. Two top-level declarations of the target are AMBIGUOUS, not a silent pick of either. The
// count is required in the refusal, because "found 0" and "found 2" are different repairs and a
// refusal that does not say which sends the reader to the wrong one.
const ambiguousCensus = censusReturnsOf(
  skeleton("    // first declaration")
  + "\n"
  + skeleton("    // second declaration"),
);
check(
  "two top-level readExactVersion declarations red as ambiguous rather than resolving to either, and the refusal carries the count",
  ambiguousCensus.returns === null
    && typeof ambiguousCensus.why === "string"
    && ambiguousCensus.why.includes("2 top-level function declarations found"),
  ambiguousCensus.why,
);

// Bucket membership, derived from the SHIPPED predicates rather than transcribed.
//
// The previous revision re-typed the three predicates inline and asked whether each row
// satisfied exactly one. A panel proved that unkillable: no string satisfies two of
// `=== "present"`, `=== "absent"` and `.startsWith("unknown:")`, so the overlap the cell
// documented as its purpose was unreachable by construction, and widening the SHIPPED absent
// bucket left the copy green. That is the same unkillable shape the commit it replaced claimed
// to remove.
//
// This cell imports isPresentRegistry, isAbsentRegistry and isUnknownRegistry, which are the
// functions the verdict ladder itself calls, and applies them to rows from a real preflight
// run. Widening any shipped predicate to overlap another therefore changes what THIS cell
// computes. The name says what it proves: every production row lands in exactly one bucket
// under the shipped predicates. Totality and disjointness are both live here, because a row
// matching zero buckets and a row matching two are both counted.
const bucketProbe = await scenario({ exactStatus: (name) => (name === "@cotal-ai/seat" ? 503 : 404) });
const bucketRows = bucketProbe.logs
  .map((line) => line.split("\t"))
  .filter(([name, version]) => fixed.includes(name) && version === "9.9.9")
  .map(([, , registry]) => registry);
const bucketMemberships = bucketRows.map((registry) => ({
  registry,
  buckets: CENSUS_BUCKETS.filter((bucket) => bucket.matches(registry)).map((bucket) => bucket.name),
}));
check(
  "under the shipped bucket predicates every production census row lands in exactly one bucket, so no row is double-counted by the verdict ladder and none is invisible to it",
  bucketRows.length === fixed.length && bucketMemberships.every((row) => row.buckets.length === 1),
  bucketMemberships,
);
// The cell above can only grade rows the probe produces. This one grades the predicates
// themselves over the value domain the enumerator proved readExactVersion can return, so a
// widening that the probe's three rows happen not to exercise is still caught.
const domainSamples = ["present", "absent", "unknown:503", "unknown:ECONNREFUSED 127.0.0.1:443"];
const sampleMemberships = domainSamples.map((registry) => ({
  registry,
  buckets: CENSUS_BUCKETS.filter((bucket) => bucket.matches(registry)).map((bucket) => bucket.name),
}));
check(
  "the shipped bucket predicates put each value readExactVersion can return in exactly one bucket, so the ladder's rung order stays safe for the whole return domain and not just the sampled rows",
  sampleMemberships.every((sample) => sample.buckets.length === 1),
  sampleMemberships,
);
// CENSUS_BUCKETS is the handle this suite grades through, so it must be the SAME predicates the
// ladder applies, not a parallel list that agrees today. Found by attacking the cells above:
// rewriting one CENSUS_BUCKETS entry to an equivalent inline arrow left every cell green, which
// would let the exported table drift away from the shipped ladder and quietly restore the
// transcription defect one layer up. So read the ladder with the same parser used on the
// returns and require that each bucket's filter callback CALLS the exported predicate by name.
//
// The same top-level pin applies here, and for a sharper reason than symmetry. This enumerator
// selected `preflightNpmPublish` by the identical last-match-wins recursive walk, so a decoy
// declaration of that name nested anywhere in the file replaced the shipped ladder. Measured: with
// the CENSUS_BUCKETS drift mutation applied so the real ladder inlines the absent comparison, a
// nested decoy that calls all three predicates by name returned this cell to GREEN. The defeat is
// not hypothetical and it hides a real drift, so location is pinned to exactly one top-level
// declaration and any other count is a refusal carrying its count.
type LadderEnumeration =
  | { callees: string[]; why: null }
  | { callees: null; why: string };
function ladderFilterCallees(source: string): LadderEnumeration {
  const parsed = ts.createSourceFile("preflight-npm-publish.mjs", source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  const located = soleTopLevelFunction(parsed, "preflightNpmPublish");
  if (located.fn === null) return { callees: null, why: located.why };
  const fn = located.fn;
  const callees: string[] = [];
  const walk = (node: ts.Node): void => {
    // The same boundary the return walk uses, and for the same reason. Pinning the TARGET to one
    // top-level declaration stops a SIBLING decoy from being selected, but it does not stop a decoy
    // nested INSIDE the real function from contributing its callees to this list. Measured after
    // the top-level pin was in place: with the absent comparison inlined and a decoy
    // `preflightNpmPublish` declared inside the real one, all three names were still collected and
    // the cell stayed green. Location and attribution are two claims, and the pin only makes one of
    // them. A nested function's `filter` call is not the ladder's.
    if (isReturnScopeBoundary(node)) return;
    // `rows.filter((row) => <callee>(row.registry))`
    if (ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === "filter"
      && node.arguments.length === 1) {
      const arrow = node.arguments[0];
      if (ts.isArrowFunction(arrow) && ts.isCallExpression(arrow.body) && ts.isIdentifier(arrow.body.expression)) {
        callees.push(arrow.body.expression.text);
      }
      // The arrow IS a boundary, so descend into the call's own subtree deliberately rather than
      // letting the generic walk do it: the callee name lives in the argument that was just read,
      // and nothing below it is the ladder's own code.
      return;
    }
    node.forEachChild(walk);
  };
  fn.body!.forEachChild(walk);
  return { callees, why: null };
}
const ladderEnumeration = ladderFilterCallees(preflightSource);
const ladderCallees = ladderEnumeration.callees;
const bucketPredicateNames = ["isUnknownRegistry", "isPresentRegistry", "isAbsentRegistry"];
check(
  "the verdict ladder buckets rows by calling the exported predicates by name, so CENSUS_BUCKETS cannot drift into a parallel copy that agrees today and diverges later",
  ladderCallees !== null && bucketPredicateNames.every((name) => ladderCallees.includes(name)),
  { ladderCallees, locationRefusal: ladderEnumeration.why, required: bucketPredicateNames },
);

// 5. The ladder's own shadow, which is the case that actually hides a drift rather than merely
// confusing an instrument. The source below is the SHIPPED file with the ladder's absent filter
// inlined, AND a nested decoy `preflightNpmPublish` that calls all three predicates by name. Under
// the retired last-wins lookup the decoy replaced the real ladder and this cell went green while
// the shipped ladder had already drifted. Under the top-level pin the decoy is invisible and the
// drift is still seen.
//
// The drift applied here is the one the LADDER-INLINE fixture entry applies, which is a DIFFERENT
// entry from the CENSUS_BUCKETS drift. Both inline the same absent comparison, which is exactly how
// one gets mistaken for the other, and one was: the two entries are adjacent in the fixture. They
// touch different code. The bucket entry rewrites the module-level CENSUS_BUCKETS table, which sits
// OUTSIDE preflightNpmPublish and which this enumerator therefore never reads; measured, applying
// it leaves this enumerator's callee list byte-identical. The ladder entry is the one that can
// defeat this cell, so it is the one used, and both are located BY NAME below because the union
// merge renumbers the file and index would silently select the neighbour.
//
// The drift is applied here by the same string the fixture uses, so the two cannot diverge
// silently: if the shipped line is reworded, this substitution stops changing the source and the
// assertion below that it DID change fails first, which is a louder failure than a quiet green.
const ladderDriftFind = "  const absent = rows.filter((row) => isAbsentRegistry(row.registry));\n";
const ladderDriftReplace = "  const absent = rows.filter((row) => row.registry === \"absent\");\n";
const driftedLadderSource = preflightSource.split(ladderDriftFind).join(ladderDriftReplace);
// Read both drift entries out of the fixture BY NAME and assert the strings this file uses are the
// fixture's own, so the cell and the fixture cannot drift apart.
const preflightFixture = JSON.parse(readFileSync(join(ROOT, "bin/smoke/mutations/npm-publish-preflight.json"), "utf8")) as
  { mutations: Array<{ name: string; find: string; replace: string }> };
const fixtureEntry = (name: string) => preflightFixture.mutations.filter((entry) => entry.name === name);
const LADDER_INLINE_ENTRY = "the verdict ladder stops calling the exported bucket predicate and inlines the comparison";
const BUCKET_DRIFT_ENTRY = "a CENSUS_BUCKETS entry drifts off the exported predicate onto an equivalent inline copy";
const ladderInline = fixtureEntry(LADDER_INLINE_ENTRY);
const bucketDrift = fixtureEntry(BUCKET_DRIFT_ENTRY);
// Both lookups must RESOLVE before anything below grades anything, because a by-name lookup that
// misses is SILENT: the cells beneath it still run and still pass on an undefined entry, and the
// only trace is a cell count nobody compares. Measured while building this: renaming one fixture
// entry dropped three cells from the run with zero failures reported. A rename is a legitimate
// thing for a later commit to do, so the miss has to be loud and has to name what vanished.
check(
  "both drift entries this file grades through resolve in the fixture by name, so a renamed entry fails loudly instead of silently deleting the cells below it",
  ladderInline.length === 1 && bucketDrift.length === 1,
  {
    ladderInlineMatches: ladderInline.length,
    bucketDriftMatches: bucketDrift.length,
    hint: "exactly 1 each is required; 0 means the entry was renamed or removed",
  },
);
check(
  "the ladder drift this cell applies is the fixture's own ladder-inline entry, so the cell grades the mutation the fixture actually ships",
  ladderInline.length === 1
    && ladderInline[0].find === ladderDriftFind
    && ladderInline[0].replace === ladderDriftReplace,
  { matched: ladderInline.length, find: ladderInline[0]?.find, replace: ladderInline[0]?.replace },
);
// The two entries are NOT interchangeable, and this cell exists because they were confused once.
const bucketDriftedSource = bucketDrift.length === 1
  ? preflightSource.split(bucketDrift[0].find).join(bucketDrift[0].replace)
  : preflightSource;
check(
  "the CENSUS_BUCKETS drift entry changes the shipped source but leaves the ladder enumerator's reading identical, so it is not the entry that can defeat the ladder cell",
  bucketDrift.length === 1
    && bucketDriftedSource !== preflightSource
    && JSON.stringify(ladderFilterCallees(bucketDriftedSource).callees) === JSON.stringify(ladderCallees),
  {
    changedSource: bucketDriftedSource !== preflightSource,
    calleesUnderBucketDrift: ladderFilterCallees(bucketDriftedSource).callees,
    calleesShipped: ladderCallees,
  },
);
// The bucket drift IS graded, just by a different cell: a RUNTIME identity comparison over imported
// function objects. No textual decoy can launder an object identity, so that pairing is decoy-proof
// by construction rather than by a guard a later commit could relax.
check(
  "the CENSUS_BUCKETS drift replaces the exported predicate with an inline copy, so the identity cell that grades it cannot be laundered by any nested decoy",
  bucketDrift.length === 1
    && bucketDrift[0].find.includes("isAbsentRegistry")
    && !bucketDrift[0].replace.includes("isAbsentRegistry")
    && CENSUS_BUCKETS.find((bucket) => bucket.name === "absent")?.matches === isAbsentRegistry,
  { find: bucketDrift[0]?.find, replace: bucketDrift[0]?.replace },
);
check(
  "positive control: the ladder drift used by the decoy cell really changes the shipped source, so that cell is not grading an unmodified file",
  driftedLadderSource !== preflightSource && preflightSource.includes(ladderDriftFind),
  { occurrences: preflightSource.split(ladderDriftFind).length - 1, changed: driftedLadderSource !== preflightSource },
);
const shadowedLadder = ladderFilterCallees(
  driftedLadderSource
  + "\nfunction ladderWrapper() {\n"
  + "  async function preflightNpmPublish(rows) {\n"
  + "    const unknown = rows.filter((row) => isUnknownRegistry(row.registry));\n"
  + "    const present = rows.filter((row) => isPresentRegistry(row.registry));\n"
  + "    const absent = rows.filter((row) => isAbsentRegistry(row.registry));\n"
  + "    return { unknown, present, absent };\n"
  + "  }\n"
  + "  return preflightNpmPublish;\n"
  + "}\n",
);
check(
  "a nested same-name preflightNpmPublish decoy cannot restore this cell to green, so a ladder that has drifted off the exported predicate is still caught",
  shadowedLadder.callees !== null && !shadowedLadder.callees.includes("isAbsentRegistry"),
  { callees: shadowedLadder.callees, locationRefusal: shadowedLadder.why },
);
// And the ambiguity refusal for this enumerator too, with its count, so the pin is graded on both
// enumerators rather than assumed to transfer.
const ambiguousLadder = ladderFilterCallees(
  preflightSource
  + "\nasync function preflightNpmPublish(rows) {\n"
  + "  return rows.filter((row) => isAbsentRegistry(row.registry));\n"
  + "}\n",
);
check(
  "two top-level preflightNpmPublish declarations red as ambiguous rather than resolving to either, and the refusal carries the count",
  ambiguousLadder.callees === null
    && typeof ambiguousLadder.why === "string"
    && ambiguousLadder.why.includes("2 top-level function declarations found"),
  ambiguousLadder.why,
);
// The pin fixes SELECTION. Attribution is a separate claim, and it was still open after the pin
// landed: a decoy declared INSIDE the real ladder contributed its callees to the same list, so the
// drifted ladder still read as calling all three predicates. Measured at that intermediate state,
// which is why the walk now stops at a function boundary here too. This cell is the decoy in its
// nastiest placement, inside the real target rather than beside it.
const innerShadowedLadder = ladderFilterCallees(
  preflightSource.split(ladderDriftFind).join(
    ladderDriftReplace
    + "  function shadowHolder() {\n"
    + "    async function preflightNpmPublish(shadowRows) {\n"
    + "      return shadowRows.filter((row) => isAbsentRegistry(row.registry));\n"
    + "    }\n"
    + "    return preflightNpmPublish;\n"
    + "  }\n"
    + "  void shadowHolder;\n",
  ),
);
check(
  "a decoy preflightNpmPublish nested INSIDE the real ladder does not lend it the exported predicate, so attribution is pinned as well as location",
  innerShadowedLadder.callees !== null && !innerShadowedLadder.callees.includes("isAbsentRegistry"),
  { callees: innerShadowedLadder.callees, locationRefusal: innerShadowedLadder.why },
);
check(
  "each CENSUS_BUCKETS entry is the exported predicate object itself, so grading through the table grades the function the ladder calls",
  CENSUS_BUCKETS.length === 3
    && CENSUS_BUCKETS.find((bucket) => bucket.name === "unknown")?.matches === isUnknownRegistry
    && CENSUS_BUCKETS.find((bucket) => bucket.name === "present")?.matches === isPresentRegistry
    && CENSUS_BUCKETS.find((bucket) => bucket.name === "absent")?.matches === isAbsentRegistry,
  CENSUS_BUCKETS.map((bucket) => bucket.name),
);

// 6. DATA FLOW, not text presence. Everything above this point asks "does the ladder's text
// contain a call to each exported predicate". That question is satisfiable by a call that can
// never run, and a dead call is cheap to write.
//
// Measured at this head with only the enumerator above in place, each bucket drifted ALONE to an
// inline comparison with a dead `if (false)` call to its predicate left beside it:
//
//   unknown  drifted + dead call  ->  119 passed, 0 failed   NOT CAUGHT
//   present  drifted + dead call  ->  119 passed, 0 failed   NOT CAUGHT
//   absent   drifted + dead call  ->  116 passed, 3 failed   NOT CAUGHT EITHER
//
// The `absent` row is the trap. Its three reds are the positive control and the two decoy cells
// above, all of which anchor on the exact `absent` line the drift rewrote, so they fail because
// their anchors rotted rather than because anything detected the drift. A cell that reds because
// its anchor rotted is indistinguishable from a cell that reds because it caught something, and
// the difference is the whole verdict. The rot-only control at the end of this section separates
// them: it rewrites that same line WITHOUT changing the data flow, and the reading below stays
// green while those anchors rot.
//
// The question that matters is "does the value `registryVerdict` consumes come from the exported
// predicate". So this reading resolves it: take the sole top-level ladder, take the sole
// `registryVerdict` declaration in the ladder's OWN statement list, read the identifiers its
// initialiser actually consumes, resolve each of those to a declaration in that same statement
// list, and require the bucket bindings among them to be INITIALISED by a call of an exported
// predicate. A call that is not the initialiser of a consumed binding is unreachable from this
// reading by construction, so a dead call, a nested call, and a call in a branch the verdict never
// reads all fail to satisfy it. There is no guard to relax: the laundering call is simply never
// looked at.
//
// WHICH declaration that call binds to is asked of the COMPILER'S BINDER, not of a scope walk
// written here. The retired version walked the callee's scope chain itself, testing each enclosing
// SourceFile, Block, function-like and catch clause for a same-name declaration. Every revision of
// that walk was a better ENUMERATION of the ways a name can be rebound, and every revision was
// defeated by a shape it did not enumerate. Measured at the head that shipped it, on a tree where
// all 143 cells were green:
//
//   a same-name predicate in the ladder's DESTRUCTURED parameter list  ->  143 passed, 0 failed
//   `{ var isUnknownRegistry = ... }` in a sibling block, hoisted      ->  143 passed, 0 failed
//
// The first escaped because the walk filtered parameters on `ts.isIdentifier(parameter.name)` and
// the shipped ladder's only parameter is an ObjectBindingPattern, so every binding inside it was
// invisible. The second escaped because `var` hoists to the function scope while the walk read
// only the statements of the block it was handed. Both are live shadows: the second changes what a
// real 404/404/410 census returns, from inconclusive to incomplete.
//
// There are more shapes than a list here will hold, so this reading stops listing them.
// `getSymbolAtLocation` on the call's expression is the answer the language itself uses, aliases
// are followed with `getAliasedSymbol` so a re-export resolves to its origin, and the callee is
// accepted only when that symbol IS the module's exported symbol of the same name, which must have
// exactly one declaration and that declaration must be the top-level one. Refusal is by SYMBOL
// IDENTITY. Binding patterns, `var` hoisting, parameters, catch clauses and every shape not
// thought of here are already modelled by the binder, because it is the binder that decides them.
//
// `rows` is consumed too (`rows.length`) and is deliberately NOT a bucket binding: its initialiser
// is `[]`, not a `.filter()` call. Partitioning on the initialiser SHAPE rather than on the binding
// NAME is what makes this survive a rename. A ladder that computes `absentRows` inline and reads
// THAT in the verdict still has three bucket bindings, one of which calls no predicate, and reds
// here even though a correct `absent` binding is still declared and still calls isAbsentRegistry
// one line above. That variant is graded below, because it is the same laundering with the dead
// call made live, and a fix that only knew the name `absent` would miss it.
// A Program over the single module, so the reading below can ask the checker which declaration a
// call binds to. Nothing outside this source is resolved: `noResolve` and `noLib` keep the program
// to the one file, so the answer is about this text and never about whatever happens to sit on disk
// beside it. The SourceFile handed to the host is the same node the reading walks, so a symbol the
// checker returns and a node this file inspects are the same objects.
const CHECKED_MODULE_FILENAME = "preflight-npm-publish.mjs";
function checkedModule(source: string): { parsed: ts.SourceFile; checker: ts.TypeChecker } {
  const parsed = ts.createSourceFile(CHECKED_MODULE_FILENAME, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  const host: ts.CompilerHost = {
    getSourceFile: (name) => (name === CHECKED_MODULE_FILENAME ? parsed : undefined),
    getDefaultLibFileName: () => "lib.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => "/",
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (name) => name === CHECKED_MODULE_FILENAME,
    readFile: (name) => (name === CHECKED_MODULE_FILENAME ? source : undefined),
  };
  const program = ts.createProgram([CHECKED_MODULE_FILENAME], {
    allowJs: true,
    noResolve: true,
    noLib: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    types: [],
  }, host);
  return { parsed: program.getSourceFile(CHECKED_MODULE_FILENAME)!, checker: program.getTypeChecker() };
}

// An `export { f }` clause produces an ALIAS symbol, which is a different object from the symbol
// the declaration creates. Comparing those two by identity would refuse a module that exports its
// predicates in a trailing clause rather than inline, which is a refactor this pin has no business
// forbidding, so both sides are followed to their origin before they are compared.
const unalias = (checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol =>
  (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;

type BucketBinding = { name: string; callee: string | null; initializer: string; calleeWhy: string | null };
type LadderBindingEnumeration =
  | { bindings: BucketBinding[]; why: null }
  | { bindings: null; why: string };
function ladderConsumedBuckets(source: string): LadderBindingEnumeration {
  const { parsed, checker } = checkedModule(source);
  const located = soleTopLevelFunction(parsed, "preflightNpmPublish");
  if (located.fn === null) return { bindings: null, why: located.why };
  // The ladder's own statement list, not a recursive walk. A declaration nested in a block, in a
  // dead branch, or inside another function is not what this scope's `registryVerdict` reads, so
  // it is not looked at. This is the same reason the walks above stop at a function boundary,
  // applied to bindings instead of to calls.
  const statements = [...located.fn.body!.statements];
  const declarationsOf = (name: string): ts.VariableDeclaration[] =>
    statements.flatMap((statement) =>
      ts.isVariableStatement(statement)
        ? statement.declarationList.declarations.filter(
            (declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === name,
          )
        : []);
  // An export the module declares under a name, as ONE symbol. `getExportsOfModule` is the
  // checker's own export table, so `export const f = ...`, a separate `export { f }`, and a
  // re-export all arrive here the same way, and an alias is followed to the thing it names rather
  // than compared as the alias record.
  const moduleSymbol = checker.getSymbolAtLocation(parsed);
  const moduleExports = moduleSymbol ? checker.getExportsOfModule(moduleSymbol) : [];
  const exportedSymbol = (name: string): { symbol: ts.Symbol | null; why: string | null } => {
    const matches = moduleExports.filter((exported) => exported.name === name);
    if (matches.length !== 1) {
      return { symbol: null, why: `${name}: ${matches.length} module exports found under that name, and exactly 1 is required` };
    }
    const target = unalias(checker, matches[0]);
    const declarations = target.declarations ?? [];
    if (declarations.length !== 1) {
      return {
        symbol: null,
        why: `${name}: the export resolves to a symbol with ${declarations.length} declarations, and exactly 1 is required`
          + ` (0 means nothing declares it here; 2 or more means which declaration ships is ambiguous)`,
      };
    }
    const declaration = declarations[0];
    if (declaration.parent === undefined || !ts.isVariableDeclarationList(declaration.parent)
      || declaration.parent.parent === undefined || !ts.isVariableStatement(declaration.parent.parent)
      || declaration.parent.parent.parent !== parsed) {
      return { symbol: null, why: `${name}: the export's sole declaration is not a top-level variable declaration in this module` };
    }
    return { symbol: target, why: null };
  };
  const verdict = declarationsOf("registryVerdict");
  if (verdict.length !== 1) {
    return {
      bindings: null,
      why: `registryVerdict: ${verdict.length} declarations found in the ladder's own scope, and exactly 1 is required`
        + ` (0 means the verdict was renamed or moved out of this scope and this reading grades nothing;`
        + ` 2 or more means which one the ladder reads is ambiguous)`,
    };
  }
  const initializer = verdict[0].initializer;
  if (!initializer) {
    return { bindings: null, why: "registryVerdict: the sole declaration has no initialiser, so it consumes nothing and there is no data flow to pin" };
  }
  // Only the identifiers the verdict expression actually READS. `unknown.length` reads `unknown`,
  // and descending generically would also collect a phantom binding called `length`, so a property
  // access contributes its object and never its property name.
  const consumed: string[] = [];
  const readIdentifiers = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      if (!consumed.includes(node.text)) consumed.push(node.text);
      return;
    }
    if (ts.isPropertyAccessExpression(node)) { readIdentifiers(node.expression); return; }
    node.forEachChild(readIdentifiers);
  };
  readIdentifiers(initializer);
  // A consumed name declared more than once in the same scope is a refusal and not a silent pick,
  // for the same reason the top-level lookups above refuse: two candidates mean the reader cannot
  // say which value the verdict sees, and choosing one quietly is how an enumerator gets fooled.
  const doubled = consumed.filter((name) => declarationsOf(name).length > 1);
  if (doubled.length > 0) {
    return {
      bindings: null,
      why: `${doubled.join(", ")}: consumed by registryVerdict and declared more than once in the ladder's own scope,`
        + ` so which value the verdict reads is ambiguous`,
    };
  }
  const bindings: BucketBinding[] = [];
  for (const name of consumed) {
    const declared = declarationsOf(name);
    if (declared.length !== 1) continue;
    const init = declared[0].initializer;
    // The bucket-binding shape: `<rows>.filter(<single arrow>)`. Anything else is a consumed local
    // that is not a bucket (`rows` itself is the live example) and is not graded here.
    if (!init || !ts.isCallExpression(init)) continue;
    if (!ts.isPropertyAccessExpression(init.expression) || init.expression.name.text !== "filter") continue;
    if (init.arguments.length !== 1) continue;
    const arrow = init.arguments[0];
    if (!ts.isArrowFunction(arrow)) continue;
    let callee: string | null = null;
    let calleeWhy: string | null = "the filter callback body is not a direct identifier call";
    if (ts.isCallExpression(arrow.body) && ts.isIdentifier(arrow.body.expression)) {
      const identifier = arrow.body.expression;
      const exported = exportedSymbol(identifier.text);
      // The binder's answer for THIS call site, not a lookup this file re-implements.
      const raw = checker.getSymbolAtLocation(identifier);
      const resolved = raw ? unalias(checker, raw) : null;
      if (resolved === null) {
        calleeWhy = `${identifier.text}: the checker resolves no symbol for the consumed call's callee`;
      } else if ((resolved.declarations ?? []).length !== 1) {
        calleeWhy = `${identifier.text}: the consumed call's callee resolves to a symbol with `
          + `${(resolved.declarations ?? []).length} declarations, and exactly 1 is required`;
      } else if (exported.symbol === null) {
        calleeWhy = exported.why;
      } else if (resolved !== exported.symbol) {
        calleeWhy = `${identifier.text}: the consumed call's callee resolves to a different symbol than the top-level exported declaration`;
      } else {
        callee = identifier.text;
        calleeWhy = null;
      }
    }
    bindings.push({ name, callee, initializer: init.getText(parsed), calleeWhy });
  }
  return { bindings, why: null };
}
const consumedLadder = ladderConsumedBuckets(preflightSource);
const consumedBindings = consumedLadder.bindings;
const consumedCallees = (consumedBindings ?? []).map((binding) => binding.callee);
check(
  "the verdict ladder consumes exactly three bucket bindings, so the data-flow reading grades the whole ladder rather than whichever subset of it still parses",
  consumedBindings !== null && consumedBindings.length === 3,
  { bindings: consumedBindings, refusal: consumedLadder.why },
);
const BUCKET_PREDICATE_BY_NAME = [
  ["unknown", "isUnknownRegistry"],
  ["present", "isPresentRegistry"],
  ["absent", "isAbsentRegistry"],
] as const;
for (const [bucket, predicate] of BUCKET_PREDICATE_BY_NAME) {
  check(
    `the ${bucket} rung's consumed callee resolves by symbol identity to the module's exported ${predicate}, whose sole declaration is the top-level one`,
    consumedCallees.filter((callee) => callee === predicate).length === 1,
    { callees: consumedCallees, bindings: consumedBindings, refusal: consumedLadder.why },
  );
}
// The three laundering mutations, applied here by the fixture's OWN strings so the cells and the
// fixture cannot drift apart. Resolved by name first and loudly, because a by-name lookup that
// misses is silent: the cells beneath it would still run and still pass on an undefined entry.
// Everything from here to the refusals grades the READING'S POWER, and it does so on a skeleton
// rather than on the shipped file. That placement is the lesson of the `absent` trap, applied to my
// own cells. A control that builds its input by substituting a literal shipped line is disarmed by
// the very mutation it exists to grade: apply the absent mutant and that substitution matches
// nothing, so the control reds for rot while the detector reds for detection, and the two are
// indistinguishable in the transcript. Measured on the first version of this section: the present
// dead-call mutant produced 2 reds, only 1 of which was detection.
//
// So the skeleton is assembled from parts that a drift cannot rot: the bucket lines come from the
// FIXTURE's own find/replace strings, and the verdict expression is lifted out of the shipped file
// BY AST rather than by text match. The shipped tree is graded by the three rung cells above, which
// is where a drift SHOULD red. Down here a red means the reading itself broke.
// The verdict expression is SYNTHETIC, written out here in full, and that is a correction rather
// than a first choice. The first version lifted the shipped `registryVerdict` statement out of the
// module by AST, on the reasoning that a real expression cannot go stale. It can: the rename mutant
// rewrites that very statement, so the lifted text changed under the mutant, the skeleton stopped
// being the clean control it claims to be, and `mutation-proof` graded that mutant WRONG-RED with
// five reds in the transcript instead of one clean named red. AST-lifting is not rot-proof, it is
// rot-with-more-steps: it still reads the file the mutants edit.
//
// A synthetic verdict cannot rot because nothing edits it. What it can do is DRIFT away from the
// shipped ladder's real shape, which would make every cell below grade a strawman, so that risk is
// paid for directly by the cell after it: the same three shipped bucket lines are fed through this
// skeleton and through the SHIPPED module, and both readings must agree. That is what ties the
// skeleton to reality, and it is a comparison of two readings rather than a copy of one text.
const SKELETON_VERDICT = "  const registryVerdict = unknown.length > 0\n"
  + "    ? \"inconclusive\"\n"
  + "    : absent.length === rows.length\n"
  + "      ? \"all-absent\"\n"
  + "      : present.length === rows.length\n"
  + "        ? \"all-present\"\n"
  + "        : present.length > 0\n"
  + "          ? \"mixed\"\n"
  + "          : \"incomplete\";\n";
const ladderSkeleton = (unknownLine: string, presentLine: string, absentLine: string, verdict = SKELETON_VERDICT): string =>
  "export const isUnknownRegistry = (registry) => registry.startsWith(\"unknown:\");\n"
  + "export const isPresentRegistry = (registry) => registry === \"present\";\n"
  + "export const isAbsentRegistry = (registry) => registry === \"absent\";\n"
  + "export async function preflightNpmPublish(rows) {\n"
  + unknownLine + presentLine + absentLine
  + verdict
  + "  return registryVerdict;\n"
  + "}\n";
const DEAD_CALL_ENTRIES = [
  ["unknown", "isUnknownRegistry", "the unknown bucket binding drifts off its exported predicate while a dead call to it remains"],
  ["present", "isPresentRegistry", "the present bucket binding drifts off its exported predicate while a dead call to it remains"],
  ["absent", "isAbsentRegistry", "the absent bucket binding drifts off its exported predicate while a dead call to it remains"],
] as const;
const deadCallEntries = DEAD_CALL_ENTRIES.map(([bucket, predicate, name]) => ({ bucket, predicate, name, matched: fixtureEntry(name) }));
check(
  "all three dead-call laundering entries resolve in the fixture by name, so a renamed entry fails loudly instead of silently deleting the cells below it",
  deadCallEntries.every((entry) => entry.matched.length === 1),
  deadCallEntries.map((entry) => ({ name: entry.name, matches: entry.matched.length })),
);
// That the fixture's `find` strings still match the SHIPPED file exactly once is a real
// requirement, and it is deliberately NOT asserted here: `bin/smoke/mutation-fixtures.smoke.ts`
// already checks presence and uniqueness for every anchor in the tree, and asserting it again in
// this suite is precisely what would rot under these mutants. One owner per claim.
const cleanLines = deadCallEntries.map((entry) => entry.matched[0]?.find ?? "");
const cleanLadderSkeleton = ladderSkeleton(cleanLines[0], cleanLines[1], cleanLines[2]);
const cleanLadderFlow = ladderConsumedBuckets(cleanLadderSkeleton);
// POSITIVE CONTROL ON THE INSTRUMENT, before any laundering is graded through it. A reading that
// answered "no predicate" for every input would kill every mutant below for free, and would be
// indistinguishable from a working one on those cells alone. This is the input where the answer
// must be all three, and it doubles as proof that the fixture's `find` strings are the correct
// shape rather than merely present.
// Compared as a SET, not as a sequence. The bindings come back in the order the verdict CONSUMES
// them, which is unknown, absent, present, and not the order they are declared in. Asserting the
// declaration order here failed on the first run, and it was this assertion that was wrong rather
// than the reading: the three rung cells above already grade each predicate individually and were
// green throughout. Recorded because an order-sensitive control would red on any rung reorder,
// which is a refactor this pin has no business forbidding.
const cleanLadderCallees = [...(cleanLadderFlow.bindings ?? []).map((binding) => binding.callee)].sort();
// THE TIE TO REALITY for the synthetic verdict above. If the shipped ladder ever stops matching
// this skeleton's shape -- a fourth rung, a different consumption pattern, a rung that reads
// something else -- the two readings diverge and this reds, so the cells below cannot quietly
// drift into grading a strawman. It compares READINGS and not TEXT, which is why a mutant that
// rewrites the shipped verdict reds the rung cells above rather than rotting this one.
const shippedLadderCallees = [...(consumedBindings ?? []).map((binding) => binding.callee)].sort();
check(
  "the skeleton built from the three fixture find strings reads as all three exported predicates, so the laundering cells below run on an instrument that can say yes",
  cleanLadderFlow.bindings !== null
    && cleanLadderFlow.bindings.length === 3
    && JSON.stringify(cleanLadderCallees)
      === JSON.stringify(["isAbsentRegistry", "isPresentRegistry", "isUnknownRegistry"]),
  { bindings: cleanLadderFlow.bindings, refusal: cleanLadderFlow.why },
);
for (const [index, [bucket, predicate]] of BUCKET_PREDICATE_BY_NAME.entries()) {
  const shadowedLines = [...cleanLines];
  const localPredicate = bucket === "unknown"
    ? `  const ${predicate} = (registry) => registry.startsWith("unknown:");\n`
    : `  const ${predicate} = (registry) => registry === "${bucket}";\n`;
  shadowedLines[index] = localPredicate + shadowedLines[index];
  const shadowedSkeleton = ladderSkeleton(shadowedLines[0], shadowedLines[1], shadowedLines[2]);
  const shadowedFlow = ladderConsumedBuckets(shadowedSkeleton);
  const shadowedBinding = shadowedFlow.bindings?.find((binding) => binding.name === bucket);
  check(
    `symbol-identity control: a same-name local ${predicate} declaration is refused on the ${bucket} binding while the other exported bindings still resolve`,
    shadowedFlow.bindings !== null
      && shadowedFlow.bindings.length === 3
      && shadowedBinding?.callee === null
      && shadowedBinding.calleeWhy?.includes("resolves to a different symbol than the top-level exported declaration") === true
      && shadowedFlow.bindings.filter((binding) => binding.name !== bucket).every((binding) => binding.callee !== null),
    { bindings: shadowedFlow.bindings, refusal: shadowedFlow.why },
  );
}
// THE PLACEMENTS THE RETIRED SCOPE WALK COULD NOT SEE, graded here on the skeleton so this file
// records what changed and why rather than only that something changed. Neither of these is a new
// scope kind added to a list: both are inputs on which the binder is asked the same single
// question, and both would need a separate hand-written rule under the retired walk. They are
// controls on the instrument; the shipped tree is graded by the three rung cells above, and the
// fixture carries one mutant per placement so a regression reds there too.
//
// `var` hoists out of the block it is written in and contends at the FUNCTION scope, which is the
// scope the rung's call is in. The retired walk read a block's own statements and the enclosing
// function's parameters, and so attributed this declaration to the block and never to the function.
const HOISTED_VAR_SHADOWS = [
  ["unknown", "isUnknownRegistry", "  { var isUnknownRegistry = (registry) => registry.startsWith(\"unknown:\") && registry !== \"unknown:410\"; }\n"],
  ["absent", "isAbsentRegistry", "  { var isAbsentRegistry = (registry) => registry === \"absent\" || registry === \"gone\"; }\n"],
] as const;
for (const [bucket, predicate, hoisted] of HOISTED_VAR_SHADOWS) {
  const index = BUCKET_PREDICATE_BY_NAME.findIndex(([name]) => name === bucket);
  const hoistedLines = [...cleanLines];
  hoistedLines[index] = hoisted + hoistedLines[index];
  const hoistedFlow = ladderConsumedBuckets(ladderSkeleton(hoistedLines[0], hoistedLines[1], hoistedLines[2]));
  const hoistedBinding = hoistedFlow.bindings?.find((binding) => binding.name === bucket);
  check(
    `symbol-identity control: a sibling-block var ${predicate} hoists to the ladder's own scope and is refused on the ${bucket} binding, which the retired scope walk attributed to the block and missed`,
    hoistedFlow.bindings !== null
      && hoistedFlow.bindings.length === 3
      && hoistedBinding?.callee === null
      && hoistedBinding.calleeWhy?.includes("resolves to a different symbol than the top-level exported declaration") === true
      && hoistedFlow.bindings.filter((binding) => binding.name !== bucket).every((binding) => binding.callee !== null),
    { bindings: hoistedFlow.bindings, refusal: hoistedFlow.why },
  );
}
// And the shipped ladder's actual parameter shape. `preflightNpmPublish` takes ONE destructured
// options object, so a same-name predicate given a default inside that pattern is a live binding
// over the whole function body. The retired walk filtered parameters on `ts.isIdentifier(name)`,
// and an ObjectBindingPattern is not an identifier, so every binding inside it was invisible: the
// absent rung printed a green tick claiming no shadow while a widened shadow was in fact bound.
const destructuredParameterSkeleton = ladderSkeleton(cleanLines[0], cleanLines[1], cleanLines[2])
  .split("export async function preflightNpmPublish(rows) {\n")
  .join("export async function preflightNpmPublish({ rows, isAbsentRegistry = (registry) => registry === \"absent\" || registry === \"gone\" }) {\n");
const destructuredParameterFlow = ladderConsumedBuckets(destructuredParameterSkeleton);
const destructuredParameterBinding = destructuredParameterFlow.bindings?.find((binding) => binding.name === "absent");
check(
  "positive control: the destructured-parameter skeleton really rebinds isAbsentRegistry in the ladder's parameter list, so the cell below is not grading an unchanged input",
  destructuredParameterSkeleton !== cleanLadderSkeleton
    && destructuredParameterSkeleton.includes("isAbsentRegistry = (registry) => registry === \"absent\" || registry === \"gone\" }) {"),
  { changed: destructuredParameterSkeleton !== cleanLadderSkeleton },
);
check(
  "symbol-identity control: a same-name isAbsentRegistry inside the ladder's destructured parameter list is refused on the absent binding, which the retired scope walk could not see because the parameter name is a binding pattern",
  destructuredParameterFlow.bindings !== null
    && destructuredParameterFlow.bindings.length === 3
    && destructuredParameterBinding?.callee === null
    && destructuredParameterBinding.calleeWhy?.includes("resolves to a different symbol than the top-level exported declaration") === true
    && destructuredParameterFlow.bindings.filter((binding) => binding.name !== "absent").every((binding) => binding.callee !== null),
  { bindings: destructuredParameterFlow.bindings, refusal: destructuredParameterFlow.why },
);
// The other direction, and the reason symbol identity is compared after following aliases rather
// than as raw symbols. A module that declares its predicates plainly and exports them in a trailing
// `export { ... }` clause binds the rung to the SAME thing; the export table entry is an alias
// record and is a different object. Comparing the raw symbols would refuse this clean module, which
// is a false red on a legitimate refactor.
const aliasExportSkeleton = ladderSkeleton(cleanLines[0], cleanLines[1], cleanLines[2])
  .split("export const ").join("const ")
  .split("export async function preflightNpmPublish(rows) {\n")
  .join("export { isUnknownRegistry, isPresentRegistry, isAbsentRegistry };\nexport async function preflightNpmPublish(rows) {\n");
const aliasExportFlow = ladderConsumedBuckets(aliasExportSkeleton);
check(
  "an export clause rather than an inline export modifier still resolves all three rungs, so following aliases is what makes symbol identity the right comparison rather than a stricter one",
  aliasExportSkeleton !== cleanLadderSkeleton
    && aliasExportSkeleton.includes("export { isUnknownRegistry, isPresentRegistry, isAbsentRegistry };")
    && JSON.stringify([...(aliasExportFlow.bindings ?? []).map((binding) => binding.callee)].sort())
      === JSON.stringify(["isAbsentRegistry", "isPresentRegistry", "isUnknownRegistry"]),
  { bindings: aliasExportFlow.bindings, refusal: aliasExportFlow.why },
);
check(
  "the synthetic skeleton and shipped module resolve the same three top-level exported predicate declarations without same-name local shadows, so the laundering cells below grade a stand-in that still matches the ladder that ships",
  cleanLadderCallees.length === 3
    && JSON.stringify(cleanLadderCallees) === JSON.stringify(shippedLadderCallees),
  { skeleton: cleanLadderCallees, shipped: shippedLadderCallees },
);
for (const [index, entry] of deadCallEntries.entries()) {
  const launderedLines = [...cleanLines];
  launderedLines[index] = entry.matched[0]?.replace ?? "";
  const launderedSkeleton = ladderSkeleton(launderedLines[0], launderedLines[1], launderedLines[2]);
  check(
    `positive control: the ${entry.bucket} dead-call laundering entry's replace really differs from its find, so the two cells below it are not grading an unchanged skeleton`,
    entry.matched.length === 1 && launderedSkeleton !== cleanLadderSkeleton,
    { changed: launderedSkeleton !== cleanLadderSkeleton, find: entry.matched[0]?.find, replace: entry.matched[0]?.replace },
  );
  // The other half of the control, and the reason this reading exists rather than being a second
  // opinion on the same evidence: the text-presence enumerator is DEFEATED by this exact source.
  // If this cell ever goes green the laundering stopped working, and the cell below it would then
  // be proving nothing.
  const textualCallees = ladderFilterCallees(launderedSkeleton).callees;
  check(
    `the ${entry.bucket} dead-call laundering still satisfies the text-presence reading, so that reading alone would ship this drifted ladder green`,
    textualCallees !== null && textualCallees.includes(entry.predicate),
    { callees: textualCallees },
  );
  const launderedFlow = ladderConsumedBuckets(launderedSkeleton);
  check(
    `a dead call to ${entry.predicate} does not satisfy the ${entry.bucket} rung, because the value registryVerdict consumes no longer comes from that predicate`,
    launderedFlow.bindings !== null
      && launderedFlow.bindings.length === 3
      && !launderedFlow.bindings.map((binding) => binding.callee).includes(entry.predicate),
    { bindings: launderedFlow.bindings, refusal: launderedFlow.why },
  );
}
// The rename variant: the same laundering with the dead call made LIVE. The correct `absent`
// binding is still declared and still calls isAbsentRegistry, so every reading that asks whether
// the predicate is called, or whether a binding of that name is correct, says yes. The verdict
// reads `absentRows` instead. Graded because a pin that resolved buckets by NAME would pass this
// while the shipped ladder had drifted.
const renamedSkeleton = ladderSkeleton(
  cleanLines[0],
  cleanLines[1],
  cleanLines[2] + "  const absentRows = rows.filter((row) => row.registry === \"absent\");\n",
).split(": absent.length === rows.length").join(": absentRows.length === rows.length");
check(
  "positive control: the rename-laundering skeleton really differs from the clean one and really redirects the absent rung, so the cell below is not grading an unchanged input",
  renamedSkeleton !== cleanLadderSkeleton && renamedSkeleton.includes("absentRows.length === rows.length"),
  { changed: renamedSkeleton !== cleanLadderSkeleton, redirected: renamedSkeleton.includes("absentRows.length === rows.length") },
);
const renamedFlow = ladderConsumedBuckets(renamedSkeleton);
check(
  "a ladder that keeps a live isAbsentRegistry binding but reads an inline copy in the verdict is still caught, so the pin follows the value registryVerdict consumes and not the presence of a correct binding beside it",
  renamedFlow.bindings !== null
    && renamedFlow.bindings.length === 3
    && !renamedFlow.bindings.map((binding) => binding.callee).includes("isAbsentRegistry"),
  { bindings: renamedFlow.bindings, refusal: renamedFlow.why },
);
// THE ROT-ONLY CONTROL, and the cell that makes every mutant verdict in this section readable.
// Renaming the arrow parameter rewrites the exact absent line that the older decoy cells anchor
// on, so it rots those anchors precisely as a real drift would, while changing nothing about which
// predicate produces the consumed value. If this reading were secretly text-sensitive it would red
// here. It does not, so a red from this reading is detection.
const reparameterizedSkeleton = ladderSkeleton(
  cleanLines[0],
  cleanLines[1],
  "  const absent = rows.filter((entry) => isAbsentRegistry(entry.registry));\n",
);
check(
  "renaming the absent filter's arrow parameter rots every control anchored on that line's text yet leaves the data-flow reading byte-identical, so a red from this reading is detection and never anchor rot",
  reparameterizedSkeleton !== cleanLadderSkeleton
    && !reparameterizedSkeleton.includes(cleanLines[2])
    && JSON.stringify([...(ladderConsumedBuckets(reparameterizedSkeleton).bindings ?? []).map((binding) => binding.callee)].sort())
      === JSON.stringify(cleanLadderCallees),
  {
    changed: reparameterizedSkeleton !== cleanLadderSkeleton,
    anchorRotted: !reparameterizedSkeleton.includes(cleanLines[2]),
    calleesAfter: ladderConsumedBuckets(reparameterizedSkeleton).bindings?.map((binding) => binding.callee),
    calleesClean: cleanLadderFlow.bindings?.map((binding) => binding.callee),
  },
);
// And the refusals for this reading, graded rather than assumed to transfer from the enumerators
// above. Two verdict declarations is ambiguous; a decoy top-level ladder is refused by the shared
// top-level pin.
const ambiguousVerdict = ladderConsumedBuckets(
  cleanLadderSkeleton.split("  const registryVerdict").join("  const registryVerdict = \"all-absent\";\n  const registryVerdict"),
);
check(
  "two registryVerdict declarations in the ladder's own scope red as ambiguous rather than resolving to either, and the refusal carries the count",
  ambiguousVerdict.bindings === null
    && typeof ambiguousVerdict.why === "string"
    && ambiguousVerdict.why.includes("2 declarations found in the ladder's own scope"),
  ambiguousVerdict.why,
);
const ambiguousFlowTarget = ladderConsumedBuckets(
  cleanLadderSkeleton
  + "\nasync function preflightNpmPublish(rows) {\n"
  + "  const absent = rows.filter((row) => isAbsentRegistry(row.registry));\n"
  + "  const registryVerdict = absent.length;\n"
  + "  return registryVerdict;\n"
  + "}\n",
);
check(
  "two top-level preflightNpmPublish declarations red as ambiguous for the data-flow reading too, so its location claim is pinned on the same terms as the enumerators above",
  ambiguousFlowTarget.bindings === null
    && typeof ambiguousFlowTarget.why === "string"
    && ambiguousFlowTarget.why.includes("2 top-level function declarations found"),
  ambiguousFlowTarget.why,
);

// ---- THE LADDER'S ARMS, GRADED AGAINST THE VERDICTS IT PRODUCES --------------------------------
// Everything above grades what the verdict READS. Nothing above grades what the ladder DOES with
// the verdict it computed, and that gap was measurable: deleting the `incomplete` arm whole left
// this suite at 148 passed, 0 failed, exit 0.
//
// That arm cannot be closed by a fixture, and the triage on #1584 measured why over 1364 census
// combinations: with no unknown rows, zero present rows forces absent === rows.length, which the
// earlier all-absent rung has already claimed, so no input reaches it. A verdict with no reachable
// input still has a reachable DELETION, and the consequence of one is not cosmetic: a verdict with
// no arm falls through into the credential stage and returns a publish-ready state.
//
// So the claim here is a JOIN and not a text match: enumerate the verdicts the ladder's own
// expression can PRODUCE, enumerate the verdicts an arm beneath it HANDLES, and require the two to
// agree up to the one deliberate fall-through. Deleting an arm removes a handler while leaving the
// producer, so the sets diverge and the detector reds by name.
//
// What the DETECTOR does on a legitimate refactor, measured on the shipped file rather than
// asserted: removing the `incomplete` verdict from the producer AND its arm together leaves the
// detector cell GREEN, because nothing then produces the state and nothing needs to guard it. The
// SUITE still reds on that refactor, on the skeleton/shipped agreement cell below, which is the
// same bargain the bucket-predicate skeleton above already makes: a change to the ladder's SHAPE
// is required to restate the stand-in beside it. Verified in both directions -- the pre-existing
// cell reds identically when a fourth bucket rung is added, which is a shape change in ITS
// dimension. Recorded because the first version of this comment claimed the whole suite stays
// green on that refactor, and running it showed otherwise: the detector stays green, the
// agreement cell does not.
type LadderArms =
  | { produced: string[]; handled: string[]; why: null }
  | { produced: null; handled: null; why: string };
function ladderVerdictArms(source: string): LadderArms {
  const parsed = ts.createSourceFile(CHECKED_MODULE_FILENAME, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  const located = soleTopLevelFunction(parsed, "preflightNpmPublish");
  if (located.fn === null) return { produced: null, handled: null, why: located.why };
  // The ladder's own statement list, for the same reason the data-flow reading above uses it: an
  // arm nested in a block or in another function is not what this scope's verdict flows through.
  const statements = [...located.fn.body!.statements];
  const declared = statements.flatMap((statement) =>
    ts.isVariableStatement(statement)
      ? statement.declarationList.declarations.filter(
          (declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === "registryVerdict",
        )
      : []);
  if (declared.length !== 1) {
    return {
      produced: null,
      handled: null,
      why: `registryVerdict: ${declared.length} declarations found in the ladder's own scope, and exactly 1 is required`
        + ` (0 means this reading grades nothing; 2 or more means which one the arms see is ambiguous)`,
    };
  }
  const initializer = declared[0].initializer;
  if (!initializer) {
    return { produced: null, handled: null, why: "registryVerdict: the sole declaration has no initialiser, so it produces no verdict to grade" };
  }
  // Every value the conditional chain can yield, proved from the syntax alone. A branch result the
  // syntax does not pin to a string literal is a REFUSAL and not a guess, for the same reason the
  // return enumerator refuses an identifier: a producer this reading cannot enumerate is a producer
  // whose arms it cannot grade, and reporting "nothing unguarded" about it would be a lie.
  const produced: string[] = [];
  const unpinned: string[] = [];
  const collectProduced = (node: ts.Expression): void => {
    if (ts.isParenthesizedExpression(node)) { collectProduced(node.expression); return; }
    if (ts.isConditionalExpression(node)) { collectProduced(node.whenTrue); collectProduced(node.whenFalse); return; }
    if (ts.isStringLiteral(node)) { if (!produced.includes(node.text)) produced.push(node.text); return; }
    unpinned.push(`${ts.SyntaxKind[node.kind]} ${JSON.stringify(node.getText(parsed))}`);
  };
  collectProduced(initializer);
  if (unpinned.length > 0) {
    return {
      produced: null,
      handled: null,
      why: `registryVerdict: ${unpinned.join("; ")} -- the syntax does not pin these branch results to a verdict literal,`
        + ` so which states this ladder produces cannot be enumerated`,
    };
  }
  // An arm is an `if (registryVerdict === "<verdict>")` reachable from the ladder's own scope
  // whose consequent ENDS in a throw or a return. Requiring the terminator is what keeps this from
  // being satisfied by an arm someone gutted: an `if` that prints a census and then falls out of the
  // block leaves the verdict continuing into the credential stage exactly as a deleted arm would, so
  // a reading that counted it as handled would bless the same defect in a quieter shape.
  //
  // ELSE BRANCHES ARE FOLLOWED, and that is a correction rather than a first choice. The first
  // version read only the ladder's top-level statement list, which is the right scope for a chain
  // of sibling `if`s and the wrong one the moment anybody writes the same arms as an if/else-if
  // chain. Measured on the shipped file: joining the inconclusive and mixed arms with `else if` is
  // behaviour-preserving, and the cell reddened with `unguarded: [mixed]` because the second arm had
  // moved into an else branch this walk never entered. That is a FALSE POSITIVE -- a red on a clean
  // refactor -- and a pin that forbids a legitimate restatement of the same logic is a pin that will
  // be deleted rather than satisfied. An else-if chain is the same guard written differently, so the
  // walk follows the else chain while still refusing to descend into a nested block or another
  // function, which are not this scope's arms.
  const handled: string[] = [];
  const nonTerminal: string[] = [];
  const collectArm = (statement: ts.Statement): void => {
    if (!ts.isIfStatement(statement)) return;
    const test = statement.expression;
    const elseBranch = statement.elseStatement;
    if (ts.isBinaryExpression(test)
      && test.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
      && ts.isIdentifier(test.left) && test.left.text === "registryVerdict"
      && ts.isStringLiteral(test.right)) {
      const consequent = statement.thenStatement;
      const last = ts.isBlock(consequent)
        ? consequent.statements[consequent.statements.length - 1]
        : consequent;
      if (last === undefined || !(ts.isThrowStatement(last) || ts.isReturnStatement(last))) {
        nonTerminal.push(test.right.text);
      } else if (!handled.includes(test.right.text)) {
        handled.push(test.right.text);
      }
    }
    // The `else` of an if/else-if chain is the next arm, so it is followed. A plain `else { ... }`
    // block is not an arm and contributes nothing, which is why only a further IfStatement recurses.
    if (elseBranch !== undefined) collectArm(elseBranch);
  };
  for (const statement of statements) collectArm(statement);
  if (nonTerminal.length > 0) {
    return {
      produced: null,
      handled: null,
      why: `${nonTerminal.join(", ")}: the arm does not end in a throw or a return, so the verdict falls out of the arm`
        + ` and into the credential stage exactly as a deleted arm would`,
    };
  }
  return { produced, handled, why: null };
}

// The one verdict that deliberately carries no arm: `all-absent` is the clean release and falls
// through to the credential stage on purpose. It is named in ONE constant so the exemption stays a
// single line a reviewer can see, rather than a list that grows by one entry every time an arm is
// removed. The cell after the detector pins that this name still describes a real branch.
const LADDER_FALLTHROUGH_VERDICT = "all-absent";
const shippedArms = ladderVerdictArms(preflightSource);
const unguardedVerdicts = (shippedArms.produced ?? []).filter(
  (verdict) => verdict !== LADDER_FALLTHROUGH_VERDICT && !(shippedArms.handled ?? []).includes(verdict),
);
check(
  "every verdict the shipped ladder produces has an arm beneath it that throws or returns, apart from the named all-absent fall-through, so an arm cannot be deleted while its verdict is still produced",
  shippedArms.produced !== null && shippedArms.produced.length > 0 && unguardedVerdicts.length === 0,
  { produced: shippedArms.produced, handled: shippedArms.handled, unguarded: unguardedVerdicts, refusal: shippedArms.why },
);
check(
  "the shipped ladder still produces the all-absent fall-through and still gives it no arm, so the exemption above names a real branch rather than covering for an arm that went missing",
  (shippedArms.produced ?? []).includes(LADDER_FALLTHROUGH_VERDICT)
    && !(shippedArms.handled ?? []).includes(LADDER_FALLTHROUGH_VERDICT),
  { produced: shippedArms.produced, handled: shippedArms.handled, refusal: shippedArms.why },
);

// CONTROLS ON THE INSTRUMENT, on synthetic sources, for the reason every other control in this file
// runs on one: the shipped tree is graded by the two cells above, and a control that rebuilt its
// input by substituting a shipped line would rot under the very mutation it exists to grade. A
// reading that answered "nothing unguarded" for every input would pass those two cells for free, so
// it is shown able to say both answers here.
const ARM_BODIES: Record<string, string> = {
  inconclusive: "    printPublishCensus(rows, log);\n    throw new Error(`registry census was inconclusive for ${unknown.length}/${rows.length} packages`);\n",
  mixed: "    printPublishCensus(rows, log);\n    throw new Error(`publish preflight refused: ${present.length}/${rows.length} exact versions already exist`);\n",
  incomplete: "    printPublishCensus(rows, log);\n    throw new Error(\"the packages that would publish are not the complete fixed group\");\n",
  "all-present": "    printPublishCensus(rows, log);\n    return { state: \"nothing-to-publish\", rows };\n",
};
const ARMED_VERDICTS = ["inconclusive", "mixed", "incomplete", "all-present"] as const;
const armSkeleton = (arms: readonly string[], bodies: Record<string, string> = ARM_BODIES): string =>
  "export async function preflightNpmPublish(rows) {\n"
  + cleanLines.join("")
  + SKELETON_VERDICT
  + arms.map((verdict) => `  if (registryVerdict === "${verdict}") {\n${bodies[verdict]}  }\n`).join("")
  + "  return { state: \"ready\", rows };\n"
  + "}\n";
const cleanArms = ladderVerdictArms(armSkeleton(ARMED_VERDICTS));
check(
  "positive control: the fully armed skeleton reads as five produced verdicts with four handled, so the detector below runs on an instrument that can say every arm is present",
  cleanArms.produced !== null
    && JSON.stringify([...cleanArms.produced].sort()) === JSON.stringify(["all-absent", "all-present", "incomplete", "inconclusive", "mixed"])
    && JSON.stringify([...cleanArms.handled].sort()) === JSON.stringify(["all-present", "incomplete", "inconclusive", "mixed"]),
  { produced: cleanArms.produced, handled: cleanArms.handled, refusal: cleanArms.why },
);
// THE TIE TO REALITY for the synthetic verdict this skeleton carries. If the shipped ladder grows a
// rung, loses one, or renames a state, the two readings diverge and this reds, so the detector
// beneath cannot quietly drift into grading a ladder that no longer ships. It compares READINGS and
// not text, which is why an arm deletion reds the shipped cell above rather than rotting this one.
check(
  "the skeleton and the shipped module produce the same verdict set, so the arm controls below grade a stand-in that still matches the ladder that ships",
  cleanArms.produced !== null
    && shippedArms.produced !== null
    && JSON.stringify([...cleanArms.produced].sort()) === JSON.stringify([...shippedArms.produced].sort()),
  { skeleton: cleanArms.produced, shipped: shippedArms.produced },
);
for (const verdict of ARMED_VERDICTS) {
  const withoutArm = ladderVerdictArms(armSkeleton(ARMED_VERDICTS.filter((name) => name !== verdict)));
  const unguarded = (withoutArm.produced ?? []).filter(
    (name) => name !== LADDER_FALLTHROUGH_VERDICT && !(withoutArm.handled ?? []).includes(name),
  );
  check(
    `detector control: deleting the ${verdict} arm whole leaves its verdict produced and unhandled, which is the deletion the shipped cell above refuses`,
    JSON.stringify(unguarded) === JSON.stringify([verdict]),
    { produced: withoutArm.produced, handled: withoutArm.handled, unguarded, refusal: withoutArm.why },
  );
  // The quieter shape of the same defect: the arm is still written, still matches by text, and no
  // longer stops anything. A reading that only asked whether an `if` mentioning the verdict exists
  // would call this handled.
  const gutted = ladderVerdictArms(armSkeleton(ARMED_VERDICTS, { ...ARM_BODIES, [verdict]: "    printPublishCensus(rows, log);\n" }));
  check(
    `detector control: a ${verdict} arm that prints the census and then falls out of its block is refused, so an arm that stopped refusing is not counted as one`,
    gutted.produced === null
      && gutted.why.startsWith(`${verdict}: the arm does not end in a throw or a return`),
    gutted.why,
  );
}
// THE FALSE-POSITIVE DIRECTION, which is the half a detector-only control cannot see. Every cell
// above asks whether the reading catches a missing arm. This one asks whether it accuses a clean
// one, and it exists because the first version of this reading did: the arms written as an
// if/else-if chain are the same guards with the same behaviour, and reading only the top-level
// statement list lost every arm after the first `else`. Measured on the shipped file at the time,
// the detector cell reddened with `unguarded: [mixed]` on a refactor that changed nothing.
//
// It is graded on the SKELETON rather than by editing the shipped file, for the reason the other
// controls here are: the shipped tree is graded by the detector cell above, and a control that
// rewrites shipped text rots under the mutants that also rewrite it.
const chainedArmSkeleton = "export async function preflightNpmPublish(rows) {\n"
  + cleanLines.join("")
  + SKELETON_VERDICT
  + ARMED_VERDICTS.map((verdict, index) =>
      `${index === 0 ? "  if" : " else if"} (registryVerdict === "${verdict}") {\n${ARM_BODIES[verdict]}  }`).join("")
  + "\n  return { state: \"ready\", rows };\n"
  + "}\n";
const chainedArms = ladderVerdictArms(chainedArmSkeleton);
const chainedUnguarded = (chainedArms.produced ?? []).filter(
  (name) => name !== LADDER_FALLTHROUGH_VERDICT && !(chainedArms.handled ?? []).includes(name),
);
check(
  "positive control: the chained skeleton really writes the arms as one if/else-if chain, so the cell below is not grading the sibling-if form again",
  chainedArmSkeleton !== armSkeleton(ARMED_VERDICTS)
    && chainedArmSkeleton.includes("} else if (registryVerdict === \"mixed\")"),
  { chained: chainedArmSkeleton.includes("} else if (registryVerdict === \"mixed\")") },
);
check(
  "arms written as an if/else-if chain are all found and none is reported unguarded, so a behaviour-preserving restatement of the same guards is not accused of deleting one",
  chainedArms.produced !== null
    && JSON.stringify([...chainedArms.handled].sort()) === JSON.stringify(["all-present", "incomplete", "inconclusive", "mixed"])
    && chainedUnguarded.length === 0,
  { produced: chainedArms.produced, handled: chainedArms.handled, unguarded: chainedUnguarded, refusal: chainedArms.why },
);
// And the detector still bites through a chain: deleting one arm OUT of the chain is still caught,
// so following else branches widened what the reading sees without softening what it refuses.
const chainedMinusIncomplete = ladderVerdictArms(
  "export async function preflightNpmPublish(rows) {\n"
  + cleanLines.join("")
  + SKELETON_VERDICT
  + ARMED_VERDICTS.filter((verdict) => verdict !== "incomplete").map((verdict, index) =>
      `${index === 0 ? "  if" : " else if"} (registryVerdict === "${verdict}") {\n${ARM_BODIES[verdict]}  }`).join("")
  + "\n  return { state: \"ready\", rows };\n"
  + "}\n",
);
check(
  "deleting the incomplete arm out of an if/else-if chain is still reported unguarded, so following else branches did not soften the detector",
  JSON.stringify((chainedMinusIncomplete.produced ?? []).filter(
    (name) => name !== LADDER_FALLTHROUGH_VERDICT && !(chainedMinusIncomplete.handled ?? []).includes(name),
  )) === JSON.stringify(["incomplete"]),
  { produced: chainedMinusIncomplete.produced, handled: chainedMinusIncomplete.handled, refusal: chainedMinusIncomplete.why },
);
// The refusals for this reading, graded rather than assumed to carry over from the enumerators
// above. An ambiguous producer and a producer the syntax cannot pin are both refusals, and a
// refusal reds the shipped cell because its `produced` is null.
const ambiguousArmVerdict = ladderVerdictArms(
  armSkeleton(ARMED_VERDICTS).split("  const registryVerdict").join("  const registryVerdict = \"all-absent\";\n  const registryVerdict"),
);
check(
  "two registryVerdict declarations in the ladder's own scope red as ambiguous for the arm reading too, and the refusal carries the count",
  ambiguousArmVerdict.produced === null
    && ambiguousArmVerdict.why.includes("2 declarations found in the ladder's own scope"),
  ambiguousArmVerdict.why,
);
const unpinnedArmVerdict = ladderVerdictArms(
  armSkeleton(ARMED_VERDICTS).split("          : \"incomplete\";").join("          : deriveVerdict(rows);"),
);
check(
  "a branch result the syntax cannot pin to a verdict literal is refused rather than enumerated as nothing, so a computed verdict cannot pose as a ladder with no unguarded states",
  unpinnedArmVerdict.produced === null
    && unpinnedArmVerdict.why.includes("the syntax does not pin these branch results to a verdict literal"),
  unpinnedArmVerdict.why,
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
check(
  "the three post-census refusals do not retain the removed unproven guard",
  !readFileSync(join(ROOT, "scripts", "preflight-npm-publish.mjs"), "utf8").includes("direct-publish authorization was not proven")
    && oidcRefused.error instanceof Error
    && !oidcRefused.error.message.includes("not proven")
    && stageOnly.error instanceof Error
    && !stageOnly.error.message.includes("not proven"),
  { oidc: oidcRefused.error, stageOnly: stageOnly.error },
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
check(
  "accept control: direct authorization still refuses an opaque exchange without the removed guard",
  opaque201.error instanceof Error && !opaque201.error.message.includes("not proven"),
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
 *
 * The OPTIONAL MARKER is captured rather than tolerated, and the caller refuses it. A reviewer
 * measured the false green: `state?: NpmPublishPreflightState` passed 78 of 78 cells, because this
 * pattern swallowed the `?` and graded the VALUE, which is a correct two-member union. Under the
 * repository's own tsc that shape is the #1585 harm itself (`Type 'S | undefined' is not
 * assignable` at any caller branching on the verdict). The module's two returns do set the
 * property unconditionally, but that is NOT why this branch is needed and the shape is NOT
 * unreachable: the declaration is emitted by `tsc --declaration` over the module's `@returns`
 * JSDoc, not over its return statements, so editing either `@returns` to `state?:` publishes an
 * optional verdict while every runtime return still sets it. A reviewer measured exactly that
 * against the real module through the real generator: the emit produced `state?:` on BOTH entry
 * points and this cell caught it. `S | undefined` was already refused while `state?:` was
 * accepted, so one consumer-visible contract had two spellings and opposite verdicts.
 */
function topLevelPropertyValues(block: string, key: string): string[] {
  const property = new RegExp(`^\\s*${key}(\\??):\\s*(.+?);\\s*$`);
  const values: string[] = [];
  let depth = 0;
  for (const line of block.split("\n")) {
    if (depth === 1) {
      const written = property.exec(line);
      if (written) values.push(`${written[1]}${written[2].trim()}`);
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
    if (written[0].startsWith("?")) { refusals.push(`${fn}: state is optional, so the census verdict may be absent from the published result`); continue; }
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

/**
 * Rewrite the TOP-LEVEL `state` property of ONE NAMED entry point's result block.
 *
 * This exists because positional indexing into the base is the same defect the grader was just
 * fixed for, one level up. `replaceNth(base, "state: <alias>;", "state: string;", 2)` means "the
 * second occurrence in the file", which is only "the second entry point" while no other `state`
 * exists anywhere. A reviewer's nested-decoy attack added a third occurrence and occurrence 2
 * became the NESTED property, so the fixture widened something other than the thing it was named
 * for and reported an EMPTY refusal list: a red for a reason unrelated to its name, which is noise
 * rather than evidence. Naming the entry point and the nesting depth cannot drift that way.
 */
function widenTopLevelState(dts: string, fn: string, replacement: string): string {
  const needle = `export function ${fn}(`;
  const start = dts.indexOf(needle);
  if (start < 0) throw new Error(`fixture is stale: ${fn} is not in the declaration`);
  const open = dts.indexOf("): Promise<{", start);
  if (open < 0) throw new Error(`fixture is stale: ${fn} has no resolved result object to widen`);
  const lines = dts.slice(open).split("\n");
  let depth = 0;
  for (let index = 0; index < lines.length; index++) {
    const before = depth;
    for (const character of lines[index]) {
      if (character === "{") depth++;
      else if (character === "}") depth--;
    }
    if (before === 1 && /^\s*state\??:\s*[^;]+;\s*$/.test(lines[index])) {
      lines[index] = lines[index].replace(/state\??:\s*[^;]+;/, replacement);
      return dts.slice(0, open) + lines.join("\n");
    }
    if (before >= 1 && depth === 0) break;
  }
  throw new Error(`fixture is stale: ${fn} has no top-level state property to widen`);
}

/** Remove the TOP-LEVEL `state` property of one NAMED entry point, by name rather than by position. */
function dropTopLevelState(dts: string, fn: string): string {
  const marker = "__FIXTURE_DROPPED_STATE__: never;";
  const withMarker = widenTopLevelState(dts, fn, marker);
  return withMarker.replace(new RegExp(`^\\s*${marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n`, "m"), "");
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
/**
 * Each fixture's declaration is built LAZILY, and a builder that cannot find its subject reds one
 * NAMED cell instead of throwing.
 *
 * A reviewer found why this matters: widening the second entry point's result to `Promise<void>`
 * makes the contract cells red correctly, and then the fixture builder threw "occurrence 2 is not
 * in the declaration" at module scope. The process died with NO `SUITE COMPLETE` line and 17 of 78
 * cells never ran, so a real fault reported itself as a stack trace about test scaffolding and took
 * the rest of the suite's signal with it. A suite that dies on a fault it correctly detected has
 * converted a precise red into an outage, and the operator has to read a trace to find out which.
 */
const stateFixtures: Array<{ name: string; dts: () => string; names: string; branch: string }> = [
  {
    name: "state widened back to string on preflightNpmPublish",
    branch: "not a union of the census literals",
    dts: () => widenTopLevelState(acceptingBase, "preflightNpmPublish", "state: string;"),
    names: "preflightNpmPublish",
  },
  {
    name: "state widened back to string on preflightFromRepository",
    branch: "not a union of the census literals",
    dts: () => widenTopLevelState(acceptingBase, "preflightFromRepository", "state: string;"),
    names: "preflightFromRepository",
  },
  {
    name: "a state property dropped from the result object",
    branch: "no top-level state property",
    dts: () => dropTopLevelState(acceptingBase, "preflightNpmPublish"),
    names: "preflightNpmPublish",
  },
  {
    name: "an entry point the declaration never declares",
    branch: "the declaration never declares this entry point",
    dts: () => replaceNth(acceptingBase, "export function preflightFromRepository(", "export function preflightElsewhere(", 1),
    names: "preflightFromRepository",
  },
  {
    name: "a state alias this declaration never defines",
    branch: "which this declaration never defines",
    dts: () => acceptingBase.replace(/^export type NpmPublishPreflightState = .*$/m, ""),
    names: "preflightNpmPublish",
  },
  {
    name: "a census member dropped from the union",
    branch: "state union is missing",
    dts: () => acceptingBase.replace(/^export type NpmPublishPreflightState = .*$/m, 'export type NpmPublishPreflightState = "nothing-to-publish";'),
    names: "preflightNpmPublish",
  },
  {
    name: "a state the census can never return added to the union",
    branch: "which the census never returns",
    dts: () => acceptingBase.replace(/^export type NpmPublishPreflightState = .*$/m, 'export type NpmPublishPreflightState = "nothing-to-publish" | "ready" | "inconclusive";'),
    names: "preflightNpmPublish",
  },
  {
    name: "a tuple the declaration never defines behind the state alias",
    branch: "which this declaration never defines",
    dts: () => `${acceptingBase.replace(/^export const NPM_PUBLISH_PREFLIGHT_STATES: .*$/m, "")
      .replace(/^export type NpmPublishPreflightState = .*$/m, "")}\nexport type NpmPublishPreflightState = (typeof NPM_PUBLISH_PREFLIGHT_STATES)[number];\n`,
    names: "preflightNpmPublish",
  },
  {
    name: "a census member dropped from the tuple behind the state alias",
    branch: "state union is missing",
    dts: () => `${acceptingBase.replace(/^export const NPM_PUBLISH_PREFLIGHT_STATES: .*$/m, "")
      .replace(/^export type NpmPublishPreflightState = .*$/m, "")}\nexport const NPM_PUBLISH_PREFLIGHT_STATES: readonly ["nothing-to-publish"];\nexport type NpmPublishPreflightState = (typeof NPM_PUBLISH_PREFLIGHT_STATES)[number];\n`,
    names: "preflightNpmPublish",
  },
  {
    name: "a nested state read instead of the widened top-level one",
    dts: () => widenTopLevelState(acceptingBase, "preflightNpmPublish",
      `census: {\n        ${stateProperty}\n    };\n    state: string;`),
    names: "preflightNpmPublish",
    branch: "not a union of the census literals",
  },
  {
    name: "the state property marked optional on preflightNpmPublish",
    branch: "state is optional, so the census verdict may be absent",
    dts: () => widenTopLevelState(acceptingBase, "preflightNpmPublish", "state?: NpmPublishPreflightState;"),
    names: "preflightNpmPublish",
  },
  {
    name: "the state property marked optional on preflightFromRepository",
    branch: "state is optional, so the census verdict may be absent",
    dts: () => widenTopLevelState(acceptingBase, "preflightFromRepository", "state?: NpmPublishPreflightState;"),
    names: "preflightFromRepository",
  },
  {
    name: "two top-level state properties, so which one publishes is ambiguous",
    dts: () => widenTopLevelState(acceptingBase, "preflightNpmPublish", `${stateProperty}\n    state: string;`),
    names: "preflightNpmPublish",
    branch: "top-level state properties",
  },
  {
    name: "a second declaration of the same entry point appended after the first",
    dts: () => `${acceptingBase}\nexport function preflightFromRepository(options?: any): Promise<{\n    state: string;\n    rows: any[];\n}>;\n`,
    names: "preflightFromRepository",
    branch: "so which result a caller resolves is ambiguous",
  },
  {
    name: "an entry point whose result object is not resolved in its own declaration",
    dts: () => replaceNth(acceptingBase, "): Promise<{", "): Promise<any>;", 1),
    names: "preflightNpmPublish",
    branch: "no resolved result object in the declaration",
  },
];
for (const fixture of stateFixtures) {
  let built: string;
  try {
    built = fixture.dts();
  } catch (error) {
    check(
      `the census state fixture for ${fixture.name} still finds its subject in the declaration`,
      false,
      error instanceof Error ? error.message : error,
    );
    continue;
  }
  const refusals = censusStateRefusals(built);
  check(
    `the census state grader refuses ${fixture.name}`,
    built !== acceptingBase
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
  "state is optional, so the census verdict may be absent",
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
