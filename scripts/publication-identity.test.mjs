import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { verifyBuildAttestation, verifyPublicationRequest } from "./release-qualification.mjs";
import { publicationDeadline } from "./publication-budget.mjs";

const repository = "Cotal-AI/Cotal", publisher = "d".repeat(40);
const scope = { RELEASE_CANDIDATE_SHA256: "a".repeat(64), RELEASE_SOURCE: "b".repeat(40), RELEASE_QUALIFICATION_RUN: "123", RELEASE_TAG: "latest" };
const title = (version, requestedAt, values = scope) => `publication-v1 ${version} ${values.RELEASE_CANDIDATE_SHA256} ${values.RELEASE_SOURCE} ${values.RELEASE_QUALIFICATION_RUN} ${values.RELEASE_TAG} ${requestedAt}`;
const makeRun = (id, number, version, requestedAt, createdAt = requestedAt, values = scope) => ({
  id, run_number: number, run_attempt: 1, head_sha: publisher, head_branch: "main", event: "workflow_dispatch", path: ".github/workflows/changesets.yml",
  repository: { full_name: repository }, head_repository: { full_name: repository }, created_at: createdAt,
  display_title: title(version, requestedAt, values),
});

async function withHistory(rows, current, run) {
  let mode = "normal", reads = 0, aborted = false;
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, "Bearer synthetic-not-a-credential");
    const url = new URL(request.url, "http://fixture.invalid");
    response.setHeader("Content-Type", "application/json");
    if (url.pathname.endsWith(`/actions/runs/${current.id}`)) { response.end(JSON.stringify(current)); return; }
    assert(url.pathname.endsWith("/actions/workflows/changesets.yml/runs"));
    reads++;
    if (mode === "stalled") { response.writeHead(200); response.write('{"unfinished":'); response.on("close", () => { aborted = true; }); return; }
    const [from, to] = url.searchParams.get("created").split("..").map(Date.parse);
    let selected = rows.filter((row) => Date.parse(row.created_at) >= from && Date.parse(row.created_at) <= to).sort((a, b) => b.run_number - a.run_number);
    if (mode === "missing-current") selected = selected.filter((row) => row.id !== current.id);
    const page = Number(url.searchParams.get("page"));
    response.end(JSON.stringify({ total_count: selected.length + (mode === "incomplete" ? 1 : 0), workflow_runs: selected.slice((page - 1) * 100, page * 100) }));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const requestedAt = current.display_title.split(" ").at(-1);
  const env = { ...scope, GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/main", GITHUB_RUN_ATTEMPT: "1", GITHUB_RUN_ID: String(current.id), GITHUB_SHA: publisher, GITHUB_REPOSITORY: repository, GH_TOKEN: "synthetic-not-a-credential", RELEASE_VERSION: "1.2.3", RELEASE_REQUESTED_AT: requestedAt };
  const options = { env, deadline: Date.now() + 20_000, fetchImpl: (url, init) => {
    const parsed = new URL(url); assert.equal(parsed.origin, "https://api.github.com");
    return fetch(origin + parsed.pathname + parsed.search, init);
  } };
  try { await run(options, { mode: (value) => { mode = value; }, reads: () => reads, aborted: () => aborted }); }
  finally { server.closeAllConnections(); await new Promise((done) => server.close(done)); }
}

test("live server history preserves the first version request across pages and reruns", async () => {
  const now = Date.now(), requestedAt = new Date(now - 5_000).toISOString(), createdAt = new Date(now - 1_000).toISOString();
  const first = makeRun(1, 1, "1.2.3", requestedAt, createdAt); first.run_attempt = 2;
  const rows = [first, ...Array.from({ length: 100 }, (_, i) => makeRun(i + 2, i + 2, "9.0.0", requestedAt, createdAt))];
  const current = makeRun(102, 102, "1.2.3", requestedAt, new Date(now).toISOString()); rows.push(current);
  await withHistory(rows, current, async (options, control) => {
    assert.deepEqual(await verifyPublicationRequest(options), { v: 1, version: "1.2.3", firstRunId: 1, requestedAt, candidateSha256: scope.RELEASE_CANDIDATE_SHA256, source: scope.RELEASE_SOURCE, qualificationRun: 123, tag: "latest" });
    assert.equal(control.reads(), 2);
    control.mode("incomplete");
    await assert.rejects(() => verifyPublicationRequest(options), /history is incomplete/);
    control.mode("missing-current");
    await assert.rejects(() => verifyPublicationRequest(options), /not yet present/);
  });
});

