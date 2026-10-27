import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { test } from "node:test";
import YAML from "yaml";
import { createServer } from "node:http";
import { preflightNpmPublish, classifyDirectPublishPermission } from "./preflight-npm-publish.mjs";
import { closureFromConfig } from "./verify-publish-closure.mjs";
import { releaseManifests, stageReleasePlan, STAGING_TAG } from "./stage-release-plan.mjs";

const root = join(import.meta.dirname, "..");

test("workflow parses and every ID download flattens the artifact into its declared plan path", () => {
  const workflow = YAML.parse(readFileSync(join(root, ".github/workflows/changesets.yml"), "utf8"));
  for (const name of ["select", "publish"]) {
    const downloads = workflow.jobs[name].steps.filter((step) => step.with?.["artifact-ids"]);
    assert.equal(downloads.length, 1);
    assert.equal(downloads[0].with["merge-multiple"], true);
  }
  const steps = workflow.jobs.publish.steps;
  const verify = steps.findIndex((step) => step.name === "Verify staged closure and registry installation");
  const promote = steps.findIndex((step) => step.name === "Promote verified packages to latest");
  assert(verify >= 0 && promote > verify);
  assert.match(steps[verify].run, /verify-release-installable\.mjs.*--closure/);
  assert.equal(steps[promote].if, "steps.publish.outputs.published == 'true'");
  assert.equal(steps[promote]["continue-on-error"], undefined);
});
const entry = (name) => ({ kind: "publish", name, version: "1.2.3", access: "public", tag: "latest" });
const manifests = [{ name: "core", version: "1.2.3" }, { name: "adapter", version: "1.2.3", peerDependencies: { core: "*" } }, { name: "cotal-ai", version: "1.2.3", dependencies: { core: "*" } }];
const fixed = manifests.map((pkg) => pkg.name);
const plan = () => ({ version: 1, plan: [[entry("core")], [entry("adapter"), entry("cotal-ai")]] });

test("staged preflight refuses missing or unreadable dist-tag authority before any upload", async () => {
  const claims = { repository: "Cotal-AI/Cotal", workflow_ref: "Cotal-AI/Cotal/.github/workflows/changesets.yml@refs/heads/main", ref: "refs/heads/main", event_name: "workflow_dispatch", environment: "npm-publish", aud: "npm:registry.npmjs.org", jti: "synthetic" };
  const publisher = { type: "github", claims: { repository: claims.repository, workflow_ref: { file: "changesets.yml" }, environment: "npm-publish" }, permissions: ["createPackage"] };
  assert.equal(classifyDirectPublishPermission([publisher], undefined, { requireDistTags: true }), "refused:manage-dist-tags");
  assert.equal(classifyDirectPublishPermission([{ ...publisher, permissions: ["manageDistTags"] }], undefined, { requireDistTags: true }), "stage-only");
  assert.equal(classifyDirectPublishPermission([publisher, { ...publisher, permissions: ["manageDistTags"] }], undefined, { requireDistTags: true }), "refused:manage-dist-tags", "separate configurations cannot combine authority");
  let mode = "missing", writes = 0;
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.method !== "GET" && !request.url.includes("/oidc/token/exchange/")) writes++;
    if (request.url.startsWith("/id-token")) response.end(JSON.stringify({ value: `synthetic.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature` }));
    else if (request.url.includes("/oidc/token/exchange/")) { response.writeHead(201); response.end(JSON.stringify({ token: "synthetic-not-a-credential" })); }
    else if (request.url.endsWith("/trust")) {
      if (mode === "unreadable") { response.writeHead(401); response.end("{}"); }
      else response.end(JSON.stringify([{ ...publisher, permissions: mode === "ready" ? ["createPackage", "manageDistTags"] : ["createPackage"] }]));
    } else if (request.url.endsWith("/1.2.3")) { response.writeHead(404); response.end("{}"); }
    else response.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const registryBase = `http://127.0.0.1:${server.address().port}`;
  const options = { fixedPackages: ["one"], workspacePackages: [{ name: "one", version: "1.2.3", path: "/synthetic" }], registryBase, requireDistTags: true, env: { GITHUB_REPOSITORY: claims.repository, GITHUB_REF: claims.ref, GITHUB_EVENT_NAME: claims.event_name, ACTIONS_ID_TOKEN_REQUEST_URL: `${registryBase}/id-token`, ACTIONS_ID_TOKEN_REQUEST_TOKEN: "synthetic-not-a-credential" }, log: () => {} };
  try {
    for (mode of ["missing", "unreadable"]) await assert.rejects(() => preflightNpmPublish(options), /dist-tag authority is missing or unverifiable.*refuse before upload/);
    mode = "ready";
    assert.equal((await preflightNpmPublish(options)).state, "ready");
    assert.equal(writes, 0);
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});

test("staging preserves supported plan fields and derives dependency order with binary last", () => {
  const source = plan();
  const result = stageReleasePlan(source, fixed, manifests);
  assert.deepEqual(result.specs, ["core@1.2.3", "adapter@1.2.3", "cotal-ai@1.2.3"]);
  assert(result.document.plan.flat().every((release) => release.tag === STAGING_TAG));
  assert(source.plan.flat().every((release) => release.tag === "latest"));
  for (const group of result.document.plan) for (const release of group) release.tarball = { path: `packages/${release.name}.tgz`, integrity: "sha256-synthetic" };
  assert.deepEqual(stageReleasePlan(result.document, fixed, manifests, { packed: true }).specs, result.specs);
});

