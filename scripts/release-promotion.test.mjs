import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { coldOsEnvironment } from "./release-cold-environment.mjs";
import { verifyPromotedArchives } from "./verify-promoted-archives.mjs";
import { recordPublicationOutcome } from "./record-publication-outcome.mjs";
import { preflightNpmPublish } from "./preflight-npm-publish.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const workspace = join(import.meta.dirname, "..");

test("real install-check entrypoint isolates two synthetic operator environments", { skip: process.platform === "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "release-private-install-"));
  try {
    const bin = join(root, "bin"); mkdirSync(bin);
    const capture = join(root, "captured.json");
    const cliCapture = join(root, "cli.json");
    writeFileSync(join(bin, "npm"), `#!${process.execPath}\n` + `
const fs = require("node:fs"), path = require("node:path");
const env = process.env;
fs.appendFileSync(${JSON.stringify(capture)}, JSON.stringify({
  home: env.HOME, cwd: process.cwd(), token: Boolean(env.GITHUB_TOKEN), preferOnline: process.argv.includes("--prefer-online"), specs: process.argv.filter(arg => /@1\.2\.3$/.test(arg)),
  operatorState: (env.COTAL_HOME || "").includes("synthetic-operator"),
  privatePaths: ["USERPROFILE", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "COTAL_HOME", "CLAUDE_CONFIG_DIR", "TMPDIR", "TMP", "TEMP", "npm_config_userconfig", "npm_config_globalconfig", "npm_config_cache"].every(key => env[key] === env.HOME || env[key]?.startsWith(env.HOME + path.sep)),
  emptyConfigs: [env.npm_config_userconfig, env.npm_config_globalconfig].every(file => fs.readFileSync(file, "utf8") === "")
})+"\\n");
const prefix = process.argv[process.argv.indexOf("--prefix") + 1];
fs.mkdirSync(path.join(prefix, "bin"), { recursive: true });
fs.writeFileSync(path.join(prefix, "bin", "cotal"), ${JSON.stringify(`#!${process.execPath}\nrequire("node:fs").appendFileSync(${JSON.stringify(cliCapture)}, JSON.stringify({ args: process.argv.slice(2), home: process.env.HOME, registry: process.env.npm_config_registry }) + "\\n");\nprocess.stdout.write("cotal-ai 1.2.3\\n");\n`)}, { mode: 0o755 });
`, { mode: 0o755 });
    for (const session of ["first", "second", "late"]) {
      const flags = session === "late" ? [`--requested-at=${new Date(Date.now() - 3_600_000).toISOString()}`] : [];
      writeFileSync(capture, ""); writeFileSync(cliCapture, "");
      const output = execFileSync(process.execPath, [join(import.meta.dirname, "verify-release-installable.mjs"), "1.2.3", "--deadline-ms=5000", "--closure", ...flags], {
        cwd: workspace, encoding: "utf8", timeout: 10_000,
        env: { ...coldOsEnvironment(), PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: join(root, session), GITHUB_TOKEN: "synthetic-not-a-credential", COTAL_HOME: join(root, "synthetic-operator", session), ...(session === "late" ? { RELEASE_ATTEMPT_STARTED_AT: new Date().toISOString() } : {}) },
      });
      assert.match(output, /VERDICT: INSTALLABLE/);
      const captures = readFileSync(capture, "utf8").trim().split("\n").map(line => JSON.parse(line));
      assert.equal(captures.length, 2);
      const captured = captures.at(-1);
      assert.equal(captured.token, false); assert.equal(captured.operatorState, false);
      assert.equal(captured.preferOnline, true, "registry install must request packument revalidation");
      const fixed = JSON.parse(readFileSync(join(workspace, ".changeset/config.json"), "utf8")).fixed.flat().sort();
      assert.deepEqual(captures[0].specs.sort(), fixed.map(name => `${name}@1.2.3`), "every fixed sibling must resolve through npm");
      assert.deepEqual(captured.specs, ["cotal-ai@1.2.3"], "global CLI install must retain its supported dependency layout");
      assert.equal(captured.privatePaths, true); assert.equal(captured.emptyConfigs, true);
      assert.equal(captured.cwd, captured.home);
      assert.equal(existsSync(captured.home), false, "successful install probe must clean its private scratch root");
      const cli = readFileSync(cliCapture, "utf8").trim().split("\n").map(line => JSON.parse(line));
      assert.deepEqual(cli.map(call => call.args), [["--version"], ["ext", "seed"]], "the installed CLI must seed its connectors after reporting its version");
      assert(cli.every(call => call.home === captured.home), "the seed must run in the private installation home");
      assert.equal(cli[1].registry, "https://registry.npmjs.org/", "the seed must read the verified registry");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a version whose connector seed fails is not installable", { skip: process.platform === "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "release-seed-refused-"));
  try {
    const bin = join(root, "bin"); mkdirSync(bin);
    const cotal = `#!${process.execPath}\nif (process.argv[2] === "ext") { process.stderr.write("✗ failed to seed connector \\"claude\\": failed to import: Class2 is not a constructor\\n"); process.exit(1); }\nprocess.stdout.write("cotal-ai 1.2.3\\n");\n`;
    writeFileSync(join(bin, "npm"), `#!${process.execPath}\nconst fs = require("node:fs"), path = require("node:path");\nconst prefix = process.argv[process.argv.indexOf("--prefix") + 1];\nfs.mkdirSync(path.join(prefix, "bin"), { recursive: true });\nfs.writeFileSync(path.join(prefix, "bin", "cotal"), ${JSON.stringify(cotal)}, { mode: 0o755 });\n`, { mode: 0o755 });
    let failure;
    try {
      execFileSync(process.execPath, [join(import.meta.dirname, "verify-release-installable.mjs"), "1.2.3", "--deadline-ms=1500", "--poll-interval-ms=100"], {
        cwd: workspace, encoding: "utf8", timeout: 10_000, stdio: "pipe",
        env: { ...coldOsEnvironment(), PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: root },
      });
    } catch (error) { failure = error; }
    assert.equal(failure?.status, 1);
    assert.match(failure.stdout, /attempt 1: cotal ext seed exited 1: ✗ failed to seed connector "claude": failed to import: Class2 is not a constructor/);
    assert.match(failure.stdout, /VERDICT: NOT INSTALLABLE/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("real install timeout settles its live descendant before scratch cleanup", { skip: process.platform === "win32" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "release-install-custody-"));
  const bin = join(root, "bin"); mkdirSync(bin);
  const ready = join(root, "ready"), late = join(root, "late-write");
  const descendant = `const fs = require("node:fs"); fs.writeFileSync(${JSON.stringify(ready)}, process.env.HOME); setTimeout(() => fs.writeFileSync(${JSON.stringify(late)}, "unwanted write after install timeout"), 2_000);`;
  writeFileSync(join(bin, "npm"), `#!${process.execPath}\nrequire("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: "ignore" }); setInterval(() => {}, 1_000);\n`, { mode: 0o755 });
  try {
    let status;
    try {
      execFileSync(process.execPath, [join(import.meta.dirname, "verify-release-installable.mjs"), "1.2.3", "--deadline-ms=1000"], {
        cwd: workspace, timeout: 5_000, stdio: "pipe",
        env: { ...coldOsEnvironment(), PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: root },
      });
    } catch (error) { status = error.status; }
    await new Promise((resolve) => setTimeout(resolve, 2_100));
    assert.equal(status, 1); assert(existsSync(ready), "owned descendant must have started");
    assert.equal(existsSync(late), false, "npm descendant continued after the install gate returned");
    assert.equal(existsSync(readFileSync(ready, "utf8")), false, "settled private scratch root was not removed");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("real registry reads bind every version, archive, integrity and dist-tag", async () => {
  const root = mkdtempSync(join(tmpdir(), "release-registry-"));
  const packages = ["one", "two"].map((name) => {
    const bytes = Buffer.from(`synthetic qualified archive ${name}`);
    writeFileSync(join(root, `${name}.tgz`), bytes);
    return { name, version: "1.2.3", archive: `${name}.tgz`, sha256: sha(bytes), bytes, integrity: "sha512-" + createHash("sha512").update(bytes).digest("base64") };
  });
  mkdirSync(join(root, ".changeset"));
  writeFileSync(join(root, ".changeset/config.json"), JSON.stringify({ fixed: [["one", "two"]] }));
  const manifest = JSON.stringify({ packages: packages.map(({ bytes, integrity, ...pkg }) => pkg) });
  const manifestFile = join(root, "manifest.json"); writeFileSync(manifestFile, manifest);
  let registry, mode = "ready", reads = 0;
  const server = createServer((request, response) => {
    reads++;
    const pkg = packages.find(({ name }) => request.url.includes(name));
    if (!pkg || mode === "missing") { response.writeHead(404); response.end(); return; }
    if (request.url.endsWith(".tgz")) { response.end(mode === "wrong-bytes" ? "corrupt" : pkg.bytes); return; }
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(request.url.endsWith("dist-tags")
      ? { latest: mode === "old-tag" ? "1.2.2" : pkg.version }
      : { name: pkg.name, version: pkg.version, dist: { tarball: `${registry}/${pkg.archive}`, integrity: mode === "wrong-integrity" ? "sha512-wrong" : pkg.integrity } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  registry = `http://127.0.0.1:${server.address().port}`;
  const options = { root, manifestFile, registry, expectedSha256: sha(manifest), tag: "latest", pollIntervalMs: 5, log: () => {} };
  try {
    const receipt = await verifyPromotedArchives({ ...options, requestedAt: new Date().toISOString() });
    assert.equal(receipt.complete, true); assert.equal(receipt.withinPublicationBudget, true);
    assert.equal(receipt.packages.length, 2); assert.equal(reads, 6);
    for (mode of ["missing", "old-tag"]) {
      await assert.rejects(() => verifyPromotedArchives({ ...options, requestedAt: new Date(Date.now() - 599_800).toISOString() }), /execution deadline/);
    }
    for (mode of ["wrong-bytes", "wrong-integrity"]) {
      await assert.rejects(() => verifyPromotedArchives({ ...options, requestedAt: new Date().toISOString() }), (error) => error.code === "ERR_RELEASE_ARTIFACT");
    }
    mode = "ready";
    const late = await verifyPromotedArchives({ ...options, requestedAt: new Date(Date.now() - 601_000).toISOString(), attemptStartedAt: new Date().toISOString() });
    assert.equal(late.complete, true); assert.equal(late.withinPublicationBudget, false); assert.equal(late.recheck, false);
    const recovery = await verifyPromotedArchives({ ...options, requestedAt: new Date(Date.now() - 601_000).toISOString(), recheck: true });
    assert.equal(recovery.complete, true); assert.equal(recovery.withinPublicationBudget, false); assert.equal(recovery.recheck, true);
    await assert.rejects(() => verifyPromotedArchives({ ...options, requestedAt: new Date().toISOString(), expectedSha256: "f".repeat(64) }), /another candidate/);
  } finally {
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});

test("live preflight bounds concurrency and waits for the whole census before authorization", async () => {
  const packages = Array.from({ length: 8 }, (_, index) => ({ name: `pkg${index}`, version: "1.0.0", path: "/synthetic" }));
  const claims = { repository: "Cotal-AI/Cotal", workflow_ref: "Cotal-AI/Cotal/.github/workflows/changesets.yml@refs/heads/main", ref: "refs/heads/main", event_name: "workflow_dispatch", environment: "npm-publish", aud: "npm:registry.npmjs.org", jti: "synthetic-id" };
  const token = `synthetic.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.not-a-signature`;
  let active = 0, peak = 0, census = 0, earlyAuthorization = false, stalled = false, aborted = false, authorizations = 0;
  let currentTag = "2.0.0";
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (/^\/pkg\d(?:\/1\.0\.0)?$/.test(request.url)) {
      peak = Math.max(peak, ++active);
      setTimeout(() => {
        active--; census++;
        response.writeHead(request.url.endsWith("/1.0.0") ? 404 : 200); response.end("{}");
      }, 30);
      return;
    }
    if (request.url.endsWith("/dist-tags")) { response.end(JSON.stringify({ latest: currentTag })); return; }
    if (request.url.startsWith("/oidc")) {
      authorizations++;
      if (census !== 16) earlyAuthorization = true;
      if (stalled) { response.writeHead(200); response.write('{"value":'); response.on("close", () => { aborted = true; }); }
      else response.end(JSON.stringify({ value: token }));
    } else if (request.url.endsWith("/trust")) { response.writeHead(401); response.end("{}"); }
    else if (request.method === "POST" && request.url.includes("/oidc/token/exchange/package/")) { response.writeHead(201); response.end(JSON.stringify({ token: "synthetic-not-a-credential" })); }
    else { response.writeHead(500); response.end("{}"); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const registryBase = `http://127.0.0.1:${server.address().port}`;
  const env = { GITHUB_REPOSITORY: claims.repository, GITHUB_REF: claims.ref, GITHUB_EVENT_NAME: claims.event_name, ACTIONS_ID_TOKEN_REQUEST_URL: `${registryBase}/oidc`, ACTIONS_ID_TOKEN_REQUEST_TOKEN: "synthetic-not-a-credential" };
  const options = { fixedPackages: packages.map(({ name }) => name), workspacePackages: packages, registryBase, env, concurrency: 2, log: () => {} };
  try {
    assert.equal((await preflightNpmPublish({ ...options, deadline: Date.now() + 3_000 })).state, "ready");
    assert.equal(peak, 4); assert.equal(earlyAuthorization, false);
    census = 0; authorizations = 0;
    await assert.rejects(() => preflightNpmPublish({ ...options, tag: "latest", deadline: Date.now() + 3_000 }), /move latest backwards/);
    assert.equal(authorizations, 0, "a stale prepared version must refuse before authorization or writes");
    census = 0; currentTag = "0.9.0";
    assert.equal((await preflightNpmPublish({ ...options, tag: "latest", deadline: Date.now() + 3_000 })).state, "ready");
    census = 0; stalled = true;
    const started = Date.now();
    await assert.rejects(() => preflightNpmPublish({ ...options, deadline: Date.now() + 300 }), /OIDC exchange refused/);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert(aborted); assert(Date.now() - started < 2_000);
    assert.equal(earlyAuthorization, false);
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});

test("recorded outcomes never turn accepted uploads or late recovery into a timely publication", () => {
  const root = mkdtempSync(join(tmpdir(), "release-outcome-"));
  const publicationFile = join(root, "publication.json"), archivesFile = join(root, "archives.json");
  const requestedAt = "2026-10-22T00:00:00Z", candidate = "a".repeat(64);
  writeFileSync(publicationFile, JSON.stringify({ complete: true, candidateSha256: candidate, packages: [{ state: "accepted" }] }));
  const env = { RELEASE_REQUESTED_AT: requestedAt, RELEASE_CANDIDATE_SHA256: candidate, RELEASE_SOURCE: "b".repeat(40), INSTALL_OK: "true" };
  const record = (name, now, extra = {}) => recordPublicationOutcome({ publicationFile, archivesFile, output: join(root, name + ".json"), now: Date.parse(requestedAt) + now, env: { ...env, ...extra } });
  try {
    assert.equal(record("uploads-only", 1_000).available, false);
    writeFileSync(archivesFile, JSON.stringify({ complete: true, candidateSha256: candidate, requestedAt }));
    assert.equal(record("not-installed", 2_000, { INSTALL_OK: "" }).available, false);
    assert.equal(record("on-time", 3_000).withinPublicationBudget, true);
    const late = record("late", 601_000);
    assert.equal(late.available, true); assert.equal(late.withinPublicationBudget, false);
    assert.equal(late.elapsedMs, 601_000);
    const output = join(root, "late-cli.json");
    const cli = execFileSync(process.execPath, [join(import.meta.dirname, "record-publication-outcome.mjs"), publicationFile, archivesFile, output], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    assert.match(cli, /availability verified=true; within original ten-minute budget=false/);
    const recorded = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(recorded.available, true);
    assert.equal(recorded.withinPublicationBudget, false);
    assert.equal(recorded.requestedAt, requestedAt);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
