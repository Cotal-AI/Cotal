#!/usr/bin/env node
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";

const env = process.env;
assert(env.GITHUB_EVENT_NAME === "workflow_dispatch" && env.GITHUB_REF === "refs/heads/main", "native selection requires the main publisher");
assert(/^[1-9]\d*$/.test(env.RELEASE_NATIVE_RUN ?? ""), "native build run is required");
const api = async path => {
  const response = await fetch(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/${path}`, { headers: { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: "application/vnd.github+json" }, redirect: "manual", signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 200, "cannot verify native artifact provenance");
  return response.json();
};
const run = await api(`actions/runs/${env.RELEASE_NATIVE_RUN}`);
assert.equal(run.head_sha, env.RELEASE_SOURCE, "native artifacts belong to another source");
assert.equal(run.repository?.full_name, env.GITHUB_REPOSITORY);
assert.equal(run.head_repository?.full_name, env.GITHUB_REPOSITORY);
assert.equal(run.path, ".github/workflows/cold-setup.yml");
const jobs = await api(`actions/runs/${run.id}/jobs?per_page=100`);
for (const name of ["cold native (x64)", "cold native (arm64)", "workspace-native / build (x64)", "workspace-native / build (arm64)"]) {
  const job = jobs.jobs.filter(job => job.name === name);
  assert.equal(job.length, 1, `ambiguous native builder ${name}`);
  assert.equal(job[0].conclusion, "success", `native builder did not succeed: ${name}`);
}
const listing = await api(`actions/runs/${run.id}/artifacts?per_page=100`);
assert.equal(listing.total_count, listing.artifacts.length, "incomplete native artifact listing");
const ids = ["cold-native-x64", "cold-native-arm64", "workspace-native-x64", "workspace-native-arm64"].map(name => {
  const matches = listing.artifacts.filter(item => item.name === name);
  assert.equal(matches.length, 1, `ambiguous artifact ${name}`);
  const artifact = matches[0];
  assert(!artifact.expired && /^sha256:[a-f0-9]{64}$/.test(artifact.digest ?? ""), "native artifact is expired or has no digest");
  assert.equal(artifact.workflow_run?.head_sha, env.RELEASE_SOURCE);
  return artifact.id;
});
appendFileSync(env.GITHUB_OUTPUT, `artifact-ids=${ids.join(",")}\n`);
console.log(`Selected four successful native build artifacts from ${run.id}; test-matrix status is not a release gate.`);
