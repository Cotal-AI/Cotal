/**
 * `cotal update` keeps a built-in only when the extensions prefix is the tree its lock records
 * (`prefixLockDiffers`). An optional package that is absent is excused only under npm's own platform
 * rule: npm-install-checks `checkPlatform`, with negated `os`/`cpu` entries, `any`, bare strings and
 * `libc`. The first cut read `["!darwin"]` as excluding Linux and excused a package npm had actually
 * installed and that had since gone missing.
 *
 * The lock entries here are written by the real `npm install --install-links` over file: packages in
 * a private prefix, never by hand, so the suite proves the reader against what npm records.
 * Broker-free; needs `npm` on PATH and no network. Run: pnpm smoke:seed-verify-platform
 */
import { createHash } from "node:crypto";
import { execFile, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { emitSentinel } from "@cotal-ai/smoke-kit";
import { resolveOnPath } from "@cotal-ai/workspace";
import { admits, packagesMissingOptionalDependencies, platformExcludesHost, prefixLockDiffers } from "../src/seed/verify.js";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ FAIL: ${name}`, extra ?? "");
  }
}

const here = process.platform;
const elsewhere = here === "darwin" ? "linux" : "darwin";
const otherArch = process.arch === "arm64" ? "x64" : "arm64";

// ── admits: npm-install-checks checkList, entry by entry ──────────────────────────────────────────
check("admits: a plain match", admits(here, [here]));
check("admits: a plain mismatch is left out", !admits(here, [elsewhere]));
check("admits: a negated other platform admits this one", admits(here, [`!${elsewhere}`]));
check("admits: a negated own platform leaves it out", !admits(here, [`!${here}`]));
check("admits: mixed list needs a plain match and no negated hit", admits(here, [`!${elsewhere}`, here]) && !admits(here, [`!${elsewhere}`, elsewhere]));
check("admits: any admits everything", admits(here, ["any"]));
check("admits: a bare string is a one-entry list", admits(here, here) && !admits(here, elsewhere));
check("admits: an empty list admits (nothing required, nothing negated)", admits(here, []));
check("admits: an unreadable list admits, so an absent package is reported, not excused", admits(here, 42) && admits(here, [1, 2]));

// ── platformExcludesHost: os, cpu, libc together ─────────────────────────────────────────────────
const host = { platform: here, arch: process.arch, libc: () => "glibc" as string | undefined };
check("platform: negated other os does not exclude", !platformExcludesHost({ os: [`!${elsewhere}`] }, host));
check("platform: other os excludes", platformExcludesHost({ os: [elsewhere] }, host));
check("platform: other cpu excludes even when os admits", platformExcludesHost({ os: [here], cpu: [otherArch] }, host));
check("platform: libc mismatch excludes", platformExcludesHost({ libc: ["musl"] }, host));
check("platform: libc requirement on a host with no libc excludes", platformExcludesHost({ libc: ["glibc"] }, { ...host, libc: () => undefined }));
check("platform: libc match admits", !platformExcludesHost({ os: ["linux"], libc: ["glibc"] }, { ...host, platform: "linux" }));
check("platform: no lists, nothing excluded", !platformExcludesHost({}, host));

// ── prefixLockDiffers over a lock the real npm wrote ─────────────────────────────────────────────
const base = mkdtempSync(join(tmpdir(), "cotal-seed-verify-platform-"));
const savedEnv = {
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  npm_config_cache: process.env.npm_config_cache,
  npm_config_registry: process.env.npm_config_registry,
  npm_config_userconfig: process.env.npm_config_userconfig,
  npm_config_globalconfig: process.env.npm_config_globalconfig,
  npm_config_package_lock: process.env.npm_config_package_lock,
  npm_config_offline: process.env.npm_config_offline,
};
const savedPlatform = Object.getOwnPropertyDescriptor(process, "platform");
try {
  const realNpm = resolveOnPath("npm", process.env);
  if (!realNpm) throw new Error("the smoke needs npm on PATH");
  const prefix = join(base, "xdg", "cotal", "extensions");
  const fixtures = join(base, "fixtures");
  mkdirSync(prefix, { recursive: true });
  mkdirSync(join(base, "home"), { recursive: true });
  const fixture = (name: string, platform: Record<string, unknown>): string => {
    const dir = join(fixtures, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0", ...platform }));
    writeFileSync(join(dir, "index.js"), "");
    return dir;
  };
  const optional = {
    "probe-negated-other": fixture("probe-negated-other", { os: [`!${elsewhere}`] }), // npm installs it here
    "probe-other-os": fixture("probe-other-os", { os: [elsewhere] }), // npm leaves it out here
    "probe-any": fixture("probe-any", { os: ["any"] }),
    "probe-other-cpu": fixture("probe-other-cpu", { cpu: [otherArch] }),
  };
  writeFileSync(join(prefix, "package.json"), JSON.stringify({
    name: "cotal-extensions", private: true,
    dependencies: { "probe-plain": fixture("probe-plain", {}) },
    optionalDependencies: Object.fromEntries(Object.entries(optional).map(([name, dir]) => [name, `file:${dir}`])),
  }));
  const userNpmrc = join(base, "user.npmrc");
  const globalNpmrc = join(base, "global.npmrc");
  for (const file of [userNpmrc, globalNpmrc]) writeFileSync(file, "");
  const env = {
    PATH: process.env.PATH ?? "", HOME: join(base, "home"), npm_config_cache: join(base, "npm-cache"),
    npm_config_userconfig: userNpmrc, npm_config_globalconfig: globalNpmrc,
    npm_config_update_notifier: "false", DO_NOT_TRACK: "1",
  };
  const install = spawnSync("npm", ["install", "--no-audit", "--no-fund", "--ignore-scripts", "--install-links"], { cwd: prefix, env, encoding: "utf8" });
  check("real npm installs the prefix", install.status === 0, install.stderr.slice(-600));
  const lock = JSON.parse(readFileSync(join(prefix, "package-lock.json"), "utf8")) as { packages: Record<string, { optional?: boolean; os?: string[]; cpu?: string[] }> };
  const entry = (name: string) => lock.packages[`node_modules/${name}`];
  check("npm recorded the negated os list on the optional entry", entry("probe-negated-other")?.optional === true && JSON.stringify(entry("probe-negated-other")?.os) === JSON.stringify([`!${elsewhere}`]), entry("probe-negated-other"));
  check("npm installed the negated-other-os package here", existsSync(join(prefix, "node_modules", "probe-negated-other", "package.json")));
  check("npm left the other-os and other-cpu packages out here", !existsSync(join(prefix, "node_modules", "probe-other-os")) && !existsSync(join(prefix, "node_modules", "probe-other-cpu")));
  check("npm recorded the other-os and other-cpu entries anyway", entry("probe-other-os")?.os?.[0] === elsewhere && entry("probe-other-cpu")?.cpu?.[0] === otherArch);

  const tools = join(base, "tools");
  const npmCalls = join(tools, "npm-calls.log");
  mkdirSync(tools, { recursive: true });
  writeFileSync(join(tools, "npm"), `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
appendFileSync(${JSON.stringify(npmCalls)}, process.argv.slice(2).join(" ") + "\\n");
process.exit(spawnSync(${JSON.stringify(realNpm)}, process.argv.slice(2), { stdio: "inherit" }).status ?? 1);
`, { mode: 0o755 });
  if (here === "win32") writeFileSync(join(tools, "npm.cmd"), `@"${process.execPath}" "%~dp0\\npm" %*\r\n`);

  process.env.XDG_CONFIG_HOME = join(base, "xdg");
  process.env.HOME = join(base, "home");
  process.env.npm_config_userconfig = userNpmrc;
  process.env.npm_config_globalconfig = globalNpmrc;
  process.env.PATH = `${tools}${delimiter}${savedEnv.PATH ?? ""}`;

  check("real npm also wrote node_modules/.package-lock.json", existsSync(join(prefix, "node_modules", ".package-lock.json")));
  check("intact prefix: platform-excluded absences are not differences", prefixLockDiffers() === undefined && prefixLockDiffers() === undefined, prefixLockDiffers());
  check("default package-lock=true verification and stage pass do not spawn npm when package-lock.json covers the tree",
    packagesMissingOptionalDependencies(prefix).length === 0 && !existsSync(npmCalls));

  // Simulated Windows without npm on PATH: readPrefixLock must never throw.
  const emptyPath = join(base, "empty-path");
  mkdirSync(emptyPath, { recursive: true });
  process.env.PATH = emptyPath;
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  try {
    let validResult: string | undefined | Error;
    try { validResult = prefixLockDiffers(); } catch (e) { validResult = e as Error; }
    check("simulated win32 without npm on PATH verifies a valid public lock without throwing", validResult === undefined, validResult);
    renameSync(join(prefix, "package-lock.json"), join(prefix, "package-lock.json.aside"));
    let missingResult: string | undefined | Error;
    try { missingResult = prefixLockDiffers(); } catch (e) { missingResult = e as Error; }
    check("simulated win32 without npm on PATH returns a reason string when the public lock is missing",
      typeof missingResult === "string" && missingResult.startsWith("the prefix lock is unreadable"), missingResult);
    renameSync(join(prefix, "package-lock.json.aside"), join(prefix, "package-lock.json"));
  } finally {
    if (savedPlatform) Object.defineProperty(process, "platform", savedPlatform);
    process.env.PATH = `${tools}${delimiter}${savedEnv.PATH ?? ""}`;
  }

  // Failed npm config query (non-zero exit or unexpected stdout) falls back to public-lock check without throwing.
  const brokenTools = join(base, "broken-tools");
  mkdirSync(brokenTools, { recursive: true });
  writeFileSync(join(brokenTools, "npm"), "#!/usr/bin/env node\nconsole.log('unexpected-value'); process.exit(2);\n", { mode: 0o755 });
  if (here === "win32") writeFileSync(join(brokenTools, "npm.cmd"), `@"${process.execPath}" "%~dp0\\npm" %*\r\n`);
  process.env.PATH = brokenTools;
  renameSync(join(prefix, "package-lock.json"), join(prefix, "package-lock.json.aside"));
  check("non-zero npm config exit returns public-lock reason string",
    prefixLockDiffers()?.startsWith("the prefix lock is unreadable") === true, prefixLockDiffers());
  renameSync(join(prefix, "package-lock.json.aside"), join(prefix, "package-lock.json"));
  process.env.PATH = `${tools}${delimiter}${savedEnv.PATH ?? ""}`;

  const plain = join(prefix, "node_modules", "probe-plain", "package.json");
  // Default package-lock=true stage pass deletes nothing even when an installed package declares an absent non-suffix optional.
  writeFileSync(plain, JSON.stringify({
    name: "probe-plain",
    version: "1.0.0",
    optionalDependencies: { "@probe/sharp-wasm32": "1.0.0", [`@probe/native-${here}-${process.arch}`]: "1.0.0" },
  }));
  check("default package-lock=true stage pass deletes no packages",
    packagesMissingOptionalDependencies(prefix).length === 0, packagesMissingOptionalDependencies(prefix));
  writeFileSync(plain, JSON.stringify({ name: "probe-plain", version: "1.0.0" }));

  const negated = join(prefix, "node_modules", "probe-negated-other");
  renameSync(negated, `${negated}.aside`);
  const missingNegated = prefixLockDiffers();
  check("a missing package npm installed under a negated os list is a difference", missingNegated === "node_modules/probe-negated-other is recorded in the prefix lock but not installed", missingNegated);
  renameSync(`${negated}.aside`, negated);

  const any = join(prefix, "node_modules", "probe-any");
  renameSync(any, `${any}.aside`);
  const missingAny = prefixLockDiffers();
  check("a missing package under os any is a difference", missingAny === "node_modules/probe-any is recorded in the prefix lock but not installed", missingAny);
  renameSync(`${any}.aside`, any);

  writeFileSync(plain, JSON.stringify({ name: "probe-plain", version: "1.0.1" }));
  const skewed = prefixLockDiffers();
  check("a version other than the lock's is a difference", skewed === "node_modules/probe-plain is 1.0.1 on disk and 1.0.0 in the prefix lock", skewed);
  writeFileSync(plain, JSON.stringify({ name: "probe-plain", version: "1.0.0" }));

  rmSync(join(prefix, "package-lock.json"));
  check("no lock at all is a difference", prefixLockDiffers()?.startsWith("the prefix lock is unreadable") === true, prefixLockDiffers());

  // ── package-lock=false over node_modules/.package-lock.json ─────────────────────────────────────
  rmSync(npmCalls, { force: true });
  process.env.npm_config_package_lock = "false";
  check("literal npm_config_package_lock=false excuses foreign-platform file optionals with zero npm calls",
    prefixLockDiffers() === undefined && !existsSync(npmCalls), prefixLockDiffers());
  process.env.npm_config_package_lock = "true";
  check("literal npm_config_package_lock=true treats package locks as enabled with zero npm calls",
    prefixLockDiffers()?.startsWith("the prefix lock is unreadable") === true &&
    packagesMissingOptionalDependencies(prefix).length === 0 && !existsSync(npmCalls));
  delete process.env.npm_config_package_lock;

  writeFileSync(userNpmrc, "package-lock=false\n");
  check("package-lock=false in .npmrc asks npm once and caches the lookup across repeated checks",
    prefixLockDiffers() === undefined && prefixLockDiffers() === undefined && prefixLockDiffers() === undefined, prefixLockDiffers());
  const npmrcCalls = existsSync(npmCalls) ? readFileSync(npmCalls, "utf8").trim().split("\n") : [];
  check("package-lock=false in .npmrc spawned npm config once under 022-safe path", npmrcCalls.length === 1, npmrcCalls);

  // Five .npmrc / env configurations where naive parsing disagrees with npm:
  writeFileSync(plain, JSON.stringify({
    name: "probe-plain",
    version: "1.0.0",
    optionalDependencies: { [`@probe/native-${here}-${process.arch}`]: "1.0.0" },
  }));
  writeFileSync(userNpmrc, "package-lock=FALSE\n");
  check("package-lock=FALSE (uppercase) agrees with npm that locks remain enabled and keeps the deletion gate closed",
    prefixLockDiffers()?.startsWith("the prefix lock is unreadable") === true &&
    packagesMissingOptionalDependencies(prefix).length === 0);
  writeFileSync(userNpmrc, "[foo]\npackage-lock=false\n");
  check("sectioned [foo] package-lock=false agrees with npm that locks remain enabled and keeps the deletion gate closed",
    prefixLockDiffers()?.startsWith("the prefix lock is unreadable") === true &&
    packagesMissingOptionalDependencies(prefix).length === 0);
  process.env.PROBING_LOCK = "true";
  writeFileSync(userNpmrc, "package-lock=false\n");
  writeFileSync(join(prefix, ".npmrc"), "package-lock=${PROBING_LOCK}\n");
  check("interpolated project package-lock=true over user false agrees with npm that locks remain enabled",
    prefixLockDiffers()?.startsWith("the prefix lock is unreadable") === true &&
    packagesMissingOptionalDependencies(prefix).length === 0);
  writeFileSync(plain, JSON.stringify({ name: "probe-plain", version: "1.0.0" }));
  process.env.PROBING_LOCK = "false";
  writeFileSync(userNpmrc, "package-lock=true\n");
  writeFileSync(join(prefix, ".npmrc"), "package-lock=${PROBING_LOCK}\n");
  check("interpolated project package-lock=false over user true agrees with npm that locks are disabled",
    prefixLockDiffers() === undefined, prefixLockDiffers());
  rmSync(join(prefix, ".npmrc"), { force: true });
  delete process.env.PROBING_LOCK;
  process.env.npm_config_package_lock = "";
  writeFileSync(userNpmrc, "package-lock=false\n");
  check("empty npm_config_package_lock over user package-lock=false agrees with npm that locks are disabled",
    prefixLockDiffers() === undefined, prefixLockDiffers());
  delete process.env.npm_config_package_lock;
  writeFileSync(userNpmrc, "package-lock=false\n");

  // Registry-style platform-suffixed optional dependencies on an installed package.
  writeFileSync(plain, JSON.stringify({
    name: "probe-plain",
    version: "1.0.0",
    optionalDependencies: {
      [`@probe/native-${elsewhere}-${otherArch}`]: "1.0.0",
      ...(here === "darwin" ? {} : { fsevents: "~2.3.3" }),
    },
  }));
  check("package-lock=false excuses foreign-platform native optionalDependencies absent from .package-lock.json",
    prefixLockDiffers() === undefined, prefixLockDiffers());

  writeFileSync(plain, JSON.stringify({
    name: "probe-plain",
    version: "1.0.0",
    optionalDependencies: { [`@probe/native-${here}-${process.arch}`]: "1.0.0" },
  }));
  const missingHostNative = prefixLockDiffers();
  check("package-lock=false detects a missing host-admissible native optionalDependency",
    missingHostNative === `node_modules/@probe/native-${here}-${process.arch} is recorded in optionalDependencies but not installed`,
    missingHostNative);
  check("package-lock=false stage pass flags only packages whose missing optional verify reports",
    packagesMissingOptionalDependencies(prefix).join(",") === join(prefix, "node_modules", "probe-plain"));

  // Offline settings keep the stage deletion gate closed.
  process.env.npm_config_offline = "true";
  check("literal npm_config_offline=true skips stage optional deletion",
    packagesMissingOptionalDependencies(prefix).length === 0);
  delete process.env.npm_config_offline;
  writeFileSync(userNpmrc, "package-lock=false\noffline=true\n");
  check("offline=true in .npmrc skips stage optional deletion",
    packagesMissingOptionalDependencies(prefix).length === 0);
  writeFileSync(userNpmrc, "package-lock=false\n");

  // Symlinked node_modules folders (nested or top-level) are never followed outside the stage.
  if (here !== "win32") {
    writeFileSync(plain, JSON.stringify({ name: "probe-plain", version: "1.0.0" }));
    const outsideNm = join(base, "outside-nm");
    const outsideVictim = join(outsideNm, "victim");
    mkdirSync(outsideVictim, { recursive: true });
    writeFileSync(join(outsideVictim, "package.json"), JSON.stringify({
      name: "victim",
      version: "1.0.0",
      optionalDependencies: { [`@probe/native-${here}-${process.arch}`]: "1.0.0" },
    }));
    const nestedLink = join(prefix, "node_modules", "probe-plain", "node_modules");
    symlinkSync(outsideNm, nestedLink, "dir");
    check("stage walk skips a symlinked nested node_modules pointing outside the stage",
      packagesMissingOptionalDependencies(prefix).length === 0 && existsSync(join(outsideVictim, "package.json")));
    rmSync(nestedLink, { force: true });
    const linkedStage = join(base, "linked-stage");
    mkdirSync(linkedStage, { recursive: true });
    writeFileSync(join(linkedStage, "package.json"), JSON.stringify({ name: "linked-stage", private: true }));
    symlinkSync(outsideNm, join(linkedStage, "node_modules"), "dir");
    check("stage walk skips a symlinked top-level node_modules pointing outside the stage",
      packagesMissingOptionalDependencies(linkedStage, prefix).length === 0 && existsSync(join(outsideVictim, "package.json")));
  }

  // Real npm fills _cacache from a loopback registry (using npm's lowercase %2f scoped key) for scoped
  // optionals whose package names the suffix heuristic misreads.
  const customCache = join(base, "cacache-real-npm");
  const packWork = join(base, "pack-work");
  mkdirSync(packWork, { recursive: true });
  const misreadForeignName = `@probe/addon-${here}-${process.arch}`;
  const misreadHostName = `@probe/addon-${elsewhere}-${otherArch}`;
  const packFixture = (slug: string, pkgJson: Record<string, unknown>): Buffer => {
    const dir = join(packWork, slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify(pkgJson));
    writeFileSync(join(dir, "index.js"), "");
    const before = new Set(readdirSync(packWork));
    const packed = spawnSync(realNpm, ["pack", "--silent", "--pack-destination", packWork, dir], { env, encoding: "utf8" });
    if (packed.status !== 0) throw new Error(`npm pack failed: ${packed.stderr}`);
    const tgzFile = readdirSync(packWork).find((f) => f.endsWith(".tgz") && !before.has(f))!;
    return readFileSync(join(packWork, tgzFile));
  };
  const misreadForeignTgz = packFixture("misread-foreign", { name: misreadForeignName, version: "1.0.0", cpu: ["wasm32"] });
  const misreadHostTgz = packFixture("misread-host", { name: misreadHostName, version: "1.0.0", os: [here], cpu: [process.arch] });
  const sharpWasmTgz = packFixture("sharp-wasm32", { name: "@probe/sharp-wasm32", version: "1.0.0", cpu: ["wasm32"] });
  const distMeta = (port: number, route: string, bytes: Buffer) => ({
    tarball: `http://127.0.0.1:${port}/${route}`,
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    shasum: createHash("sha1").update(bytes).digest("hex"),
  });
  let loopPort = 0;
  const loopServer = createServer((req, res) => {
    const path = decodeURIComponent(req.url!);
    if (path === `/${misreadForeignName}`) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        name: misreadForeignName, "dist-tags": { latest: "1.0.0" },
        versions: { "1.0.0": { name: misreadForeignName, version: "1.0.0", cpu: ["wasm32"], dist: distMeta(loopPort, "misread-foreign.tgz", misreadForeignTgz) } },
      }));
    } else if (path === `/${misreadHostName}`) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        name: misreadHostName, "dist-tags": { latest: "1.0.0" },
        versions: { "1.0.0": { name: misreadHostName, version: "1.0.0", os: [here], cpu: [process.arch], dist: distMeta(loopPort, "misread-host.tgz", misreadHostTgz) } },
      }));
    } else if (path === "/@probe/sharp-wasm32") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        name: "@probe/sharp-wasm32", "dist-tags": { latest: "1.0.0" },
        versions: { "1.0.0": { name: "@probe/sharp-wasm32", version: "1.0.0", cpu: ["wasm32"], dist: distMeta(loopPort, "sharp-wasm32.tgz", sharpWasmTgz) } },
      }));
    } else if (path === "/misread-foreign.tgz") {
      res.setHeader("content-type", "application/octet-stream"); res.end(misreadForeignTgz);
    } else if (path === "/misread-host.tgz") {
      res.setHeader("content-type", "application/octet-stream"); res.end(misreadHostTgz);
    } else if (path === "/sharp-wasm32.tgz") {
      res.setHeader("content-type", "application/octet-stream"); res.end(sharpWasmTgz);
    } else {
      res.statusCode = 404; res.end('{"error":"not found"}');
    }
  });
  await new Promise<void>((resolveListen, reject) => loopServer.once("error", reject).listen(0, "127.0.0.1", resolveListen));
  try {
    const addr = loopServer.address();
    if (!addr || typeof addr === "string") throw new Error("loopback server has no port");
    loopPort = addr.port;
    writeFileSync(userNpmrc, `@probe:registry=http://127.0.0.1:${loopPort}\npackage-lock=false\n`);
    const warmupDir = join(base, "cache-warmup");
    mkdirSync(warmupDir, { recursive: true });
    writeFileSync(join(warmupDir, "package.json"), JSON.stringify({
      name: "cache-warmup", private: true,
      optionalDependencies: {
        [misreadForeignName]: "^1.0.0",
        [misreadHostName]: "^1.0.0",
        "@probe/sharp-wasm32": "^1.0.0",
      },
    }));
    const warmup = await promisify(execFile)(realNpm, ["install", "--no-audit", "--no-fund", "--ignore-scripts"], {
      cwd: warmupDir,
      env: { ...env, npm_config_userconfig: userNpmrc, npm_config_cache: customCache, npm_config_fetch_retries: "0" },
      timeout: 30_000,
    });
    check("real npm populates _cacache from loopback registry and honors metadata over package names",
      !existsSync(join(warmupDir, "node_modules", ...misreadForeignName.split("/"))) &&
      existsSync(join(warmupDir, "node_modules", ...misreadHostName.split("/"), "package.json")),
      warmup.stderr);
  } finally {
    await new Promise<void>((resolveClose, reject) => loopServer.close((err) => err ? reject(err) : resolveClose()));
  }
  process.env.npm_config_cache = customCache;
  writeFileSync(plain, JSON.stringify({
    name: "probe-plain",
    version: "1.0.0",
    optionalDependencies: {
      [misreadForeignName]: "^1.0.0",
      "@probe/sharp-wasm32": "^1.0.0",
      "@probe/unknown-unindexed-addon": "^1.0.0",
    },
  }));
  check("package-lock=false reads real npm %2f cache entry to excuse a scoped optional whose name suffix matches this host",
    prefixLockDiffers() === undefined && packagesMissingOptionalDependencies(prefix).length === 0, prefixLockDiffers());

  writeFileSync(plain, JSON.stringify({
    name: "probe-plain",
    version: "1.0.0",
    optionalDependencies: { [misreadHostName]: "^1.0.0" },
  }));
  const missingCachedHost = prefixLockDiffers();
  check("package-lock=false reads real npm %2f cache entry to report a missing scoped optional whose name suffix matches another platform",
    missingCachedHost === `node_modules/${misreadHostName} is recorded in optionalDependencies but not installed` &&
    packagesMissingOptionalDependencies(prefix).join(",") === join(prefix, "node_modules", "probe-plain"),
    missingCachedHost);
  writeFileSync(userNpmrc, "package-lock=false\n");

  // Stale public lock entry supplies os/cpu/libc when the npm cache is cold.
  process.env.npm_config_cache = join(base, "cold-cache");
  writeFileSync(join(prefix, "package-lock.json"), JSON.stringify({
    lockfileVersion: 3,
    packages: {
      "": { dependencies: { "probe-stale-only": "0.0.1" } },
      "node_modules/@probe/sharp-linuxmusl-custom": { version: "1.0.0", optional: true, os: [elsewhere] },
      "node_modules/@probe/sharp-host-locked": { version: "1.0.0", optional: true, os: [here], cpu: [process.arch] },
    },
  }));
  writeFileSync(plain, JSON.stringify({
    name: "probe-plain",
    version: "1.0.0",
    optionalDependencies: { "@probe/sharp-linuxmusl-custom": "^1.0.0" },
  }));
  check("package-lock=false excuses an absent non-suffix optional using its stale public lock platform lists",
    prefixLockDiffers() === undefined && packagesMissingOptionalDependencies(prefix).length === 0, prefixLockDiffers());
  writeFileSync(plain, JSON.stringify({
    name: "probe-plain",
    version: "1.0.0",
    optionalDependencies: { "@probe/sharp-host-locked": "^1.0.0" },
  }));
  check("package-lock=false reports an absent non-suffix optional whose stale public lock admits this host",
    prefixLockDiffers() === "node_modules/@probe/sharp-host-locked is recorded in optionalDependencies but not installed",
    prefixLockDiffers());
  rmSync(join(prefix, "package-lock.json"));

  // Local-path package whose source folder is gone is never flagged for stage deletion or reinstall loop.
  const goneLocalSource = join(base, "gone-local-source");
  const rootManifest = readFileSync(join(prefix, "package.json"), "utf8");
  const parsedRoot = JSON.parse(rootManifest) as { dependencies: Record<string, string> };
  parsedRoot.dependencies["probe-plain"] = `file:${goneLocalSource}`;
  writeFileSync(join(prefix, "package.json"), JSON.stringify(parsedRoot));
  writeFileSync(plain, JSON.stringify({
    name: "probe-plain",
    version: "1.0.0",
    optionalDependencies: { [`@probe/native-${here}-${process.arch}`]: "1.0.0" },
  }));
  check("package-lock=false keeps an installed local-path package whose source folder is gone",
    prefixLockDiffers() === undefined && packagesMissingOptionalDependencies(prefix).length === 0, prefixLockDiffers());
  writeFileSync(join(prefix, "package.json"), rootManifest);
  delete process.env.npm_config_cache;
  delete process.env.npm_config_registry;
  writeFileSync(plain, JSON.stringify({ name: "probe-plain", version: "1.0.0" }));

  // Real npm with --omit=optional under package-lock=false strips optional packages from both disk and .package-lock.json.
  const omitEnv = { ...env, npm_config_userconfig: userNpmrc };
  const omitted = spawnSync(realNpm, ["install", "--omit=optional", "--no-audit", "--no-fund", "--ignore-scripts", "--install-links"], { cwd: prefix, env: omitEnv, encoding: "utf8" });
  const hiddenAfterOmit = JSON.parse(readFileSync(join(prefix, "node_modules", ".package-lock.json"), "utf8")) as { packages: Record<string, unknown> };
  check("real npm --omit=optional with package-lock=false removes host optional package from disk and .package-lock.json",
    omitted.status === 0 && !existsSync(negated) && hiddenAfterOmit.packages["node_modules/probe-negated-other"] === undefined, omitted.stderr);
  const omittedDiffers = prefixLockDiffers();
  check("package-lock=false detects the omitted host-admissible optional dependency",
    omittedDiffers === "node_modules/probe-negated-other is recorded in optionalDependencies but not installed", omittedDiffers);
  const repaired = spawnSync(realNpm, ["install", "--include=optional", "--no-audit", "--no-fund", "--ignore-scripts", "--install-links"], { cwd: prefix, env: omitEnv, encoding: "utf8" });
  check("reinstalling with --include=optional under package-lock=false restores a clean verification",
    repaired.status === 0 && !existsSync(join(prefix, "package-lock.json")) && prefixLockDiffers() === undefined, prefixLockDiffers());

  // Real npm writes ../ keys into node_modules/.package-lock.json when a prefix is reached through a symlink.
  if (here !== "win32") {
    const symReal = join(base, "sym-real", "cotal", "extensions");
    const symLink = join(base, "sym-link");
    mkdirSync(symReal, { recursive: true });
    symlinkSync(join(base, "sym-real"), symLink, "dir");
    writeFileSync(join(symReal, "package.json"), JSON.stringify({ name: "cotal-extensions", private: true }));
    const symDep = fixture("sym-dep", {});
    const symA = fixture("sym-a", { dependencies: { "sym-dep": `file:${symDep}` } });
    const symB = fixture("sym-b", {});
    const linkedPrefix = join(symLink, "cotal", "extensions");
    const addSym = spawnSync(realNpm, ["install", "--save", "--no-audit", "--no-fund", "--ignore-scripts", "--install-links", symA, symB, "--prefix", linkedPrefix], { env: omitEnv, encoding: "utf8" });
    const rmSym = spawnSync(realNpm, ["remove", "--no-audit", "--no-fund", "--install-links", "sym-b", "--prefix", linkedPrefix], { env: omitEnv, encoding: "utf8" });
    const symHidden = JSON.parse(readFileSync(join(linkedPrefix, "node_modules", ".package-lock.json"), "utf8")) as { packages: Record<string, unknown> };
    const symKeys = Object.keys(symHidden.packages);
    check("real npm writes ../ package keys in .package-lock.json under a symlinked prefix",
      addSym.status === 0 && rmSym.status === 0 && symKeys.length >= 2 && symKeys.every((key) => key.startsWith("../")), symKeys);
    process.env.XDG_CONFIG_HOME = symLink;
    check("package-lock=false accepts intact ../ entries in .package-lock.json", prefixLockDiffers() === undefined, prefixLockDiffers());
    writeFileSync(join(linkedPrefix, "node_modules", "sym-dep", "package.json"), JSON.stringify({ name: "sym-dep", version: "9.9.9" }));
    const symSkewed = prefixLockDiffers();
    check("package-lock=false detects a version-skewed ../ entry in .package-lock.json",
      typeof symSkewed === "string" && symSkewed.includes("sym-dep is 9.9.9 on disk and 1.0.0 in the prefix lock"), symSkewed);
    rmSync(join(linkedPrefix, "node_modules", "sym-dep"), { recursive: true, force: true });
    const symMissing = prefixLockDiffers();
    check("package-lock=false detects a missing ../ entry in .package-lock.json",
      typeof symMissing === "string" && symMissing.includes("sym-dep is recorded in the prefix lock but not installed"), symMissing);
  }
} finally {
  if (savedPlatform) Object.defineProperty(process, "platform", savedPlatform);
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(base, { recursive: true, force: true });
}

console.log(`\nseed-verify-platform smoke: ${pass} passed, ${fail} failed`);
emitSentinel({ passed: pass, failed: fail });
process.exit(fail ? 1 : 0);
