// Only the native boundary is simulated. The built renderer and styles are unchanged.
import assert from "node:assert/strict";
export function nativeStub(scenario) {
  const callbacks = new Map(); let next = 0;
  const state = { ...scenario };
  const ok = result => ({ v: 1, event: "result", ok: true, result });
  const fail = (code, message, native) => ({ v: 1, event: "result", ok: false, error: { code, message, ...(native ? { native: { code: native } } : {}) } });
  const manager = () => ({ space: "acme-team", state: "answering", instanceId: "machine-1", connectors: [{ agent: "claude", state: "available" }, { agent: "codex", state: "available" }] });
  window.isTauri = true;
  window.__renderState = state;
  Object.defineProperty(navigator, "clipboard", { value: { writeText: async value => { if (state.copyFailure) throw new Error("Clipboard unavailable"); state.clipboard = value; } }, configurable: true });
  window.__TAURI_INTERNALS__ = {
    transformCallback(fn) { callbacks.set(++next, fn); return next; },
    unregisterCallback(id) { callbacks.delete(id); },
    async invoke(command, args) {
      if (command === "plugin:deep-link|get_current") return state.link ? [state.link] : null;
      if (command === "plugin:event|listen") return 1;
      if (command === "desktop_presence") return { loginEnabled: true, relocationOffer: false, pinOffer: false, pinMessage: "" };
      if (command === "open_browser" || command === "set_connection_state" || command.startsWith("plugin:")) return null;
      if (command !== "daemon_request") throw new Error(`Unexpected native command: ${command}`);
      const request = args.request; let index = 0;
      const send = message => callbacks.get(args.onEvent.id)({ message, index: index++ });
      if (request.op === "about") {
        if (state.loading) await new Promise(() => {});
        return ok({ version: "0.156.0", machine: "Davids-MacBook-Pro", platform: "darwin", arch: "arm64", memoryBytes: 36 * 1024 ** 3 });
      }
      if (request.op === "install") { state.installed = true; return ok({ installed: true }); }
      if (!state.installed) return fail("NOT_RUNNING", "The daemon is not running. Install its background service first.");
      if (request.op === "status" && state.offline) return fail("NOT_ANSWERING", "The background service did not answer. Check the host connection before retrying.");
      if (request.op === "status") return ok({ state: "ready", version: state.version ?? "0.156.0", managers: state.connected ? [manager()] : [], ...(state.account ? { account: state.account } : {}) });
      if (request.op === "spaces" && state.catalogFailure) throw new Error("The space catalog could not be refreshed.");
      if (request.op === "spaces") return ok({ spaces: state.signedIn && !state.empty ? [{ space: "acme-team", label: "Acme team", mode: "user", idp: "https://cloud.cotal.ai/api/auth", catalogId: "sp_acme", kind: state.personal ? "personal" : "team", role: "owner" }, ...(state.multiple ? [{ space: "research", label: "Research", mode: "user", idp: "https://cloud.cotal.ai/api/auth", catalogId: "sp_research", kind: "team", role: "member" }] : [])] : [] });
      if (request.op === "service-status") return ok({ state: state.serviceState ?? "disconnected" });
      if (request.op === "service-disconnect") { state.connected = false; return ok({ state: "disconnected" }); }
      if (request.op === "login") {
        if (state.loginError) return fail(state.loginError, `Sign-in failed: ${state.loginError}.`);
        send({ v: 1, event: "login-prompt", prompt: { verificationUriComplete: "https://cloud.cotal.ai/device?user_code=WDJB-MJHT", userCode: "WDJB-MJHT", expiresAt: new Date(Date.now() + (state.expired ? -1000 : 581000)).toISOString() } });
        if (state.waiting || state.expired) await new Promise(() => {});
        state.signedIn = true;
        if (state.accountAfterLogin) state.account = state.accountAfterLogin;
        return ok({ outcome: "signed-in" });
      }
      if (request.op === "setup") {
        const progress = (step, outcome, detail, extra = {}) => send({ v: 1, event: "setup-progress", line: detail, progress: { step, outcome, detail, ...extra } });
        progress("install", "ready", "service: background service answers");
        progress("sign-in", "already-signed-in", "sign-in: already signed in");
        progress("discover", "registered", "discover: space registered");
        progress("manager", "running", "service: waiting for hosted Managers to confirm readiness and an idle restart fence");
        if (state.connecting) {
          window.__advanceSetup = () => progress("applications", "available", "connectors: available", { applications: ["Claude Code", "Codex"] });
          await new Promise(() => {});
        }
        if (state.setupError) return fail("LIFECYCLE_BLOCKED", `Setup could not proceed: ${state.setupError}. Stop active sessions before retrying.`, state.setupError);
        progress("applications", state.noApp ? "unavailable" : "available", "connectors: availability checked", { applications: ["Claude Code", "Codex", "Hermes", "Jcode", "OpenCode", "pi"] });
        if (state.noApp) return fail("DEPENDENCY_UNAVAILABLE", "No available connector in the hosted Manager environment. Install Claude Code or Codex, then check again.", "NO_AVAILABLE_CONNECTOR");
        state.connected = true; return ok({ launchReady: true, manager: manager() });
      }
      throw new Error(`Unexpected operation: ${request.op}`);
    },
  };
}

