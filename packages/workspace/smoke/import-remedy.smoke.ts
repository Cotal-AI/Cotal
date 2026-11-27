/** Installed factory verification and import remedies. Run: pnpm smoke:import-remedy */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { registry, type Extension } from "@cotal-ai/core";
import {
  CorruptExtensionPackageError, extensionPackageDir, extensionsManifestPath, installedExtensionPackage,
  installedExtensionVersion, materializeFromManifest, resolveExtensionEntry, type InstalledExtension,
} from "@cotal-ai/workspace";
import { pluginManifest } from "../src/plugin-manifest.js";
import { readPluginDeclaration, samePluginDeclaration } from "../src/plugin-declaration.js";
import { checkPluginCore } from "../src/plugin-core.js";
import { writePluginFixture } from "../../../scripts/plugin-fixture.mjs";

const prior = process.env.XDG_CONFIG_HOME;
const tmp = mkdtempSync(join(import.meta.dirname, ".import-remedy-"));
process.env.XDG_CONFIG_HOME = tmp;

async function fixture(name: string, opts: { body?: string; main?: string; entry?: string; declared?: boolean; spec?: string } = {}) {
  const pkg = `@third/${name}`;
  const version = "1.0.0";
  const dir = extensionPackageDir(pkg);
  const ref = { kind: "runtime", name };
  const declaration = await pluginManifest((host) => host.register(ref));
  const metadata = { name: pkg, version, type: "module", main: opts.main ?? "index.mjs", ...(opts.declared === false ? {} : { cotal: declaration }) };
  const item: InstalledExtension = { pkg, version, installId: name, spec: opts.spec, provides: declaration.provides, commands: [] };
  const publish = (entry = item) => writeFileSync(extensionsManifestPath(), JSON.stringify({ extensions: [entry] }));
  const meta = join(dir, "package.json");
  const marker = join(dir, "imported");
  const body = opts.body ?? `export default (host) => host.register(${JSON.stringify(ref)});`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(meta, JSON.stringify(metadata));
  const entry = opts.entry ?? "index.mjs";
  if (entry.includes("/")) mkdirSync(join(dir, entry.split("/")[0]!), { recursive: true });
  writeFileSync(join(dir, entry), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'imported');\n${body}`);
  publish();
  return { dir, ref, declaration, item, meta, metadata, marker, publish };
}

async function importRemedies() {
  const bad = await fixture("broken", { body: 'throw new Error("broken extension entry");' });
  await assert.rejects(materializeFromManifest(bad.ref), (error: Error) =>
    error.message.includes("failed to import: broken extension entry") && error.message.includes("`cotal ext remove '@third/broken'`"));
  const pinned = await fixture("pinned-broken", { spec: "@third/pinned-broken@1.0.0", body: 'throw new Error("broken pinned entry");' });
  await assert.rejects(materializeFromManifest(pinned.ref), /broken pinned entry.*cotal ext add/);
  const legacy = await fixture("legacy", { declared: false });
  await assert.rejects(materializeFromManifest(legacy.ref), /old contract.*cotal ext add @third\/legacy@latest.*cotal ext remove @third\/legacy/);
  assert(!existsSync(legacy.marker));
  const version = await fixture("pin");
  version.publish({ ...version.item, version: "2.0.0" });
  await assert.rejects(materializeFromManifest(version.ref), /1\.0\.0 on disk but the manifest pinned 2\.0\.0/);
  assert(!existsSync(version.marker));
  const mismatch = await fixture("mismatch", { body: 'export default (host) => host.register({ kind: "runtime", name: "unlisted" });' });
  await assert.rejects(materializeFromManifest(mismatch.ref), /factory does not match its cotal declaration/);
  assert(!registry.has("runtime", "unlisted"));
  const missingFactory = await fixture("missing-factory", { body: "export const notAFactory = true;" });
  await assert.rejects(materializeFromManifest(missingFactory.ref), /must export a default factory/);
  const thrownFactory = await fixture("thrown-factory", { body: 'export default (host) => { host.register({ kind: "runtime", name: "thrown-factory" }); throw new Error("factory threw"); };' });
  await assert.rejects(materializeFromManifest(thrownFactory.ref), /factory threw/);
  assert(!registry.has("runtime", thrownFactory.ref.name));
  const external = await fixture("external-registration", {
    body: `import { registry } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, "../../core/dist/index.js")).href)};\n` +
      'const provider = { kind: "runtime", name: "external-registration" }; registry.register(provider); export default (host) => host.register(provider);',
  });
  for (let i = 0; i < 2; i++) await assert.rejects(materializeFromManifest(external.ref), /registered outside its factory/);
  assert(!registry.has("runtime", external.ref.name));
}

async function entryResolution() {
  const directory = await fixture("directory-entry", { main: "./dist", entry: "dist/index.js" });
  const probe = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import { materializeFromManifest } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, "../dist/index.js")).href)};
    assert.equal((await materializeFromManifest(${JSON.stringify(directory.ref)})).name, ${JSON.stringify(directory.ref.name)});
  `], { encoding: "utf8" });
  assert.equal(probe.status, 0, probe.stderr || probe.stdout);
  const empty = await fixture("directory-empty", { main: "./empty" });
  mkdirSync(join(empty.dir, "empty"));
  await assert.rejects(materializeFromManifest(empty.ref), /failed to import.*cotal ext remove/);

  const dir = extensionPackageDir("@third/entry-precedence");
  mkdirSync(join(dir, "dist"), { recursive: true });
  for (const name of ["entry", "entry.js", "export.js", "dist/index.js"]) writeFileSync(join(dir, name), "");
  const meta = { version: "1.0.0", main: "./entry" };
  for (const [exports, expected] of [
    [undefined, "entry"], [{ ".": { import: "./export.js" } }, "export.js"], [{ default: "./export.js" }, "export.js"],
    [{ ".": { default: "./export.js", import: "./entry" } }, "export.js"], [{ ".": { node: { require: "./entry" }, default: "./export.js" } }, "export.js"],
    [{ "./import": "./export.js" }, "entry"], ["./dist", "dist/index.js"], ["./export", "export"],
  ] as const) assert.equal(resolveExtensionEntry(dir, { ...meta, exports }), join(dir, expected));
}