test("a fresh attempt-1 dispatch cannot renew an expired version's original clock", async () => {
  const now = Date.now(), original = new Date(now - 601_000).toISOString(), replacement = new Date(now - 1_000).toISOString();
  const first = makeRun(1, 1, "1.2.3", original);
  const current = makeRun(2, 2, "1.2.3", replacement, new Date(now).toISOString());
  await withHistory([first, current], current, async (options) => {
    await assert.rejects(() => verifyPublicationRequest(options), /cannot replace the original command timestamp/);
    const changed = { ...scope, RELEASE_SOURCE: "a".repeat(40), RELEASE_CANDIDATE_SHA256: "b".repeat(64), RELEASE_QUALIFICATION_RUN: "999" };
    current.display_title = title("1.2.3", replacement, changed);
    await assert.rejects(() => verifyPublicationRequest({ ...options, env: { ...options.env, ...changed } }), /cannot replace the original command timestamp/);
    current.display_title = title("1.2.3", original);
    const late = await verifyPublicationRequest({ ...options, env: { ...options.env, RELEASE_REQUESTED_AT: original } });
    assert.equal(late.requestedAt, original, "the original command timestamp is retained");
    assert.equal(late.firstRunId, first.id, "the first run keeps the request identity");
    assert.throws(() => publicationDeadline(late.requestedAt), /ten-minute deadline/, "its original publication deadline is still expired");
  });
});

test("keeping the old timestamp cannot silently replace the requested publication scope", async () => {
  const now = Date.now(), at = new Date(now - 5_000).toISOString();
  const first = makeRun(1, 1, "1.2.3", at), current = makeRun(2, 2, "1.2.3", at, new Date(now).toISOString());
  await withHistory([first, current], current, async (options) => {
    for (const changed of [
      { ...scope, RELEASE_CANDIDATE_SHA256: "c".repeat(64) }, { ...scope, RELEASE_SOURCE: "c".repeat(40) },
      { ...scope, RELEASE_QUALIFICATION_RUN: "456" }, { ...scope, RELEASE_TAG: "next" },
    ]) {
      current.display_title = title("1.2.3", at, changed);
      await assert.rejects(() => verifyPublicationRequest({ ...options, env: { ...options.env, ...changed } }), /cannot replace the original requested candidate, source, qualification or tag/);
    }
  });
});

test("publication request identity rejects another publisher, changed title and malformed time", async () => {
  const now = Date.now(), at = new Date(now - 1_000).toISOString();
  const current = makeRun(10, 10, "1.2.3", at, new Date(now).toISOString());
  await withHistory([current], current, async (options) => {
    await assert.rejects(() => verifyPublicationRequest({ ...options, env: { ...options.env, GITHUB_SHA: "b".repeat(40) } }), /publisher source/);
    await assert.rejects(() => verifyPublicationRequest({ ...options, env: { ...options.env, GITHUB_RUN_ATTEMPT: "2" } }), /reruns cannot replace/);
    await assert.rejects(() => verifyPublicationRequest({ ...options, env: { ...options.env, RELEASE_REQUESTED_AT: new Date(now - 500).toISOString() } }), /inputs differ/);
    current.display_title = title("1.2.3", "invalid");
    await assert.rejects(() => verifyPublicationRequest(options), /original UTC/);
  });
});

test("unrelated version records cannot widen or poison the requested publication", async () => {
  const at = new Date(Date.now() - 1_000).toISOString();
  const unrelated = makeRun(1, 1, "9.0.0", "malformed-unrelated-time", at);
  const current = makeRun(2, 2, "1.2.3", at);
  await withHistory([unrelated, current], current, async (options) => {
    assert.equal((await verifyPublicationRequest(options)).firstRunId, current.id);
  });
});

