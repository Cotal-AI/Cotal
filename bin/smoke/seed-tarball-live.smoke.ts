/**
 * LIVE published-path smoke for built-in-connector seeding. Packs the REAL `cotal-ai` closure
 * (pnpm pack, which replaces `workspace:*` with concrete versions), installs it into a clean npm
 * prefix with no repo on the resolution path, and proves the PUBLISHED seed path:
 *
 *  - the `cotal-ai` tarball ships the `seeded-connectors/<name>` payloads (prepack) with concrete deps
 *  - explicit reconciliation on the installed binary seeds the built-ins from those bundled payloads
 *    (`shippedSourceDir` published branch), installing each from the durable store under the isolated
 *    config (never a repo path). Driven through the `.bin/cotal` SYMLINK npm publishes, the way a user
 *    reaches an installed binary: `process.argv[1]` is then the link, whose parents hold no
 *    `package.json` and no `seeded-connectors/`, so only resolving it reaches the payloads
 *  - each connector registers into THE BINARY'S single `@cotal-ai/core` (ext add asserts this; a
 *    dual-core install would fail it), recorded `source:"seeded"`
 *  - the docs data every connector reads ships once, in `seeded-connectors/_shared`; the seed puts it
 *    back in each installed connector, and `cotal update` verifies those copies against it
 *
 * Broker-free and deterministic. Needs `npm` + `pnpm` on PATH and network for third-party deps.
 * Run: pnpm smoke:seed-tarball:live
 */
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, sep } from "node:path";
import { promisify } from "node:util";
import { resolveOnPath } from "@cotal-ai/workspace";
import { platformExcludesHost } from "../../implementations/cli/src/seed/verify.js";
import { createSuite } from "@cotal-ai/smoke-kit";

const REPO = join(import.meta.dirname, "..", "..");
const { check, finish, passed, failed } = createSuite();
const cleanEnv: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_")));

function seedWithShadowedNode(entry: string, cwd: string, env: NodeJS.ProcessEnv, version: string) {
  const tools = join(env.HOME!, "tools");
  const invocations = join(tools, "npm-node");
  const npm = resolveOnPath("npm", env);
  if (!npm) throw new Error("the smoke needs npm on PATH");
  mkdirSync(tools);
  writeFileSync(join(tools, "node"), '#!/bin/sh\necho "unsupported project Node" >&2\nexit 89\n', { mode: 0o755 });
  writeFileSync(join(tools, "npm"), `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
appendFileSync(${JSON.stringify(invocations)}, process.argv[2] + " " + process.execPath + "\\n");
if (process.argv[2] === "view" && process.argv[3] === "cotal-ai@latest") console.log(${JSON.stringify(JSON.stringify(version))});
else process.exit(spawnSync(${JSON.stringify(npm)}, process.argv.slice(2), { stdio: "inherit" }).status ?? 1);
`, { mode: 0o755 });
  const result = spawnSync(process.execPath, [entry, "update", "--self"], {
    cwd, encoding: "utf8", env: { ...env, PATH: `${tools}${delimiter}${env.PATH}` },
  });
  const calls = existsSync(invocations) ? readFileSync(invocations, "utf8").trim().split("\n") : [];
  check("self-update uses the running Node with PATH's npm for both the version check and connector install",
    calls.includes(`view ${process.execPath}`) && calls.includes(`install ${process.execPath}`), calls);
  check("self-update reconciles the built-ins with an unsupported Node first on PATH",
    result.status === 0 && /connectors reconciled.*seeded/.test(result.stdout), result.stdout + result.stderr);
}

function checkSelfUpdateWithoutPackageLock(
  selfUpdate: () => string,
  prefix: string,
  npmrc: string,
  claudePayload: string,
  updateEnv: NodeJS.ProcessEnv,
  native: readonly [string, { version?: string }],
  nativeManifest: string,
): void {
  const userConfig = readFileSync(npmrc, "utf8");
  const lockPath = join(prefix, "package-lock.json");
  const hiddenLockPath = join(prefix, "node_modules", ".package-lock.json");
  const contents = readFileSync(lockPath, "utf8");
  const stale = JSON.parse(contents);
  stale.packages["node_modules/@cotal-ai/connector-claude-code"].version = "0.0.0";
  const staleContents = JSON.stringify(stale, null, 2) + "\n";
  const payload = readFileSync(claudePayload);
  writeFileSync(npmrc, `${userConfig}package-lock=false\n`);
  writeFileSync(lockPath, staleContents);
  try {
    const current = selfUpdate();
    check("self-update keeps all current built-ins when npm leaves a stale lockfile",
      current.includes("installed package closure is current"), current);
    writeFileSync(claudePayload, Buffer.concat([payload, Buffer.from("\n")]));
    const repaired = selfUpdate();
    check("self-update reinstalls only the damaged built-in with package-lock disabled",
      repaired.match(/Reconciling built-in \w+/g)?.join(", ") === "Reconciling built-in claude" &&
      readFileSync(claudePayload).equals(payload), repaired);
    check("self-update leaves the stale public lockfile unchanged", readFileSync(lockPath, "utf8") === staleContents);
    rmSync(lockPath);
    const unlocked = selfUpdate();
    check("self-update keeps current built-ins without creating a public lockfile",
      unlocked.includes("installed package closure is current") && !existsSync(lockPath), unlocked);

    const omitted = spawnSync("npm", ["install", "--omit=optional", "--legacy-peer-deps", "--install-links", "--no-audit", "--no-fund"], {
      cwd: prefix, env: updateEnv, encoding: "utf8",
    });
    check("real npm with omit=optional and package-lock=false removes the host native dependency",
      omitted.status === 0 && !existsSync(nativeManifest) && !existsSync(lockPath), omitted.stderr);
    const optionalRepaired = selfUpdate();
    check("self-update with package-lock=false repairs an omitted host native dependency",
      /reinstalling every built-in/.test(optionalRepaired) && existsSync(nativeManifest) && !existsSync(lockPath), optionalRepaired);
    const afterOptionalRepair = selfUpdate();
    check("repeat self-update after optional repair keeps current built-ins",
      afterOptionalRepair.includes("installed package closure is current") && !existsSync(lockPath), afterOptionalRepair);

    const hidden = JSON.parse(readFileSync(hiddenLockPath, "utf8")) as { packages: Record<string, { version?: string; extraneous?: boolean }> };
    hidden.packages[`../.extensions.stage-removed/config/cotal/extensions/${native[0]}`] = { version: native[1].version, extraneous: true };
    writeFileSync(hiddenLockPath, JSON.stringify(hidden, null, 2) + "\n");
    const stageRepaired = selfUpdate();
    const repairedHidden = JSON.parse(readFileSync(hiddenLockPath, "utf8")) as { packages: Record<string, unknown> };
    check("self-update with package-lock=false repairs a stale ../ stage entry in .package-lock.json",
      /reinstalling every built-in/.test(stageRepaired) &&
      Object.keys(repairedHidden.packages).every((key) => !key.includes(".extensions.stage-")), stageRepaired);
    check("repeat self-update after hidden lock stage repair keeps current built-ins",
      selfUpdate().includes("installed package closure is current") && !existsSync(lockPath));

    check("self-update leaves the user's package-lock setting unchanged", readFileSync(npmrc, "utf8") === `${userConfig}package-lock=false\n`);
  } finally {
    writeFileSync(npmrc, userConfig);
    writeFileSync(lockPath, contents);
  }
}

