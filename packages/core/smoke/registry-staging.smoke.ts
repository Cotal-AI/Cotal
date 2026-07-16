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
import assert from "node:assert/strict";
import { Registry, registry } from "../src/registry.js";

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

console.log("registry-staging.smoke: all assertions passed");
