// Only the native boundary is simulated. The built renderer and styles are unchanged.
import assert from "node:assert/strict";
export function nativeStub(scenario) {
  const callbacks = new Map(); let next = 0;
  const state = { ...scenario, accountRequests: [] };
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
      if (command === "first_paint") { state.paintReports = (state.paintReports ?? 0) + 1; return null; }
      if (command === "plugin:deep-link|get_current") return state.link ? [state.link] : null;
      if (command === "plugin:event|listen") return 1;
      if (command === "desktop_presence") return { loginEnabled: true, relocationOffer: false, pinOffer: false, pinMessage: "" };
      if (command === "set_update_notice") { state.trayUpdate = args.version; return null; }
      if (command === "open_browser" || command === "set_connection_state" || command.startsWith("plugin:")) return null;
      if (command !== "daemon_request") throw new Error(`Unexpected native command: ${command}`);
      const request = args.request; let index = 0;
      const send = message => callbacks.get(args.onEvent.id)({ message, index: index++ });
      if (request.op === "about") {
        if (state.loading) await new Promise(() => {});
        return ok({ version: "0.156.0", machine: "Davids-MacBook-Pro", platform: state.platform ?? "darwin", arch: state.arch ?? "arm64", memoryBytes: 36 * 1024 ** 3 });
      }
      if (request.op === "update-release") return ok({ assets: state.missingAsset ? [] : [{ name: "Cotal_0.161.0_aarch64.dmg", url: "https://github.com/Cotal-AI/Cotal/releases/download/v0.161.0/Cotal_0.161.0_aarch64.dmg" }] });
      if (request.op === "update-settings") { state.update = { ...state.update, ...(request.auto !== undefined ? { automatic: request.auto } : {}), ...(request.notify !== undefined ? { notify: request.notify } : {}) }; return ok({ update: state.update }); }
      if (request.op === "update-check") return ok({ update: state.update });
      if (request.op === "install") { state.installed = true; return ok({ installed: true }); }
      if (!state.installed) return fail("NOT_RUNNING", "The daemon is not running. Install its background service first.");
      if (request.op === "status" && state.offline) return fail("NOT_ANSWERING", "The background service did not answer. Check the host connection before retrying.");
      if (request.op === "status") return ok({ state: "ready", version: state.version ?? "0.156.0", managers: state.accountAction ? state.account.spaces.filter(row => row.desired).map(row => ({ ...manager(), space: row.space })) : state.connected ? [manager()] : [], ...(state.update ? { update: state.update } : {}), ...(state.account ? { account: state.account } : {}) });
      if (request.op === "spaces" && state.catalogFailure) throw new Error("The space catalog could not be refreshed.");
      if (request.op === "spaces") return ok({ signedInProviders: state.signedIn ? ["https://cloud.cotal.ai/api/auth"] : [], ...(state.otherProviderFailed && request.refresh ? { refresh: "partial", failedProviders: ["https://hack.cotal.ai/api/auth"] } : {}), spaces: state.catalogSpaces ?? (state.signedIn && !state.empty ? [{ space: "acme-team", label: "Acme team", mode: "user", idp: "https://cloud.cotal.ai/api/auth", catalogId: "sp_acme", kind: state.personal ? "personal" : "team", role: "owner" }, ...(state.multiple ? [{ space: "research", label: "Research", mode: "user", idp: "https://cloud.cotal.ai/api/auth", catalogId: "sp_research", kind: "team", role: "member" }] : [])] : []) });
      if (request.op === "name") { if (request.name !== undefined) state.computerName = request.name; return ok({ computer: state.computerName ?? "Davids-MacBook-Pro" }); }
      if (request.op === "service-status") return ok({ state: state.accountAction && state.account.spaces.some(row => row.space === request.space && row.desired) ? "connected" : state.serviceState ?? "disconnected" });
      if (request.op === "logout") {
        state.accountRequests.push({ ...request });
        if (state.accountAction === "signout-busy") await new Promise(() => {});
        if (state.accountAction === "signout-refusal") return fail("LOGOUT_FAILED", "The provider refused to revoke this sign-in. Try again.");
        state.signedIn = false;
        return ok({ kind: "logout", localLoginCleared: true, serverRevoked: true, removedRegistrations: [] });
      }
      if (request.op === "service-disconnect") {
        if (state.accountAction) {
          state.accountRequests.push({ ...request });
          if (state.accountAction === "disconnect-busy") await new Promise(() => {});
          if (state.accountAction === "disconnect-refusal" || (state.accountAction === "disconnect-partial" && request.space === "research")) return fail("LIFECYCLE_BLOCKED", "Active sessions prevent disconnecting this space.", "SEATS_ACTIVE");
          if (state.accountAction === "disconnect-unknown") return ok({ state: "unknown" });
          const row = state.account.spaces.find(item => item.space === request.space);
          if (row) { row.desired = false; row.observed = "removed on this computer"; }
          state.connected = state.account.spaces.some(item => item.desired);
        } else state.connected = false;
        return ok({ state: "disconnected" });
      }
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
const update = { channel: "desktop", current: "0.156.0", latest: "0.161.0", lastCheck: "2026-11-11T22:00:00Z", lastResult: "available", automatic: true, notify: true };
const longAccountSpaces = Array.from({ length: 12 }, (_, index) => ({ space: `team-${index + 1}-${"nested-project-path-".repeat(5)}`, label: `Organization / engineering / projects / ${index + 1} / ${"long-unbroken-label".repeat(5)}`, idp: "https://cloud.cotal.ai/api/auth", mode: "user", kind: "team", role: "owner" }));
export const scenarios = [
  ...[12, 30].map(count => ({
    name: `connected-long-spaces-${count}`,
    state: { installed: true, signedIn: true, connected: true, account: { mode: "account", hostSupport: "supported", spaces: Array.from({ length: count }, (_, index) => ({ space: `team-${index + 1}-${"nested-project-path-".repeat(5)}`, desired: true, observed: "connected" })) } },
    expect: async page => {
      assert.equal(await page.locator("#connected-panel").isVisible(), true);
      assert.equal(await page.locator('[data-testid="connected-space-row"]').count(), count);
      assert.equal(await page.locator("#settings-panel").isVisible(), false);
      const region = page.getByRole("region", { name: "Connected space list", exact: true });
      assert.equal(await region.getAttribute("tabindex"), "0");
      const lastRow = page.locator('[data-testid="connected-space-row"]').last();
      await region.focus();
      await region.press("End");
      await page.waitForFunction(() => { const el = document.querySelector(".connected-spaces-scroll"); return el.scrollTop + el.clientHeight >= el.scrollHeight - 2; });
      await lastRow.scrollIntoViewIfNeeded();
      const lastButton = lastRow.locator("button").last();
      await lastButton.focus();
      assert.equal(await lastButton.evaluate(el => el === document.activeElement), true);
      assert.equal(await lastButton.evaluate(el => { const row = el.getBoundingClientRect(); const bounds = el.closest(".connected-spaces-scroll").getBoundingClientRect(); return row.top >= bounds.top && row.bottom <= bounds.bottom; }), true);
      await region.evaluate(el => { el.scrollTop = 0; });
      assert.equal(await page.locator("#dashboard").isVisible(), true);
      await page.click("#open-settings", { timeout: 5000 });
      assert.equal(await page.locator("#settings-panel").isVisible(), true);
      assert.equal(await page.locator("#open-settings").textContent(), "Back");
      await page.click("#open-settings", { timeout: 5000 });
      assert.equal(await page.locator("#connected-panel").isVisible(), true);
    },
  })),
  { name: "account-disconnect-long-confirmation", state: { installed: true, signedIn: true, connected: true, accountAction: "disconnect-confirmation", catalogSpaces: longAccountSpaces, account: { idpUrl: "https://cloud.cotal.ai/api/auth", mode: "account", hostSupport: "supported", spaces: [{ space: longAccountSpaces[0].space, desired: true, observed: "connected" }] } }, act: async page => {
    await page.click("#open-settings");
    await page.evaluate(spaces => {
      window.__renderState.catalogSpaces = spaces;
      window.__renderState.account.spaces = spaces.map(({ space }) => ({ space, desired: true, observed: "connected" }));
    }, longAccountSpaces);
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="connected-space-row"]').length === 12, null, { timeout: 6000 });
    await page.click("#settings-disconnect");
    await page.locator("#account-confirmation:not([hidden])").waitFor();
  }, expect: async page => {
    assert.equal(await page.locator("#account-confirm-spaces li").count(), 12);
    assert.match(await page.locator("#account-confirm-spaces li").first().textContent(), /Organization \/ engineering \/ projects/);
    const bounds = await page.locator("#account-confirm-spaces").evaluate(el => ({ height: el.clientHeight, scroll: el.scrollHeight, right: el.getBoundingClientRect().right, width: window.innerWidth }));
    assert.ok(bounds.height <= 100);
    assert.ok(bounds.scroll > bounds.height, "long lists remain scrollable");
    assert.ok(bounds.right <= bounds.width, "pathlike names stay within the window");
    assert.equal(await page.locator("#account-confirm").isVisible(), true);
    assert.equal(await page.locator("#account-cancel").isVisible(), true);
    assert.deepEqual(await page.evaluate(() => window.__renderState.accountRequests), []);
  } },
  { name: "account-signedout-connected", state: { installed: true, signedIn: false, connected: true, account: { idpUrl: "https://cloud.cotal.ai/api/auth", sub: "stale-account-owner", mode: "account", hostSupport: "supported", spaces: [{ space: "acme-team", desired: true, observed: "connected" }] } }, act: page => page.click("#open-settings"), expect: async page => {
    assert.equal(await page.locator("#settings-signout").isDisabled(), true);
    assert.equal(await page.locator("#settings-disconnect").isEnabled(), true);
    assert.equal(await page.evaluate(() => window.__renderState.connected), true);
    assert.deepEqual(await page.evaluate(() => window.__renderState.accountRequests), []);
  } },
  ...["signout", "disconnect"].flatMap(action => (action === "signout" ? ["confirmation", "cancel", "success", "refusal", "outcome-back", "busy"] : ["confirmation", "cancel", "success", "refusal", "partial", "unknown", "busy"]).map(mode => ({
    name: `account-${action}-${mode}`,
    state: { installed: true, signedIn: true, connected: true, multiple: true, accountAction: `${action}-${mode}`, account: { idpUrl: "https://cloud.cotal.ai/api/auth", sub: "account-owner", mode: "account", hostSupport: "supported", spaces: ["acme-team", "research"].map(space => ({ space, desired: true, observed: "connected" })) } },
    act: async page => {
      await page.click("#open-settings");
      await page.click(`#settings-${action}`);
      await page.locator("#account-confirmation:not([hidden])").waitFor();
      if (mode === "confirmation") return;
      if (mode === "cancel") await page.click("#account-cancel");
      else {
        await page.click("#account-confirm");
        if (mode === "busy") await page.waitForFunction(() => window.__renderState.accountRequests.length === 1);
        else {
          await page.locator("#account-confirmation").waitFor({ state: "hidden" });
          await page.locator("#account-outcome:not([hidden])").waitFor();
          if (mode === "outcome-back") await page.click("#account-outcome-back");
        }
      }
    },
    expect: async page => {
      const snapshot = await page.evaluate(() => ({ requests: window.__renderState.accountRequests, connected: window.__renderState.connected, signedIn: window.__renderState.signedIn, spaces: window.__renderState.account.spaces }));
      if (mode === "confirmation" || mode === "cancel") {
        assert.deepEqual(snapshot.requests, []);
        assert.equal(snapshot.connected, true);
        assert.equal(snapshot.signedIn, true);
        assert.equal(await page.locator("#account-confirmation").isVisible(), mode === "confirmation");
        if (mode === "confirmation") {
          assert.equal(await page.locator("#account-confirm-title").textContent(), action === "signout" ? "Sign out of Cotal Cloud, cloud.cotal.ai?" : "Disconnect this computer from Cotal Cloud, cloud.cotal.ai?");
          assert.equal(await page.locator("#account-confirm-copy").textContent(), action === "signout" ? "Existing connections keep running. Disconnect this computer first if you also want to stop its connections. Only this provider will be signed out." : "Stop the following spaces one by one. This does not remove this computer from the dashboard, uninstall the service, revoke provider authority or erase retained renewal records. Disconnect before signing out if you want both.");
          assert.equal(await page.locator("#account-cancel").evaluate(el => el === document.activeElement), true);
          if (action === "disconnect") {
            assert.match(await page.locator("#account-confirm-spaces").textContent(), /acme-team/);
            assert.match(await page.locator("#account-confirm-spaces").textContent(), /research/);
          }
        } else assert.equal(await page.locator(`#settings-${action}`).evaluate(el => el === document.activeElement), true);
        return;
      }
      assert.equal(snapshot.requests[0].op, action === "signout" ? "logout" : "service-disconnect");
      if (mode === "busy") {
        assert.equal(snapshot.requests.length, 1);
        assert.equal(snapshot.connected, true);
        assert.equal(await page.locator("#account-confirm").isDisabled(), true);
        assert.equal(await page.locator("#account-cancel").isDisabled(), true);
        return;
      }
      if (mode === "outcome-back") {
        assert.equal(await page.locator("#settings-panel").evaluate(el => el.classList.contains("account-outcome-view")), false);
        for (const id of ["settings-name", "check-updates", "update-preference", "autostart", "settings-signout", "settings-disconnect", "settings-versions", "release-notes"]) {
          const geometry = await page.locator(`#${id}`).evaluate(el => { const rect = el.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom, right: rect.right, height: window.innerHeight, width: window.innerWidth }; });
          assert.equal(await page.locator(`#${id}`).isVisible(), true);
          assert.ok(geometry.top >= 0 && geometry.bottom <= geometry.height && geometry.right <= geometry.width, `${id} fully restored within viewport`);
        }
        assert.equal(await page.locator("#settings-title").evaluate(el => el === document.activeElement), true);
        assert.equal(await page.locator("#account-outcome-back").isVisible(), false);
        assert.equal(snapshot.connected, true);
        return;
      }
      assert.equal(await page.locator("#settings-panel").evaluate(el => el.classList.contains("account-outcome-view")), true);
      assert.equal(await page.locator("#account-outcome-back").isVisible(), true);
      assert.equal(await page.locator("#settings-versions").isVisible(), false);
      const outcome = (await page.locator("#account-outcome").textContent()).trim();
      assert.ok(outcome, "completed actions always describe their outcome");
      if (action === "signout") {
        assert.equal(snapshot.requests.length, 1);
        assert.equal(snapshot.requests[0].idp, "https://cloud.cotal.ai/api/auth");
        assert.equal(snapshot.connected, true, "signing out does not disconnect the computer");
        assert.equal(snapshot.signedIn, mode !== "success");
        assert.equal(outcome, mode === "success" ? "Signed out of Cotal Cloud, cloud.cotal.ai. Existing connections keep running." : "Sign-out: The provider refused to revoke this sign-in. Try again.");
      } else {
        assert.deepEqual(snapshot.requests.map(request => request.space), ["acme-team", "research"]);
        assert.match(outcome, /acme-team/);
        assert.match(outcome, /research/);
        assert.equal(snapshot.connected, mode !== "success");
        assert.deepEqual(snapshot.spaces.map(space => space.desired), mode === "success" ? [false, false] : mode === "partial" ? [false, true] : [true, true]);
        assert.equal(snapshot.signedIn, true, "disconnecting does not sign out");
        if (mode === "refusal" || mode === "partial") {
          for (const space of mode === "partial" ? ["research"] : ["acme-team", "research"]) assert.ok(outcome.includes(`${space}: Active sessions prevent disconnecting this space.`));
          if (mode === "partial") assert.ok(outcome.includes("acme-team: disconnected, confirmed by refresh."));
        }
        if (mode === "success") for (const space of ["acme-team", "research"]) assert.ok(outcome.includes(`${space}: disconnected, confirmed by refresh.`));
        if (mode === "unknown") for (const space of ["acme-team", "research"]) assert.ok(outcome.includes(`${space}: Disconnect not confirmed (unknown).`));
      }
    },
  }))),
  ...["available", "missing", "current", "failed", "off", "linux", "windows", "toggle-off", "toggle-on", "check"].map(mode => ({
    name: `settings-${mode}`,
    state: { installed: true, signedIn: true, connected: true, missingAsset: mode === "missing", platform: mode === "linux" ? "linux" : mode === "windows" ? "win32" : "darwin", update: { ...update, ...(mode === "current" ? { latest: "0.156.0" } : mode === "failed" ? { latest: undefined, lastResult: "check failed" } : mode === "off" || mode === "toggle-on" ? { notify: false } : {}) } },
    act: async page => { await page.click("#open-settings"); if (mode.startsWith("toggle-")) await page.click("#update-preference"); if (mode === "check") await page.click("#check-updates"); },
    expect: async page => { assert.equal(await page.locator("#settings-panel").isVisible(), true); assert.equal(await page.locator("#autostart").isVisible(), true); },
  })),
  { name: "update-available", state: { installed: true, signedIn: true, connected: true, update }, expect: async page => { assert.match(await page.locator("#update-banner").textContent(), /0.161.0/); } },
  { name: "update-later", state: { installed: true, signedIn: true, connected: true, update }, act: async page => { await page.click("#update-later"); }, expect: async page => { assert.equal(await page.locator("#update-banner").isVisible(), false); } },
  { name: "update-onboarding", state: { installed: true, update }, expect: async page => { assert.equal(await page.locator("#update-banner").isVisible(), false); } },
  ...["view", "edit", "save", "cancel", "invalid", "long", "settings"].map(mode => ({
    name: `computer-name-${mode}`, state: { installed: true, signedIn: mode === "settings", connected: mode === "settings" },
    act: async page => {
      if (mode !== "settings") await signIn(page);
      if (mode === "view") return;
      await page.click("#edit-computer-name");
      if (mode === "edit" || mode === "settings") return;
      await page.fill("#computer-name-input", mode === "invalid" ? "" : mode === "long" ? "Very long computer name ".repeat(5) : "My named computer");
      if (mode === "cancel") await page.press("#computer-name-input", "Escape");
      else await page.press("#computer-name-input", "Enter");
    },
    expect: async page => {
      if (mode === "invalid") assert.match(await page.locator("#computer-name-error").textContent(), /1 to 128/);
      if (mode === "save") assert.equal(await page.locator("#machine-name").textContent(), "My named computer");
      if (mode === "cancel") assert.equal(await page.locator("#machine-name").textContent(), "Davids-MacBook-Pro");
      if (mode === "long") assert.equal(await page.locator("#machine-name").getAttribute("title"), ("Very long computer name ".repeat(5)).trim());
    },
  })),
  { name: "other-provider-notice", state: { installed: true, otherProviderFailed: true }, act: signIn, expect: async page => {
    assert.equal(await page.locator("#recovery-panel").isVisible(), false);
    assert.match(await page.locator("#notice").textContent(), /Spaces from hack\.cotal\.ai could not be refreshed/);
  } },
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