async function checkLocalOperatorUpdate(entry: string, cwd: string, env: NodeJS.ProcessEnv, version: string, extensions: string): Promise<void> {
  const command = "local-peer-probe", pkg = `@cotal-ai/${command}`, source = join(cwd, command);
  mkdirSync(source);
  writeFileSync(join(source, "package.json"), JSON.stringify({ name: pkg, version, type: "module", main: "index.mjs", peerDependencies: { "@cotal-ai/core": version } }));
  writeFileSync(join(source, "index.mjs"), `import { registry } from '@cotal-ai/core';
registry.register({ kind: 'command', name: '${command}', summary: 'Print a test greeting', run() { console.log('probe loaded'); } });
`);
  const requests: string[] = [];
  const registry = createServer((req, res) => {
    const path = decodeURIComponent(req.url!);
    requests.push(path);
    res.setHeader("content-type", "application/json");
    if (path === "/cotal-ai") res.end(JSON.stringify({ name: "cotal-ai", "dist-tags": { latest: version }, versions: { [version]: { name: "cotal-ai", version } } }));
    else { res.statusCode = 404; res.end('{"error":"not found"}'); }
  });
  await new Promise<void>((resolve, reject) => registry.once("error", reject).listen(0, "127.0.0.1", resolve));
  try {
    const address = registry.address();
    if (!address || typeof address === "string") throw new Error("loopback registry has no port");
    const exec = promisify(execFile);
    const run = (...args: string[]) => exec(process.execPath, [entry, ...args], {
      cwd, env: { ...env, COTAL_NO_UPDATE_CHECK: "1", npm_config_registry: `http://127.0.0.1:${address.port}`, npm_config_fetch_retries: "0" }, timeout: 120_000,
    });
    await run("ext", "add", `./${command}`);
    check("local scoped extension runs before the update", (await run(command)).stdout.trim() === "probe loaded");
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await run("update", "--self");
      check("self-update keeps the working local scoped extension", result.stdout.includes("installed package closure is current"), result.stdout + result.stderr);
    }
    const installed = join(extensions, "node_modules", pkg, "index.mjs");
    rmSync(installed);
    await run("update", "--self");
    check("self-update repairs a missing entry from the recorded local copy", readFileSync(installed).equals(readFileSync(join(source, "index.mjs"))));
    writeFileSync(installed, "throw new Error('unloadable local entry');\n");
    await run("update", "--self");
    check("self-update repairs an unloadable entry from the recorded local copy", readFileSync(installed).equals(readFileSync(join(source, "index.mjs"))));
    check("local scoped extension runs after repair", (await run(command)).stdout.trim() === "probe loaded");
    const status = JSON.parse((await run("status", "--json")).stdout) as { result: { extensions: { items: { package: string }[] } } };
    check("status still lists the local scoped extension", status.result.extensions.items.some(item => item.package === pkg));
    const inventory = JSON.parse(readFileSync(join(extensions, "extensions.json"), "utf8")) as { extensions: { pkg: string; spec: string }[] };
    check("update retains the operator's recorded path", inventory.extensions.find(item => item.pkg === pkg)?.spec === source);
    check("npm checks the latest CLI without asking for the local package", requests.filter(path => path === "/cotal-ai").length >= 4 && !requests.includes(`/${pkg}`), requests);
  } finally {
    await new Promise<void>((resolveClose, reject) => registry.close(error => error ? reject(error) : resolveClose()));
  }
}