test("filtered history beyond GitHub's 1000-result cap is partitioned rather than truncated", async () => {
  const now = Date.now(), at = new Date(now - 5_000).toISOString();
  const rows = Array.from({ length: 1_099 }, (_, i) => {
    const created = new Date(now - (1_100 - i) * 86_400_000).toISOString();
    return makeRun(i + 1, i + 1, "9.0.0", created);
  });
  const first = makeRun(1_100, 1_100, "1.2.3", at, new Date(now - 1_000).toISOString());
  const current = makeRun(1_101, 1_101, "1.2.3", at, new Date(now).toISOString()); rows.push(first, current);
  await withHistory(rows, current, async (options, control) => {
    assert.equal((await verifyPublicationRequest(options)).firstRunId, first.id);
    assert(control.reads() > 12, "control must cross the filtered search cap and enumerate partitions");
  });
});

test("a live history body cannot hold the publication beyond its remaining budget", async () => {
  const at = new Date(Date.now() - 1_000).toISOString(), current = makeRun(1, 1, "1.2.3", at);
  await withHistory([current], current, async (options, control) => {
    control.mode("stalled");
    await assert.rejects(() => verifyPublicationRequest({ ...options, deadline: Date.now() + 300 }), /deadline|aborted/i);
    await new Promise((done) => setTimeout(done, 30));
    assert(control.aborted(), "deadline must abort the actual history response body");
  });
});

function attestationFixture(run) {
  const root = mkdtempSync(join(tmpdir(), "publication-certificate-policy-"));
  const manifestFile = join(root, "manifest.json"), bundleFile = join(root, "qualification.sigstore.json");
  writeFileSync(manifestFile, "synthetic candidate"); writeFileSync(bundleFile, "synthetic bundle; no cryptographic evidence");
  const qualified = { source: "a".repeat(40), runId: 123, runAttempt: 1 };
  const invocation = `https://github.com/${repository}/actions/runs/123/attempts/1`;
  const verified = (uri) => JSON.stringify([{ verificationResult: { signature: { certificate: { runInvocationURI: uri } }, statement: { predicate: { runInvocationURI: invocation } } } }]);
  const options = { manifestFile, bundleFile, qualified, env: { GITHUB_REPOSITORY: repository, GH_TOKEN: "synthetic-not-a-credential" }, deadline: Date.now() + 10_000 };
  try { run(options, { invocation, verified }); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

test("certificate verification pins artifact, source, signer, issuer and hosted-runner policy", () => attestationFixture((options, { invocation, verified }) => {
  verifyBuildAttestation({ ...options, exec: (file, args, settings) => {
    assert.equal(file, "gh");
    assert.deepEqual(args, ["attestation", "verify", options.manifestFile, "--bundle", options.bundleFile, "--repo", repository,
      "--source-digest", options.qualified.source, "--signer-digest", options.qualified.source,
      "--signer-workflow", `${repository}/.github/workflows/cold-setup.yml`, "--cert-oidc-issuer", "https://token.actions.githubusercontent.com",
      "--deny-self-hosted-runners", "--format", "json"]);
    assert(settings.timeout > 0 && settings.timeout <= 10_000);
    assert.equal(settings.env.GH_HOST, "github.com"); assert.equal(settings.env.GH_PROMPT_DISABLED, "1");
    return verified(invocation);
  } });
}));

test("a free predicate cannot replace certificate-bound run and attempt identity", () => attestationFixture((options, { invocation, verified }) => {
  for (const uri of [invocation.replace("/123/", "/124/"), invocation.replace("/attempts/1", "/attempts/2"), undefined]) {
    assert.throws(() => verifyBuildAttestation({ ...options, exec: () => verified(uri) }), /certificate belongs to another run or attempt/);
  }
  assert.throws(() => verifyBuildAttestation({ ...options, exec: () => "[]" }), /certificate belongs to another run or attempt/);
  assert.throws(() => verifyBuildAttestation({ ...options, exec: () => { throw Object.assign(new Error("synthetic untrusted certificate"), { status: 1 }); } }), /build attestation verification failed/);
}));
