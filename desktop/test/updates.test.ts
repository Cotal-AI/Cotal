import assert from "node:assert/strict";
import test from "node:test";
import { accountHost, installerLink, installerName, newerVersion, releaseUrl, updateNotice, updatePolicy, updateSummary, type UpdateStatus } from "../src/updates";

test("account labels recognize both Cloud auth URLs without branding custom providers", () => {
  assert.equal(accountHost("https://cotal.cloud/api/auth"), "Cotal Cloud, cotal.cloud");
  assert.equal(accountHost("https://cloud.cotal.ai/api/auth"), "Cotal Cloud, cloud.cotal.ai");
  assert.equal(accountHost("https://example.com/api/auth"), "example.com");
  assert.equal(accountHost("https://cotal.cloud/other"), "cotal.cloud");
  assert.equal(accountHost(undefined), "No account selected");
});

const status: UpdateStatus = { channel: "desktop", current: "0.160.5", latest: "0.161.0", automatic: true, notify: true, lastCheck: "2026-11-11T22:00:00Z", lastResult: "available" };
test("desktop notice tracks app version and Later hides only that release", () => {
  assert.equal(updateNotice(status, "0.160.5"), "0.161.0");
  assert.equal(updateNotice(status, "0.160.5", "0.161.0"), undefined);
  assert.equal(updateNotice({ ...status, latest: "0.161.1" }, "0.160.5", "0.161.0"), "0.161.1");
  assert.equal(updateNotice(status, "0.161.0"), undefined);
  assert.equal(updateNotice({ ...status, notify: false }, "0.160.5"), undefined);
  assert.equal(updateNotice({ ...status, channel: "npm" }, "0.160.5"), undefined);
});
test("update summary covers available current unchecked and failed", () => {
  assert.equal(updateSummary(status, "0.160.5"), "Version 0.161.0 is available.");
  assert.equal(updateSummary({ ...status, latest: "0.160.5" }, "0.160.5"), "You are up to date.");
  assert.equal(updateSummary({ ...status, latest: undefined, lastResult: "check failed" }, "0.160.5"), "The update check failed. Try again.");
  assert.equal(newerVersion("0.9.0", "0.10.0"), false);
  assert.equal(newerVersion("0.10.1", "0.10.0"), true);
});
test("each platform explains the control that can actually work", () => {
  for (const platform of ["darwin", "win32", "linux"]) {
    assert.equal(updatePolicy("desktop", platform).label, "Install updates automatically");
    assert.match(updatePolicy("desktop", platform).description, /downloads verified desktop updates/);
  }
  assert.equal(updatePolicy("npm", "linux").label, "Install updates automatically");
  for (const platform of ["darwin", "win32"]) assert.equal(updatePolicy("npm", platform).label, "Notify me about updates");
  for (const automatic of [true, false]) assert.equal(updateNotice({ ...status, automatic }, "0.160.5"), status.latest);
});
test("installer links require an observed matching release asset", () => {
  for (const [platform, arch, suffix] of [["darwin", "arm64", "aarch64.dmg"], ["darwin", "x64", "x64.dmg"], ["win32", "x64", "x64-setup.exe"], ["linux", "x64", "amd64.deb"]]) {
    const name = `Cotal_0.161.0_${suffix}`;
    const url = `https://github.com/Cotal-AI/Cotal/releases/download/v0.161.0/${name}`;
    assert.equal(installerName("0.161.0", platform, arch), name);
    assert.equal(installerLink("0.161.0", platform, arch, [{ name, url }]).url, url);
    assert.equal(installerLink("0.161.0", platform, arch, [{ name, url: "https://evil.example/file" }]).available, false);
  }
  assert.equal(installerLink("0.161.0", "linux", "arm64", []).url, releaseUrl("0.161.0"));
  assert.equal(installerLink("0.161.0", "win32", "arm64", []).label, "Open release page");
  assert.throws(() => releaseUrl("../latest"));
});
