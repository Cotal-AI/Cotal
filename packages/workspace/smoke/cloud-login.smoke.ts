import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { COTAL_CLOUD_IDP, cloudAuthUrl, isCotalCloudIdp, loginRecoveryCommand, loginBrowserCommand } from "../src/cloud-login.js";

assert.equal(COTAL_CLOUD_IDP, "https://cotal.cloud/api/auth");
for (const host of ["cotal.cloud", "cloud.cotal.ai"]) {
  for (const url of [`https://${host}/api/auth`, `https://${host}/api/auth/`, `https://${host.toUpperCase()}:443/api/auth`])
    assert.equal(isCotalCloudIdp(url), true, url);
  for (const url of [`https://${host}`, `https://${host}/other`, `https://${host}/api/auth/extra`, `http://${host}/api/auth`, `https://${host}:444/api/auth`, `https://user@${host}/api/auth`, `https://${host}/api/auth?x=1`, `https://${host}/api/auth#x`, `https://${host}.evil.example/api/auth`])
    assert.equal(isCotalCloudIdp(url), false, url);
}
assert.equal(isCotalCloudIdp("not a URL"), false);
assert.equal(cloudAuthUrl("https://cotal.cloud"), COTAL_CLOUD_IDP);
assert.equal(cloudAuthUrl("https://cotal.cloud/"), COTAL_CLOUD_IDP);
assert.equal(cloudAuthUrl("https://cloud.cotal.ai"), "https://cloud.cotal.ai/api/auth");
assert.equal(cloudAuthUrl("https://cloud.cotal.ai/"), "https://cloud.cotal.ai/api/auth");
assert.equal(cloudAuthUrl("https://other.example"), "https://other.example");
assert.equal(cloudAuthUrl("https://cloud.cotal.ai.evil.example"), "https://cloud.cotal.ai.evil.example");
for (const idp of [COTAL_CLOUD_IDP, `${COTAL_CLOUD_IDP}/`, 'https://cotal.cloud']) assert.equal(loginRecoveryCommand(idp), 'cotal login');
for (const idp of ['https://cloud.cotal.ai/api/auth', 'https://other.example/api/auth', 'http://127.0.0.1:12345/api/auth', 'https://cloud.cotal.ai.evil.example']) assert.equal(loginRecoveryCommand(idp), `cotal login --idp ${idp}`);
const desktop = readFileSync(new URL("../../../desktop/src/model.ts", import.meta.url), "utf8");
assert.equal(desktop.match(/export const COTAL_CLOUD_IDP = "([^"]+)"/)?.[1], COTAL_CLOUD_IDP, "desktop and CLI Cloud addresses agree");
const url = "https://cloud.cotal.ai/device?user_code=TEST";
const options = { terminal: true, json: false, noBrowser: false, platform: "linux" as const, env: { DISPLAY: ":1" } };
assert.deepEqual(loginBrowserCommand(url, options), { command: "xdg-open", args: [url] });
assert.equal(loginBrowserCommand(url, { ...options, terminal: false }), undefined);
assert.equal(loginBrowserCommand(url, { ...options, json: true }), undefined);
assert.equal(loginBrowserCommand(url, { ...options, noBrowser: true }), undefined);
assert.equal(loginBrowserCommand(url, { ...options, env: {} }), undefined);
assert.deepEqual(loginBrowserCommand(url, { ...options, env: { WAYLAND_DISPLAY: "wayland-0" } }), { command: "xdg-open", args: [url] });
assert.deepEqual(loginBrowserCommand(url, { ...options, platform: "darwin" }), { command: "open", args: [url] });
assert.deepEqual(loginBrowserCommand(url, { ...options, platform: "win32" }), { command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] });
assert.throws(() => loginBrowserCommand("javascript:alert(1)", options));
assert.throws(() => loginBrowserCommand("https://user:pass@example.test", options));
assert.throws(() => loginBrowserCommand("https://example.test/%PATH%", { ...options, platform: "win32" }));
console.log("Cloud alias, desktop consistency and browser decision cells passed (no browser launched).");
