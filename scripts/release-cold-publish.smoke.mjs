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
  const options = { root, directory: root, results: root, env: {}, exec: (file, args) => {
    if (file === "git") { assert.deepEqual(args, ["rev-parse", "HEAD"]); return source + "\n"; }
    assert.equal(file, "pnpm"); calls.push(args);
  }, preflight: async () => ({ state: "ready", rows }) };
  await check("secure preflight refusal prevents every publication", async () => {
    await assert.rejects(() => publishColdCandidate({ ...options, preflight: async () => { throw new Error("fixture authority refusal"); } }), /fixture authority refusal/);
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
      await assert.rejects(() => publishColdCandidate({ ...options, exec: (file, args) => {
        const result = options.exec(file, args);
        if (file === "pnpm") writeFileSync(last, "changed during synthetic first write");
        return result;
      } }), /publication archive changed after preflight/);
      assert.equal(calls.length, 1);
    } finally { writeFileSync(last, originalArchive); calls.length = 0; }
  });
  await check("missing native receipt prevents preflight and publication", async () => {
    const receipt = readFileSync(firstReceipt); rmSync(firstReceipt);
    try { await assert.rejects(() => publishColdCandidate({ ...options, preflight: async () => { assert.fail("must not preflight an unqualified candidate"); } }), /ENOENT/); assert.equal(calls.length, 0); }
    finally { writeFileSync(firstReceipt, receipt); }
  });
} finally { rmSync(root, { recursive: true, force: true }); }
console.log(`COLD PUBLICATION CONTRACT OK (${passed} checks; synthetic fixtures only)`);
console.log(`SUITE COMPLETE: ${passed} passed, 0 failed`);
