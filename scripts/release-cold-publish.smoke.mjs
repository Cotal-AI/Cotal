#!/usr/bin/env node
// Synthetic packing/publication controls only. The native matrix and real-pnpm archive probe are separate.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { create as createTar, replace as replaceTar } from "tar";
import { coldPublicationInputs, publishColdCandidate } from "./publish-cold-candidate.mjs";
import { packColdCandidate } from "./pack-cold-candidate.mjs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { coldOsEnvironment } from "./release-cold-environment.mjs";
import { checkoutReleaseSource, recordQualification, selectQualification, verifyQualification } from "./release-qualification.mjs";
import { coldResultNames } from "./verify-cold-results.mjs";

// Exercise the source imports through a real entrypoint in a fresh personal environment.
if (!process.argv.includes("--contract-child")) {
  const home = mkdtempSync(join(tmpdir(), "cold-contract-child-"));
  let status = 0;
  try {
    execFileSync(process.execPath, [fileURLToPath(import.meta.url), "--contract-child"], {
      stdio: "inherit",
      env: { ...coldOsEnvironment(), HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home, TMPDIR: home, TMP: home, TEMP: home },
    });
  } catch (error) {
    console.error(`contract subprocess failed (${error.status ?? error.code})`);
    status = 1;
  } finally { rmSync(home, { recursive: true, force: true }); }
  process.exit(status);
}

