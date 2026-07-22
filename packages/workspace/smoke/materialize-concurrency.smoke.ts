/**
 * Concurrency + idempotency smoke for importInstalledExtension (no NATS). Run:
 * pnpm smoke:materialize-concurrency
 *
 * ES modules evaluate ONCE: a second import() of an already-loaded package is a cache hit with no
 * registration side effects, so its stage is empty. This guards that two first materializations of
 * the same package still both succeed (the second observes the first's committed keys instead of
 * falsely reporting "did not register"), that two refs from one package resolve concurrently, and
 * that a sequential repeat is idempotent, without weakening the genuine "advertised key absent" error.
 *
 * Lays down real self-registering ESM packages under a temp cotal config home (XDG_CONFIG_HOME) INSIDE
 * the repo, so each package's `import "@cotal-ai/core"` resolves to the same core singleton this smoke
 * and materialize.ts use.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registry, type ExtensionRef } from "@cotal-ai/core";
import {
  claimExtensionUpdatePass,
  extensionsDir,
  importInstalledExtension,
  type InstalledExtension,
} from "@cotal-ai/workspace";

// Temp config home under the repo so the fixture packages resolve @cotal-ai/core to the repo copy
// (node walks up to packages/workspace/node_modules), sharing this process's registry singleton.
const tmp = mkdtempSync(join(import.meta.dirname, ".mat-concurrency-"));
process.env.XDG_CONFIG_HOME = tmp;

let seq = 0;
/** Write a self-registering ESM package that registers `refs` on import; return its manifest row. */
function fakePackage(refs: ExtensionRef[]): InstalledExtension {
  const pkg = `@fake/mat-${++seq}`;
  const dir = join(extensionsDir(), "node_modules", ...pkg.split("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: pkg, version: "1.0.0", type: "module", main: "index.mjs" }));
  const body = refs.map((r) => `registry.register(${JSON.stringify({ kind: r.kind, name: r.name })});`).join("\n");
  writeFileSync(join(dir, "index.mjs"), `import { registry } from "@cotal-ai/core";\n${body}\n`);
  return { pkg, version: "1.0.0", spec: ".", commands: [], provides: refs };
}

try {
  // 1. Two concurrent FIRST materializations of the same package/ref both fulfill: the second sees the
  //    first's committed key rather than re-importing an already-evaluated, side-effect-free module.
  {
    const ref: ExtensionRef = { kind: "connector", name: "same" };
    const ext = fakePackage([ref]);
    const results = await Promise.allSettled([importInstalledExtension(ext, ref), importInstalledExtension(ext, ref)]);
    assert.deepEqual(results.map((r) => r.status), ["fulfilled", "fulfilled"], `concurrent same-ref: ${JSON.stringify(results)}`);
    assert.equal(registry.resolve("connector", "same").name, "same");
  }

  // 2. Two concurrent first materializations of DIFFERENT refs from ONE package both fulfill: one
  //    import evaluates and commits BOTH keys; the other observes the committed sibling.
  {
    const c: ExtensionRef = { kind: "connector", name: "dual" };
    const cmd: ExtensionRef = { kind: "command", name: "dual" };
    const ext = fakePackage([c, cmd]);
    const results = await Promise.allSettled([importInstalledExtension(ext, c), importInstalledExtension(ext, cmd)]);
    assert.deepEqual(results.map((r) => r.status), ["fulfilled", "fulfilled"], `concurrent two-ref: ${JSON.stringify(results)}`);
    assert.equal(registry.resolve("connector", "dual").name, "dual");
    assert.equal(registry.resolve("command", "dual").name, "dual");
  }

  // 3. Sequential repeat is idempotent: a cached re-import has no new stage, so the early live-check
  //    must short-circuit instead of falsely reporting "did not register".
  {
    const ref: ExtensionRef = { kind: "connector", name: "repeat" };
    const ext = fakePackage([ref]);
    await importInstalledExtension(ext, ref);
    await assert.doesNotReject(importInstalledExtension(ext, ref), "sequential repeat must be idempotent");
    assert.equal(registry.resolve("connector", "repeat").name, "repeat");
  }

  // 4. Regression: a package that imports cleanly but never advertises the wanted key STILL throws and
  //    commits none of its keys (the early live-check must not weaken validation).
  {
    const ext = fakePackage([{ kind: "connector", name: "provided" }]);
    await assert.rejects(importInstalledExtension(ext, { kind: "connector", name: "absent" }), /did not register connector "absent"/);
    assert.throws(() => registry.resolve("connector", "provided"), /no connector registered/, "unadvertised import leaked a key");
  }

  // 5. Materialization can rewrite shared-peer links, so it must obey the same pass -> writer order as
  //    add/remove. A whole update pass excludes a direct materializer, not only CLI mutation helpers.
  {
    const ref: ExtensionRef = { kind: "connector", name: "pass-excluded" };
    const ext = fakePackage([ref]);
    const release = claimExtensionUpdatePass();
    try {
      await assert.rejects(
        importInstalledExtension(ext, ref),
        /another extension update or mutation is in progress/,
      );
    } finally {
      release();
    }
  }

  console.log("materialize-concurrency.smoke: all assertions passed");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
