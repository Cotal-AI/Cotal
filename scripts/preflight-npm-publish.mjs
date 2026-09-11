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
 * When GitHub Actions exposes its OIDC token requester, a distinct id_token is exchanged for every
 * package before any build, assembly, or publish command begins.
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
  if (response.status !== 201) return `refused:${response.status}`;
  const body = await response.json();
  if (!body || typeof body.token !== "string" || body.token.length === 0) return "refused:malformed-token";
  return "ready";
}

export function printPublishCensus(rows, log = console.log) {
  log("npm publish preflight census");
  log("package\tversion\tregistry\toidc");
  for (const row of rows) log(`${row.name}\t${row.version}\t${row.registry}\t${row.oidc}`);
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
    printPublishCensus(names.map((name) => ({
      name,
      version: manifests.get(name)?.version ?? "<missing>",
      registry: "not-run",
      oidc: "not-run",
    })), log);
    throw error;
  }
  const rows = [];
  for (const pkg of packages) {
    rows.push({ ...pkg, registry: await readExactVersion(pkg, registryBase, fetchImpl), oidc: "not-run" });
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

  for (const row of rows) {
    try {
      row.oidc = await exchangePackageIdentity(row, registryBase, env, fetchImpl);
    } catch (error) {
      row.oidc = `refused:${error instanceof Error ? error.message : String(error)}`;
    }
  }
  printPublishCensus(rows, log);
  const refused = rows.filter((row) => row.oidc !== "ready");
  if (refused.length) throw new Error(`npm OIDC exchange refused ${refused.length}/${rows.length} packages`);
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