const root = mkdtempSync(join(tmpdir(), "cold-publication-contract-"));
const source = "a".repeat(40);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
let passed = 0;
const check = async (name, fn) => {
  try { await fn(); }
  catch (error) { console.error(`FAIL ${name}`); throw error; }
  passed++; console.log(`PASS ${name}`);
};
try {
  const longEntry = "dist/" + "archive-entry-".repeat(12) + ".js";
  const rows = ["one", "two"].map((name) => {
    const path = join(root, name); mkdirSync(path);
    writeFileSync(join(path, "package.json"), JSON.stringify({ name, version: "1.0.0", scripts: { prepublishOnly: "fixture-guard" } }));
    mkdirSync(join(path, "dist"));
    writeFileSync(join(path, "dist/index.js"), "synthetic distribution " + name);
    writeFileSync(join(path, longEntry), "synthetic long filename");
    return { name, version: "1.0.0", path };
  });
  mkdirSync(join(root, ".changeset"));
  writeFileSync(join(root, ".changeset/config.json"), JSON.stringify({ fixed: [["one", "two"]] }));
  let archiveChildren = 0;
  const events = [];
  const packFixture = (label, alter = () => {}) => {
    const output = join(root, label);
    return packColdCandidate({ root, output, exec: (file, args, options) => {
      if (file === "git") { assert.deepEqual(args, ["rev-parse", "HEAD"]); return source + "\n"; }
      if (file === "pnpm") {
        if (args[0] === "list") return JSON.stringify(rows);
        if (args[0] === "-r") { events.push(args.at(-1)); return; }
        assert.equal(args[0], "--dir");
        const row = rows.find((row) => row.path === args[1]); assert(row);
        events.push(`pack:${row.name}`);
        const archive = join(output, row.name + ".tgz");
        createTar({ file: archive, cwd: row.path, prefix: "package", gzip: true, portable: true, sync: true }, ["package.json", "dist/index.js", longEntry]);
        alter(row, archive);
        return;
      }
      assert.equal(file, "tar"); archiveChildren++;
      return execFileSync(file, args, options);
    } });
  };
  await check("cold candidate runs prepublish guards before packing", () => {
    const packed = packFixture("packed");
    assert.deepEqual(events, ["prepublishOnly", "pack:one", "pack:two"]);
    assert.deepEqual(packed.prepublishOnly, ["one", "two"]);
    assert.equal(packed.source, source);
    assert.deepEqual(JSON.parse(readFileSync(join(root, "packed/manifest.json"), "utf8")), packed);
    assert(packed.packages.every((row) => row.files["dist/index.js"] && row.files[longEntry] === sha("synthetic long filename") && row.sourceManifest));
  });
  await check("cold candidate inspects archives without tar subprocesses", () => assert.equal(archiveChildren, 0));
  await check("cold candidate refuses corrupt gzip archives", () => assert.throws(() => packFixture("bad-gzip", (_, archive) => writeFileSync(archive, "not a gzip archive"))));
  await check("cold candidate refuses repeated archive entries", () => assert.throws(() => packFixture("duplicate", (row, archive) => {
    const plain = archive + ".tar";
    const options = { file: plain, cwd: row.path, prefix: "package", portable: true, sync: true };
    createTar(options, ["package.json", "dist/index.js"]);
    replaceTar(options, ["package.json"]);
    writeFileSync(archive, gzipSync(readFileSync(plain)));
  }), /repeated archive entry/));
  await check("cold candidate refuses absent built distributions", () => assert.throws(() => packFixture("no-dist", (row, archive) => createTar({ file: archive, cwd: row.path, prefix: "package", gzip: true, portable: true, sync: true }, ["package.json"])), /has no built distribution/));
  await check("incomplete pack census prevents every prepublish guard", () => {
    assert.throws(() => packColdCandidate({ root, output: join(root, "rejected"), exec: (file, args) => {
      assert.equal(file, "pnpm"); assert.equal(args[0], "list"); return JSON.stringify(rows.slice(0, 1));
    } }), /public package census disagrees/);
  });
  const manifest = { source, prepublishOnly: ["one", "two"], packages: rows.map((row) => {
    const archive = row.name + ".tgz";
    const bytes = Buffer.from("synthetic archive fixture " + row.name); writeFileSync(join(root, archive), bytes);
    return { name: row.name, version: row.version, sourceManifest: readFileSync(join(row.path, "package.json"), "utf8"), archive, sha256: sha(bytes) };
  }) };
  const bytes = JSON.stringify(manifest); writeFileSync(join(root, "manifest.json"), bytes);
  const checks = ["cold restart replaces every process generation", "native process identity round-trips before daemon startup"];
  for (const round of [0, 1]) for (const name of ["Manager, delivery and broker survive startup", "native Manager control answers", "empty Manager roster is an empty seat list", "native shutdown policy is accepted once", "owned broker listener closed"]) checks.push(`round ${round} ${name}`);
  for (const round of [0, 1]) for (const component of ["manager", "delivery"]) checks.push(`round ${round} Windows ${component} cleanup handler ran`);
  let firstReceipt;
  for (const [runner, platform, arch] of [["ubuntu-latest", "linux", "x64"], ["ubuntu-24.04-arm", "linux", "arm64"], ["macos-15-intel", "darwin", "x64"], ["macos-15", "darwin", "arm64"], ["windows-latest", "win32", "x64"], ["windows-11-arm", "win32", "arm64"]]) {
    for (const node of [22, 24, 26]) {
      const dir = join(root, `cold-result-${runner}-node${node}`); mkdirSync(dir);
      const file = join(dir, "cold-result.json"); firstReceipt ??= file;
      writeFileSync(file, JSON.stringify({ source, candidateSha256: sha(bytes), platform, arch, node: `v${node}.0.0`, complete: true, assertions: checks.length, checks, generations: [0, 1].map((round) => ["nats", "manager", "delivery"].map((name, index) => ({ name: name + ".pid", pid: 100 + index + round * 10, token: `fixture-${round}` }))) }));
    }
  }
  await check("publication validates the complete synthetic archive set", () => assert.equal(coldPublicationInputs(manifest, rows, source, root).length, 2));
  for (const [name, mutate] of [
    ["source mismatch", (m) => { m.source = "b".repeat(40); }],
    ["missing package", (m) => { m.packages.pop(); }],
    ["duplicate package", (m) => { m.packages[1] = m.packages[0]; }],
    ["changed policy", (m) => { const p = JSON.parse(m.packages[0].sourceManifest); p.scripts.prepublishOnly = "different"; m.packages[0].sourceManifest = JSON.stringify(p); }],
    ["changed version", (m) => { m.packages[0].version = "2.0.0"; }],
    ["archive path escape", (m) => { m.packages[0].archive = "../one.tgz"; }],
    ["changed archive bytes", (m) => { m.packages[0].sha256 = "b".repeat(64); }],
    ["omitted prepublish guard", (m) => { m.prepublishOnly.pop(); }],
  ]) await check(`publication refuses ${name}`, () => { const copy = structuredClone(manifest); mutate(copy); assert.throws(() => coldPublicationInputs(copy, rows, source, root)); });
  const calls = [];
  const options = { root, directory: root, results: root, env: { RELEASE_REQUESTED_AT: new Date().toISOString() }, exec: (file, args) => {
    assert.equal(file, "git"); assert.deepEqual(args, ["rev-parse", "HEAD"]); return source + "\n";
  }, publish: async (file, args, { timeout }) => {
    assert.equal(file, "pnpm"); assert(timeout > 0 && timeout <= 180_000); calls.push(args);
  }, preflight: async () => ({ state: "ready", rows }) };
  await check("secure preflight refusal prevents every publication", async () => {
    await assert.rejects(() => publishColdCandidate({ ...options, preflight: async ({ tag }) => { assert.equal(tag, "latest"); throw new Error("fixture authority refusal"); } }), /fixture authority refusal/);
    assert.equal(calls.length, 0);
  });
  await check("publisher sends only qualified archive paths with provenance and no hooks", async () => {
    assert.equal((await publishColdCandidate(options)).length, 2);
    assert.deepEqual(calls, manifest.packages.map((pkg) => ["publish", join(root, pkg.archive), "--provenance", "--access=public", "--no-git-checks", "--ignore-scripts", "--tag", "latest"]));
  });
  calls.length = 0;
  await check("all-present secure preflight remains a no-op", async () => {
    assert.deepEqual(await publishColdCandidate({ ...options, preflight: async () => ({ state: "nothing-to-publish", rows }) }), []);
    assert.equal(calls.length, 0);
  });
  const last = join(root, "two.tgz"), originalArchive = readFileSync(last);
  await check("a corrupt last archive prevents even the first publication", async () => {
    writeFileSync(last, "corrupt synthetic archive");
    try { await assert.rejects(() => publishColdCandidate(options), /publication archive differs from qualified bytes/); assert.equal(calls.length, 0); }
    finally { writeFileSync(last, originalArchive); }
  });
  await check("archive changes between writes prevent the changed publication", async () => {
    try {
      await assert.rejects(() => publishColdCandidate({ ...options, concurrency: 1, publish: async (file, args, opts) => {
        await options.publish(file, args, opts);
        writeFileSync(last, "changed during synthetic first write");
      } }), /publication archive changed after preflight/);
      assert.equal(calls.length, 1);
    } finally { writeFileSync(last, originalArchive); calls.length = 0; }
  });
  await check("parallel archive uploads settle before completion and retain accepted outcomes", async () => {
    const receiptFile = join(root, "accepted.json");
    let active = 0, peak = 0;
    await publishColdCandidate({ ...options, receiptFile, publish: async () => {
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setTimeout(resolve, 20)); active--;
    } });
    assert.equal(peak, 2); assert.equal(active, 0);
    const receipt = JSON.parse(readFileSync(receiptFile, "utf8"));
    assert.equal(receipt.complete, true);
    assert.deepEqual(receipt.packages.map(({ state }) => state), ["accepted", "accepted"]);
    await assert.rejects(() => publishColdCandidate({ ...options, receiptFile }), /overwrite an existing publication receipt/);
  });
  await check("a failed upload records uncertainty and settles admitted siblings", async () => {
    const receiptFile = join(root, "partial.json");
    let settled = false;
    await assert.rejects(() => publishColdCandidate({ ...options, receiptFile, publish: async (_, args) => {
      if (args[1].endsWith("one.tgz")) throw new Error("synthetic upload refusal");
      await new Promise((resolve) => setTimeout(resolve, 20)); settled = true;
    } }), /synthetic upload refusal/);
    assert(settled);
    const receipt = JSON.parse(readFileSync(receiptFile, "utf8"));
    assert.equal(receipt.complete, false);
    assert.deepEqual(receipt.packages.map(({ state }) => state), ["unknown", "accepted"]);
  });
  await check("expired publication requests reach neither preflight nor uploads", async () => {
    await assert.rejects(() => publishColdCandidate({ ...options, env: { RELEASE_REQUESTED_AT: new Date(Date.now() - 600_001).toISOString() }, preflight: assert.fail }), /ten-minute deadline/);
  });
  const qualifiedDirectory = join(root, "cold-qualified"); mkdirSync(qualifiedDirectory);
  const tree = "c".repeat(40), main = "d".repeat(40), head = "e".repeat(40);
  const before = new Date(Date.now() - 2_000).toISOString();
  const qualificationEnv = { GITHUB_SHA: source, GITHUB_REPOSITORY: "Cotal-AI/Cotal", GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1" };
  recordQualification({ root, directory: root, results: root, output: join(qualifiedDirectory, "qualification.json"), env: qualificationEnv,
    exec: (_, args) => args[1] === "HEAD" ? source : tree });
  const apiRun = { id: 123, path: ".github/workflows/cold-setup.yml", event: "pull_request", head_sha: head, run_attempt: 1, status: "completed", conclusion: "success", repository: { full_name: "Cotal-AI/Cotal" }, head_repository: { full_name: "Cotal-AI/Cotal" }, updated_at: before };
  const artifactRows = ["cold-candidate", "cold-qualified", ...coldResultNames()].map((name, index) => ({ id: index + 1, name, digest: "sha256:" + "f".repeat(64), expired: false, created_at: before, workflow_run: { id: 123, head_sha: head } }));
  const promotionEnv = { ...options.env, GITHUB_SHA: main, GITHUB_RUN_ID: "456", GITHUB_REPOSITORY: "Cotal-AI/Cotal", GITHUB_REF: "refs/heads/main", GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_RUN_ATTEMPT: "1", GH_TOKEN: "synthetic-not-a-credential", RELEASE_VERSION: "1.0.0", RELEASE_TAG: "latest", RELEASE_SOURCE: main, RELEASE_CANDIDATE_SHA256: sha(bytes), RELEASE_QUALIFICATION_RUN: "123" };
  const publicationRun = { id: 456, run_number: 1, run_attempt: 1, path: ".github/workflows/changesets.yml", event: "workflow_dispatch", head_sha: main, head_branch: "main", repository: { full_name: "Cotal-AI/Cotal" }, head_repository: { full_name: "Cotal-AI/Cotal" }, created_at: promotionEnv.RELEASE_REQUESTED_AT, display_title: `publication-v1 1.0.0 ${promotionEnv.RELEASE_CANDIDATE_SHA256} ${main} 123 latest ${promotionEnv.RELEASE_REQUESTED_AT}` };
  const certificateResult = () => JSON.stringify([{ verificationResult: { signature: { certificate: { runInvocationURI: "https://github.com/Cotal-AI/Cotal/actions/runs/123/attempts/1" } } } }]);
  const fetchImpl = async (url) => ({ status: 200, json: async () => url.includes("/actions/workflows/changesets.yml/runs?") ? { total_count: 1, workflow_runs: [publicationRun] }
    : url.endsWith("/actions/runs/456") ? publicationRun : url.includes("/git/commits/") ? { sha: source, tree: { sha: tree }, parents: [{ sha: "f".repeat(40) }, { sha: head }] } : url.includes("/artifacts?") ? { total_count: artifactRows.length, artifacts: artifactRows } : apiRun });
  const selectionFile = join(root, "selection.json");
  const selection = await selectQualification({ runId: 123, env: promotionEnv, deadline: Date.now() + 10_000, fetchImpl });
  writeFileSync(selectionFile, JSON.stringify(selection));
  // Use the same layout that download-artifact produces, without moving the synthetic candidate.
  const candidateDirectory = join(root, "cold-candidate"); mkdirSync(candidateDirectory);
  writeFileSync(join(candidateDirectory, "manifest.json"), bytes);
  writeFileSync(join(candidateDirectory, "qualification.sigstore.json"), "synthetic signature fixture; not cryptographic evidence");
  const promotionOptions = { root, directory: candidateDirectory, results: root, selectionFile, tag: "latest", env: promotionEnv, deadline: Date.now() + 10_000, fetchImpl,
    exec: (file, args) => file === "gh" ? certificateResult() : args[1] === "HEAD" ? main : tree };
  await check("same-tree promotion retains the original PR merge and native source", async () => {
    const qualified = await verifyQualification(promotionOptions);
    assert.equal(qualified.source, source); assert.equal(qualified.promotionSource, main);
    assert.equal(qualified.artifacts.length, 20);
  });
  await check("the real publisher reaches same-tree promotion without relabelling its archives", async () => {
    for (const pkg of manifest.packages) writeFileSync(join(candidateDirectory, pkg.archive), readFileSync(join(root, pkg.archive)));
    const uploaded = [];
    const result = await publishColdCandidate({ ...options, ...promotionOptions, publish: async (_, args) => { uploaded.push(args[1]); } });
    assert.equal(result.length, 2);
    assert.deepEqual(uploaded, manifest.packages.map(({ archive }) => join(candidateDirectory, archive)));
    assert.equal(JSON.parse(readFileSync(join(candidateDirectory, "manifest.json"), "utf8")).source, source);
  });
  await check("an unverified build certificate prevents preflight and every publication", async () => {
    await assert.rejects(() => publishColdCandidate({ ...options, ...promotionOptions,
      preflight: async () => assert.fail("must not preflight an unverified build"), publish: async () => assert.fail("must not publish an unverified build"),
      exec: (file, args, settings) => {
        if (file === "gh") throw Object.assign(new Error("synthetic certificate covers another executed source"), { status: 1 });
        return promotionOptions.exec(file, args, settings);
      },
    }), /build attestation verification failed/);
  });
  await check("a predicate cannot substitute for the certificate's actual producing run", async () => {
    await assert.rejects(() => publishColdCandidate({ ...options, ...promotionOptions,
      preflight: async () => assert.fail("must not preflight a foreign producing run"), publish: async () => assert.fail("must not publish a foreign producing run"),
      exec: (file, args, settings) => file === "gh" ? JSON.stringify([{ verificationResult: { signature: { certificate: { runInvocationURI: "https://github.com/Cotal-AI/Cotal/actions/runs/999/attempts/1" } }, statement: { predicate: { runInvocationURI: "https://github.com/Cotal-AI/Cotal/actions/runs/123/attempts/1" } } } }]) : promotionOptions.exec(file, args, settings),
    }), /certificate belongs to another run or attempt/);
  });
  await check("publication inputs cannot detach the original clock from their server record", async () => {
    await assert.rejects(() => publishColdCandidate({ ...options, ...promotionOptions, env: { ...promotionEnv, RELEASE_REQUESTED_AT: new Date(Date.parse(promotionEnv.RELEASE_REQUESTED_AT) + 1).toISOString() },
      preflight: async () => assert.fail("must not preflight changed request inputs"), publish: async () => assert.fail("must not publish changed request inputs"),
    }), /inputs differ from their server request record/);
  });
  const publisherRoot = join(root, "publisher-controls"), advancedHead = "f".repeat(40);
  const advancedEnv = { ...promotionEnv, GITHUB_SHA: advancedHead };
  const advancedExec = (file, args, opts) => {
    if (file === "gh") return certificateResult();
    assert.equal(file, "git");
    if (args[0] === "rev-list") {
      assert.equal(opts.cwd, publisherRoot);
      assert.deepEqual(args, ["rev-list", "--first-parent", `${main}^..${advancedHead}`]);
      return `${advancedHead}\n${main}\n`;
    }
    assert.equal(args[0], "rev-parse");
    return args[1] === "HEAD^{tree}" ? tree : opts.cwd === publisherRoot ? advancedHead : main;
  };
  await check("main can advance without changing the frozen release source or archives", async () => {
    const receiptFile = join(root, "advanced-main-publication.json");
    publicationRun.head_sha = advancedHead;
    let result;
    try { result = await publishColdCandidate({ ...options, ...promotionOptions, publisherRoot, env: advancedEnv, exec: advancedExec, receiptFile, publish: async () => {} }); }
    finally { publicationRun.head_sha = main; }
    assert.equal(result.length, 2);
    const receipt = JSON.parse(readFileSync(receiptFile, "utf8"));
    assert.equal(receipt.source, source); assert.equal(receipt.promotionSource, main); assert.equal(receipt.publisherSource, advancedHead);
    assert.equal(receipt.qualification.sourceTree, tree);
  });
  await check("a publication rerun refuses before inspecting authority or starting another write", async () => {
    await assert.rejects(() => verifyQualification({ ...promotionOptions, env: { ...promotionEnv, GITHUB_RUN_ATTEMPT: "2" }, fetchImpl: async () => { assert.fail("must not start a new qualification or authority read"); } }), /reruns cannot retry unknown writes/);
  });
  await check("a merged side-branch head is not accepted as a first-parent main source", async () => {
    await assert.rejects(() => verifyQualification({ ...promotionOptions, publisherRoot, env: advancedEnv,
      exec: (file, args, opts) => args[0] === "rev-list" ? advancedHead : advancedExec(file, args, opts),
      fetchImpl: async () => { assert.fail("must refuse before GitHub or registry work"); },
    }), /not a first-parent main commit/);
  });
  await check("release checkout requests only its owned detached worktree and refuses an existing target", () => {
    const runner = join(root, "owned-runner");
    const target = join(runner, "release-source");
    const env = { ...advancedEnv, RUNNER_TEMP: runner, RELEASE_ROOT: target };
    const requested = [];
    const exec = (file, args, opts) => {
      if (args[0] === "worktree") { requested.push(args); return ""; }
      return advancedExec(file, args, opts);
    };
    assert.equal(checkoutReleaseSource({ publisherRoot, env, exec, deadline: Date.now() + 10_000 }), target);
    assert.deepEqual(requested, [["worktree", "add", "--detach", target, main]]);
    mkdirSync(target, { recursive: true });
    assert.throws(() => checkoutReleaseSource({ publisherRoot, env, exec, deadline: Date.now() + 10_000 }), /overwrite/);
    assert.equal(requested.length, 1);
  });
  for (const [name, change] of [
    ["another repository", (run) => { run.repository.full_name = "foreign/repo"; }],
    ["a fork", (run) => { run.head_repository.full_name = "foreign/repo"; }],
    ["another workflow", (run) => { run.path = ".github/workflows/other.yml"; }],
    ["an unfinished qualification", (run) => { run.status = "in_progress"; }],
    ["a partial rerun", (run) => { run.run_attempt = 2; }],
    ["qualification after publish-go", (run) => { run.updated_at = new Date(Date.now() + 60_000).toISOString(); }],
  ]) await check(`promotion refuses ${name}`, async () => {
    const original = structuredClone(apiRun);
    try { change(apiRun); await assert.rejects(() => verifyQualification(promotionOptions)); }
    finally { Object.assign(apiRun, original); }
  });
  await check("promotion refuses a forged tree claim even with matching manifests", async () => {
    await assert.rejects(() => verifyQualification({ ...promotionOptions, exec: (_, args) => args[1] === "HEAD" ? main : "f".repeat(40) }), /source tree differs/);
  });
  await check("promotion refuses an expired artifact and an incomplete immutable selection", async () => {
    artifactRows[0].expired = true;
    try { await assert.rejects(() => verifyQualification(promotionOptions), /expired/); }
    finally { artifactRows[0].expired = false; }
    const removed = artifactRows.pop();
    try { await assert.rejects(() => verifyQualification(promotionOptions), /needs one immutable/); }
    finally { artifactRows.push(removed); }
  });
  await check("the binary starts last and never starts after a sibling upload fails", async () => {
    const path = join(root, "binary"); mkdirSync(path);
    const pkg = { name: "cotal-ai", version: "1.0.0" };
    writeFileSync(join(path, "package.json"), JSON.stringify(pkg));
    const archive = "cotal-ai.tgz", archiveBytes = Buffer.from("synthetic binary archive");
    writeFileSync(join(root, archive), archiveBytes);
    const binary = { ...pkg, sourceManifest: JSON.stringify(pkg), archive, sha256: sha(archiveBytes) };
    const preparedBytes = JSON.stringify({ ...manifest, packages: [binary, ...manifest.packages] });
    const saved = coldResultNames().map((name) => {
      const file = join(root, name, "cold-result.json");
      const original = readFileSync(file);
      writeFileSync(file, JSON.stringify({ ...JSON.parse(original), candidateSha256: sha(preparedBytes) }));
      return [file, original];
    });
    writeFileSync(join(root, "manifest.json"), preparedBytes);
    const preflight = async () => ({ state: "ready", rows: [{ ...pkg, path }, ...rows] });
    try {
      let settled = 0, binaryStarted = false;
      const publish = async (_, args) => {
        if (args[1].endsWith(archive)) { assert.equal(settled, 2); binaryStarted = true; return; }
        await new Promise((resolve) => setTimeout(resolve, 10)); settled++;
      };
      await publishColdCandidate({ ...options, preflight, publish });
      assert(binaryStarted); binaryStarted = false;
      await assert.rejects(() => publishColdCandidate({ ...options, preflight, publish: async (file, args, opts) => {
        if (args[1].endsWith("one.tgz")) throw new Error("synthetic sibling refusal");
        return publish(file, args, opts);
      } }), /synthetic sibling refusal/);
      assert.equal(binaryStarted, false);
    } finally {
      writeFileSync(join(root, "manifest.json"), bytes);
      for (const [file, original] of saved) writeFileSync(file, original);
    }
  });
  await check("missing native receipt prevents preflight and publication", async () => {
    const receipt = readFileSync(firstReceipt); rmSync(firstReceipt);
    try { await assert.rejects(() => publishColdCandidate({ ...options, preflight: async () => { assert.fail("must not preflight an unqualified candidate"); } }), /ENOENT/); assert.equal(calls.length, 0); }
    finally { writeFileSync(firstReceipt, receipt); }
  });
} finally { rmSync(root, { recursive: true, force: true }); }
console.log(`COLD PUBLICATION CONTRACT OK (${passed} checks; synthetic fixtures only)`);
console.log(`SUITE COMPLETE: ${passed} passed, 0 failed`);
