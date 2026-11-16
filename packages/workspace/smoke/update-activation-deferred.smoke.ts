import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimUpdateClosureAccess, deferredUpdateActivation, recordUpdateActivation } from "../src/update-closure.js";

process.env.COTAL_HOME = mkdtempSync(join(tmpdir(), "activation-deferred-"));
const installation = "/owned/install/dist/cotal.js";
const release = claimUpdateClosureAccess();
try {
  recordUpdateActivation(installation, "0.2.0", "Manager work is unknown; restart deferred");
  assert.equal(deferredUpdateActivation(installation, "0.2.0"), "Manager work is unknown; restart deferred");
  assert.equal(deferredUpdateActivation(installation, "0.3.0"), undefined);
  assert.equal(deferredUpdateActivation("/other/install/dist/cotal.js", "0.2.0"), undefined);
} finally { release(); }
assert.equal(deferredUpdateActivation(installation, "0.2.0"), "Manager work is unknown; restart deferred", "completed transaction retains its target-specific deferral");
const clear = claimUpdateClosureAccess();
try { recordUpdateActivation(installation, "0.2.0"); }
finally { clear(); }
assert.equal(deferredUpdateActivation(installation, "0.2.0"), undefined);
console.log("activation deferral: target/install binding survives completed transaction and a fresh authorized decision clears it");
