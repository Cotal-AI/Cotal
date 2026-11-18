import "./update-isolation.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { emitSentinel } from "@cotal-ai/smoke-kit";

const source = readFileSync(new URL("../src/seed/reconcile.ts", import.meta.url), "utf8");
assert(source.includes('await reconcile("auto", true)'), "boot reconciliation carries automatic intent");
assert(source.includes("const result = await reconcile(mode)"), "explicit seed keeps strict reconciliation intent");
assert.equal(source.split('await reconcile("repair", automatic)').length - 1, 2, "automatic repair paths preserve boot intent");
const start = source.indexOf('if ((mode === "auto" || automatic)');
const branch = source.slice(start, source.indexOf("const lock = acquireReconcileLock()", start));
assert(branch.indexOf("connectorConfigDir();") < branch.indexOf("try { await assertAutomaticSeedManagers"), "selection validation is not converted to a Manager hold");
assert(branch.includes("if (!automatic) throw error"), "explicit reconciliation remains strict");
assert(branch.includes("return NOOP"), "automatic Manager hold skips writes");
assert(branch.includes("until the Manager is restarted"), "the informational line explains the retained connector generation");
emitSentinel({ passed: 7, failed: 0 });
