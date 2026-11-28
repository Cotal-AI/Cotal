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
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve, sep } from "node:path";
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

function snapshotTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = join(dir, entry.name);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) out[rel] = `link:${realpathSync(full)}`;
      else if (st.isDirectory()) walk(full, rel);
      else out[rel] = createHash("sha256").update(readFileSync(full)).digest("hex");
    }
  };
  walk(root, "");
  return out;
}

async function checkPackageLockCellsAndUpgrade(
  entry: string,
  version: string,
  seatClone: string,
  packedTgzDir: string,
): Promise<void> {
  const exec = promisify(execFile);
  const noNpmEnv: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(cleanEnv).filter(([key]) => !key.toLowerCase().startsWith("npm_config_")),
  );
  const realNpm = resolveOnPath("npm", noNpmEnv);
  if (!realNpm) throw new Error("the smoke needs npm on PATH");
  const root = mkdtempSync(join(tmpdir(), "cotal-package-lock-"));
  const builtInPkgs = [
    "@cotal-ai/connector-claude-code", "@cotal-ai/connector-opencode", "@cotal-ai/connector-codex",
    "@cotal-ai/connector-hermes", "@cotal-ai/connector-jcode", "@cotal-ai/pi", "@cotal-ai/web",
  ];
  const makeCase = (name: string) => {
    const dir = join(root, name);
    const home = join(dir, "home");
    const appData = join(dir, "appdata");
    const cotalHome = join(dir, "cotal-home");
    const xdg = join(dir, "xdg");
    const tmp = join(dir, "tmp");
    const globalPrefix = join(dir, "npm-global");
    const cache = join(dir, "npm-cache");
    for (const d of [dir, home, appData, cotalHome, xdg, tmp, globalPrefix, cache]) mkdirSync(d, { recursive: true, mode: 0o700 });
    const userNpmrc = join(dir, "user.npmrc");
    const globalNpmrc = join(dir, "global.npmrc");
    writeFileSync(userNpmrc, "");
    writeFileSync(globalNpmrc, "");
    const env: NodeJS.ProcessEnv = {
      ...noNpmEnv,
      HOME: home, USERPROFILE: home, APPDATA: appData, LOCALAPPDATA: appData,
      COTAL_HOME: cotalHome, XDG_CONFIG_HOME: xdg, TMPDIR: tmp, TMP: tmp, TEMP: tmp,
      npm_config_prefix: globalPrefix, npm_config_cache: cache,
      npm_config_userconfig: userNpmrc, npm_config_globalconfig: globalNpmrc,
      DO_NOT_TRACK: "1",
    };
    return { dir, home, xdg, globalPrefix, cache, userNpmrc, env };
  };
  const globalCliEntry = (globalPrefix: string): string =>
    process.platform === "win32"
      ? join(globalPrefix, "node_modules", "cotal-ai", "dist", "cotal.js")
      : join(globalPrefix, "bin", "cotal");
  const runNpm = (args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; timeout?: number }) =>
    exec(realNpm, args, { ...opts, shell: process.platform === "win32" });
  const runGlobalCli = (globalPrefix: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; timeout?: number }) => {
    const target = globalCliEntry(globalPrefix);
    return process.platform === "win32"
      ? exec(process.execPath, [target, ...args], opts)
      : exec(target, args, opts);
  };
  const lockHasAllBuiltIns = (lockPath: string, ver: string): boolean => {
    if (!existsSync(lockPath)) return false;
    const lock = JSON.parse(readFileSync(lockPath, "utf8")) as { packages?: Record<string, { version?: string }> };
    return builtInPkgs.every(pkg => lock.packages?.[`node_modules/${pkg}`]?.version === ver);
  };

  // Pack head packages both at current version (from packedTgzDir) and bumped strictly above both local and registry latest for real self-update.
  const latestResp = await fetch("https://registry.npmjs.org/cotal-ai/latest", { signal: AbortSignal.timeout(30_000) });
  const registryLatest = latestResp.ok
    ? ((await latestResp.json()) as { version?: string }).version ?? version
    : version;
  const parseTriple = (v: string): [number, number, number] => {
    const [a = 0, b = 0, c = 0] = v.split("-")[0]!.split(".").map(Number);
    return [a, b, c];
  };
  const [lmaj, lmin, lpat] = parseTriple(version);
  const [rmaj, rmin, rpat] = parseTriple(registryLatest);
  const higher = lmaj !== rmaj ? (lmaj > rmaj ? [lmaj, lmin, lpat] : [rmaj, rmin, rpat])
    : lmin !== rmin ? (lmin > rmin ? [lmaj, lmin, lpat] : [rmaj, rmin, rpat])
    : lpat >= rpat ? [lmaj, lmin, lpat] : [rmaj, rmin, rpat];
  const targetVer = `${higher[0]}.${higher[1]}.${higher[2] + 1}`;
  const candidateOut = join(root, "cand-tgz");
  mkdirSync(candidateOut, { recursive: true });
  const allDirs = [
    "bin",
    ...["packages", "implementations", "extensions"].flatMap(group =>
      readdirSync(join(REPO, group)).map(sub => `${group}/${sub}`).filter(rel => existsSync(join(REPO, rel, "package.json")))),
  ];
  const fixedNames = new Set((JSON.parse(readFileSync(join(REPO, ".changeset/config.json"), "utf8")) as { fixed: string[][] }).fixed.flat());
  const cloneWs = join(root, "ws");
  mkdirSync(cloneWs, { recursive: true });
  for (const name of ["package.json", "pnpm-workspace.yaml", "tsconfig.base.json"]) cpSync(join(REPO, name), join(cloneWs, name));
  symlinkSync(join(REPO, "node_modules"), join(cloneWs, "node_modules"), "dir");
  const candidateEntries = new Map<string, { meta: Record<string, unknown>; archive: string }>();
  const currentEntries = new Map<string, { meta: Record<string, unknown>; archive: string }>();
  const archiveBytes = new Map<string, Buffer>();
  for (const tgzName of readdirSync(packedTgzDir).filter(f => f.endsWith(".tgz"))) {
    const full = join(packedTgzDir, tgzName);
    const bytes = readFileSync(full);
    const meta = JSON.parse(execFileSync("tar", ["xzf", full, "-O", "package/package.json"], { env: noNpmEnv, encoding: "utf8" })) as Record<string, unknown> & { name: string };
    const key = `cur-${tgzName}`;
    currentEntries.set(meta.name, { meta, archive: key });
    archiveBytes.set(key, bytes);
  }
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
    execFileSync("pnpm", ["-C", dst, "pack", ...skip, "--pack-destination", candidateOut], { env: noNpmEnv, stdio: ["ignore", "ignore", "inherit"] });
    const tgzName = readdirSync(candidateOut).find(f => !before.has(f) && f.endsWith(".tgz"))!;
    const bytes = readFileSync(join(candidateOut, tgzName));
    const packedMeta = JSON.parse(execFileSync("tar", ["xzf", join(candidateOut, tgzName), "-O", "package/package.json"], { env: noNpmEnv, encoding: "utf8" })) as Record<string, unknown> & { name: string };
    const key = `cand-${tgzName}`;
    candidateEntries.set(packedMeta.name, { meta: packedMeta, archive: key });
    archiveBytes.set(key, bytes);
  }

  const upstreamCache = new Map<string, Record<string, unknown>>();
  let overlayUrl = "";
  let serveMode: "current" | "candidate" = "current";
  const overlay = createServer(async (req, res) => {
    try {
      const urlObj = new URL(req.url!, "http://localhost");
      if (urlObj.pathname.startsWith("/refused")) {
        res.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ error: "registry refused" }));
        return;
      }
      const rawPath = decodeURIComponent(urlObj.pathname).slice(1);
      if (rawPath.startsWith("__tar/")) {
        const bytes = archiveBytes.get(rawPath.slice("__tar/".length));
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
      const localMap = serveMode === "candidate" ? candidateEntries : currentEntries;
      const localVer = serveMode === "candidate" ? targetVer : version;
      const local = localMap.get(name);
      if (local) {
        const bytes = archiveBytes.get(local.archive)!;
        packument.versions[localVer] = {
          ...local.meta,
          dist: { tarball: `${overlayUrl}/__tar/${local.archive}`, integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`, shasum: createHash("sha1").update(bytes).digest("hex") },
        };
        packument["dist-tags"].latest = localVer;
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
    const queryExtRoot = async (binEntry: string, dir: string, env: NodeJS.ProcessEnv): Promise<string> => {
      const out = await exec(process.execPath, [binEntry, "ext", "root"], { cwd: dir, env, timeout: 60_000 });
      return out.stdout.trim();
    };
    const queryGlobalExtRoot = async (globalPrefix: string, dir: string, env: NodeJS.ProcessEnv): Promise<string> => {
      const out = await runGlobalCli(globalPrefix, ["ext", "root"], { cwd: dir, env, timeout: 60_000 });
      return out.stdout.trim();
    };

    // Built CLI over published layout: user .npmrc, environment, prefix .npmrc, working-folder .npmrc isolation, and default config parity.
    {
      serveMode = "current";
      const overrideCase = makeCase("lock-override-cases");
      overrideCase.env.npm_config_registry = overlayUrl;
      writeFileSync(overrideCase.userNpmrc, "package-lock=false\n");
      const npmrcBytes = readFileSync(overrideCase.userNpmrc);
      await exec(process.execPath, [entry, "ext", "seed"], { cwd: overrideCase.dir, env: overrideCase.env, timeout: 240_000 });
      const extDir = await queryExtRoot(entry, overrideCase.dir, overrideCase.env);
      const lockPath = join(extDir, "package-lock.json");
      const claudeIdx = join(extDir, "node_modules/@cotal-ai/connector-claude-code/dist/index.js");
      writeFileSync(claudeIdx, `${readFileSync(claudeIdx, "utf8")}\n`);
      const u1 = await exec(process.execPath, [entry, "update"], { cwd: overrideCase.dir, env: overrideCase.env, timeout: 240_000 });
      const u2 = await exec(process.execPath, [entry, "update"], { cwd: overrideCase.dir, env: overrideCase.env, timeout: 240_000 });
      check("user .npmrc package-lock=false updates cleanly, writes current package-lock.json, and keeps .npmrc byte-identical",
        /refreshed claude\b/.test(u1.stdout + u1.stderr)
        && !/reinstalling every built-in|Reconciling built-in/.test(u2.stdout + u2.stderr)
        && lockHasAllBuiltIns(lockPath, version)
        && readFileSync(overrideCase.userNpmrc).equals(npmrcBytes),
        { u1: u1.stdout + u1.stderr, u2: u2.stdout + u2.stderr });

      writeFileSync(overrideCase.userNpmrc, "");
      rmSync(lockPath);
      const env1 = await exec(process.execPath, [entry, "update"], { cwd: overrideCase.dir, env: { ...overrideCase.env, npm_config_package_lock: "false" }, timeout: 240_000 });
      const env2 = await exec(process.execPath, [entry, "update"], { cwd: overrideCase.dir, env: { ...overrideCase.env, npm_config_package_lock: "false" }, timeout: 240_000 });
      check("env npm_config_package_lock=false writes current package-lock.json and converges",
        lockHasAllBuiltIns(lockPath, version)
        && !/reinstalling every built-in|Reconciling built-in/.test(env2.stdout + env2.stderr),
        { env1: env1.stdout + env1.stderr, env2: env2.stdout + env2.stderr });

      const prefixRc = join(extDir, ".npmrc");
      writeFileSync(prefixRc, "package-lock=false\n");
      const prefixRcBytes = readFileSync(prefixRc);
      rmSync(lockPath);
      const pfx1 = await exec(process.execPath, [entry, "update"], { cwd: overrideCase.dir, env: overrideCase.env, timeout: 240_000 });
      const pfx2 = await exec(process.execPath, [entry, "update"], { cwd: overrideCase.dir, env: overrideCase.env, timeout: 240_000 });
      check("extensions/.npmrc package-lock=false writes current package-lock.json, converges, and leaves prefix .npmrc byte-identical",
        lockHasAllBuiltIns(lockPath, version)
        && !/reinstalling every built-in|Reconciling built-in/.test(pfx2.stdout + pfx2.stderr)
        && readFileSync(prefixRc).equals(prefixRcBytes),
        { pfx1: pfx1.stdout + pfx1.stderr, pfx2: pfx2.stdout + pfx2.stderr });
      rmSync(prefixRc);

      const workProject = join(overrideCase.dir, "project-cwd");
      mkdirSync(workProject, { recursive: true });
      const projRc = join(workProject, ".npmrc");
      writeFileSync(projRc, "package-lock=false\n");
      const projRcBytes = readFileSync(projRc);
      rmSync(lockPath);
      const prj1 = await exec(process.execPath, [entry, "update"], { cwd: workProject, env: overrideCase.env, timeout: 240_000 });
      const prj2 = await exec(process.execPath, [entry, "update"], { cwd: workProject, env: overrideCase.env, timeout: 240_000 });
      check("working-folder .npmrc: nothing in the working folder is read or written during update (holds on main too)",
        lockHasAllBuiltIns(lockPath, version)
        && !/reinstalling every built-in|Reconciling built-in/.test(prj2.stdout + prj2.stderr)
        && readFileSync(projRc).equals(projRcBytes)
        && readdirSync(workProject).join(",") === ".npmrc",
        { prj1: prj1.stdout + prj1.stderr, prj2: prj2.stdout + prj2.stderr });

      // Default npm configuration: compare lock package list and installed tree against main's npm flags.
      const defaultCase = makeCase("default-npm-config");
      defaultCase.env.npm_config_registry = overlayUrl;
      await exec(process.execPath, [entry, "ext", "seed"], { cwd: defaultCase.dir, env: defaultCase.env, timeout: 240_000 });
      const defaultExtDir = await queryExtRoot(entry, defaultCase.dir, defaultCase.env);
      const defaultLock = JSON.parse(readFileSync(join(defaultExtDir, "package-lock.json"), "utf8")) as {
        packages: Record<string, unknown>;
      };
      const defaultPkgJson = JSON.parse(readFileSync(join(defaultExtDir, "package.json"), "utf8")) as {
        dependencies: Record<string, string>;
      };
      const controlDir = join(defaultCase.dir, "main-control-prefix");
      mkdirSync(controlDir, { recursive: true });
      writeFileSync(join(controlDir, "package.json"), `${JSON.stringify({ name: "cotal-extensions", private: true }, null, 2)}\n`);
      const specs = Object.values(defaultPkgJson.dependencies).map(spec => spec.startsWith("file:") ? resolve(defaultExtDir, spec.slice(5)) : spec);
      await runNpm(["install", "--save", "--no-audit", "--no-fund", "--install-links", ...specs, "--prefix", controlDir, "--include=optional", "--legacy-peer-deps"], {
        cwd: defaultCase.dir, env: defaultCase.env, timeout: 240_000,
      });
      const controlLock = JSON.parse(readFileSync(join(controlDir, "package-lock.json"), "utf8")) as {
        packages: Record<string, unknown>;
      };
      const topInstalled = (dir: string) => readdirSync(join(dir, "node_modules/@cotal-ai")).sort();
      check("default npm configuration produces the same lock package list and installed tree as main",
        JSON.stringify(Object.keys(defaultLock.packages).sort()) === JSON.stringify(Object.keys(controlLock.packages).sort())
        && JSON.stringify(topInstalled(defaultExtDir)) === JSON.stringify(topInstalled(controlDir)),
        { defaultCount: Object.keys(defaultLock.packages).length, controlCount: Object.keys(controlLock.packages).length });
    }

    // Stale prefix without package-lock.json (seeded by published cotal-ai when on npm, else packed head with lock removed): first update reinstalls once, second changes nothing.
    {
      const staleCase = makeCase("stale-prefix-without-lock");
      writeFileSync(staleCase.userNpmrc, "package-lock=false\n");
      const npmrcBefore = readFileSync(staleCase.userNpmrc);
      const curPublished = (await fetch(`https://registry.npmjs.org/cotal-ai/${version}`, { signal: AbortSignal.timeout(30_000) })).ok;
      const cotalCurTgz = join(packedTgzDir, readdirSync(packedTgzDir).find(f => /^cotal-ai-\d/.test(f))!);
      if (curPublished) {
        await runNpm(["install", "-g", "--prefix", staleCase.globalPrefix, `cotal-ai@${version}`, "--no-audit", "--no-fund"], {
          cwd: staleCase.dir, env: staleCase.env, timeout: 240_000,
        });
        const pubVer = (await runGlobalCli(staleCase.globalPrefix, ["--version"], { cwd: staleCase.dir, env: staleCase.env })).stdout.trim();
        check(`stale-prefix setup: installed published cotal-ai@${version}`, pubVer.split("\n")[0] === `cotal-ai ${version}`, pubVer);
        await runGlobalCli(staleCase.globalPrefix, ["ext", "seed"], { cwd: staleCase.dir, env: staleCase.env, timeout: 240_000 });
      } else {
        serveMode = "current";
        await runNpm(["install", "-g", "--prefix", staleCase.globalPrefix, cotalCurTgz, "--no-audit", "--no-fund"], {
          cwd: staleCase.dir, env: { ...staleCase.env, npm_config_registry: overlayUrl }, timeout: 240_000,
        });
        const pubVer = (await runGlobalCli(staleCase.globalPrefix, ["--version"], { cwd: staleCase.dir, env: staleCase.env })).stdout.trim();
        check(`stale-prefix setup: installed packed cotal-ai@${version}`, pubVer.split("\n")[0] === `cotal-ai ${version}`, pubVer);
        await runGlobalCli(staleCase.globalPrefix, ["ext", "seed"], { cwd: staleCase.dir, env: { ...staleCase.env, npm_config_registry: overlayUrl }, timeout: 240_000 });
        rmSync(join(await queryGlobalExtRoot(staleCase.globalPrefix, staleCase.dir, staleCase.env), "package-lock.json"));
      }
      const staleExtDir = await queryGlobalExtRoot(staleCase.globalPrefix, staleCase.dir, staleCase.env);
      const staleLockPath = join(staleExtDir, "package-lock.json");
      check(`stale ${version} extension prefix has no package-lock.json before repair`,
        !existsSync(staleLockPath) && existsSync(join(staleExtDir, "extensions.json")));

      if (curPublished) {
        serveMode = "current";
        await runNpm(["install", "-g", "--prefix", staleCase.globalPrefix, cotalCurTgz, "--no-audit", "--no-fund"], {
          cwd: staleCase.dir, env: { ...staleCase.env, npm_config_registry: overlayUrl, npm_config_cache: join(staleCase.dir, "head-cache") }, timeout: 240_000,
        });
      }
      const run1 = await runGlobalCli(staleCase.globalPrefix, ["update"], { cwd: staleCase.dir, env: { ...staleCase.env, npm_config_registry: overlayUrl }, timeout: 240_000 });
      console.log("=== stale-prefix repair update 1 ===\n" + (run1.stdout + run1.stderr).trim());
      const lockShaAfterRun1 = existsSync(staleLockPath) ? createHash("sha256").update(readFileSync(staleLockPath)).digest("hex") : "";
      const run2 = await runGlobalCli(staleCase.globalPrefix, ["update"], { cwd: staleCase.dir, env: { ...staleCase.env, npm_config_registry: overlayUrl }, timeout: 240_000 });
      console.log("=== stale-prefix verify update 2 ===\n" + (run2.stdout + run2.stderr).trim());
      const lockShaAfterRun2 = existsSync(staleLockPath) ? createHash("sha256").update(readFileSync(staleLockPath)).digest("hex") : "";
      check(`first update on stale ${version} prefix reinstalls built-ins once and writes package-lock.json`,
        /reinstalling every built-in: the prefix lock is unreadable/.test(run1.stdout + run1.stderr)
        && /connectors reconciled - refreshed /.test(run1.stdout + run1.stderr)
        && lockHasAllBuiltIns(staleLockPath, version),
        run1.stdout + run1.stderr);
      check("second update on repaired prefix changes nothing and keeps user .npmrc byte-identical",
        !/reinstalling every built-in|Reconciling built-in/.test(run2.stdout + run2.stderr)
        && /connectors reconciled - verified /.test(run2.stdout + run2.stderr)
        && lockShaAfterRun2 === lockShaAfterRun1
        && readFileSync(staleCase.userNpmrc).equals(npmrcBefore),
        run2.stdout + run2.stderr);
    }

    // Linked extensions folder with a refused registry: failed ext add removes nothing from the live prefix.
    {
      const linkedCase = makeCase("linked-extensions-refused");
      linkedCase.env.npm_config_registry = overlayUrl;
      writeFileSync(linkedCase.userNpmrc, "package-lock=false\n");
      await exec(process.execPath, [entry, "ext", "seed"], { cwd: linkedCase.dir, env: linkedCase.env, timeout: 240_000 });
      const liveExtLink = await queryExtRoot(entry, linkedCase.dir, linkedCase.env);
      const realLiveExt = join(linkedCase.dir, "moved-extensions-target");
      renameSync(liveExtLink, realLiveExt);
      symlinkSync(realLiveExt, liveExtLink, "junction");
      const snapshotBefore = snapshotTree(realLiveExt);
      let refusedStatus = 0;
      try {
        await exec(process.execPath, [entry, "ext", "add", "@probe/refused-live@1.0.0"], {
          cwd: linkedCase.dir,
          env: {
            ...linkedCase.env,
            npm_config_registry: `${overlayUrl}/refused`,
            npm_config_cache: join(linkedCase.dir, "empty-cache"),
            npm_config_fetch_retries: "0",
          },
          timeout: 60_000,
        });
      } catch (err) {
        refusedStatus = typeof (err as { code?: number }).code === "number" ? (err as { code: number }).code : 1;
      }
      const snapshotAfter = snapshotTree(realLiveExt);
      check("linked extensions folder with refused registry removes nothing from the live prefix",
        refusedStatus !== 0 && lstatSync(liveExtLink).isSymbolicLink()
        && JSON.stringify(snapshotAfter) === JSON.stringify(snapshotBefore));
    }

    // Real self-update from published cotal-ai@0.183.0 with package-lock=false in user .npmrc to packed head, then load a built-in connector.
    {
      const upgradeCase = makeCase("published-release-self-update");
      writeFileSync(upgradeCase.userNpmrc, "package-lock=false\n");
      const npmrcBefore = readFileSync(upgradeCase.userNpmrc);
      await runNpm(["install", "-g", "--prefix", upgradeCase.globalPrefix, "cotal-ai@0.183.0", "--no-audit", "--no-fund"], {
        cwd: upgradeCase.dir, env: upgradeCase.env, timeout: 240_000,
      });
      await runGlobalCli(upgradeCase.globalPrefix, ["ext", "seed"], { cwd: upgradeCase.dir, env: upgradeCase.env, timeout: 240_000 });
      const beforeVer = (await runGlobalCli(upgradeCase.globalPrefix, ["--version"], { cwd: upgradeCase.dir, env: upgradeCase.env })).stdout.trim();
      console.log("=== versions before self-update ===\n" + beforeVer);
      check("installed published cotal-ai@0.183.0 with package-lock=false before self-update",
        beforeVer.split("\n")[0] === "cotal-ai 0.183.0"
        && beforeVer.split("\n").slice(1).every(line => line.trim().endsWith(" 0.183.0")),
        beforeVer);

      serveMode = "candidate";
      const globalBinDir = process.platform === "win32" ? upgradeCase.globalPrefix : join(upgradeCase.globalPrefix, "bin");
      const upgradeEnv: NodeJS.ProcessEnv = {
        ...upgradeCase.env,
        npm_config_registry: overlayUrl,
        PATH: `${globalBinDir}${delimiter}${upgradeCase.env.PATH ?? ""}`,
      };
      const upgraded = await runGlobalCli(upgradeCase.globalPrefix, ["update", "--self"], { cwd: upgradeCase.dir, env: upgradeEnv, timeout: 300_000 });
      const afterVer = (await runGlobalCli(upgradeCase.globalPrefix, ["--version"], { cwd: upgradeCase.dir, env: upgradeEnv })).stdout.trim();
      console.log("=== versions after self-update ===\n" + afterVer);
      const upgradedExtDir = await queryGlobalExtRoot(upgradeCase.globalPrefix, upgradeCase.dir, upgradeEnv);
      const upgradedLockPath = join(upgradedExtDir, "package-lock.json");
      check(`self-update from 0.183.0 with package-lock=false reaches ${targetVer}, writes current package-lock.json, and leaves .npmrc untouched`,
        afterVer.split("\n")[0] === `cotal-ai ${targetVer}`
        && afterVer.split("\n").slice(1).every(line => line.trim().endsWith(` ${targetVer}`))
        && /connectors reconciled/.test(upgraded.stdout + upgraded.stderr)
        && lockHasAllBuiltIns(upgradedLockPath, targetVer)
        && readFileSync(upgradeCase.userNpmrc).equals(npmrcBefore),
        { afterVer, out: upgraded.stdout + upgraded.stderr });

      const repeatSelf = await runGlobalCli(upgradeCase.globalPrefix, ["update", "--self"], { cwd: upgradeCase.dir, env: upgradeEnv, timeout: 180_000 });
      check("repeat update --self after self-update is current without reinstalling",
        repeatSelf.stdout.includes("installed package closure is current"),
        repeatSelf.stdout + repeatSelf.stderr);

      const probeProject = join(upgradeCase.dir, "connector-load-project");
      mkdirSync(probeProject, { recursive: true });
      await runGlobalCli(upgradeCase.globalPrefix, ["space", "create", "upgrade-probe", "--root", "."], {
        cwd: probeProject, env: upgradeEnv, timeout: 120_000,
      });
      writeFileSync(
        join(probeProject, "probe.md"),
        "---\nname: probe\nrole: developer\nmodel: claude-opus-5-5\n---\nVerify built-in connector load after upgrade.\n",
      );
      const previewOut = await runGlobalCli(
        upgradeCase.globalPrefix,
        ["spawn", "--file", "./probe.md", "--dry-run", "--space", "upgrade-probe", "--harness", "claude", "--json"],
        { cwd: probeProject, env: upgradeEnv, timeout: 120_000 },
      );
      console.log("=== built-in connector load after self-update (spawn --dry-run) ===\n" + previewOut.stdout.trim());
      const previewJson = JSON.parse(previewOut.stdout) as {
        outcome?: string;
        result?: { harness?: string; model?: string; connectorArgumentValidation?: string };
      };
      check("upgraded CLI loads built-in claude connector cleanly and validates its arguments",
        previewJson.outcome === "ok"
        && previewJson.result?.harness === "claude"
        && previewJson.result?.model === "claude-opus-5-5"
        && previewJson.result?.connectorArgumentValidation === "checked",
        previewOut.stdout);
    }
  } finally {
    await new Promise<void>((resolveClose, reject) => overlay.close(error => error ? reject(error) : resolveClose()));
    rmSync(root, { recursive: true, force: true });
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
  check("cotal-ai tarball ships the connector installer folders", listing.includes("package/dist/daemon/seeded-installers.json"));
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
    await checkPackageLockCellsAndUpgrade(invokedBin, umbrellaVersion, seatClone, tgz);
  }
} finally {
  rmSync(base, { recursive: true, force: true });
}

console.log(`\nseed-tarball smoke: ${passed()} passed, ${failed()} failed`);
finish();
process.exit(failed() ? 1 : 0);
