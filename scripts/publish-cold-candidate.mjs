#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isMainEntry } from "./main-entry.mjs";
import { preflightFromRepository } from "./preflight-npm-publish.mjs";
import { verifyColdResults } from "./verify-cold-results.mjs";
import { publicationDeadline, publicationMap, remainingBudget } from "./publication-budget.mjs";
import { verifyQualification } from "./release-qualification.mjs";
import { runPublicationChild } from "./publication-child.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function coldPublicationInputs(manifest, rows, source, directory) {
  assert.equal(manifest.source, source, "publication candidate belongs to another source");
  assert.deepEqual(manifest.packages.map((pkg) => pkg.name).sort(), rows.map((pkg) => pkg.name).sort(), "publication candidate is not the complete release census");
  const guarded = [];
  const archives = new Set();
  const inputs = rows.map((row) => {
    const pkg = manifest.packages.find((entry) => entry.name === row.name);
    const current = JSON.parse(readFileSync(join(row.path, "package.json"), "utf8"));
    assert.deepEqual(JSON.parse(pkg.sourceManifest), current, "publication package policy or version differs from qualification");
    assert.equal(pkg.version, row.version, "publication version differs from qualification");
    assert.equal(current.name, row.name);
    assert.equal(current.version, row.version);
    if (current.scripts?.prepublishOnly) guarded.push(row.name);
    assert(typeof pkg.archive === "string" && /^[^/\\]+\.tgz$/.test(pkg.archive) && !archives.has(pkg.archive), "publication archive path is invalid or repeated");
    archives.add(pkg.archive);
    assert(/^[a-f0-9]{64}$/.test(pkg.sha256), "publication archive lacks its qualified hash");
    const archive = join(directory, pkg.archive);
    assert(lstatSync(archive).isFile(), "publication archive must be a regular file");
    assert.equal(sha(readFileSync(archive)), pkg.sha256, "publication archive differs from qualified bytes");
    return { ...pkg, archive };
  });
  assert.deepEqual(manifest.prepublishOnly, guarded.sort(), "publication candidate omitted a prepublish guard");
  return inputs;
}

export async function publishArchive(file, args, { cwd, env, timeout }) {
  const result = await runPublicationChild(file, args, { cwd, env, timeout });
  if (result.status === 0 && !result.error) return;
  throw Object.assign(new Error(result.error?.code === "ETIMEDOUT" ? "publication subprocess exceeded its deadline; registry outcome is unknown" : "publication subprocess failed; inspect its registry outcome before retrying"), { code: result.error?.code ?? result.status, signal: result.signal });
}

export async function publishColdCandidate({
  env = process.env,
  root = resolve(env.RELEASE_ROOT ?? resolve(import.meta.dirname, "..")),
  publisherRoot = resolve(import.meta.dirname, ".."),
  directory = env.COLD_CANDIDATE,
  results = env.COLD_RESULTS,
  tag = "latest",
  exec = execFileSync,
  publish = publishArchive,
  preflight = preflightFromRepository,
  concurrency = 4,
  receiptFile = env.PUBLISH_RECEIPT,
  selectionFile = env.RELEASE_QUALIFICATION,
  fetchImpl = fetch,
} = {}) {
  assert(directory && results, "publication needs the qualified candidate and all native receipts");
  assert(typeof tag === "string" && /^[a-z][a-z0-9._-]*$/i.test(tag), "publication dist-tag is invalid");
  const deadline = publicationDeadline(env.RELEASE_REQUESTED_AT);
  directory = resolve(directory);
  const bytes = readFileSync(join(directory, "manifest.json"));
  const manifest = JSON.parse(bytes.toString("utf8"));
  const source = exec("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", timeout: remainingBudget(deadline), killSignal: "SIGKILL" }).trim();
  const qualification = selectionFile ? await verifyQualification({ root, publisherRoot, directory, results, selectionFile, tag, env, exec, deadline, fetchImpl }) : undefined;
  const qualifiedSource = qualification?.source ?? source;
  assert.equal(manifest.source, qualifiedSource, "publication candidate belongs to another source");
  verifyColdResults(results, qualifiedSource, sha(bytes));
  if (receiptFile) assert(!existsSync(receiptFile), "refusing to overwrite an existing publication receipt");
  const census = await preflight({ root, env, exec, deadline, tag });
  if (census.state === "nothing-to-publish") return [];
  assert.equal(census.state, "ready", "publication preflight returned an unsupported state");
  // Validate the entire set before the first write, then recheck each archive at its write boundary.
  const inputs = coldPublicationInputs(manifest, census.rows, qualifiedSource, directory);
  const receipt = {
    v: 1, source: qualifiedSource, promotionSource: source, publisherSource: qualification?.publisherSource, qualification, candidateSha256: sha(bytes), requestedAt: env.RELEASE_REQUESTED_AT, deadline: new Date(deadline).toISOString(), tag,
    packages: inputs.map(({ name, version, sha256 }) => ({ name, version, sha256, state: "not-started" })),
  };
  if (receiptFile) mkdirSync(dirname(receiptFile), { recursive: true, mode: 0o700 });
  const save = () => {
    if (!receiptFile) return;
    const temporary = `${receiptFile}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    renameSync(temporary, receiptFile);
  };
  save();
  const write = async (pkg) => {
    const row = receipt.packages.find((entry) => entry.name === pkg.name);
    let entered = false;
    try {
      assert.equal(sha(readFileSync(pkg.archive)), pkg.sha256, "publication archive changed after preflight");
      const timeout = remainingBudget(deadline, 180_000);
      row.state = "running";
      save();
      entered = true;
      await publish("pnpm", ["publish", pkg.archive, "--provenance", "--access=public", "--no-git-checks", "--ignore-scripts", "--tag", tag], { cwd: root, env, timeout });
      row.state = "accepted";
      row.acceptedAt = new Date().toISOString();
      save();
    } catch (error) {
      if (row.state !== "accepted") row.state = entered ? "unknown" : "refused";
      save();
      throw error;
    }
  };
  let failed = false;
  let failure;
  try {
    await publicationMap(inputs.filter(({ name }) => name !== "cotal-ai"), concurrency, write);
    const binary = inputs.find(({ name }) => name === "cotal-ai");
    if (binary) await write(binary);
  } catch (error) { failed = true; failure = error; }
  receipt.complete = !failed;
  receipt.finishedAt = new Date().toISOString();
  save();
  if (failed) throw failure;
  return inputs.map(({ name, version }) => ({ name, version }));
}

if (isMainEntry(import.meta.url)) {
  assert(process.env.RELEASE_QUALIFICATION, "publication entrypoint needs a verified cross-run qualification selection");
  publishColdCandidate({ tag: process.argv[2] ?? "latest" }).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
