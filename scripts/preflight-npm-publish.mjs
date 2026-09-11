#!/usr/bin/env node
/**
 * Establish that a lockstep release is safe to start before the first registry write.
 *
 * The preflight derives both sides of the release from repository state:
 *   - the complete Changesets fixed group from .changeset/config.json;
 *   - the public workspace manifests that `pnpm publish -r` can select.
 *
 * It then reads every exact package@version from npm. A clean release has every version absent.
 * Any present exact version is refused. A mixed census is a prior partial publish; an all-present
 * census has no complete fixed group left to publish. Unknown registry answers refuse too.
 *
 * When GitHub Actions exposes its OIDC token requester, a distinct id_token is exchanged for every
 * package. That HTTP 201 is identity only: npm's trusted-publisher Allowed actions always permit
 * `npm stage publish`, and configurations created after 2026-09-03 default to stage. Direct
 * `npm publish` is a separate permission. The exchanged token is then used to GET
 * `/-/package/<name>/trust`. The whole run refuses unless THIS repository's `changesets.yml`
 * publisher lists a direct-publish action. Other publishers on the same package are not proof
 * that this job can `npm publish`. A stage-only sibling cannot pass this census and later fail
 * during sequential `pnpm publish -r` after earlier writes.
 *
 * There is no non-writing PUT that proves createPackage: a complete packument would publish, and
 * an incomplete one can 400 before the policy check. This script therefore never PUT/POSTs a
 * packument. GET trust is the authorization census. If that read cannot be obtained, the run
 * refuses rather than treating OIDC 201 as publish-ready.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { closureFromConfig, versionUrl } from "./verify-publish-closure.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_REGISTRY = "https://registry.npmjs.org";
const OIDC_AUDIENCE = "npm:registry.npmjs.org";
const WORKFLOW_FILE = ".github/workflows/changesets.yml";

function decodeJwtPayload(token) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("GitHub OIDC requester returned a malformed JWT");
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch (cause) {
    throw new Error("GitHub OIDC requester returned a JWT with an unreadable payload", { cause });
  }
}

export function assertGithubIdentity(claims, env) {
  const expectedWorkflow = `${env.GITHUB_REPOSITORY}/${WORKFLOW_FILE}@`;
  const failures = [];
  if (!env.GITHUB_REPOSITORY || claims.repository !== env.GITHUB_REPOSITORY) failures.push("repository");
  if (typeof claims.workflow_ref !== "string" || !claims.workflow_ref.startsWith(expectedWorkflow)) failures.push("workflow_ref");
  if (!env.GITHUB_REF || claims.ref !== env.GITHUB_REF) failures.push("ref");
  if (!env.GITHUB_EVENT_NAME || claims.event_name !== env.GITHUB_EVENT_NAME) failures.push("event_name");
  if (claims.aud !== OIDC_AUDIENCE) failures.push("aud");
  if (typeof claims.jti !== "string" || claims.jti.length === 0) failures.push("jti");
  if (failures.length) throw new Error(`GitHub OIDC identity did not match the release job: ${failures.join(", ")}`);
}

export function workspacePackagesFromPnpm(root = ROOT, exec = execFileSync) {
  const raw = exec("pnpm", ["list", "-r", "--depth", "-1", "--json"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  let rows;
  try {
    rows = JSON.parse(raw);
  } catch (cause) {
    throw new Error("pnpm workspace census was not valid JSON", { cause });
  }
  if (!Array.isArray(rows)) throw new Error("pnpm workspace census was not an array");
  return rows
    .filter((row) => row && row.private !== true && row.path !== root)
    .map((row) => ({ name: row.name, version: row.version, path: row.path }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

export function validateReleaseSet(fixedPackages, workspacePackages) {
  const fixed = [...new Set(fixedPackages)].sort();
  const manifests = new Map();
  const invalid = [];
  for (const pkg of workspacePackages) {
    if (typeof pkg.name !== "string" || pkg.name.length === 0 || typeof pkg.version !== "string" || pkg.version.length === 0) {
      invalid.push(pkg.path ?? "<unknown workspace>");
      continue;
    }
    if (manifests.has(pkg.name)) invalid.push(`duplicate ${pkg.name}`);
    manifests.set(pkg.name, pkg);
  }
  const missingManifests = fixed.filter((name) => !manifests.has(name));
  const outsideFixedGroup = [...manifests.keys()].filter((name) => !fixed.includes(name)).sort();
  if (invalid.length || missingManifests.length || outsideFixedGroup.length || manifests.size !== fixed.length) {
    throw new Error([
      "recursive publish set is not the complete Changesets fixed group",
      invalid.length ? `invalid workspace manifests: ${invalid.join(", ")}` : "",
      missingManifests.length ? `fixed packages missing from workspace publish set: ${missingManifests.join(", ")}` : "",
      outsideFixedGroup.length ? `public workspace packages outside fixed group: ${outsideFixedGroup.join(", ")}` : "",
    ].filter(Boolean).join("\n"));
  }
  return fixed.map((name) => manifests.get(name));
}

export function trustUrl(registryBase, name) {
  return `${registryBase}/-/package/${encodeURIComponent(name)}/trust`;
}

function normalizeAction(action) {
  return String(action).toLowerCase().replace(/[\s._-]/g, "");
}

function isDirectPublishAction(action) {
  const n = normalizeAction(action);
  return n === "publish" || n === "npmpublish" || n === "createpackage" || n === "direct" || n === "directpublish";
}

function publisherView(entry) {
  if (!entry || typeof entry !== "object") return { type: "", repository: "", workflow: "" };
  const nested = entry.publisher && typeof entry.publisher === "object" ? entry.publisher : {};
  return {
    type: String(entry.type ?? nested.type ?? ""),
    repository: String(entry.repository ?? nested.repository ?? nested.repository_name ?? ""),
    workflow: String(entry.workflow_filename ?? entry.workflowFilename ?? entry.workflow ?? nested.workflow_filename ?? nested.workflow ?? ""),
  };
}

function normalizeRepo(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(www\.)?github\.com\//, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
}

function workflowBasename(value) {
  return String(value).trim().split(/[/\\]/).filter(Boolean).pop()?.toLowerCase() ?? "";
}

function isGithubPublisher(entry) {
  const view = publisherView(entry);
  if (view.type.toLowerCase().includes("github")) return true;
  return view.workflow.length > 0 || view.repository.length > 0;
}

function isThisReleasePublisher(entry, identity) {
  if (!isGithubPublisher(entry)) return false;
  const view = publisherView(entry);
  const expectedRepo = normalizeRepo(identity?.repository ?? "");
  const expectedWorkflow = workflowBasename(identity?.workflowFilename ?? "changesets.yml");
  if (!expectedRepo || !expectedWorkflow) return false;
  return normalizeRepo(view.repository) === expectedRepo
    && workflowBasename(view.workflow) === expectedWorkflow;
}

function publisherEntries(body) {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== "object") return null;
  if (Array.isArray(body.trustedPublishers)) return body.trustedPublishers;
  if (Array.isArray(body.publishers)) return body.publishers;
  if (Array.isArray(body.configurations)) return body.configurations;
  if (Array.isArray(body.configs)) return body.configs;
  return null;
}

function actionList(entry) {
  if (!entry || typeof entry !== "object") return [];
  const nested = entry.publisher && typeof entry.publisher === "object" ? entry.publisher : {};
  const raw = entry.allowedActions ?? entry.allowed_actions ?? entry.permissions ?? nested.allowedActions ?? nested.permissions;
  return Array.isArray(raw) ? raw : [];
}

/**
 * Map a GET /-/package/<name>/trust body onto the direct-publish Allowed action
 * for this release job's GitHub publisher (repository + workflow file). Other
 * publishers on the same package are ignored. Empty allowed-action lists on this
 * publisher are stage-only: npm's post-2026-09-03 default. HTTP 201 from the
 * OIDC exchange is not an input here.
 */
