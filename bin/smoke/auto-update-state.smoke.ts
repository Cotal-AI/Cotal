import strictAssert from "node:assert/strict";
import { countedAssert, emitSentinel } from "./sentinel.mjs";
const counted = countedAssert(strictAssert);
const assert: typeof strictAssert = counted.assert as typeof strictAssert;
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { automaticUpdates } from "../daemon/auto-update.js";
const home = mkdtempSync(join(tmpdir(), "autoupd-state-"));
process.env.COTAL_HOME = home;
const path = join(home, "update-attempt.json");
writeFileSync(path, JSON.stringify({ version: "2.0.0", failures: 2, result: "failed twice", next: Date.now() + 3600_000 }));
const updater = automaticUpdates({ version: "1.0.0", eligible: () => true, prepare: async () => {}, abort: async () => {}, report: () => {} });
try {
 assert.equal(updater.status().failures, 2);
 const { recordUpdateCompletion, writeUpdateRecovery, clearUpdateRecovery } = await import("@cotal-ai/workspace");
 recordUpdateCompletion("2.0.0", "updated to 2.0.0", true);
 assert.equal(updater.status().failures, 0);
 assert.ok(updater.status().lastResult.startsWith("updated to 2.0.0"));
 writeUpdateRecovery({ previous: "1.0.0", target: "2.0.0", installed: "2.0.0", phase: "paused", reason: "repair failed" });
 assert.equal(updater.status().automatic, false);
 assert.match(updater.status().lastResult, /installed 2.0.0.*repair failed/);
 clearUpdateRecovery();
 assert.equal(updater.status().automatic, process.platform === "linux" && process.env.COTAL_NO_UPDATE_CHECK !== "1");
 const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
 try {
  for (const value of ["darwin", "win32", "freebsd"]) {
   Object.defineProperty(process, "platform", { value });
   assert.equal(updater.status().automatic, false, `${value} must not install automatically`);
   assert.match(updater.status().lastResult, /Automatic installation is available on Linux in this release\. Run `cotal update --self` here/);
  }
 } finally { Object.defineProperty(process, "platform", platform); }
 emitSentinel({ passed: counted.cells(), failed: 0 });
} finally { await updater.close(); }