async function metadataPolicy() {
  const { item, dir, ref, meta, metadata } = await fixture("metadata-policy");
  const read = () => installedExtensionPackage(item.pkg);
  const fields = { ...metadata, exports: { ".": "./index.mjs" }, dependencies: { foo: "1.0.0" }, peerDependencies: { "@cotal-ai/core": "*" } };
  writeFileSync(meta, JSON.stringify(fields));
  const snapshot = read()!;
  for (const key of ["version", "main", "exports", "dependencies", "peerDependencies", "cotal"] as const) assert.deepEqual(snapshot[key], fields[key]);
  assert.equal(installedExtensionVersion(item.pkg), fields.version);
  assert.equal(installedExtensionPackage("@third/absent"), undefined);
  for (const body of ["{corrupt", "{}"]) {
    writeFileSync(meta, body);
    assert.throws(read, (error: Error) => error instanceof CorruptExtensionPackageError && error.message.includes(item.pkg) && error.message.includes(meta));
    await assert.rejects(materializeFromManifest(ref), CorruptExtensionPackageError);
  }
  rmSync(meta);
  assert.throws(read, CorruptExtensionPackageError);
  if (process.platform !== "win32") {
    mkdirSync(meta);
    assert.throws(read, { code: "EISDIR" });
    rmSync(meta, { recursive: true });
    if (process.getuid?.() !== 0) {
      writeFileSync(meta, JSON.stringify(fields));
      chmodSync(meta, 0o000);
      try { assert.throws(read, { code: "EACCES" }); } finally { chmodSync(meta, 0o600); }
    }
    const dangling = "@third/metadata-dangling";
    symlinkSync(join(dir, "missing-target"), extensionPackageDir(dangling), "dir");
    assert.throws(() => installedExtensionPackage(dangling), CorruptExtensionPackageError);
  }
}