export function classifyDirectPublishPermission(body, identity = { repository: "Cotal-AI/Cotal", workflowFilename: "changesets.yml" }) {
  const entries = publisherEntries(body);
  if (!entries) return "refused:malformed-trust";
  if (entries.length === 0) return "refused:no-trusted-publisher";
  const mine = entries.filter((entry) => isThisReleasePublisher(entry, identity));
  if (mine.length === 0) return "refused:no-github-publisher";
  const withDirect = mine.filter((entry) => actionList(entry).some(isDirectPublishAction));
  if (withDirect.length > 0) return "createPackage";
  return "stage-only";
}

async function readExactVersion(pkg, registryBase, fetchImpl) {
  try {
    const response = await fetchImpl(versionUrl(registryBase, pkg.name, pkg.version), {
      method: "GET",
      redirect: "manual",
    });
    if (response.status === 200) return "present";
    if (response.status === 404) return "absent";
    return `unknown:${response.status}`;
  } catch (error) {
    return `unknown:${error instanceof Error ? error.message : String(error)}`;
  }
}

async function requestGithubIdToken(env, fetchImpl) {
  const requestUrl = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!requestUrl || !requestToken) {
    throw new Error("GitHub OIDC requester is unavailable; ACTIONS_ID_TOKEN_REQUEST_URL/TOKEN are required");
  }
  const url = new URL(requestUrl);
  url.searchParams.set("audience", OIDC_AUDIENCE);
  const response = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${requestToken}`, Accept: "application/json" },
    redirect: "manual",
  });
  if (response.status !== 200) throw new Error(`GitHub OIDC requester returned HTTP ${response.status}`);
  const body = await response.json();
  if (!body || typeof body.value !== "string") throw new Error("GitHub OIDC requester returned no id_token");
  assertGithubIdentity(decodeJwtPayload(body.value), env);
  return body.value;
}

async function exchangePackageIdentity(pkg, registryBase, env, fetchImpl) {
  const idToken = await requestGithubIdToken(env, fetchImpl);
  const url = `${registryBase}/-/npm/v1/oidc/token/exchange/package/${encodeURIComponent(pkg.name)}`;
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${idToken}`, Accept: "application/json", "Content-Length": "0" },
    body: "",
    redirect: "manual",
  });
  if (response.status !== 201) return { oidc: `refused:${response.status}`, token: null };
  const body = await response.json();
  if (!body || typeof body.token !== "string" || body.token.length === 0) return { oidc: "refused:malformed-token", token: null };
  return { oidc: "exchanged", token: body.token };
}