async function checkReview2PackageLockCells(
  entry: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  version: string,
  extensions: string,
  claudePayload: string,
  seatClone: string,
): Promise<void> {
  const work = join(cwd, "review2-cells");
  const optSrc = join(work, "sharp-wasm32");
  const hostOptSrc = join(work, "host-opt");
  mkdirSync(optSrc, { recursive: true });
  mkdirSync(hostOptSrc, { recursive: true });
  writeFileSync(join(optSrc, "package.json"), JSON.stringify({ name: "@probe/sharp-wasm32", version: "1.0.0", cpu: ["wasm32"] }));
  writeFileSync(join(optSrc, "index.js"), "");
  writeFileSync(join(hostOptSrc, "package.json"), JSON.stringify({ name: "@probe/host-opt", version: "1.0.0", os: [process.platform], cpu: [process.arch] }));
  writeFileSync(join(hostOptSrc, "index.js"), "");
  execFileSync("npm", ["pack", "--silent", "--pack-destination", work, optSrc], { env: cleanEnv });
  execFileSync("npm", ["pack", "--silent", "--pack-destination", work, hostOptSrc], { env: cleanEnv });
  const wasmBytes = readFileSync(join(work, readdirSync(work).find(f => f.startsWith("probe-sharp-wasm32-"))!));
  const hostOptBytes = readFileSync(join(work, readdirSync(work).find(f => f.startsWith("probe-host-opt-"))!));
  const integrityOf = (bytes: Buffer) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  const shasumOf = (bytes: Buffer) => createHash("sha1").update(bytes).digest("hex");

  let addressPort = 0;
  const registry = createServer((req, res) => {
    const path = decodeURIComponent(req.url!);
    res.setHeader("content-type", "application/json");
    if (path === "/cotal-ai") {
      res.end(JSON.stringify({ name: "cotal-ai", "dist-tags": { latest: version }, versions: { [version]: { name: "cotal-ai", version } } }));
    } else if (path === "/@probe/sharp-wasm32") {
      res.end(JSON.stringify({
        name: "@probe/sharp-wasm32", "dist-tags": { latest: "1.0.0" },
        versions: { "1.0.0": { name: "@probe/sharp-wasm32", version: "1.0.0", cpu: ["wasm32"], dist: { tarball: `http://127.0.0.1:${addressPort}/wasm.tgz`, integrity: integrityOf(wasmBytes), shasum: shasumOf(wasmBytes) } } },
      }));
    } else if (path === "/@probe/host-opt") {
      res.end(JSON.stringify({
        name: "@probe/host-opt", "dist-tags": { latest: "1.0.0" },
        versions: { "1.0.0": { name: "@probe/host-opt", version: "1.0.0", os: [process.platform], cpu: [process.arch], dist: { tarball: `http://127.0.0.1:${addressPort}/host-opt.tgz`, integrity: integrityOf(hostOptBytes), shasum: shasumOf(hostOptBytes) } } },
      }));
    } else if (path === "/wasm.tgz") {
      res.setHeader("content-type", "application/octet-stream"); res.end(wasmBytes);
    } else if (path === "/host-opt.tgz") {
      res.setHeader("content-type", "application/octet-stream"); res.end(hostOptBytes);
    } else {
      res.statusCode = 404; res.end('{"error":"not found"}');
    }
  });
  await new Promise<void>((resolveListen, reject) => registry.once("error", reject).listen(0, "127.0.0.1", resolveListen));
  const exec = promisify(execFile);
  const userNpmrc = join(work, "user.npmrc");
  const cacheDir = join(work, "npm-cache");
  try {
    const addr = registry.address();
    if (!addr || typeof addr === "string") throw new Error("loopback registry has no port");
    addressPort = addr.port;
    const probeScope = `@probe:registry=http://127.0.0.1:${addressPort}\n`;
    writeFileSync(userNpmrc, probeScope);
    const cellTools = join(work, "tools");
    mkdirSync(cellTools, { recursive: true, mode: 0o700 });
    const cellRealNpm = resolveOnPath("npm", cleanEnv)!;
    const cellNpmLog = join(cellTools, "npm.log");
    writeFileSync(join(cellTools, "npm"), `#!/usr/bin/env node\nconst fs = require("node:fs"), cp = require("node:child_process");\nfs.appendFileSync(${JSON.stringify(cellNpmLog)}, process.argv.slice(2).join(" ") + "\\n");\nprocess.exit(cp.spawnSync(${JSON.stringify(cellRealNpm)}, process.argv.slice(2), { stdio: "inherit" }).status ?? 1);\n`, { mode: 0o755 });
    const cellEnv = {
      ...env,
      COTAL_NO_UPDATE_CHECK: "1",
      npm_config_userconfig: userNpmrc,
      npm_config_cache: cacheDir,
      npm_config_fetch_retries: "0",
      PATH: `${cellTools}${delimiter}${env.PATH ?? ""}`,
    };
    const run = (...args: string[]) => exec(process.execPath, [entry, ...args], { cwd, env: cellEnv, timeout: 120_000 });
    const runSelf = () => exec(process.execPath, [entry, "update", "--self"], {
      cwd, env: { ...cellEnv, npm_config_registry: `http://127.0.0.1:${addressPort}` }, timeout: 120_000,
    });

    // Cell A: Default setting stage pass deletes nothing, and local-path extension with removed source + missing optional completes `cotal update`.
    const localGoneDefault = join(work, "local-gone-default");
    mkdirSync(localGoneDefault);
    writeFileSync(join(localGoneDefault, "package.json"), JSON.stringify({
      name: "local-gone-default", version: "1.0.0", type: "module", main: "index.mjs",
      peerDependencies: { "@cotal-ai/core": version },
      optionalDependencies: { "@probe/sharp-wasm32": "1.0.0", "@probe/host-opt": "1.0.0" },
    }));
    writeFileSync(join(localGoneDefault, "index.mjs"), `import { registry } from '@cotal-ai/core';\nregistry.register({ kind: 'command', name: 'local-gone-default', summary: 'probe', run() { console.log('default ok'); } });\n`);
    await run("ext", "add", localGoneDefault);
    const installedDefaultDir = join(extensions, "node_modules", "local-gone-default");
    const markerDefault = join(installedDefaultDir, "stage-kept.txt");
    writeFileSync(markerDefault, "kept");
    rmSync(join(extensions, "node_modules", "@probe", "host-opt"), { recursive: true, force: true });
    rmSync(join(installedDefaultDir, "node_modules", "@probe", "host-opt"), { recursive: true, force: true });
    // Trigger a real staged install under default settings by damaging claude's payload while local source still exists: marker must survive.
    const origClaude = readFileSync(claudePayload);
    writeFileSync(claudePayload, Buffer.concat([origClaude, Buffer.from("\n")]));
    const defaultStageOut = await run("update");
    check("default-setting staged reconcile deletes no existing package from the stage",
      defaultStageOut.stdout.includes("refreshed claude") && existsSync(markerDefault), defaultStageOut.stdout + defaultStageOut.stderr);
    // Remove the local source folder while optional dependency is missing on disk, damage claude again, and run `cotal update`.
    rmSync(localGoneDefault, { recursive: true, force: true });
    rmSync(join(extensions, "node_modules", "@probe", "host-opt"), { recursive: true, force: true });
    writeFileSync(claudePayload, Buffer.concat([origClaude, Buffer.from("\n")]));
    const defaultGoneUpdate = await run("update");
    check("default setting: cotal update completes and keeps local-path extension when source is gone and optional is missing",
      defaultGoneUpdate.stdout.includes("refreshed claude") && existsSync(join(installedDefaultDir, "index.mjs")) &&
      (await run("local-gone-default")).stdout.trim() === "default ok", defaultGoneUpdate.stdout + defaultGoneUpdate.stderr);
    await run("ext", "remove", "local-gone-default");

    // Cell B: package-lock=false with non-suffix optional (`@probe/sharp-wasm32` cpu: ["wasm32"]) and local-path missing-source + missing-optional.
    writeFileSync(userNpmrc, `${probeScope}package-lock=false\n`);
    rmSync(join(extensions, "package-lock.json"), { force: true });
    const localWasm = join(work, "local-wasm-ext");
    const localGoneUnlocked = join(work, "local-gone-unlocked");
    mkdirSync(localWasm);
    mkdirSync(localGoneUnlocked);
    writeFileSync(join(localWasm, "package.json"), JSON.stringify({
      name: "local-wasm-ext", version: "1.0.0", type: "module", main: "index.mjs",
      peerDependencies: { "@cotal-ai/core": version },
      optionalDependencies: { "@probe/sharp-wasm32": "1.0.0" },
    }));
    writeFileSync(join(localWasm, "index.mjs"), `import { registry } from '@cotal-ai/core';\nregistry.register({ kind: 'command', name: 'local-wasm-ext', summary: 'wasm', run() { console.log('wasm ok'); } });\n`);
    writeFileSync(join(localGoneUnlocked, "package.json"), JSON.stringify({
      name: "local-gone-unlocked", version: "1.0.0", type: "module", main: "index.mjs",
      peerDependencies: { "@cotal-ai/core": version },
      optionalDependencies: { "@probe/host-opt": "1.0.0" },
    }));
    writeFileSync(join(localGoneUnlocked, "index.mjs"), `import { registry } from '@cotal-ai/core';\nregistry.register({ kind: 'command', name: 'local-gone-unlocked', summary: 'gone', run() { console.log('unlocked ok'); } });\n`);
    await run("ext", "add", localWasm);
    await run("ext", "add", localGoneUnlocked);
    const unlockedConverge1 = await runSelf();
    check("package-lock=false converges with an optional package excluded by cpu list rather than package name",
      unlockedConverge1.stdout.includes("installed package closure is current") && !existsSync(join(extensions, "package-lock.json")),
      unlockedConverge1.stdout + unlockedConverge1.stderr);
    // Also verify convergence when the npm cache is cold (unknown absent optional fallback): reconcile makes zero npm calls, and update only runs the version check.
    const coldEnv = { ...cellEnv, npm_config_cache: join(work, "cold-cache"), npm_config_registry: `http://127.0.0.1:${addressPort}` };
    rmSync(cellNpmLog, { force: true });
    const coldSeed = await exec(process.execPath, [entry, "ext", "seed"], { cwd, env: coldEnv, timeout: 120_000 });
    const coldSeedNpmCalls = existsSync(cellNpmLog) ? readFileSync(cellNpmLog, "utf8").trim().split("\n").filter(Boolean) : [];
    rmSync(cellNpmLog, { force: true });
    const coldUpdate = await exec(process.execPath, [entry, "update"], { cwd, env: coldEnv, timeout: 120_000 });
    const coldUpdateNpmCalls = existsSync(cellNpmLog) ? readFileSync(cellNpmLog, "utf8").trim().split("\n").filter(Boolean) : [];
    check("package-lock=false converges with zero reconcile npm calls when npm cache has no packument for an absent non-suffix optional",
      coldSeedNpmCalls.length === 0 &&
      !/reinstalling every built-in|Reconciling built-in/.test(coldUpdate.stdout + coldUpdate.stderr) &&
      coldUpdateNpmCalls.length === 1 && coldUpdateNpmCalls[0]!.startsWith("view cotal-ai@latest "),
      { coldSeedOut: coldSeed.stdout + coldSeed.stderr, coldSeedNpmCalls, coldUpdateOut: coldUpdate.stdout + coldUpdate.stderr, coldUpdateNpmCalls });

    // Remove localGoneUnlocked's source and its installed optional dependency, force a staged built-in repair, and verify update completes and converges.
    rmSync(localGoneUnlocked, { recursive: true, force: true });
    rmSync(join(extensions, "node_modules", "@probe", "host-opt"), { recursive: true, force: true });
    rmSync(join(extensions, "node_modules", "local-gone-unlocked", "node_modules", "@probe", "host-opt"), { recursive: true, force: true });
    writeFileSync(claudePayload, Buffer.concat([origClaude, Buffer.from("\n")]));
    const unlockedGoneRepair = await run("update");
    check("package-lock=false: cotal update completes and keeps local-path extension when source is gone and optional is missing",
      unlockedGoneRepair.stdout.includes("refreshed claude") &&
      existsSync(join(extensions, "node_modules", "local-gone-unlocked", "index.mjs")) &&
      (await run("local-gone-unlocked")).stdout.trim() === "unlocked ok", unlockedGoneRepair.stdout + unlockedGoneRepair.stderr);
    const unlockedGoneRepeat = await runSelf();
    check("package-lock=false: second update after missing-source local-path check is a no-op",
      unlockedGoneRepeat.stdout.includes("installed package closure is current"), unlockedGoneRepeat.stdout + unlockedGoneRepeat.stderr);
    await run("ext", "remove", "local-gone-unlocked");
    await run("ext", "remove", "local-wasm-ext");
  } finally {
    await new Promise<void>((resolveClose, reject) => registry.close(error => error ? reject(error) : resolveClose()));
  }

  // Cell C: Real version upgrade with package-lock=false (published previous release -> packed candidate build under test -> second update is a no-op with 0 npm installs).
  const upgradeRoot = join(work, "real-upgrade");
  const candidateOut = join(upgradeRoot, "candidate");
  mkdirSync(candidateOut, { recursive: true });
  const [maj, min, pat] = version.split(".").map(Number);
  const targetVer = `${maj}.${min}.${(pat ?? 0) + 1}`;
  const allDirs = [
    "bin",
    ...["packages", "implementations", "extensions"].flatMap(group =>
      readdirSync(join(REPO, group)).map(sub => `${group}/${sub}`).filter(rel => existsSync(join(REPO, rel, "package.json")))),
  ];
  const fixedNames = new Set((JSON.parse(readFileSync(join(REPO, ".changeset/config.json"), "utf8")) as { fixed: string[][] }).fixed.flat());
  const cloneWs = join(upgradeRoot, "ws");
  mkdirSync(cloneWs, { recursive: true });
  for (const name of ["package.json", "pnpm-workspace.yaml", "tsconfig.base.json"]) cpSync(join(REPO, name), join(cloneWs, name));
  symlinkSync(join(REPO, "node_modules"), join(cloneWs, "node_modules"), "dir");
  const candidateEntries = new Map<string, { meta: Record<string, unknown>; archive: string }>();
  const candidateTarballs = new Map<string, Buffer>();
  for (const rel of allDirs) {
    const srcRoot = rel === "packages/seat" ? seatClone : join(REPO, rel);
    const meta = JSON.parse(readFileSync(join(srcRoot, "package.json"), "utf8")) as Record<string, unknown> & { name?: string };
    if (!meta.name || !fixedNames.has(meta.name)) continue;
    const dst = join(cloneWs, rel);
    mkdirSync(dirname(dst), { recursive: true });
    cpSync(srcRoot, dst, { recursive: true, filter: (s) => !s.split(sep).includes("node_modules") && !s.endsWith("seeded-connectors") });
    if (existsSync(join(REPO, rel, "node_modules"))) symlinkSync(join(REPO, rel, "node_modules"), join(dst, "node_modules"), "dir");
    meta.version = targetVer;
    for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const) {
      const map = meta[field] as Record<string, string> | undefined;
      if (!map) continue;
      for (const dep of Object.keys(map)) if (fixedNames.has(dep)) map[dep] = targetVer;
    }
    writeFileSync(join(dst, "package.json"), JSON.stringify(meta, null, 2) + "\n");
  }
  for (const rel of allDirs) {
    const dst = join(cloneWs, rel);
    if (!existsSync(join(dst, "package.json"))) continue;
    const skip = ["packages/workspace", "packages/seat"].includes(rel) ? ["--config.ignore-scripts=true"] : [];
    const before = new Set(readdirSync(candidateOut));
    execFileSync("pnpm", ["-C", dst, "pack", ...skip, "--pack-destination", candidateOut], { env: cleanEnv, stdio: ["ignore", "ignore", "inherit"] });
    const tgzName = readdirSync(candidateOut).find(f => !before.has(f) && f.endsWith(".tgz"))!;
    const bytes = readFileSync(join(candidateOut, tgzName));
    const packedMeta = JSON.parse(execFileSync("tar", ["xzf", join(candidateOut, tgzName), "-O", "package/package.json"], { env: cleanEnv, encoding: "utf8" })) as Record<string, unknown> & { name: string };
    candidateEntries.set(packedMeta.name, { meta: packedMeta, archive: tgzName });
    candidateTarballs.set(tgzName, bytes);
  }
  const upstreamCache = new Map<string, Record<string, unknown>>();
  let overlayUrl = "";
  const overlay = createServer(async (req, res) => {
    try {
      const rawPath = decodeURIComponent(new URL(req.url!, "http://localhost").pathname).slice(1);
      if (rawPath.startsWith("__cand/")) {
        const bytes = candidateTarballs.get(rawPath.slice("__cand/".length));
        if (!bytes) { res.writeHead(404).end(); return; }
        res.writeHead(200, { "content-type": "application/octet-stream" }).end(bytes);
        return;
      }
      if (rawPath.includes("/-/")) {
        const up = await fetch(`https://registry.npmjs.org/${req.url!.slice(1)}`, { signal: AbortSignal.timeout(30_000) });
        res.writeHead(up.status, { "content-type": "application/octet-stream" }).end(Buffer.from(await up.arrayBuffer()));
        return;
      }
      const name = rawPath.startsWith("@") ? rawPath.split("/").slice(0, 2).join("/") : rawPath.split("/")[0]!;
      const selector = rawPath.slice(name.length + 1);
      if (!upstreamCache.has(name)) {
        const up = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(30_000) });
        if (!up.ok) { res.writeHead(up.status).end(await up.text()); return; }
        upstreamCache.set(name, await up.json() as Record<string, unknown>);
      }
      const packument = structuredClone(upstreamCache.get(name)!) as { "dist-tags": Record<string, string>; versions: Record<string, unknown> };
      const local = candidateEntries.get(name);
      if (local) {
        const bytes = candidateTarballs.get(local.archive)!;
        packument.versions[targetVer] = {
          ...local.meta,
          dist: { tarball: `${overlayUrl}/__cand/${local.archive}`, integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`, shasum: createHash("sha1").update(bytes).digest("hex") },
        };
        packument["dist-tags"].latest = targetVer;
      }
      const body = selector ? packument.versions[packument["dist-tags"][selector] ?? selector] : packument;
      res.writeHead(body ? 200 : 404, { "content-type": "application/json" }).end(JSON.stringify(body ?? { error: "not found" }));
    } catch (e) {
      if (!res.headersSent) res.writeHead(502);
      res.end(JSON.stringify({ error: (e as Error).message }));
    }
  });
  await new Promise<void>((resolveListen, reject) => overlay.once("error", reject).listen(0, "127.0.0.1", resolveListen));
  try {
    const addr = overlay.address();
    if (!addr || typeof addr === "string") throw new Error("overlay has no port");
    overlayUrl = `http://127.0.0.1:${addr.port}`;
    const upHome = join(upgradeRoot, "home");
    const upCfg = join(upgradeRoot, "cfg");
    const upCotal = join(upgradeRoot, "cotal");
    const upPrefix = join(upgradeRoot, "global");
    const upCache = join(upgradeRoot, "cache");
    const upTmp = join(upgradeRoot, "tmp");
    const upTools = join(upgradeRoot, "tools");
    for (const d of [upHome, upCfg, upCotal, upPrefix, upCache, upTmp, upTools]) mkdirSync(d, { recursive: true, mode: 0o700 });
    const upNpmrc = join(upHome, ".npmrc");
    const realNpm = resolveOnPath("npm", cleanEnv)!;
    const npmLog = join(upTools, "npm.log");
    writeFileSync(join(upTools, "npm"), `#!/usr/bin/env node\nconst fs = require("node:fs"), cp = require("node:child_process");\nfs.appendFileSync(${JSON.stringify(npmLog)}, process.argv.slice(2).join(" ") + "\\n");\nprocess.exit(cp.spawnSync(${JSON.stringify(realNpm)}, process.argv.slice(2), { stdio: "inherit" }).status ?? 1);\n`, { mode: 0o755 });
    const upEnv: NodeJS.ProcessEnv = {
      ...cleanEnv,
      HOME: upHome, COTAL_HOME: upCotal, XDG_CONFIG_HOME: upCfg, TMPDIR: upTmp,
      npm_config_prefix: upPrefix, npm_config_cache: upCache, npm_config_userconfig: upNpmrc,
      npm_config_registry: overlayUrl, DO_NOT_TRACK: "1", COTAL_TELEMETRY: "off",
      PATH: `${join(upPrefix, "bin")}${delimiter}${upTools}${delimiter}${cleanEnv.PATH ?? ""}`,
    };
    writeFileSync(upNpmrc, "");
    const cotalUp = await (await fetch("https://registry.npmjs.org/cotal-ai", { signal: AbortSignal.timeout(30_000) })).json() as { "dist-tags"?: { latest?: string } };
    const prevVer = cotalUp["dist-tags"]?.latest ?? "0.183.0";
    const globalInstall = await exec(realNpm, ["install", "-g", "--prefix", upPrefix, `cotal-ai@${prevVer}`, "--no-audit", "--no-fund"], { env: upEnv, timeout: 240_000 });
    check(`installed previous release cotal-ai@${prevVer} globally`, globalInstall.stdout !== undefined, globalInstall.stderr);
    const globalBin = join(upPrefix, "bin", "cotal");
    await exec(globalBin, ["ext", "seed"], { cwd: upHome, env: upEnv, timeout: 240_000 });
    // User now sets package-lock=false in .npmrc before upgrading to the candidate build under test.
    writeFileSync(upNpmrc, "package-lock=false\n");
    const upgraded = await exec(globalBin, ["update", "--self"], { cwd: upHome, env: upEnv, timeout: 300_000 });
    const afterVer = (await exec(globalBin, ["--version"], { cwd: upHome, env: upEnv })).stdout.trim();
    check(`real upgrade with package-lock=false reaches ${targetVer} and reconciles built-ins`,
      afterVer.split("\n")[0] === `cotal-ai ${targetVer}` &&
      afterVer.split("\n").slice(1).every(line => line.trim().endsWith(` ${targetVer}`)) &&
      /connectors reconciled/.test(upgraded.stdout + upgraded.stderr),
      { afterVer, output: upgraded.stdout + upgraded.stderr });
    rmSync(npmLog, { force: true });
    const secondUpgrade = await exec(globalBin, ["update", "--self"], { cwd: upHome, env: upEnv, timeout: 180_000 });
    const secondNpmCalls = existsSync(npmLog) ? readFileSync(npmLog, "utf8").trim().split("\n").filter(Boolean) : [];
    check("second update --self after real version upgrade with package-lock=false is a no-op and only checks cotal-ai@latest",
      secondUpgrade.stdout.includes("installed package closure is current") &&
      secondNpmCalls.length === 1 && secondNpmCalls[0]!.startsWith("view cotal-ai@latest "),
      { stdout: secondUpgrade.stdout, stderr: secondUpgrade.stderr, secondNpmCalls });
    rmSync(npmLog, { force: true });
    const seedRepeat = await exec(globalBin, ["ext", "seed"], { cwd: upHome, env: upEnv, timeout: 180_000 });
    const seedNpmCalls = existsSync(npmLog) ? readFileSync(npmLog, "utf8").trim().split("\n").filter(Boolean) : [];
    rmSync(npmLog, { force: true });
    const plainRepeat = await exec(globalBin, ["update"], { cwd: upHome, env: upEnv, timeout: 180_000 });
    const plainNpmCalls = existsSync(npmLog) ? readFileSync(npmLog, "utf8").trim().split("\n").filter(Boolean) : [];
    check("second reconcile and plain update after real version upgrade with package-lock=false verify all built-ins with zero prefix npm calls",
      seedNpmCalls.length === 0 &&
      !/reinstalling every built-in|Reconciling built-in/.test(plainRepeat.stdout + plainRepeat.stderr) &&
      plainNpmCalls.length === 1 && plainNpmCalls[0]!.startsWith("view cotal-ai@latest "),
      { seedOut: seedRepeat.stdout + seedRepeat.stderr, seedNpmCalls, stdout: plainRepeat.stdout, stderr: plainRepeat.stderr, plainNpmCalls });
  } finally {
    await new Promise<void>((resolveClose, reject) => overlay.close(error => error ? reject(error) : resolveClose()));
  }
}

const base = mkdtempSync(join(tmpdir(), "cotal-tarball-smoke-"));
const tgz = join(base, "tgz");
const prefix = join(base, "prefix");
const physicalConfig = join(base, "cfg");
const cfg = process.platform === "win32" ? physicalConfig : join(base, "linked-config");
mkdirSync(tgz, { recursive: true });
mkdirSync(prefix, { recursive: true });
mkdirSync(physicalConfig, { recursive: true });
if (cfg !== physicalConfig) symlinkSync(physicalConfig, cfg, "dir");

try {
  console.log("packing the cotal-ai closure …");
  const dirs = [
    "bin",
    "packages/core",
    "packages/seat",
    "packages/workspace",
    "implementations/cli",
    "implementations/manager",
    "implementations/delivery",
    "implementations/auth",
    "extensions/connector-core",
  ];
  // seat's prepack refuses a tree without both Linux helpers, and the build above is a host-only dev
  // build. So seat packs from a clone under `base`: the host helper that build made, plus a 20-byte
  // ELF header for each other shipped arch. The real packages/seat/build/Release is never written,
  // because a stand-in helper left there would ship on a later genuine pack.
  const seatSource = join(base, "seat-source");
  const seatClone = join(seatSource, "packages", "seat");
  cpSync(join(REPO, "packages", "seat"), seatClone, { recursive: true, filter: (src) => !src.split(sep).includes("node_modules") });
  for (const name of ["package.json", "pnpm-workspace.yaml", "tsconfig.base.json"]) cpSync(join(REPO, name), join(seatSource, name));
  symlinkSync(join(REPO, "node_modules"), join(seatSource, "node_modules"), "dir");
  symlinkSync(join(REPO, "packages", "seat", "node_modules"), join(seatClone, "node_modules"), "dir");
  for (const [arch, machine] of [["x64", 62], ["arm64", 183]] as const) {
    if (process.platform === "linux" && process.arch === arch) continue;
    const helper = join(seatClone, "build", "Release", `linux-${arch}`, "peercred.node");
    mkdirSync(dirname(helper), { recursive: true });
    const header = Buffer.alloc(20);
    header[0] = 0x7f;
    header.write("ELF", 1);
    header.writeUInt16LE(machine, 18);
    writeFileSync(helper, header);
  }
  // workspace and seat require foreign-platform bindings for publication. This host-only smoke
  // loads neither those bindings nor the simulated non-host seat headers, so skip their release checks.
  for (const d of dirs) {
    const root = d === "packages/seat" ? seatClone : join(REPO, d);
    const skipPrepack = ["packages/workspace", "packages/seat"].includes(d) ? ["--config.ignore-scripts=true"] : [];
    execFileSync("pnpm", ["-C", root, "pack", ...skipPrepack, "--pack-destination", tgz], { env: cleanEnv, stdio: ["ignore", "ignore", "inherit"] });
  }
  const tarballs = readdirSync(tgz).filter((f) => f.endsWith(".tgz"));
  check("packed the full @cotal-ai closure", tarballs.length === dirs.length, tarballs.length);

  const cotalTgz = join(tgz, tarballs.find((f) => /^cotal-ai-\d/.test(f)) ?? "");
  const listing = execFileSync("tar", ["tzf", cotalTgz], { env: cleanEnv, encoding: "utf8" });
  check("cotal-ai tarball ships seeded-connectors/ payloads", listing.includes("package/seeded-connectors/hermes/package.json"));
  check("cotal-ai tarball bundles the web dashboard payload", listing.includes("package/seeded-connectors/web/package.json"));
  const webBase = "package/seeded-connectors/web/dist/web";
  check(
    "bundled web payload ships the client page and its bundle manifest in dist",
    listing.includes(`${webBase}/index.html`) && listing.includes(`${webBase}/bundle-licenses.json`),
  );
  // Every connector bundle reads the same docs data from beside itself; the tarball carries it once.
  const docsEntries = listing.split("\n").filter((line) => /\/docs-(bundle|index)\.bin$/.test(line)).sort();
  check(
    "cotal-ai tarball ships each docs file once, in seeded-connectors/_shared",
    docsEntries.join(" ") === "package/seeded-connectors/_shared/docs-bundle.bin package/seeded-connectors/_shared/docs-index.bin",
    docsEntries,
  );
  check("cotal-ai tarball ships the shared-file placements", listing.includes("package/seeded-connectors/_shared/placements.json"));
  const packedPkg = execFileSync("tar", ["xzf", cotalTgz, "-O", "package/package.json"], { env: cleanEnv, encoding: "utf8" });
  check("cotal-ai tarball has concrete dep versions (workspace: replaced)", !packedPkg.includes("workspace:"));

  // Every bundled payload must carry the umbrella's exact version — the reconcile stamps that version
  // as the generation, so a skewed payload would be installed and treated as current (F1). The prepack
  // asserts this too; the tarball is the last place to catch it before a customer install.
  const umbrellaVersion = (JSON.parse(packedPkg) as { version: string }).version;
  for (const n of ["claude", "opencode", "hermes", "pi", "web"]) {
    const seededPkg = JSON.parse(
      execFileSync("tar", ["xzf", cotalTgz, "-O", `package/seeded-connectors/${n}/package.json`], { env: cleanEnv, encoding: "utf8" }),
    ) as { version: string };
    check(`bundled ${n} payload is version-locked to the umbrella (${umbrellaVersion})`, seededPkg.version === umbrellaVersion, seededPkg.version);
  }

  // The web dashboard's client is one Vite build: third-party code is compiled into its hashed
  // assets rather than shipped as runtime deps, so bundle-licenses.json is the auditable SBOM
  // surface. Assert that every bundled package carries a concrete version and license, that it names
  // the React runtime the page is built on, and that every file the shipped page references is in
  // the tarball, so a payload whose page points at a missing asset cannot pass into a published
  // binary. marked and DOMPurify are bundled too, because the message rows render bodies as
  // sanitized Markdown, and d3-force, d3-selection and d3-zoom lay out and pan the topology graph.
  const licenses = JSON.parse(
    execFileSync("tar", ["xzf", cotalTgz, "-O", `${webBase}/bundle-licenses.json`], { env: cleanEnv, encoding: "utf8" }),
  ) as { bundled: { package: string; version: string; license: string }[] };
  const libs = new Map(licenses.bundled.map((e) => [e.package, e]));
  check(
    "web bundle-licenses.json gives every bundled package a version and a license",
    licenses.bundled.length > 0 && licenses.bundled.every((e) => Boolean(e.version && e.license)),
    licenses.bundled,
  );
  check("web bundle-licenses.json names react and react-dom", ["react", "react-dom"].every((p) => libs.has(p)), [...libs.keys()].join(","));
  check("web bundle-licenses.json names marked and dompurify", ["marked", "dompurify"].every((p) => libs.has(p)), [...libs.keys()].join(","));
  check("web bundle-licenses.json names d3-force, d3-selection and d3-zoom", ["d3-force", "d3-selection", "d3-zoom"].every((p) => libs.has(p)), [...libs.keys()].join(","));
  const page = execFileSync("tar", ["xzf", cotalTgz, "-O", `${webBase}/index.html`], { env: cleanEnv, encoding: "utf8" });
  const refs = [...page.matchAll(/(?:src|href)="\/([^"]+)"/g)].map((m) => m[1]);
  check("the shipped web page references its script and stylesheet", refs.some((r) => r.endsWith(".js")) && refs.some((r) => r.endsWith(".css")), refs);
  for (const r of refs) check(`the shipped web page's reference /${r} is in the tarball`, listing.includes(`${webBase}/${r}`));
  // The same payload, packed from the web package directly, the way prepack packs it and the way
  // `@cotal-ai/web` publishes on its own: the umbrella must carry that package's manifest byte for
  // byte, not a copy from some other build.
  //
  // This pack is also what gives the mutation coverage gate its reach into the web package: the
  // gate cannot follow the umbrella's prepack, but it can follow an `npm pack` this suite runs over
  // `implementations/web`. It is NOT the witness for the fixture's mutation. That mutation (the
  // build stops recording bundled packages) is killed by the "names react and react-dom" cell
  // above, which reads the umbrella's own tarball.
  const webTgzDir = join(base, "web-tgz");
  mkdirSync(webTgzDir, { recursive: true });
  execFileSync("npm", ["pack", "--ignore-scripts", "--silent", "--pack-destination", webTgzDir, join(REPO, "implementations", "web")], { env: cleanEnv, stdio: ["ignore", "ignore", "inherit"] });
  const webTgz = join(webTgzDir, readdirSync(webTgzDir).find((f) => f.endsWith(".tgz")) ?? "");
  const standalone = execFileSync("tar", ["xzf", webTgz, "-O", "package/dist/web/bundle-licenses.json"], { env: cleanEnv, encoding: "utf8" });
  check("the umbrella's web manifest is the one the web package itself packs",
    standalone === execFileSync("tar", ["xzf", cotalTgz, "-O", `${webBase}/bundle-licenses.json`], { env: cleanEnv, encoding: "utf8" }));

  console.log("installing the tarball closure into a clean prefix …");
  writeFileSync(join(prefix, "package.json"), JSON.stringify({ name: "tb-host", private: true }));
  const install = spawnSync("npm", ["install", "--no-audit", "--no-fund", ...tarballs.map((f) => join(tgz, f))], {
    cwd: prefix,
    env: cleanEnv,
    encoding: "utf8",
  });
  check("npm install of the tarball closure succeeded", install.status === 0, install.stderr?.split("\n").slice(-6).join("\n"));

  const packageBin = join(prefix, "node_modules", "cotal-ai", "dist", "cotal.js");
  check("installed binary present", existsSync(packageBin));
  check("seeded-connectors present in the installed package", existsSync(join(prefix, "node_modules", "cotal-ai", "seeded-connectors")));
  check("single @cotal-ai/core hoisted in the prefix", existsSync(join(prefix, "node_modules", "@cotal-ai", "core")));

  console.log("seeding from the published layout …");
  const npmBin = join(prefix, "node_modules", ".bin", "cotal");
  const invokedBin = process.platform === "win32" ? packageBin : npmBin;
  if (process.platform !== "win32") {
    check("npm installed cotal through a bin symlink", existsSync(npmBin) && lstatSync(npmBin).isSymbolicLink());
  }
  // Seed explicitly before reading the installed inventory.
  const home = join(base, "home");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(prefix, ".cotal"));
  const npmrc = join(home, ".npmrc");
  writeFileSync(npmrc, "omit=optional\n");
  const seedEnv: NodeJS.ProcessEnv & { HOME: string; XDG_CONFIG_HOME: string } = { ...cleanEnv,
    HOME: home, COTAL_HOME: join(home, ".cotal"), XDG_CONFIG_HOME: cfg, npm_config_userconfig: npmrc };
  if (process.platform === "win32") {
    const seed = spawnSync("node", [invokedBin, "ext", "seed"], { cwd: prefix, encoding: "utf8", env: seedEnv });
    check("ext seed from the published layout succeeded", seed.status === 0, `${seed.stdout}${seed.stderr}`.split("\n").slice(-12).join("\n"));
  } else {
    seedWithShadowedNode(invokedBin, prefix, seedEnv, umbrellaVersion);
  }
  const list = spawnSync("node", [invokedBin, "ext", "list"], { cwd: prefix, encoding: "utf8", env: seedEnv });
  const out = list.stdout ?? "";
  for (const n of ["claude", "opencode", "codex", "hermes", "jcode", "pi"]) {
    check(`seeded connector:${n} from the tarball binary`, out.includes(`connector:${n}`), list.stderr);
  }
  check("seeded service-preset:web (the dashboard) from the bundled payload", out.includes("service-preset:web"), list.stderr);

  const installKey = createHash("sha256").update(packageBin).digest("hex");
  const selectionPath = join(cfg, "cotal", "installs", installKey, "sets", umbrellaVersion, "selection.json");
  const connectorRoot = existsSync(selectionPath)
    ? (JSON.parse(readFileSync(selectionPath, "utf8")) as { root: string }).root : join(cfg, "cotal");
  const extensionPrefix = join(connectorRoot, "extensions");
  const manifest = JSON.parse(readFileSync(join(extensionPrefix, "extensions.json"), "utf8")) as {
    extensions: { pkg: string; spec: string; source?: string }[];
  };
  const hermes = manifest.extensions.find((e) => e.pkg === "@cotal-ai/connector-hermes");
  check("connector installed from the durable store under the isolated config (pubDir branch)", Boolean(hermes && hermes.spec.startsWith(cfg)), hermes?.spec);
  const firstParty = ["@cotal-ai/connector-claude-code", "@cotal-ai/connector-opencode", "@cotal-ai/connector-codex", "@cotal-ai/connector-hermes", "@cotal-ai/connector-jcode", "@cotal-ai/pi", "@cotal-ai/web"];
  const seededEntries = manifest.extensions.filter((e) => firstParty.includes(e.pkg));
  const allSeeded = seededEntries.every((e) => e.source === "seeded");
  check("all seven first-party exts recorded source:seeded (registered into the binary's single core)", allSeeded && seededEntries.length === 7);
  const webEntry = manifest.extensions.find((e) => e.pkg === "@cotal-ai/web");
  check("web installed from the durable store under the isolated config (bundled, not npm-fetched)", Boolean(webEntry && webEntry.spec.startsWith(cfg)), webEntry?.spec);

  // The launcher shim a connector's buildLaunch runs (`node dist/serve.js` / `dist/launch.js`) must be
  // PACKAGED — a build that emits only declarations for it passes install + import + materialize but
  // fails at LAUNCH with MODULE_NOT_FOUND. Assert those buildLaunch targets exist in the installed
  // payload (a self-contained esbuild bundle each), so a dropped shim can never ship again.
  const extRoot = join(extensionPrefix, "node_modules");
  const launchShims: Record<string, string> = {
    "@cotal-ai/connector-opencode": "dist/serve.js",
    "@cotal-ai/connector-codex": "dist/host.js",
    "@cotal-ai/connector-hermes": "dist/launch.js",
    "@cotal-ai/connector-jcode": "dist/host.js",
  };
  for (const [pkg, shim] of Object.entries(launchShims)) {
    check(`${pkg} launcher shim ${shim} is packaged (buildLaunch target exists)`, existsSync(join(extRoot, ...pkg.split("/"), ...shim.split("/"))));
  }
  const hermesLaunch = readFileSync(join(extRoot, "@cotal-ai", "connector-hermes", "dist", "launch.js"), "utf8");
  check("Hermes launcher is self-contained (no late host-core import)", !/^\s*import\b[^\n]* from ["']@cotal-ai\/core["'];?\s*$/m.test(hermesLaunch));

  // The seed store put the shared docs data back at every path the prepack took it from, so each
  // installed connector holds the files it was packed with.
  const seededPkgs: Record<string, string> = {
    claude: "@cotal-ai/connector-claude-code", opencode: "@cotal-ai/connector-opencode", codex: "@cotal-ai/connector-codex",
    hermes: "@cotal-ai/connector-hermes", jcode: "@cotal-ai/connector-jcode", pi: "@cotal-ai/pi", web: "@cotal-ai/web",
  };
  const sharedDir = join(prefix, "node_modules", "cotal-ai", "seeded-connectors", "_shared");
  const placements = (JSON.parse(readFileSync(join(sharedDir, "placements.json"), "utf8")) as { placements: Record<string, string[]> }).placements;
  // Every connector bundles the docs data; the web dashboard does not.
  const connectors = Object.keys(seededPkgs).filter((name) => name !== "web");
  check("every connector, and only a connector, shipped its docs data in the shared copy", Object.keys(placements).sort().join(" ") === [...connectors].sort().join(" "), Object.keys(placements));
  const installedAt = (name: string, rel: string) => join(extRoot, ...seededPkgs[name].split("/"), ...rel.split("/"));
  const sharedCopy = (rel: string) => readFileSync(join(sharedDir, rel.slice(rel.lastIndexOf("/") + 1)));
  let restored = 0;
  for (const name of connectors) {
    for (const rel of placements[name] ?? []) {
      const at = installedAt(name, rel);
      if (existsSync(at) && readFileSync(at).equals(sharedCopy(rel))) restored++;
      else check(`installed ${name} holds ${rel}, byte-equal to the shared copy`, false);
    }
  }
  const placed = Object.values(placements).flat().length;
  check(`every placement is restored byte-equal in the installed connectors (${restored}/${placed})`, restored === placed && placed > 0);

  // `cotal update` keeps a seeded built-in only when its store and installed copies are byte-equal to
  // the shipped payload, which for a restored file is the shared copy. A tampered copy is reinstalled.
  const lock = JSON.parse(readFileSync(join(extensionPrefix, "package-lock.json"), "utf8")) as {
    packages: Record<string, { version?: string; optional?: boolean; os?: string[]; cpu?: string[]; libc?: string[] }>;
  };
  const native = Object.entries(lock.packages).find(([key, entry]) =>
    key.includes("/@1jehuang/jcode-") && entry.optional && !platformExcludesHost(entry));
  if (!native) throw new Error("the SDK lock records no native package for this host");
  const nativeManifest = join(extensionPrefix, native[0], "package.json");
  check("first seed includes the host native dependency despite omit=optional", existsSync(nativeManifest));
  const updateEnv = seedEnv;
  mkdirSync(updateEnv.HOME, { recursive: true });
  const runUpdate = (env: NodeJS.ProcessEnv, ...args: string[]) => {
    const run = spawnSync(process.execPath, [invokedBin, "update", ...args], { cwd: prefix, encoding: "utf8", env });
    check(`update ${args.join(" ")} exits successfully`, run.status === 0, run.stderr);
    return `${run.stdout ?? ""}${run.stderr ?? ""}`;
  };
  const update = (...args: string[]) => runUpdate(updateEnv, ...args);
  const reconciled = (out: string) => out.split("\n").find((line) => line.includes("connectors reconciled")) ?? "";
  const kept = reconciled(update());
  const standaloneDir = join(home, ".pi", "agent", "extensions");
  check(
    "cotal update verifies all seven built-ins against the shipped payload and reinstalls none",
    Object.keys(seededPkgs).every((name) => new RegExp(`verified [^;]*\\b${name}\\b`).test(kept)) && !kept.includes("refreshed"),
    kept,
  );
  check("update does not create a standalone pi extension directory", !existsSync(standaloneDir));
  if (process.platform === "linux") {
    const selfUpdate = () => runUpdate({ ...updateEnv, PATH: `${join(home, "tools")}${delimiter}${updateEnv.PATH}` }, "--self");
    const coreLink = installedAt("web", "node_modules/@cotal-ai/core");
    const dashboard = installedAt("web", "dist/index.js");
    const importDashboard = () => spawnSync(process.execPath, ["--input-type=module", "-e",
      "await import(process.argv[1]);", dashboard], { cwd: prefix, env: updateEnv, encoding: "utf8" });
    rmSync(coreLink);
    symlinkSync(join(base, "removed-generation", "core"), coreLink);
    const broken = importDashboard();
    check("the dashboard cannot import with a dangling core peer", broken.status === 1 && broken.stderr.includes("ERR_MODULE_NOT_FOUND"), broken.stderr);
    const repaired = selfUpdate();
    check("current self-update verifies the dashboard without reinstalling it", /verified [^;]*\bweb\b/.test(reconciled(repaired)) && !repaired.includes("Reconciling built-in web"), repaired);
    const loaded = importDashboard();
    check("the dashboard imports after self-update rebinds its peer", loaded.status === 0, loaded.stderr);
    check("a second self-update skips reconciliation", selfUpdate().includes("installed package closure is current"));
    checkSelfUpdateWithoutPackageLock(selfUpdate, extensionPrefix, npmrc, installedAt("claude", "package.json"), updateEnv, native, nativeManifest);
  }
  // Real npm creates the reported existing installation while leaving its lock intact.
  const omitted = spawnSync("npm", ["install", "--omit=optional", "--legacy-peer-deps", "--install-links", "--no-audit", "--no-fund"], {
    cwd: extensionPrefix, env: updateEnv, encoding: "utf8",
  });
  check("real npm with omit=optional creates the missing-native state", omitted.status === 0 && !existsSync(nativeManifest), omitted.stderr);
  const optionalRepair = update();
  check("plain update repairs an omitted host native dependency", existsSync(nativeManifest), optionalRepair);
  const standaloneCopy = join(standaloneDir, "cotal.js");
  const editedCopy = "// operator-edited standalone extension\n";
  mkdirSync(standaloneDir, { recursive: true });
  writeFileSync(standaloneCopy, editedCopy, { flag: "wx" });
  const repeated = update();
  const advice = repeated.split("\n").filter(line => line.includes("standalone pi extension"));
  check("update distinguishes the managed connector and explains how to update the standalone copy once",
    advice.length === 1 && advice[0].includes("managed pi connector") && advice[0].includes("reinstall `@cotal-ai/pi`")
    && advice[0].includes("`cotal --version`") && advice[0].includes("repeat the copy"), advice);
  check("update does not overwrite an edited standalone pi extension", readFileSync(standaloneCopy, "utf8") === editedCopy);
  check("repeat plain update does not reinstall any built-in", !/reinstalling every built-in|Reconciling built-in/.test(repeated), repeated);
  check("update leaves the operator's omit configuration unchanged", readFileSync(npmrc, "utf8") === "omit=optional\n");
  const tamperedRel = placements.claude?.[0] ?? "";
  writeFileSync(installedAt("claude", tamperedRel), Buffer.concat([sharedCopy(tamperedRel), Buffer.from([0])]));
  const repairOut = update();
  check(
    "cotal update reinstalls a built-in whose restored docs file differs from the shared copy",
    repairOut.includes(`claude: the installed copy differs at ${join(...tamperedRel.split("/"))}; reinstalling`) && /refreshed claude\b/.test(reconciled(repairOut)),
    repairOut.split("\n").filter((line) => line.includes("claude")).join("\n"),
  );
  check("the reinstall restores the shared copy", readFileSync(installedAt("claude", tamperedRel)).equals(sharedCopy(tamperedRel)));
  if (cfg !== physicalConfig) {
    const lockPath = join(extensionPrefix, "package-lock.json");
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    const stale = `../.extensions.stage-removed/config/cotal/extensions/${native[0]}`;
    lock.packages[stale] = { version: native[1].version, extraneous: true };
    writeFileSync(lockPath, JSON.stringify(lock));
    const repaired = update();
    const repairedLock = JSON.parse(readFileSync(lockPath, "utf8")) as { packages: Record<string, { extraneous?: boolean }> };
    check("one update repairs a lock containing a removed stage", /reinstalling every built-in/.test(repaired) &&
      Object.entries(repairedLock.packages).every(([key, entry]) => !key.includes(".extensions.stage-") && !(key.startsWith("../") && entry.extraneous)), repaired);
    const linkedUpdate = update("--self");
    check("the next update through the link keeps the installed built-ins", !/reinstalling every built-in|Reconciling built-in/.test(linkedUpdate), linkedUpdate);
    updateEnv.XDG_CONFIG_HOME = physicalConfig;
    for (const args of [["--version"], ["status"]]) {
      const run = spawnSync("node", [invokedBin, ...args], { cwd: prefix, encoding: "utf8", env: updateEnv });
      check(`${args[0]} succeeds through the physical config path`, run.status === 0, run.stderr);
    }
    const physicalUpdate = update("--self");
    check("an update through the physical path keeps the installed built-ins", !/reinstalling every built-in|Reconciling built-in/.test(physicalUpdate), physicalUpdate);
  }
  if (process.platform === "linux") {
    await checkLocalOperatorUpdate(invokedBin, prefix, seedEnv, umbrellaVersion, extensionPrefix);
    await checkReview2PackageLockCells(invokedBin, prefix, seedEnv, umbrellaVersion, extensionPrefix, installedAt("claude", "package.json"), seatClone);
  }
} finally {
  rmSync(base, { recursive: true, force: true });
}

console.log(`\nseed-tarball smoke: ${passed()} passed, ${failed()} failed`);
finish();
process.exit(failed() ? 1 : 0);