async function declarationPolicy() {
  const { ref, meta, metadata, marker, declaration, item, publish } = await fixture("scoped-factory");
  writeFileSync(meta, JSON.stringify({ ...metadata, cotal: { ...declaration, provides: [{ ...ref, aliases: ["surprise"] }] } }));
  await assert.rejects(materializeFromManifest(ref), /declaration does not match the installed manifest/);
  assert(!existsSync(marker));
  assert(!registry.has(ref.kind, ref.name));
  writeFileSync(meta, JSON.stringify(metadata));
  assert.equal((await materializeFromManifest(ref)).name, ref.name);
  publish({ ...item, installId: "second" });
  await assert.rejects(materializeFromManifest(ref), /restart the process/);
  assert(!registry.has(ref.kind, ref.name));

  const provider: Extension = { kind: "runtime", name: "manifest-proof", aliases: ["mp"] };
  const generated = await pluginManifest((host) => host.register(provider), { coreVersion: "0.184.1" });
  assert.deepEqual(generated, { contract: 1, core: "0.184.1", provides: [provider], commands: [], connectors: [], localProcesses: [], servicePresets: [] });
  assert(!registry.has(provider.kind, provider.name));
  assert(samePluginDeclaration(readPluginDeclaration(JSON.parse(JSON.stringify(generated))), generated));
  assert.throws(() => readPluginDeclaration({ ...generated, provides: [generated.provides[0], generated.provides[0]] }), /claims runtime:manifest-proof twice/);
  await assert.rejects(pluginManifest((host) => host.register({ kind: "auth-provider", name: "forbidden" })), /cannot provide auth-provider/);
  checkPluginCore("@third/plugin", { version: "1.0.0" }, generated, meta, "0.185.0");
  assert.throws(() => checkPluginCore("@third/plugin", { version: "1.0.0" }, { ...generated, core: "0.185.1" }, meta, "0.185.0"), /newer core.*cotal update --self/);
  assert.throws(() => checkPluginCore("@third/plugin", { version: "1.0.0" }, { ...generated, core: "0.183.9" }, meta, "0.185.0"), /unsupported core.*cotal ext add/);
  assert.throws(() => checkPluginCore("@cotal-ai/plugin", { version: "0.184.1" }, generated, meta, "0.185.0"), /cotal update --self/);
  const nested = join(meta, "..", "node_modules", "@cotal-ai", "core");
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(nested, "package.json"), JSON.stringify({ name: "@cotal-ai/core", version: "0.184.1", exports: { "./package.json": "./package.json" } }));
  checkPluginCore("@third/plugin", { version: "1.0.0", dependencies: { "@cotal-ai/core": "^0.184.0" } }, declaration, meta, "0.185.0");
}

async function physicalCoreBoundary() {
  const original = process.env.XDG_CONFIG_HOME;
  const real = join(tmp, "physical"), linked = join(tmp, "linked");
  mkdirSync(real);
  symlinkSync(real, linked, "junction");
  process.env.XDG_CONFIG_HOME = linked;
  try {
    const metadata = { version: "1.0.0", dependencies: { "@cotal-ai/core": "^0.184.0" } };
    const good = await fixture("physical-core");
    const nested = join(good.dir, "node_modules", "@cotal-ai", "core");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "package.json"), JSON.stringify({ name: "@cotal-ai/core", version: "0.184.1", exports: { "./package.json": "./package.json" } }));
    checkPluginCore(good.item.pkg, metadata, good.declaration, join(good.dir, "index.mjs"), "0.185.0");

    const outside = join(tmp, "outside-core");
    renameSync(nested, outside);
    const escaped = await fixture("escaped-core");
    const external = join(escaped.dir, "node_modules", "@cotal-ai", "core");
    mkdirSync(join(external, ".."), { recursive: true });
    symlinkSync(outside, external, "junction");
    assert.throws(() => checkPluginCore(escaped.item.pkg, metadata, escaped.declaration, join(escaped.dir, "index.mjs"), "0.185.0"), (error: Error) =>
      error.message.includes("inside the extensions prefix") && error.cause instanceof Error && error.cause.message.includes("outside the extensions prefix"));
  } finally {
    if (original === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = original;
  }
}

async function fixtureDeclarationParity() {
  const dir = join(tmp, "fixture-declaration-parity");
  const providers = [
    { kind: "command", name: "fixture-command", aliases: ["fixture-cmd"], summary: "Fixture command" },
    { kind: "connector", name: "fixture-connector", requires: ["node"], eventChannel: true, supportsReasoningEvents: true },
    { kind: "runtime", name: "fixture-runtime" },
    { kind: "local-process", name: "fixture-process", label: "Fixture process", pidFile: "{root}/fixture.pid", order: 10 },
  ];
  const core = "0.184.1";
  const factorySource = `export default host => host.register(...${JSON.stringify(providers)});`;
  const options = { name: "fixture-parity", version: "1.0.0", core, provides: providers, factorySource };
  writePluginFixture(dir, options);
  const factory = (await import(pathToFileURL(join(dir, "index.js")).href)).default;
  const declaration = await pluginManifest(factory, { coreVersion: core });
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).cotal, JSON.parse(JSON.stringify(declaration)));
  assert.throws(() => writePluginFixture(dir, { ...options, provides: [{ kind: "service-preset", name: "unsupported" }] }), /Unsupported fixture provider kind/);
}

try {
  await importRemedies();
  await entryResolution();
  await metadataPolicy();
  await declarationPolicy();
  await physicalCoreBoundary();
  await fixtureDeclarationParity();
  console.log("SMOKE OK: import-remedy");
} finally {
  if (prior === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = prior;
  rmSync(tmp, { recursive: true, force: true });
}
