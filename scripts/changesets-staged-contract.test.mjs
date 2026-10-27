import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { test } from "node:test";

const root = join(import.meta.dirname, "..");
const cli = join(root, "node_modules/@changesets/cli/bin.js");

test("unmodified installed Changesets packs staged schema and carries its tag to the publish boundary", () => {
  const scratch = mkdtempSync(join(tmpdir(), "changesets-staged-contract-"));
  try {
    writeFileSync(join(scratch, "package.json"), JSON.stringify({ name: "synthetic-root", private: true, packageManager: "pnpm@11.28.2", type: "commonjs" }));
    writeFileSync(join(scratch, "pnpm-workspace.yaml"), 'packages:\n  - packages/*\n');
    mkdirSync(join(scratch, ".changeset"));
    writeFileSync(join(scratch, ".changeset/config.json"), JSON.stringify({ fixed: [["synthetic-staging-contract"]], access: "public", baseBranch: "main" }));
    const pkg = join(scratch, "packages/one"); mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "synthetic-staging-contract", version: "1.2.3", files: ["index.js"] }));
    writeFileSync(join(pkg, "index.js"), "module.exports = 1;\n");
    const input = join(scratch, "publish-plan.json"), packed = join(scratch, "packed");
    writeFileSync(input, JSON.stringify({ version: 1, plan: [[{ kind: "publish", name: "synthetic-staging-contract", version: "1.2.3", access: "public", tag: "cotal-staged" }]] }));
    const env = { PATH: process.env.PATH, HOME: scratch, TMPDIR: scratch, DO_NOT_TRACK: "1", npm_config_provenance: "false" };
    const pack = spawnSync(process.execPath, [cli, "pack", "--from-publish-plan", input, "--out-dir", packed], { cwd: scratch, env, encoding: "utf8", timeout: 15_000 });
    assert.equal(pack.status, 0, pack.stderr + pack.stdout);
    const document = JSON.parse(readFileSync(join(packed, "publish-plan.json"), "utf8"));
    assert.equal(document.plan[0][0].tag, "cotal-staged");
    assert.match(document.plan[0][0].tarball.integrity, /^sha256-/);
    const bin = join(scratch, "intercept"); mkdirSync(bin);
    const capture = join(scratch, "publish-args.json");
    // The standard Changesets process is unchanged. Only the write boundary is intercepted and
    // deliberately refused. Nothing reaches npm or receives a real credential.
    writeFileSync(join(bin, "pnpm"), `#!${process.execPath}\nconst fs=require("node:fs");const args=process.argv.slice(2);if(args[0]==="--version"){console.log("11.28.2");process.exit(0)}fs.writeFileSync(${JSON.stringify(capture)},JSON.stringify(args));console.log(JSON.stringify({error:{code:"ERR_PNPM_FETCH_403",message:"synthetic write boundary refused"}}));process.exit(1);\n`, { mode: 0o755 });
    const publish = spawnSync(process.execPath, [cli, "publish", "--from-pack-dir", packed, "--no-git-tag"], { cwd: scratch, env: { ...env, PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin` }, encoding: "utf8", timeout: 10_000 });
    assert.equal(publish.status, 1, publish.stderr + publish.stdout);
    const args = JSON.parse(readFileSync(capture, "utf8"));
    assert.equal(args[0], "publish");
    assert.equal(args[args.indexOf("--tag") + 1], "cotal-staged");
    assert(args.some((arg) => arg.endsWith(".tgz")));
    assert.match(publish.stdout + publish.stderr, /synthetic write boundary refused/);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
