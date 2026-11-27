/**
 * Pure-function smoke for the registry's transactional, INVISIBLE staging (no NATS): the mechanism
 * `materializeFromManifest` relies on to import a package atomically. Run: pnpm smoke:registry-staging
 *
 * Proves the three properties an adversarial reviewer demanded of manifest materialization:
 *   1. A load that registers a key then rejects commits NOTHING (the stage is discarded).
 *   2. A register in an UNRELATED async context during the load's await goes live and SURVIVES that
 *      discard (AsyncLocalStorage scopes the stage to the load, not to all concurrent work).
 *   3. A load that imports cleanly but never advertises the wanted key leaves NONE of its keys live
 *      (the caller declines to commit).
 * Plus: the real production path. A dynamic import()'s self-registration is captured by the stage
 * (ALS crosses module evaluation), invisible until commit, then resolvable.
 */
import nodeAssert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { countedAssert, emitSentinel } from "@cotal-ai/smoke-kit";
import { commitPlugin, Registry, registry, stagePlugin, type PluginHost } from "../src/registry.js";
const counted = countedAssert(nodeAssert);
const assert: typeof nodeAssert = counted.assert;
const cells = counted.cells;

// 1. register-before-rejecting-await is invisible AND discarded (nothing live; key is free again).
{
  const r = new Registry();
  await assert.rejects(
    r.runStaged(async () => {
      r.register({ kind: "connector", name: "c1" }); // staged, not live
      await Promise.reject(new Error("boom")); // rejects AFTER registering
    }),
    /boom/,
  );
  assert.throws(() => r.resolve("connector", "c1"), /no connector registered/, "rejected load left c1 live");
  // Truly discarded, not a dangling stage: c1 can be registered afresh.
  assert.doesNotThrow(() => r.register({ kind: "connector", name: "c1" }), "stage was not fully discarded");
}

// 2. An unrelated register during the staged load's await goes LIVE and survives the load's failure.
{
  const r = new Registry();
  let openGate = (): void => {};
  const gate = new Promise<void>((res) => { openGate = res; });
  let announceMidLoad = (): void => {};
  const midLoad = new Promise<void>((res) => { announceMidLoad = res; });

  const load = r.runStaged(async () => {
    r.register({ kind: "connector", name: "stagedC" }); // captured by THIS load's stage
    announceMidLoad(); // load is now parked at the await with its stage active
    await gate;
    throw new Error("load-fails"); // fail so the stage is discarded
  });

  await midLoad;
  // Runs in the top-level async context (never entered runStaged), so it lands LIVE, not in the stage.
  r.register({ kind: "connector", name: "liveUnrelated" });
  openGate();
  await assert.rejects(load, /load-fails/);

  assert.throws(() => r.resolve("connector", "stagedC"), /no connector registered/, "failed load's key leaked live");
  assert.equal(r.resolve("connector", "liveUnrelated").name, "liveUnrelated", "unrelated live register was wrongly discarded");
}

// 3. Import succeeds but never advertises the wanted key → caller commits NOTHING.
{
  const r = new Registry();
  const { staged } = await r.runStaged(async () => {
    r.register({ kind: "connector", name: "actual" }); // registers, but not the advertised name
  });
  const advertised = { kind: "connector", name: "wanted" };
  assert.equal(
    staged.some((s) => s.kind === advertised.kind && s.name === advertised.name),
    false,
    "advertised key should be absent from staged",
  );
  // Caller declines to commit; nothing from the import is live.
  assert.throws(() => r.resolve("connector", "actual"), /no connector registered/, "unadvertised import leaked a key");
  assert.throws(() => r.resolve("connector", "wanted"), /no connector registered/);
}

// Positive: advertised present → commit publishes ALL of the load's keys atomically.
{
  const r = new Registry();
  const { staged } = await r.runStaged(async () => {
    r.register({ kind: "connector", name: "wanted" }, { kind: "command", name: "extra" });
  });
  assert.throws(() => r.resolve("connector", "wanted"), /no connector registered/, "staged key was visible before commit");
  r.commitStaged(staged);
  assert.equal(r.resolve("connector", "wanted").name, "wanted");
  assert.equal(r.resolve("command", "extra").name, "extra");
}

// commit is all-or-nothing against the LIVE map, which may have changed since staging.
{
  const r = new Registry();
  const { staged } = await r.runStaged(async () => {
    r.register({ kind: "connector", name: "dup" }, { kind: "connector", name: "clean" });
  });
  r.register({ kind: "connector", name: "dup" }); // becomes live after staging
  assert.throws(() => r.commitStaged(staged), /already registered: connector:dup/);
  assert.throws(() => r.resolve("connector", "clean"), /no connector registered/, "conflicting commit partially published");
}

// Real path: a dynamic import()'s self-registration is captured by the stage (ALS crosses module
// evaluation), invisible until commit, then resolvable. Uses the process singleton the fixture imports.
{
  const url = new URL("./fixtures/self-register.ts", import.meta.url).href;
  const { staged } = await registry.runStaged(() => import(url));
  assert.ok(
    staged.some((s) => s.kind === "connector" && s.name === "fixture-import"),
    "dynamic import's registration was not captured by the stage",
  );
  assert.throws(() => registry.resolve("connector", "fixture-import"), /no connector registered/, "import was visible before commit");
  registry.commitStaged(staged);
  assert.equal(registry.resolve("connector", "fixture-import").name, "fixture-import");
}