test("incomplete, duplicate, foreign, mixed, latest-packed and disordered plans refuse", () => {
  const cases = [
    (p) => p.plan.pop(),
    (p) => p.plan[1].push(entry("core")),
    (p) => { p.plan[0][0].name = "foreign"; },
    (p) => { p.plan[0][0].version = "1.2.2"; },
    (p) => { p.plan[0][0].kind = "tag-only"; },
    (p) => { p.plan[0][0].tag = "beta"; },
    (p) => { p.plan.reverse(); },
    (p) => { p.version = 2; },
  ];
  for (const change of cases) { const candidate = plan(); change(candidate); assert.throws(() => stageReleasePlan(candidate, fixed, manifests)); }
  assert.throws(() => stageReleasePlan(plan(), fixed, manifests, { packed: true }), /tag/);
  assert.throws(() => stageReleasePlan(plan(), fixed, [...manifests, { name: "outside", version: "1.2.3" }]), /workspace/);
});

test("real repository closure produces complete dependency-ordered promotion specs", () => {
  const packages = releaseManifests(root);
  const names = closureFromConfig(readFileSync(join(root, ".changeset/config.json"), "utf8"));
  const remaining = new Set(names), groups = [];
  while (remaining.size) {
    const ready = packages.filter((pkg) => remaining.has(pkg.name) && Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies }).every((dependency) => !remaining.has(dependency)));
    assert(ready.length > 0);
    groups.push(ready.map((pkg) => ({ ...entry(pkg.name), version: pkg.version })));
    for (const pkg of ready) remaining.delete(pkg.name);
  }
  const result = stageReleasePlan({ version: 1, plan: groups }, names, packages);
  assert.equal(result.specs.length, names.length);
  assert.equal(result.specs.at(-1), `cotal-ai@${packages.find((pkg) => pkg.name === "cotal-ai").version}`);
});

test("actual workflow promotion shell uses ordinary npm, stops on error and does not promote after failed verification", () => {
  const workflow = readFileSync(join(root, ".github/workflows/changesets.yml"), "utf8");
  const block = workflow.match(/      - name: Promote verified packages to latest\n        if: steps.publish.outputs.published == 'true'\n        run: \|\n([\s\S]*?)(?=\n  verify-install:)/)?.[1];
  assert(block, "ordinary promotion block must exist");
  const script = block.split("\n").map((line) => line.replace(/^          /, "")).join("\n");
  const scratch = mkdtempSync(join(tmpdir(), "release-promotion-shell-"));
  try {
    mkdirSync(join(scratch, "bin"));
    writeFileSync(join(scratch, "package.json"), '{"type":"commonjs"}');
    const capture = join(scratch, "calls");
    writeFileSync(join(scratch, "promote-specs.txt"), "core@1.2.3\nadapter@1.2.3\ncotal-ai@1.2.3\n");
    writeFileSync(join(scratch, "bin/npm"), `#!${process.execPath}\nconst fs=require("node:fs"); fs.appendFileSync(${JSON.stringify(capture)},process.argv.slice(2).join(" ")+"\\n");if(process.env.REFUSE && process.argv.includes("adapter@1.2.3"))process.exit(1);\n`, { mode: 0o755 });
    const env = { PATH: `${scratch}/bin:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: scratch, RUNNER_TEMP: scratch, DO_NOT_TRACK: "1" };
    const success = spawnSync("bash", ["-e", "-c", script], { env, encoding: "utf8" });
    assert.equal(success.status, 0, success.stderr);
    assert.equal(readFileSync(capture, "utf8"), "dist-tag add core@1.2.3 latest\ndist-tag add adapter@1.2.3 latest\ndist-tag add cotal-ai@1.2.3 latest\n");
    writeFileSync(capture, "");
    assert.equal(spawnSync("bash", ["-e", "-c", script], { env: { ...env, REFUSE: "1" } }).status, 1);
    assert(!readFileSync(capture, "utf8").includes("cotal-ai"));
    writeFileSync(capture, "");
    assert.equal(spawnSync("bash", ["-e", "-c", `false\n${script}`], { env }).status, 1);
    assert.equal(readFileSync(capture, "utf8"), "");
    writeFileSync(join(scratch, "bin/npm"), `#!${process.execPath}\nconst fs=require("node:fs");fs.appendFileSync(${JSON.stringify(capture)},process.argv.slice(2).join(" ")+"\\n");console.error("npm error code ETARGET");process.exit(1);\n`, { mode: 0o755 });
    const verifier = join(root, "scripts/verify-release-installable.mjs");
    const refused = spawnSync("bash", ["-e", "-c", `"${process.execPath}" "${verifier}" 1.2.3 --closure --deadline-ms=200 --poll-interval-ms=1\n${script}`], { env: { ...env, TMPDIR: scratch }, encoding: "utf8", timeout: 5_000 });
    assert.equal(refused.status, 1, refused.stderr + refused.stdout);
    assert.match(refused.stdout, /VERDICT: NOT INSTALLABLE/);
    const calls = readFileSync(capture, "utf8");
    assert.match(calls, /install --prefer-online/);
    assert(!calls.includes("dist-tag"), "actual verifier refusal must leave every latest tag untouched");
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
