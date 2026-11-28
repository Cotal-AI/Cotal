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
  const run = (...args: string[]) => spawnSync(process.execPath, [entry, ...args], {
    cwd, encoding: "utf8", env: { ...env, PATH: `${tools}${delimiter}${env.PATH}`, NO_COLOR: "1" },
  });
  const before = run("update", "--check");
  check("a fresh install has no recorded extensions and matches the latest tag", before.status === 0 &&
    /CLI update:\s+matches latest tag/.test(before.stdout) && before.stdout.includes("No extensions in the recorded inventory."), before.stdout + before.stderr);
  for (let attempt = 0; attempt < 2; attempt++) {
    const update = run("update", "--self");
    const output = update.stdout + update.stderr;
    check("a fresh current self-update does not initialize any built-in connectors", update.status === 0 &&
      /Update:\s+no newer latest tag/.test(output) && !/Built-in connectors|wrote operator-global seed store payload/.test(output) &&
      !existsSync(join(env.XDG_CONFIG_HOME!, "cotal")), output);
  }
  const result = run("ext", "seed");
  const calls = existsSync(invocations) ? readFileSync(invocations, "utf8").trim().split("\n") : [];
  check("the version check and explicit connector seed use the running Node with PATH's npm",
    calls.includes(`view ${process.execPath}`) && calls.includes(`install ${process.execPath}`), calls);
  check("explicit seeding installs the built-ins with an unsupported Node first on PATH",
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
  if (process.platform === "linux") await checkLocalOperatorUpdate(invokedBin, prefix, seedEnv, umbrellaVersion, extensionPrefix);
} finally {
  rmSync(base, { recursive: true, force: true });
}

console.log(`\nseed-tarball smoke: ${passed()} passed, ${failed()} failed`);
finish();
process.exit(failed() ? 1 : 0);