{
  const r = new Registry();
  const extension = { kind: "command", name: "example", aliases: ["short"] };
  let captured!: PluginHost;
  const staged = await stagePlugin(r, (host) => {
    captured = host;
    host.register(extension);
  });
  assert.deepEqual(Object.keys(captured).sort(), ["contract", "register"]);
  assert.equal(captured.contract, 1);
  assert.equal(r.has("command", "short"), false);
  assert.throws(() => captured.register(extension), /registration is closed/);
  const scope = commitPlugin(r, staged);
  assert.equal(r.resolve("command", "short"), extension);
  assert.equal(r.unregister("command", "example"), true);
  const replacement = { ...extension };
  r.register(replacement);
  scope.dispose();
  scope.dispose();
  assert.equal(r.resolve("command", "short"), replacement);

  const removable = { kind: "command", name: "removable", aliases: ["remove-me"] };
  const disposable = commitPlugin(r, await stagePlugin(r, (host) => host.register(removable)));
  disposable.dispose();
  assert.equal(r.has("command", "removable"), false);
  assert.equal(r.has("command", "remove-me"), false);
}

{
  const r = new Registry();
  const root = { kind: "command", name: "root-word" };
  const plugin = { kind: "command", name: "plugin-word", aliases: [root.name] };
  const unrelated = { kind: "command", name: "unrelated" };
  r.provide({ provides: [root], load: async () => r.register(root) });
  const staged = await stagePlugin(r, (host) => host.register(unrelated, plugin));
  assert.throws(() => commitPlugin(r, staged), /already registered: command:root-word/);
  assert.equal(r.has("command", "unrelated"), false);
  assert.equal(r.has("command", "plugin-word"), false);
  assert.equal(await r.load("command", "root-word"), root);
}

{
  const r = new Registry();
  const extension = { kind: "command", name: "discarded" };
  await assert.rejects(stagePlugin(r, (host) => {
    host.register(extension);
    throw new Error("factory failed");
  }), /factory failed/);
  assert.equal(r.has("command", "discarded"), false);
  await assert.rejects(stagePlugin(r, async (host) => {
    host.register(extension);
    await Promise.resolve();
    host.register({ kind: "command", name: "late" });
  }), /factory must be synchronous/);
  assert.equal(r.has("command", "discarded"), false);
  assert.equal(r.has("command", "late"), false);
}

async function checkCoreErrorCopies(): Promise<void> {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const clone = mkdtempSync(join(tmpdir(), "cotal-core-copy-"));
  try {
    cpSync(join(root, "dist"), join(clone, "dist"), { recursive: true });
    writeFileSync(join(clone, "package.json"), '{"type":"module"}');
    symlinkSync(join(root, "node_modules"), join(clone, "node_modules"), "junction");
    type Surface = Record<string, unknown>;
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { exports: Record<string, { import?: string } | string> };
    const left = pathToFileURL(root);
    const right = pathToFileURL(`${clone}/`);
    const seen = new Set<Function>();
    const entries = Object.values(pkg.exports).flatMap((entry) => {
      const filename = typeof entry === "string" ? entry : entry.import;
      return filename?.endsWith(".js") ? [filename] : [];
    });
    // The dial module also exports a typed error to other core modules.
    entries.push("./dist/endpoint-dial.js");
    for (const entry of entries) {
      const a: Surface = await import(new URL(entry, left).href);
      const b: Surface = await import(new URL(entry, right).href);
      for (const [name, ctor] of Object.entries(a)) {
        if (typeof ctor !== "function" || !ctor.prototype || !(ctor.prototype instanceof Error) || seen.has(ctor)) continue;
        seen.add(ctor);
        const other = b[name];
        assert.ok(typeof other === "function" && other !== ctor, `${name}: copies must load distinct constructors`);
        assert.equal(Object.create(other.prototype) instanceof ctor, true, `${name}: host must recognize the plugin error`);
        assert.equal(Object.create(ctor.prototype) instanceof other, true, `${name}: plugin must recognize the host error`);
        assert.equal(new Error() instanceof ctor, false, `${name}: plain errors must remain distinct`);
      }
    }
    assert.ok(seen.size >= 45, `expected at least 45 exported core errors, found ${seen.size}`);

    type Core = typeof import("../src/index.js");
    const a: Core = await import(new URL("./dist/index.js", left).href);
    const b: Core = await import(new URL("./dist/index.js", right).href);
    class HostOnlySubclass extends a.EpEnvelopeError {}
    const remoteChild = new b.ContractStoreCorruptError("corrupt");
    assert.ok(remoteChild instanceof a.ContractStoreCorruptError);
    assert.ok(remoteChild instanceof a.EpEnvelopeError);
    assert.ok(remoteChild instanceof Error);
    assert.equal(remoteChild instanceof a.RunAdmissionDenied, false);
    assert.equal(remoteChild instanceof HostOnlySubclass, false);
    assert.ok(new HostOnlySubclass("internal", "host-only") instanceof HostOnlySubclass);
    assert.equal(new b.EpEnvelopeError("internal", "plain envelope") instanceof a.ContractStoreCorruptError, false);
  } finally {
    rmSync(clone, { recursive: true, force: true });
  }
}

await checkCoreErrorCopies();

console.log("registry-staging.smoke: all assertions passed");
emitSentinel({ passed: cells(), failed: 0 });