const link = "cotal://connect?idp=https%3A%2F%2Fcloud.cotal.ai%2Fapi%2Fauth&space=sp_acme";
const signIn = async page => { await page.click("#login"); await page.locator("#connect-panel:not([hidden]), #space-panel:not([hidden]), #recovery-panel:not([hidden])").first().waitFor(); };
const connect = async page => { await signIn(page); await page.click("#connect"); };
export const scenarios = [
  { name: "account-live-list", state: { installed: true, signedIn: true, connected: true, multiple: true, account: { mode: "account", hostSupport: "supported", spaces: [{ space: "acme-team", desired: true, observed: "connected" }] } }, expect: async page => {
    assert.equal(await page.locator("#another-space").textContent(), "Add to another space");
    await page.evaluate(() => window.__renderState.account.spaces.push({ space: "research", desired: true, observed: "connecting" }));
    await page.locator('[data-space="research"]').waitFor({ timeout: 6000 });
    await page.evaluate(() => window.__renderState.account.spaces.pop());
    await page.locator('[data-space="research"]').waitFor({ state: "detached", timeout: 6000 });
  } },
  { name: "account-first-sign-in", state: { accountAfterLogin: { mode: "account", hostSupport: "supported", spaces: [] } }, act: async page => { await page.click("#login"); await page.locator("#connected-panel:not([hidden])").waitFor(); }, expect: async page => {
    assert.equal(await page.locator("#connection-title").textContent(), "This computer is connected to your account");
    assert.equal(await page.locator("#tray-label").textContent(), "Ready");
  } },
  { name: "account-ready", state: { installed: true, signedIn: true, account: { mode: "account", hostSupport: "supported", spaces: [] } }, expect: async page => {
    assert.equal(await page.locator("#another-space").textContent(), "Add a space");
    assert.equal(await page.locator("#connection-title").textContent(), "This computer is connected to your account");
    assert.equal(await page.locator("#tray-label").textContent(), "Ready");
    assert.equal(await page.locator("#connection-icon").getAttribute("data-icon"), "check");
    assert.equal(await page.locator("#dashboard").isVisible(), true);
    assert.equal(await page.locator("#dashboard-spaces-note").isVisible(), false);
    assert.equal(await page.locator("#tray-indicator").evaluate(el => getComputedStyle(el).backgroundColor), "rgb(95, 168, 102)");
  } },
  ...["connected", "starting", "approval-pending", "removed on this computer", "refusal", "sign-in-required"].map(observed => ({
    name: `account-${observed.replaceAll(" ", "-")}`,
    state: { installed: true, signedIn: true, connected: observed === "connected", account: { mode: observed === "sign-in-required" ? observed : "account", hostSupport: "supported", spaces: [{ space: "acme-team", desired: true, observed, ...(observed === "refusal" ? { lastRefusal: "Ask the space owner to approve this computer." } : {}) }] } },
    expect: async page => {
      assert.equal(await page.locator("#connected-panel").isVisible(), true);
      assert.equal(await page.locator("#sign-in-again").isVisible(), observed === "sign-in-required");
      const pill = observed === "connected" ? "Connected" : observed === "sign-in-required" ? "Sign in required" : observed === "removed on this computer" ? "Ready" : "Starting";
      assert.equal(await page.locator("#tray-label").textContent(), pill);
      const dot = await page.locator("#tray-indicator").evaluate(el => getComputedStyle(el).backgroundColor);
      assert.equal(dot, ["sign-in-required", "refusal"].includes(observed) ? "rgb(224, 98, 90)" : observed === "connected" || observed === "removed on this computer" ? "rgb(95, 168, 102)" : "rgb(229, 185, 78)");
      if (observed === "sign-in-required") {
        assert.equal(await page.locator("#connection-title").textContent(), "Sign in to keep this computer connected");
        assert.equal(await page.locator("#sign-in-again").textContent(), "Sign in");
        assert.equal(await page.locator("#sign-in-again").evaluate(el => el.classList.contains("primary")), true);
      }
    },
  })),
  { name: "loading", state: { loading: true }, expect: async page => {
    assert.equal(await page.locator("#tray-label").textContent(), "Checking connection");
    assert.equal(await page.locator("#loading-icon .icon-spinner").count(), 1);
    assert.ok(await page.locator(".connection-card").evaluate(el => el.getBoundingClientRect().height) < 100);
  } },
  { name: "welcome", state: {} },
  { name: "four-steps", state: {}, expect: async page => assert.equal(await page.locator('#journey li').count(), 4) },
  { name: "link", state: { link } },
  { name: "custom-host", state: {}, act: page => page.click("#other-host") },
  { name: "waiting", state: { waiting: true }, act: page => page.click("#login") },
  { name: "signed-in", state: {}, act: signIn },
  { name: "spaces", state: { multiple: true }, act: signIn },
  { name: "personal", state: { multiple: true, personal: true }, act: signIn },
  { name: "add-space", state: { installed: true, signedIn: true, connected: true, multiple: true }, act: async page => { await page.click('#another-space'); await page.selectOption('#space', 'research'); } },
  { name: "connecting", state: { connecting: true }, act: connect },
  { name: "ready", state: {}, act: connect },
  { name: "later-open", state: { installed: true, signedIn: true, connected: true }, expect: async page => assert.equal(await page.locator("#journey").isVisible(), false) },
  { name: "no-application", state: { noApp: true }, act: connect },
  { name: "sessions-active", state: { setupError: "SEATS_ACTIVE" }, act: connect },
  { name: "expired", state: { expired: true }, act: page => page.click("#login"), expect: async page => assert.equal(await page.locator("#recover .icon-spinner").count(), 0) },
  { name: "declined", state: { loginError: "DENIED" }, act: page => page.click("#login") },
  { name: "offline", state: { installed: true, signedIn: true, offline: true } },
  { name: "no-spaces", state: { empty: true }, act: signIn },
  { name: "connected-and-pending", state: { installed: true, signedIn: true, connected: true, multiple: true, serviceState: "approval-pending" }, expect: async page => {
    assert.equal(await page.locator("#connection-title").textContent(), "This computer is connected");
    assert.equal(await page.locator('[data-testid="connected-space-row"]').count(), 2);
  } },
  { name: "approval-pending", state: { installed: true, signedIn: true, serviceState: "approval-pending" }, expect: async page => {
    assert.equal(await page.locator("#connection-title").textContent(), "Waiting for owner approval");
    assert.equal(await page.locator("#connection-icon").getAttribute("data-icon"), "clock");
    assert.equal(await page.locator("#dashboard").isVisible(), false);
    assert.equal(await page.locator("#applications-label").isVisible(), false);
    assert.match(await page.locator("#connected-spaces").textContent(), /Waiting for owner approval/);
    assert.equal(await page.locator(".connection-card.has-refusal").count(), 0);
  } },
  { name: "version-mismatch", state: { installed: true, signedIn: true, version: "old" } },
  { name: "progress-done", state: { connecting: true }, prepare: connect, act: page => page.evaluate(() => window.__advanceSetup()) },
  { name: "disconnected", state: { installed: true, signedIn: true, connected: true }, act: page => page.click("#connected-spaces button"), expect: async page => assert.equal(await page.locator("#notice").isVisible(), false) },
  { name: "notice", state: { waiting: true, copyFailure: true }, prepare: page => page.click("#login"), act: page => page.click("#copy-code") },
  { name: "details-open", state: { noApp: true }, prepare: connect, act: page => page.locator("#details summary").click() },
];
