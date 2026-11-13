import "../../implementations/cli/smoke/update-isolation.js";
import strictAssert from "node:assert/strict";
import { countedAssert, emitSentinel } from "./sentinel.mjs";
const counted = countedAssert(strictAssert);
const assert: typeof strictAssert = counted.assert as typeof strictAssert;
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
 assert.equal(updater.status().automatic, ["linux", "darwin"].includes(process.platform) && process.env.COTAL_NO_UPDATE_CHECK !== "1");
 const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
 try {
  Object.defineProperty(process, "platform", { value: "darwin" });
  assert.equal(updater.status().automatic, process.env.COTAL_NO_UPDATE_CHECK !== "1", "macOS must schedule automatic installation");
  const { setUpdateSetting } = await import("@cotal-ai/workspace");
  setUpdateSetting("auto", false);
  assert.equal(updater.status().automatic, false, "macOS off switch disables scheduling");
  setUpdateSetting("auto", true);
  process.env.COTAL_NO_UPDATE_CHECK = "1";
  assert.equal(updater.status().automatic, false, "macOS environment opt-out disables scheduling");
  delete process.env.COTAL_NO_UPDATE_CHECK;
  const { renderUpdateLaunchAgent, startLaunchUpdate, readLaunchUpdateResult, cleanLaunchUpdate } = await import("../daemon/update-launchd.js");
  assert.equal(readLaunchUpdateResult(), undefined);
  writeFileSync(join(home, "update-launchd-result.json"), JSON.stringify({ pid: -1, start: "bad", done: true }), { mode: 0o600 });
  assert.throws(readLaunchUpdateResult, /result is invalid/);
  rmSync(join(home, "update-launchd-result.json"));
  writeFileSync(join(home, "update-launchd.json"), JSON.stringify({ label: "ai.cotal.daemon", source: "/foreign", sha256: "x", argv: [] }), { mode: 0o600 });
  assert.throws(cleanLaunchUpdate, /receipt is invalid/);
  rmSync(join(home, "update-launchd.json"));
  const plist = renderUpdateLaunchAgent("ai.cotal.update.test", ["/node", "/entry with & space", "label"], { PATH: "/bin", HOME: "/private/home", COTAL_TOKEN: "never-copy" });
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key><false\/>/);
  assert.match(plist, /<string>\/entry with &amp; space<\/string>/);
  assert.doesNotMatch(plist, /AbandonProcessGroup|never-copy|COTAL_TOKEN|StartInterval|StartCalendarInterval/);
  assert.throws(() => renderUpdateLaunchAgent("bad\nlabel", ["/node"], {}));
  Object.defineProperty(process, "platform", platform);
  if (process.platform !== "darwin") assert.throws(startLaunchUpdate, /requires macOS/);
  for (const value of ["win32", "freebsd"]) {
   Object.defineProperty(process, "platform", { value });
   assert.equal(updater.status().automatic, false, `${value} must not install automatically`);
   assert.match(updater.status().lastResult, /Automatic installation is unavailable on (Windows|freebsd) in this release\. Run `cotal update --self` here/);
  }
 } finally { Object.defineProperty(process, "platform", platform); }
 emitSentinel({ passed: counted.cells(), failed: 0 });
} finally { await updater.close(); rmSync(home, { recursive: true, force: true }); }