async function readDirectPublishAuthorization(pkg, registryBase, token, fetchImpl, env) {
  try {
    const response = await fetchImpl(trustUrl(registryBase, pkg.name), {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      redirect: "manual",
    });
    if (response.status !== 200) return `refused:${response.status}`;
    const body = await response.json();
    return classifyDirectPublishPermission(body, {
      repository: env.GITHUB_REPOSITORY ?? "",
      workflowFilename: "changesets.yml",
    });
  } catch (error) {
    return `refused:${error instanceof Error ? error.message : String(error)}`;
  }
}

export function printPublishCensus(rows, log = console.log) {
  log("npm publish preflight census");
  log("package\tversion\tregistry\toidc\tdirect");
  for (const row of rows) log(`${row.name}\t${row.version}\t${row.registry}\t${row.oidc}\t${row.direct}`);
}

function blankCensusRow(pkg) {
  return { ...pkg, registry: "not-run", oidc: "not-run", direct: "not-run" };
}

export async function preflightNpmPublish({
  fixedPackages,
  workspacePackages,
  registryBase = DEFAULT_REGISTRY,
  env = process.env,
  fetchImpl = fetch,
  log = console.log,
}) {
  let packages;
  try {
    packages = validateReleaseSet(fixedPackages, workspacePackages);
  } catch (error) {
    const manifests = new Map(workspacePackages.map((pkg) => [pkg.name, pkg]));
    const names = [...new Set([...fixedPackages, ...workspacePackages.map((pkg) => pkg.name)])].sort();
    printPublishCensus(names.map((name) => blankCensusRow({
      name,
      version: manifests.get(name)?.version ?? "<missing>",
    })), log);
    throw error;
  }
  const rows = [];
  for (const pkg of packages) {
    rows.push({
      ...pkg,
      registry: await readExactVersion(pkg, registryBase, fetchImpl),
      oidc: "not-run",
      direct: "not-run",
    });
  }

  const unknown = rows.filter((row) => row.registry.startsWith("unknown:"));
  const present = rows.filter((row) => row.registry === "present");
  const absent = rows.filter((row) => row.registry === "absent");

  if (unknown.length || present.length > 0) {
    printPublishCensus(rows, log);
    if (unknown.length) throw new Error(`registry census was inconclusive for ${unknown.length}/${rows.length} packages`);
    throw new Error(`publish preflight refused: ${present.length}/${rows.length} exact versions already exist`);
  }
  if (absent.length !== rows.length) {
    printPublishCensus(rows, log);
    throw new Error("the packages that would publish are not the complete fixed group");
  }

  const hasOidcUrl = Boolean(env.ACTIONS_ID_TOKEN_REQUEST_URL);
  const hasOidcToken = Boolean(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN);
  if (hasOidcUrl !== hasOidcToken) {
    for (const row of rows) {
      row.oidc = "refused:incomplete GitHub OIDC requester";
      row.direct = "not-run";
    }
  } else if (hasOidcUrl) {
    for (const row of rows) {
      try {
        const exchanged = await exchangePackageIdentity(row, registryBase, env, fetchImpl);
        row.oidc = exchanged.oidc;
        if (exchanged.oidc === "exchanged" && exchanged.token) {
          row.direct = await readDirectPublishAuthorization(row, registryBase, exchanged.token, fetchImpl, env);
        } else {
          row.direct = "not-run";
        }
      } catch (error) {
        row.oidc = `refused:${error instanceof Error ? error.message : String(error)}`;
        row.direct = "not-run";
      }
    }
  } else if (env.NPM_TOKEN || env.NODE_AUTH_TOKEN) {
    for (const row of rows) {
      row.oidc = "not-available:classic-token";
      row.direct = "not-available:classic-token";
    }
  } else {
    for (const row of rows) {
      row.oidc = "refused:no publish credential path";
      row.direct = "not-run";
    }
  }
  printPublishCensus(rows, log);
  const refusedOidc = rows.filter((row) => row.oidc.startsWith("refused:"));
  if (refusedOidc.length) throw new Error(`npm OIDC exchange refused ${refusedOidc.length}/${rows.length} packages`);
  const stageOnly = rows.filter((row) => row.direct === "stage-only");
  if (stageOnly.length) {
    throw new Error(`publish preflight refused: ${stageOnly.length}/${rows.length} packages allow only staged publish`);
  }
  const refusedDirect = rows.filter((row) => row.direct.startsWith("refused:"));
  if (refusedDirect.length) {
    throw new Error(`direct-publish authorization refused ${refusedDirect.length}/${rows.length} packages`);
  }
  const unproven = rows.filter((row) => row.direct !== "createPackage" && row.direct !== "not-available:classic-token");
  if (unproven.length) {
    throw new Error(`direct-publish authorization was not proven for ${unproven.length}/${rows.length} packages`);
  }
  return { state: "ready", rows };
}

export async function preflightFromRepository({
  root = ROOT,
  registryBase = process.env.npm_config_registry ?? DEFAULT_REGISTRY,
  env = process.env,
  fetchImpl = fetch,
  log = console.log,
  exec = execFileSync,
} = {}) {
  const fixedPackages = closureFromConfig(readFileSync(join(root, ".changeset", "config.json"), "utf8"));
  const workspacePackages = workspacePackagesFromPnpm(root, exec);
  return preflightNpmPublish({ fixedPackages, workspacePackages, registryBase: registryBase.replace(/\/+$/, ""), env, fetchImpl, log });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  preflightFromRepository().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
