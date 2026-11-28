// Only the native boundary is simulated. The built renderer and styles are unchanged.
import assert from "node:assert/strict";
export function nativeStub(scenario) {
  const missing = (name, title, maker, source, extra = {}) => ({ name, title, maker, state: "missing", missing: [name === "hermes" ? "uv" : name], install: { source }, ...extra });
  const defaultApps = [
    { name: "claude", title: "Claude Code", maker: "Anthropic", state: "signed-in", version: "2.1.332", install: { source: "claude.ai" }, signIn: true },
    { name: "codex", title: "Codex", maker: "OpenAI", state: "signed-in", version: "0.156.1", install: { source: "chatgpt.com" }, signIn: true },
    missing("opencode", "OpenCode", "Anomaly", "opencode.ai"), missing("pi", "pi", "Earendil", "pi.dev"),
    missing("jcode", "Jcode", "Jeremy Huang", "jcode.sh"), missing("hermes", "Hermes", "Nous Research", "astral.sh"),
  ];
  const callbacks = new Map(); let next = 0;
  const state = { ...scenario, accountRequests: [] };
  if (state.trackOwnerTimer) {
    const schedule = window.setTimeout;
    window.setTimeout = function (callback, delay, ...args) {
      if (delay === 5000) state.ownerTimers = (state.ownerTimers ?? 0) + 1;
      return schedule.call(this, callback, delay, ...args);
    };
  }
  const ok = result => ({ v: 1, event: "result", ok: true, result });
  const fail = (code, message, native) => ({ v: 1, event: "result", ok: false, error: { code, message, ...(native ? { native: { code: native } } : {}) } });
  const manager = () => ({ space: "acme-team", state: "answering", instanceId: "machine-1", connectors: [{ agent: "claude", state: "available" }, { agent: "codex", state: "available" }] });
  window.isTauri = true;
  window.__renderState = state;
  window.__emitTauri = (event, payload) => { const id = state.listeners?.[event]; if (id) callbacks.get(id)?.({ event, payload }); };
  Object.defineProperty(navigator, "clipboard", { value: { writeText: async value => { if (state.copyFailure) throw new Error("Clipboard unavailable"); state.clipboard = value; } }, configurable: true });
  window.__TAURI_INTERNALS__ = {
    transformCallback(fn) { callbacks.set(++next, fn); return next; },
    unregisterCallback(id) { callbacks.delete(id); },
    async invoke(command, args) {
      if (command === "app_update_check") {
        state.appChecks = [...(state.appChecks ?? []), { manual: args?.manual === true }];
        if (state.nativeCheckError) throw new Error("Native check unavailable");
        if (state.nativeCheckPending) await new Promise(() => {});
        return state.appUpdate ?? { phase: "unconfigured" };
      }
      if (command === "app_update_receipt") return state.appReceipt;
      if (command === "app_update_apply") {
        state.appApplies = [...(state.appApplies ?? []), { explicit: args.explicit }];
        return state.appUpdate ?? { phase: "unconfigured" };
      }
      if (command === "app_update_download") { state.appDownloads = (state.appDownloads ?? 0) + 1; return state.appUpdate = { phase: "ready", version: state.appUpdate.version }; }
      if (command === "first_paint") { state.paintReports = (state.paintReports ?? 0) + 1; return state.startedHidden ? false : true; }
      if (command === "plugin:deep-link|get_current") return state.link ? [state.link] : null;
      if (command === "plugin:event|listen") { state.listeners = state.listeners ?? {}; state.listeners[args.event] = args.handler; return 1; }
      if (command === "desktop_presence") return { loginEnabled: true, relocationOffer: state.relocationOffer ?? false, pinOffer: state.pinOffer ?? false, pinMessage: state.pinMessage ?? "" };
      if (command === "set_update_notice") { state.trayUpdate = args.version; return null; }
      if (command === "set_connection_state") { state.nativeConnection = args; return null; }
      if (command === "open_browser") {
        state.browserOpens = (state.browserOpens ?? 0) + 1;
        if (state.browserOpens === state.browserFailureAt) throw "The browser could not be opened.";
        return null;
      }
      if (command.startsWith("plugin:")) return null;
      if (command !== "daemon_request") throw new Error(`Unexpected native command: ${command}`);
      const request = args.request; let index = 0;
      if (state.trackAppNavigation && ["install", "login", "setup"].includes(request.op)) {
        (state.connectionActions ??= []).push(request.op);
      }
      const send = message => callbacks.get(args.onEvent.id)({ message, index: index++ });
      if (request.op === "log") { state.logReads = (state.logReads ?? 0) + 1; if (state.logError) return fail("LOG_UNAVAILABLE", "The background service log could not be read."); return ok({ text: state.logText ?? "", truncated: state.logTruncated === true }); }
      if (request.op === "about") {
        if (state.loading) await new Promise(() => {});
        return ok({ version: "0.156.0", machine: state.aboutMachine ?? "Davids-MacBook-Pro", platform: state.platform ?? "darwin", arch: state.arch ?? "arm64", memoryBytes: 36 * 1024 ** 3 });
      }
      if (request.op === "update-policy") { if (state.policyError) throw new Error("Preference unavailable"); if (request.auto !== undefined) state.autoUpdates = request.auto; return ok({ auto: state.autoUpdates !== false }); }
      if (request.op === "update-release") return ok({ assets: state.missingAsset ? [] : [{ name: "Cotal_0.161.0_aarch64.dmg", url: "https://github.com/Cotal-AI/Cotal/releases/download/v0.161.0/Cotal_0.161.0_aarch64.dmg" }] });
      if (request.op === "update-settings") { state.update = { ...state.update, ...(request.auto !== undefined ? { automatic: request.auto } : {}), ...(request.notify !== undefined ? { notify: request.notify } : {}) }; return ok({ update: state.update }); }
      if (request.op === "update-check") return ok({ update: state.update });
      if (request.op === "agent-apps") {
        state.appsRequests = [...(state.appsRequests ?? []), request.refresh === true];
        if (state.appsHold) await new Promise(() => {});
        return ok({ apps: state.agentApps ?? defaultApps, management: state.appManagement ?? (state.installed ? "service" : "local"), ...(state.serviceOwner ? { serviceOwner: state.serviceOwner } : {}), ...(request.refresh && state.refreshService ? { serviceRefresh: state.refreshService } : {}) });
      }
      if (request.op === "agent-app-install" || request.op === "agent-app-sign-in") {
        state.appActions = [...(state.appActions ?? []), `${request.op}:${request.name}`];
        const installing = request.op === "agent-app-install";
        for (const line of installing ? state.installLines ?? ["Downloading the installer from its maker", "Installing native build latest…"] : ["Opening browser to sign in…", "If the browser didn't open, visit:", "https://claude.ai/oauth/authorize?code=true"]) send({ v: 1, event: "agent-app-progress", name: request.name, line });
        if (installing ? state.appInstallHold : state.signInHold) await new Promise(() => {});
        if (installing && state.appInstallUnknown) return fail("OPERATION_UNKNOWN", "The service disconnected before returning the install result.");
        if (installing && state.appInstallFails) return { v: 1, event: "result", ok: false, error: { code: "OPERATION_FAILED", message: "the installer stopped with exit code 1", native: { code: "INSTALLER_FAILED", detail: "curl: (56) Recv failure: Connection reset by peer\nerror: the download did not finish" } } };
        const apps = state.agentApps ?? defaultApps;
        const app = { ...apps.find(item => item.name === request.name), state: installing && request.name === "claude" ? "signed-out" : installing ? "installed" : "signed-in", version: "2.1.332" };
        delete app.missing;
        state.agentApps = apps.map(item => item.name === request.name ? app : item);
        if (installing && state.ownerChangesOnInstall) {
          state.appManagement = "other-copy";
          state.serviceOwner = { kind: "app" };
          return ok({ app, serviceOwner: state.serviceOwner, serviceRefresh: { state: "pending", reason: "unconfirmed" } });
        }
        return ok(installing ? { app, ...(state.appService ? { serviceRefresh: state.appService } : {}), ...(state.pathAdded ? { pathAdded: state.pathAdded } : {}) } : { app });
      }
      if (request.op === "repair-plan") return ok(state.repairPlan ?? { digest: "0".repeat(64), steps: [{ step: "service-owner", outcome: "ok", found: "This copy of Cotal runs the background service." }] });
      if (request.op === "start") {
        (state.startRequests ??= []).push(request);
        if (state.startFails) return { v: 1, event: "result", ok: false, error: { code: "OPERATION_UNKNOWN", message: "Windows daemon restart failed during waiting for a fresh daemon to answer (up to 60s): replacement exited during proof", native: { code: "OPERATION_UNKNOWN" } } };
        if (state.startHold) await new Promise(resolve => { window.__releaseStart = resolve; });
        state.serviceStopped = false;
        return ok({ started: true });
      }
      if (request.op === "install") {
        state.installRequests = (state.installRequests ?? 0) + 1;
        for (const detail of state.installProgress ?? []) send({ v: 1, event: "setup-progress", line: `service: ${detail}`, progress: { step: "install", outcome: "running", detail } });
        if (state.installHold) await new Promise(resolve => { window.__releaseInstall = resolve; });
        if (state.installWait) await new Promise(() => {});
        if (state.installFails) return { v: 1, event: "result", ok: false, error: { code: "OPERATION_UNKNOWN", message: "Windows daemon restart failed during waiting for a fresh daemon to answer (up to 60s): replacement exited during proof", native: { code: "OPERATION_UNKNOWN" } } };
        if (state.installNotAnswering) return { v: 1, event: "result", ok: false, error: { code: "DEPENDENCY_UNAVAILABLE", message: "Cotal asked the background service on this computer to start, and it did not answer within 15 seconds. It refused to start: the native daemon source names another installation; startup refused", remedy: "choose Repair.", native: { code: "NOT_ANSWERING" } } };
        state.installed = true; state.serviceStopped = false; return ok({ installed: true });
      }
      if (state.serviceStopped && request.op === "status") state.stoppedStatusChecks = (state.stoppedStatusChecks ?? 0) + 1;
      if (state.serviceStopped) return { v: 1, event: "result", ok: false, error: { code: "NOT_RUNNING", message: "The background service is installed but stopped. Choose Start service to start it.", detail: { installed: true, ...(state.stoppedByYou || state.explicitStop ? { stopped: "by-you" } : {}) } } };
      if (!state.installed) return fail("NOT_RUNNING", "The daemon is not running. Install its background service first.");
      const statusPayload = () => ({ state: "ready", version: state.version ?? "0.156.0", managers: state.managers ?? (state.accountAction || state.readyAccountSpaces ? state.account.spaces.filter(row => row.desired).map(row => ({ ...manager(), space: row.space })) : state.connected ? [manager()] : []), ...(state.omitAgents ? {} : { agents: state.agents ?? [] }), ...(state.agentTerminal ? { agentTerminal: true } : {}), ...(state.update ? { update: state.update } : {}), ...(state.account && !state.signedOut ? { account: state.account } : {}), ...(state.signedOut ? { account: { mode: "signed-out", hostSupport: "unknown", spaces: [] } } : {}), ...(state.diskFull ? { diskFull: true } : {}), ...(state.generation ? { generation: state.generation } : {}), ...(state.recovery ? { recovery: state.recovery } : {}), ...state.statusFields, ...(!state.recovery && state.serviceOwner && state.appManagement === "other-copy" ? { recovery: { reason: "another-installation", owner: { kind: state.serviceOwner.kind } } } : {}) });
      if ((request.op === "status" || request.op === "status-watch") && state.offline) return fail(state.offlineCode ?? "UNREACHABLE", "The background service did not answer. Check the host connection before retrying.");
      if (request.op === "status") { state.statusRequests = (state.statusRequests ?? 0) + 1; if (state.missingAfterSignIn && state.signedIn && state.statusRequests > 1) state.installed = false; return ok(statusPayload()); }
      if (request.op === "status-watch") {
        state.statusWatchRequests = (state.statusWatchRequests ?? 0) + 1;
        if (state.version && state.version !== "0.156.0") {
          return {
            v: 1,
            event: "result",
            ok: false,
            error: {
              code: "VERSION_MISMATCH",
              message: "The running daemon and this app have different versions. Update them together before making changes.",
              native: { code: "UNKNOWN_OP", detail: { watchMode: "refused-unknown-op", appVersion: "0.156.0", daemonVersion: state.version } },
            },
            result: { status: statusPayload() },
          };
        }
        window.__pushStatus = () => send({ v: 1, event: "status", ok: true, watchMode: "push", result: statusPayload() });
        window.__pushStatus();
        return await new Promise(resolve => { window.__closeStatusWatch = resolve; });
      }
      if (request.op === "spaces" && state.catalogFailure) throw new Error("The space catalog could not be refreshed.");
      if (request.op === "spaces") return ok({ signedInProviders: state.signedIn ? (state.signedInProviders ?? ["https://cloud.cotal.ai/api/auth"]) : [], ...(state.otherProviderFailed && request.refresh ? { refresh: "partial", failedProviders: ["https://hack.cotal.ai/api/auth"] } : {}), spaces: state.catalogSpaces ?? (state.signedIn && !state.empty ? [{ space: "acme-team", label: "Acme team", mode: "user", idp: "https://cloud.cotal.ai/api/auth", catalogId: "sp_acme", kind: state.personal ? "personal" : "team", role: "owner" }, ...(state.multiple ? [{ space: "research", label: "Research", mode: "user", idp: "https://cloud.cotal.ai/api/auth", catalogId: "sp_research", kind: "team", role: "member" }] : [])] : []) });
      if (request.op === "name") { if (request.name !== undefined) state.computerName = request.name; return ok({ computer: state.computerName ?? state.aboutMachine ?? "Davids-MacBook-Pro" }); }
      if (request.op === "service-status") return ok({ state: state.accountAction && state.account.spaces.some(row => row.space === request.space && row.desired) ? "connected" : state.serviceState ?? "disconnected" });
      if (request.op === "logout") {
        state.accountRequests.push({ ...request });
        if (state.accountAction === "signout-busy") await new Promise(() => {});
        if (state.accountAction === "signout-disconnect-refusal") {
          return {
            v: 1,
            event: "result",
            ok: false,
            error: {
              code: "MANAGER_UNAVAILABLE",
              message: "disconnecting research did not finish (the governing auth service refused endpoint deregistration). Sign-out stopped (already disconnected: acme-team, your sign-in was kept)",
              remedy: "run `cotal daemon service-disconnect --space research`",
              detail: {
                failedSpace: "research",
                stillConnectedSpaces: ["research"],
                stoppedAgents: [{ space: "acme-team", name: "writer-1", application: "codex" }],
                rawReason: "the governing auth service refused endpoint deregistration",
              },
            },
          };
        }
        if (state.accountAction === "signout-refusal" && state.accountRequests.length === 1) return fail("LOGOUT_FAILED", "The provider refused to revoke this sign-in. Try again.");
        state.signedIn = false;
        state.connected = false;
        state.account = { idpUrl: request.idp, mode: "signed-out", hostSupport: "unknown", spaces: [] };
        state.agents = [];
        return ok({ kind: "logout", localLoginCleared: true, serverRevoked: true, disconnectedSpaces: ["acme-team", "research"], removedRegistrations: ["acme-team", "research"], skippedServices: [] });
      }
      if (request.op === "space-recover") {
        state.accountRequests.push({ ...request });
        const row = state.account.spaces.find(item => item.space === request.space);
        delete row.custodyRecovery; delete row.lastRefusal; row.observed = "connected";
        return ok({ state: "ready" });
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
        state.loginRequests = [...(state.loginRequests ?? []), request];
        state.logins = (state.logins ?? 0) + 1;
        if (state.loginLost) return fail("DAEMON_LOST", "The background service stopped before this could finish, so it did not complete. Try again when the service is running.");
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
        if (state.otherInstallation) return fail("CONFLICT", "the background service was set up by another Cotal installation, so this one cannot refresh it", "ANOTHER_INSTALLATION");
        if (state.setupError) return fail("LIFECYCLE_BLOCKED", `Setup could not proceed: ${state.setupError}. Stop active sessions before retrying.`, state.setupError);
        if (state.serviceBehind) {
          // An older background service restarts into the app's version only when no agent runs, as the daemon's idle fence does.
          state.serviceUpdates = (state.serviceUpdates ?? 0) + 1;
          const running = (state.agents ?? []).flatMap(row => row.agents ?? []).filter(agent => agent.state === "running");
          if (running.length) return fail("LIFECYCLE_BLOCKED", `the daemon refused managers-prepare-restart: SEATS_ACTIVE hosted Manager for acme-team holds ${running.length} active seat(s): ${running.map(agent => agent.name).join(", ")}\nNext: stop the seats through Manager mgr-1 in space acme-team, then run \`cotal daemon setup --space acme-team\``, "SEATS_ACTIVE");
          state.version = undefined; state.serviceBehind = false;
        }
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
const presenceOffer = id => async page => {
  assert.equal(await page.locator(`#${id} .actions .button`).count(), 1);
  assert.equal(await page.locator(`#${id} .actions .text-button`).count(), 1);
  if (id === "pin-offer") assert.equal(await page.locator("#settings-startup #pin-offer").count(), 1);
};
const zoom = factor => async page => {
  const viewport = page.viewportSize();
  await page.setViewportSize({ width: Math.round(viewport.width / factor), height: Math.round(viewport.height / factor) });
};
const reachable = async page => {
  assert.ok(await page.locator("#settings-panel").evaluate(el => el.getBoundingClientRect().top >= 0), "card top stays reachable at zoom");
  await page.locator("#release-notes").scrollIntoViewIfNeeded();
  assert.ok(await page.locator("#release-notes").evaluate(el => el.getBoundingClientRect().bottom <= innerHeight), "last Settings action stays reachable at zoom");
  await page.locator("#settings-title").scrollIntoViewIfNeeded();
};
const auditAgents = [{ space: "acme-team", state: "read", agents: Array.from({ length: 12 }, (_, i) => ({ name: `writer-${i + 1}`, application: "codex", model: "gpt-model", cwd: "/projects/cotal", startedAt: "2026-11-11T20:00:00.000Z", state: "running" })) }];
const longAccountSpaces = Array.from({ length: 12 }, (_, index) => ({ space: `team-${index + 1}-${"nested-project-path-".repeat(5)}`, label: `Organization / engineering / projects / ${index + 1} / ${"long-unbroken-label".repeat(5)}`, idp: "https://cloud.cotal.ai/api/auth", mode: "user", kind: "team", role: "owner" }));
const appState = (name, state, extra = {}) => ({ name, title: { claude: "Claude Code", codex: "Codex", opencode: "OpenCode", pi: "pi", jcode: "Jcode", hermes: "Hermes" }[name], maker: { claude: "Anthropic", codex: "OpenAI", opencode: "Anomaly", pi: "Earendil", jcode: "Jeremy Huang", hermes: "Nous Research" }[name], state, ...(state === "missing" ? { missing: [{ claude: "claude", codex: "codex", opencode: "opencode", pi: "pi", jcode: "jcode", hermes: "uv" }[name]] } : { version: "1.4.2" }), install: { source: { claude: "claude.ai", codex: "chatgpt.com", opencode: "opencode.ai", pi: "pi.dev", jcode: "jcode.sh", hermes: "astral.sh" }[name] }, ...(["claude", "codex"].includes(name) ? { signIn: true } : {}), ...extra });
const connectedApps = { installed: true, signedIn: true, connected: true };
const accountOnly = { installed: true, signedIn: true, account: { mode: "account", hostSupport: "supported", spaces: [] } };
const openApps = async page => { await page.click("#view-apps"); await page.locator("#apps-panel:not([hidden]) .app-row").first().waitFor(); };
const installClaude = async page => { await openApps(page); await appButton(page, "Install: Claude Code").click(); };
const appButton = (page, label) => page.getByRole("button", { name: label, exact: true });
const noApps = ["claude", "codex", "opencode", "pi", "jcode", "hermes"].map(name => appState(name, "missing"));
const viewTab = (page, name) => page.getByRole("tab", { name, exact: true });
async function openAppsDuringSetup(page) {
  const tab = viewTab(page, "Agent apps");
  assert.equal(await tab.isVisible(), true, "Agent apps is reachable without completing connection setup");
  await viewTab(page, "Connection").focus();
  await page.keyboard.press("ArrowDown");
  assert.equal(await tab.getAttribute("aria-selected"), "true");
  await page.locator("#apps-panel:not([hidden]) .app-row").first().waitFor();
}
async function expectAppRecovery(page, sentence, label) {
  const panel = page.locator("#apps-panel");
  assert.equal(await panel.getByText(sentence, { exact: true }).isVisible(), true, `approved copy: ${sentence}`);
  const controls = panel.getByRole("button", { name: /^(Fix in Connection|Check again)$/ });
  const enabled = [];
  for (const button of await controls.all()) {
    if (await button.isEnabled()) enabled.push(await button.innerText());
  }
  assert.deepEqual(enabled, [label], "one enabled recovery button");
  assert.equal(await page.evaluate(() => window.__renderState.ownerTimers ?? 0), 0, "no 5s owner retry scheduled");
  return controls.and(panel.locator(":enabled"));
}
const appOwnerRefusals = [
  ["version-conflict", "The app and the background service are different versions."],
  ["older-service", "This background service is too old to manage agent apps here."],
  ["foreground", "Cotal is running without an installed background service. This app can show your agent apps, but it can’t change them."],
  ["unrecorded-service", "There's a background service on this computer that this copy of Cotal can't verify. It won't change your agent apps."],
  ["no-user-services", "Cotal can't reach this Linux session's user services. Open Cotal from a desktop session, then choose Check again.", "Check again"],
];
const appsScenarios = [
  { name: "agent-apps-before-setup", state: { trackAppNavigation: true, agentApps: noApps, appManagement: "local" }, act: async page => {
    await page.locator("#sign-in-panel:not([hidden])").waitFor();
    const title = await page.locator("#connection-title").textContent();
    await openAppsDuringSetup(page);
    assert.equal(await page.locator("#apps-local").isVisible(), true);
    await appButton(page, "Install: Jcode").click();
    await page.locator('[data-app="jcode"] .app-status').getByText(/Installed.*version/).waitFor();
    assert.deepEqual(await page.evaluate(() => window.__renderState.appActions), ["agent-app-install:jcode"]);
    assert.deepEqual(await page.evaluate(() => window.__renderState.connectionActions ?? []), [], "installing an app never starts Cotal setup");
    await viewTab(page, "Settings").click();
    assert.equal(await page.locator("#settings-panel").isVisible(), true);
    await viewTab(page, "Connection").click();
    assert.equal(await page.locator("#connection-title").textContent(), title);
    await openAppsDuringSetup(page);
  } },
  { name: "agent-apps-during-sign-in", state: { installed: true, waiting: true, trackAppNavigation: true, agentApps: noApps, appManagement: "service" }, act: async page => {
    await page.click("#login");
    await page.waitForFunction(() => window.__renderState.connectionActions?.includes("login"));
    const title = await page.locator("#connection-title").textContent();
    await openAppsDuringSetup(page);
    await page.click("#apps-refresh");
    await page.waitForFunction(() => window.__renderState.appsRequests?.includes(true));
    await appButton(page, "Install: Jcode").click();
    await page.locator('[data-app="jcode"] .app-status').getByText(/Installed.*version/).waitFor();
    assert.deepEqual(await page.evaluate(() => window.__renderState.appActions), ["agent-app-install:jcode"]);
    assert.equal(await viewTab(page, "Agent apps").getAttribute("aria-selected"), "true");
    assert.deepEqual(await page.evaluate(() => window.__renderState.connectionActions), ["login"]);
    await viewTab(page, "Connection").click();
    assert.equal(await page.locator("#connection-title").textContent(), title);
    await openAppsDuringSetup(page);
  } },
  { name: "agent-apps-other-copy", state: { appManagement: "other-copy", agentApps: noApps }, act: openAppsDuringSetup, expect: async page => {
    assert.match(await page.locator("#apps-owner").textContent(), /^Another copy of Cotal runs the background service/);
    assert.equal(await page.locator("#app-list button").count(), 0);
    await page.getByRole("button", { name: "Fix in Connection" }).click();
    assert.equal(await viewTab(page, "Connection").getAttribute("aria-selected"), "true");
  } },
  ...appOwnerRefusals.map(([management, sentence, label = "Fix in Connection"]) => ({
    name: `agent-apps-${management}`,
    state: { appManagement: management, agentApps: noApps, platform: "linux", trackOwnerTimer: true },
    act: openAppsDuringSetup,
    expect: async page => {
      const recovery = await expectAppRecovery(page, sentence, label);
      assert.equal(await page.locator("#app-list button:enabled").count(), 0, "ownership refusal blocks app changes");
      if (label === "Fix in Connection") {
        await recovery.click();
        assert.equal(await viewTab(page, "Connection").getAttribute("aria-selected"), "true");
      }
    },
  })),
  { name: "agent-apps-install-unknown", state: { appManagement: "local", agentApps: noApps, appInstallUnknown: true, trackOwnerTimer: true }, act: async page => {
    await openAppsDuringSetup(page);
    await page.evaluate(() => { window.__renderState.appsRequests = []; });
    await appButton(page, "Install: Jcode").click();
    await page.locator("#apps-message").filter({ hasText: /\S/ }).waitFor();
  }, expect: async page => {
    const recovery = await expectAppRecovery(page, "Cotal couldn’t confirm whether the app changed. Choose Check again to see its current status.", "Check again");
    assert.equal(await page.locator("#app-list button:enabled").count(), 0, "unknown outcome blocks app changes");
    assert.deepEqual(await page.evaluate(() => window.__renderState.appsRequests), [], "inventory waits for Check again");
    await page.evaluate(() => {
      const state = window.__renderState;
      state.agentApps = state.agentApps.map(app => app.name === "jcode" ? { ...app, state: "installed", missing: [], version: "1.4.2" } : app);
    });
    await recovery.click();
    await page.locator('[data-app="jcode"] .app-status').getByText(/Installed.*version/).waitFor();
    assert.deepEqual(await page.evaluate(() => window.__renderState.appsRequests), [false], "Check again reads inventory without requesting a service refresh");
    assert.deepEqual(await page.evaluate(() => window.__renderState.appActions), ["agent-app-install:jcode"], "Check again does not replay the install or start sign-in");
  } },
  { name: "agent-apps-checking-owner", state: { appManagement: "checking", agentApps: noApps, trackOwnerTimer: true }, act: openAppsDuringSetup, expect: async page => {
    assert.match(await page.locator("#apps-owner").textContent(), /checking the background service/i);
    assert.equal(await page.locator("#app-list button").count(), 0);
    assert.equal(await page.locator("#apps-fix-connection").isVisible(), false);
    assert.equal(await page.evaluate(() => window.__renderState.ownerTimers), 1, "checking schedules one 5s owner retry");
    await page.evaluate(() => { window.__renderState.appManagement = "local"; });
    await appButton(page, "Install: Jcode").waitFor({ timeout: 8000 });
    assert.equal(await page.locator("#apps-owner").isVisible(), false);
  } },
  { name: "agent-apps-mixed-sign-in", state: { ...connectedApps, agentApps: [appState("claude", "signed-in"), appState("codex", "signed-out"), appState("opencode", "missing")] }, act: openApps, expect: async page => {
    assert.match(await page.locator('[data-app="claude"] .app-status').textContent(), /Signed in/);
    assert.match(await page.locator('[data-app="codex"] .app-status').textContent(), /Not signed in/i);
    assert.equal(await appButton(page, "Sign in: Codex").isVisible(), true);
  } },
  { name: "agent-apps-panel", state: connectedApps, act: openApps, expect: async page => {
    assert.equal(await page.locator("#app-list .app-row").count(), 6);
    assert.deepEqual(await page.locator("#app-list .app-name").evaluateAll(nodes => nodes.map(node => node.firstChild.textContent)), ["Claude Code", "Codex", "OpenCode", "pi", "Jcode", "Hermes"]);
    assert.match(await page.locator('[data-app="claude"] .app-status').textContent(), /Signed in · version 2\.1\.332/);
    assert.equal(await page.locator(".connection-card").isVisible(), false);
    await page.click("#view-connection");
    assert.equal(await page.locator("#apps-panel").isVisible(), false);
    assert.equal(await page.locator(".connection-card").isVisible(), true);
    await openApps(page);
  } },
  { name: "agent-apps-none", state: { ...accountOnly, agentApps: noApps }, act: openApps, expect: async page => {
    assert.equal(await page.locator('#app-list [data-state="missing"]').count(), 6);
    assert.equal(await appButton(page, "Install: Claude Code").isVisible(), true);
  } },
  { name: "agent-apps-provenance", state: { ...accountOnly, agentApps: [appState("claude", "missing"), appState("hermes", "missing"), { name: "thing", title: "Thing", maker: "Thing Co", state: "missing", missing: ["thing"], install: { source: "thing.example" }, package: "cotal-connector-thing" }] }, act: openApps, expect: async page => {
    assert.equal(await page.locator('[data-app="claude"] .app-status').textContent(), "Not installed · installs from claude.ai");
    assert.equal(await page.locator('[data-app="hermes"] .app-status').textContent(), "Not installed · installs uv from astral.sh");
    assert.equal(await page.locator('[data-app="thing"] .app-status').textContent(), "Not installed · installs from thing.example · package cotal-connector-thing");
    assert.equal(await appButton(page, "Install: Thing").isVisible(), true);
  } },
  { name: "agent-apps-only-third-party", state: { ...accountOnly, agentApps: [{ name: "thing", title: "Thing", maker: "Thing Co", state: "missing", missing: ["thing"], install: { source: "thing.example" }, package: "cotal-connector-thing" }] }, act: openApps, expect: async page => {
    assert.equal(await page.locator("#app-list .app-row").count(), 1);
    assert.equal(await appButton(page, "Install: Thing").isVisible(), true);
  } },
  { name: "agent-apps-none-install", state: { ...accountOnly, agentApps: noApps, appInstallHold: true }, act: async page => { await installClaude(page); await page.locator('[data-app="claude"][data-state="busy"]').waitFor(); }, expect: async page => {
    assert.equal(await page.locator("#apps-panel").isVisible(), true);
    assert.match(await page.locator('[data-app="claude"] .app-status').textContent(), /Installing from claude\.ai/);
    assert.match(await page.locator('[data-app="claude"] .app-line').textContent(), /Installing native build latest/);
    assert.equal(await appButton(page, "Install: Codex").isDisabled(), true);
    assert.deepEqual((await page.evaluate(() => window.__renderState.appActions)), ["agent-app-install:claude"]);
  } },
  { name: "agent-apps-install-signs-in", state: { ...accountOnly, agentApps: noApps, signInHold: true }, act: async page => { await installClaude(page); await page.locator('[data-app="claude"] .app-status:has-text("Finish signing in")').waitFor(); }, expect: async page => {
    assert.deepEqual((await page.evaluate(() => window.__renderState.appActions)), ["agent-app-install:claude", "agent-app-sign-in:claude"]);
    assert.equal(await appButton(page, "Open sign-in page: Claude Code").isVisible(), true);
    await appButton(page, "Open sign-in page: Claude Code").click();
  } },
  { name: "agent-apps-install-signs-in-service-failed", state: { ...accountOnly, agentApps: noApps, appService: { state: "pending", reason: "unconfirmed" } }, act: async page => { await installClaude(page); await page.locator('[data-app="claude"][data-state="ready"]').waitFor(); }, expect: async page => {
    // The automatic sign-in keeps the reason the service has not picked Claude Code up; only a refresh that ran clears it.
    assert.deepEqual((await page.evaluate(() => window.__renderState.appActions)), ["agent-app-install:claude", "agent-app-sign-in:claude"]);
    const reason = "Claude Code is signed in. Cotal couldn't confirm that the background service can use it. Choose Check again.";
    assert.equal(await page.locator("#apps-message").textContent(), reason);
    // An inventory response without a pickup result cannot clear the warning.
    const asked = (await page.evaluate(() => window.__renderState.appsRequests)).length;
    await page.click("#apps-refresh");
    await page.waitForFunction(n => window.__renderState.appsRequests.length > n && !document.querySelector("#apps-refresh").disabled, asked);
    assert.equal(await page.locator("#apps-message").textContent(), reason);
    await page.evaluate(() => { window.__renderState.refreshService = { state: "refreshed" }; });
    await page.click("#apps-refresh");
    await page.waitForFunction(() => document.querySelector("#apps-message")?.textContent === "");
    assert.deepEqual((await page.evaluate(() => window.__renderState.appsRequests)).at(-1), true);
  } },
  ...[
    ["agent-apps-install-other-owner", "app", "the Cotal app"],
    ["agent-apps-install-command-line-owner", "cli", "a command-line install of Cotal"],
  ].map(([name, kind, owner]) => ({ name, state: { ...connectedApps, agentApps: noApps, appManagement: "other-copy", serviceOwner: { kind }, trackOwnerTimer: true }, act: openApps, expect: async page => {
    const action = await expectAppRecovery(page, `Another copy of Cotal runs the background service (${owner}). This copy can show your agent apps but can't change them.`, "Fix in Connection");
    assert.equal(await page.locator("#apps-owner.warning").count(), 1);
    assert.equal(await page.locator("#app-list button:enabled").count(), 0);
    assert.deepEqual(await page.evaluate(() => window.__renderState.appActions ?? []), []);
    // One next step in both places: Fix in Connection lands on the card whose one button is Repair.
    await action.click();
    assert.equal(await page.locator("#connection-title").textContent(), "Another copy of Cotal runs the background service");
    assert.equal(await page.locator("#recover").textContent(), "Repair");
  } })),
  { name: "agent-apps-install-other-owner-clears", state: { ...connectedApps, agentApps: noApps, ownerChangesOnInstall: true, trackOwnerTimer: true }, act: async page => {
    await openApps(page);
    await appButton(page, "Install: Claude Code").click();
    await page.locator("#apps-owner.warning").waitFor();
  }, expect: async page => {
    const warning = "Claude Code is installed. Another copy of Cotal runs the background service (the Cotal app), so Claude Code can't be used yet.";
    const action = await expectAppRecovery(page, warning, "Fix in Connection");
    assert.equal(await page.locator("#apps-owner.warning").count(), 1);
    assert.deepEqual(await page.evaluate(() => window.__renderState.appActions), ["agent-app-install:claude"], "no sign-in replay to a new owner");
    const reads = await page.evaluate(() => window.__renderState.appsRequests.length);
    await page.evaluate(() => { const now = Date.now; Date.now = () => now() + 45_000; window.__pushStatus(); });
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => window.__renderState.appsRequests.length), reads, "a lasting owner does not schedule a read or native refresh");
    await action.click();
    await page.evaluate(() => { window.__renderState.appManagement = "service"; delete window.__renderState.serviceOwner; });
    await openApps(page);
    await page.waitForFunction(() => document.querySelector("#apps-owner").hidden);
    assert.deepEqual((await page.evaluate(() => window.__renderState.appsRequests)).slice(reads), [false], "explicit re-entry reads inventory only");
  } },
  { name: "agent-apps-install-failed", state: { ...connectedApps, appInstallFails: true }, act: async page => { await openApps(page); await appButton(page, "Install: Jcode").click(); await page.locator('[data-app="jcode"][data-state="failed"]').waitFor(); }, expect: async page => {
    assert.match(await page.locator('[data-app="jcode"] .app-status').textContent(), /Couldn’t install: The installer stopped with exit code 1/);
    await page.locator('[data-app="jcode"] summary').click();
    assert.match(await page.locator('[data-app="jcode"] pre').textContent(), /Connection reset by peer/);
    assert.equal(await appButton(page, "Try again: Jcode").isEnabled(), true);
  } },
  { name: "agent-apps-installed-path", state: { ...connectedApps, pathAdded: "~/.zshrc" }, act: async page => { await openApps(page); await appButton(page, "Install: OpenCode").click(); await page.locator('[data-app="opencode"][data-state="ready"]').waitFor(); }, expect: async page => {
    assert.match(await page.locator("#apps-message").textContent(), /OpenCode is installed\. Cotal added its folder to PATH in ~\/\.zshrc\./);
  } },
  { name: "agent-apps-installed-waiting", state: { ...connectedApps, appService: { state: "pending", reason: "agents-running" }, agents: [{ ...auditAgents[0], agents: auditAgents[0].agents.slice(0, 1) }] }, act: async page => {
    await page.locator("#agent-list .agent-row").waitFor();
    await page.waitForFunction(() => typeof window.__pushStatus === "function");
    await openApps(page);
    await page.evaluate(() => { window.__renderState.appsRequests = []; });
    await appButton(page, "Install: pi").click();
    await page.locator('[data-app="pi"][data-state="ready"]').waitFor();
  }, expect: async page => {
    assert.equal(await page.locator("#apps-message").textContent(), "pi is installed. Your spaces can use it once the running agents finish.");
    assert.deepEqual(await page.evaluate(() => window.__renderState.appsRequests), [], "no pickup while the seat is running");
    await page.evaluate(() => {
      const state = window.__renderState;
      state.agents[0].agents = [];
      state.refreshService = { state: "refreshed" };
      window.__pushStatus();
    });
    await page.waitForFunction(() => document.querySelector("#apps-message").textContent === "", null, { timeout: 8000 });
    assert.deepEqual(await page.evaluate(() => window.__renderState.appsRequests), [true], "status push triggers one inventory refresh");
    assert.deepEqual(await page.evaluate(() => window.__renderState.appActions), ["agent-app-install:pi"], "pickup does not replay install");
  } },
  { name: "agent-apps-signed-out-needs", state: { ...connectedApps, platform: "win32", agentApps: [appState("claude", "signed-in"), appState("codex", "signed-out"), { ...appState("opencode", "missing"), install: undefined }, appState("pi", "missing", { install: { source: "pi.dev", needs: ["node", "npm"] } }), appState("jcode", "installed"), appState("hermes", "missing")] }, act: openApps, expect: async page => {
    assert.equal(await appButton(page, "Sign in: Codex").isVisible(), true);
    assert.match(await page.locator('[data-app="opencode"] .app-status').textContent(), /No installer for Windows/);
    assert.match(await page.locator('[data-app="pi"] .app-status').textContent(), /Needs node and npm installed first/);
    assert.equal(await page.locator('[data-app="pi"] .app-action button').count(), 0);
  } },
];
export const scenarios = [
  ...appsScenarios,
  ...[false, true].map(confirm => ({
    name: `custody-recovery-${confirm ? "confirm" : "cancel"}`,
    state: { installed: true, signedIn: true, connected: true, readyAccountSpaces: true, account: { mode: "account", hostSupport: "supported", spaces: [{ space: "acme-team", desired: true, observed: "connected", lastRefusal: "The local space connection is held by https://old.example/api/auth.", custodyRecovery: { holder: "https://old.example/api/auth", candidate: "b".repeat(64) } }] } },
    expect: async page => {
      const button = page.getByRole("button", { name: /^Move to this account for / });
      await button.waitFor();
      assert.equal(await page.locator('[data-testid="connected-space-row"] small').last().textContent(), "This space is set up under another sign-in on this computer.");
      assert.doesNotMatch(await page.locator('[data-testid="connected-space-row"]').textContent(), /old\.example|https?:/);
      let asked = "";
      page.once("dialog", dialog => { asked = dialog.message(); return confirm ? dialog.accept() : dialog.dismiss(); });
      await button.click();
      assert.equal(asked, "Move Acme team to the account you're signed in with?");
      if (confirm) await page.waitForFunction(() => window.__renderState.accountRequests.some(row => row.op === "space-recover"));
      assert.deepEqual(await page.evaluate(() => window.__renderState.accountRequests.filter(row => row.op === "space-recover")), confirm ? [
        { op: "space-recover", space: "acme-team", candidate: "b".repeat(64), holder: "https://old.example/api/auth" },
      ] : []);
    },
  })),
  // One scenario per row state a saved refusal can produce. Each row shows one plain sentence and one
  // button that acts, and nothing in the window carries a service sentence, address or command.
  ...[
    { state: "held", saved: ["The local space connection is held by https://cloud.cotal.ai/api/auth.", "The local space connection is held by https://cloud.cotal.ai/api/auth."], text: "This space is set up under another sign-in on this computer.", label: "Remove" },
    { state: "no-app", saved: ["no available application"], text: "No agent app is installed.", label: "Set up agent apps" },
    { state: "sign-in", saved: ["not-signed-in"], text: "Sign in again to use this space.", label: "Sign in" },
    { state: "starting", saved: ["Manager is not answering"], text: "Starting this space. Cotal keeps trying by itself.", label: "Check again", managerReason: "Manager exited (code 1)" },
    { state: "unreachable", saved: ["unreachable"], text: "Can't reach this space. Cotal keeps trying by itself.", label: "Check again" },
    { state: "removal-failed", saved: ["disconnect refused; inspect daemon status before retrying"], text: "Couldn't remove this space from this computer. Cotal keeps trying by itself.", label: "Check again" },
    { state: "unknown", saved: ["NEVER_SEEN_REFUSAL: run `cotal daemon setup --space acme-team`"], text: "Can't connect this space.", label: "Check again" },
  ].map(({ state, saved, text, label, managerReason }) => ({
    name: `space-row-${state}`,
    state: { installed: true, signedIn: true, multiple: saved.length > 1, account: { mode: "account", hostSupport: "supported", spaces: saved.map((lastRefusal, index) => ({ space: index ? "research" : "acme-team", desired: true, observed: "not-requested", lastRefusal })) }, ...(managerReason ? { managers: [{ space: "acme-team", state: "starting", restarts: 1, reason: managerReason, next: "read `cotal daemon status --space acme-team`; the daemon will retry" }] } : {}) },
    expect: async page => {
      const rows = page.locator('[data-testid="connected-space-row"]');
      await rows.first().waitFor();
      assert.equal(await rows.count(), saved.length);
      for (let index = 0; index < saved.length; index++) {
        assert.equal(await rows.nth(index).locator("small").last().textContent(), text);
        assert.deepEqual(await rows.nth(index).locator("button").allTextContents(), [label]);
      }
      assert.doesNotMatch(await page.locator("main").textContent(), /`|\bcotal [a-z]|https?:\/\/|held by|inspect |\bManager\b/);
      const statusReads = await page.evaluate(() => window.__renderState.statusRequests ?? 0);
      if (label === "Remove") {
        let asked = "";
        page.once("dialog", dialog => { asked = dialog.message(); return dialog.dismiss(); });
        await rows.first().locator("button").click();
        assert.equal(asked, "Remove Acme team from this computer? Agents from this space stop running here.");
        assert.equal(await page.evaluate(() => window.__renderState.accountRequests.filter(row => row.op === "service-disconnect").length), 0, "Cancel removes nothing");
        return;
      }
      await rows.first().locator("button").click();
      if (label === "Check again") await page.waitForFunction(count => (window.__renderState.statusRequests ?? 0) > count, statusReads);
      if (label === "Sign in") await page.waitForFunction(() => window.__renderState.logins === 1);
      if (label === "Set up agent apps") await page.locator("#apps-panel:not([hidden])").waitFor();
      if (label !== "Remove") assert.equal(await page.evaluate(() => window.__renderState.accountRequests.filter(row => row.op === "service-disconnect").length), 0, "a fixing button never removes the space");
    },
  })),
  { name: "single-space-manager-details", state: { installed: true, signedIn: true, connected: true, managers: [{ space: "acme-team", state: "refused", restarts: 0, reason: "the space refused remote supervision", next: "run `cotal daemon login --idp https://cloud.cotal.ai/api/auth`, correct the reported cause, then run `cotal daemon setup --space acme-team`" }] }, expect: async page => {
    await page.locator("#details:not([hidden])").waitFor();
    assert.equal(await page.locator("#refusal-detail").textContent(), "MANAGER_UNAVAILABLE\nThe agent host for this space stopped. The background service said: the space refused remote supervision");
    assert.doesNotMatch(await page.locator("main").textContent(), /`|\bcotal [a-z]|https?:\/\//);
  } },
  { name: "details-address-for-terminal", state: { installed: true, signedIn: true, connected: true }, act: async page => {
    await page.locator("#connected-panel:visible").waitFor();
    await page.evaluate(() => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      window.__TAURI_INTERNALS__.invoke = (command, args) => command === "daemon_request" && (args.request.op === "status" || args.request.op === "status-watch")
        ? Promise.resolve({ v: 1, event: "result", ok: false, error: { code: "UNREACHABLE", message: "the service stopped at https://cloud.cotal.ai/api/auth" } })
        : invoke(command, args);
    });
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await page.click("#open-settings"); await page.click("#open-settings");
    await page.locator("#recovery-panel:visible").waitFor();
  }, expect: async page => {
    assert.doesNotMatch(await page.locator("#refusal-detail").textContent(), /https?:\/\//);
    assert.doesNotMatch(await page.locator("main").textContent(), /cloud\.cotal\.ai\/api/);
  } },
  { name: 'mac-apply-busy-reason', state: { installed: true, signedIn: true, connected: true, update, appUpdate: { phase: 'available', version: '0.161.0', reason: 'An app operation is still running. Finish it, then choose Restart to update.' } },
    act: page => page.click('#view-settings'), expect: async page => { assert.match(await page.locator('#settings-update-summary').textContent(), /An app operation is still running/); } },
  { name: 'mac-apply-visible', state: { installed: true, signedIn: true, connected: true, update, appUpdate: { phase: 'available', version: '0.161.0' } },
    act: page => page.click('#view-settings'), expect: async page => {
      assert.equal(await page.locator('#restart-update').isVisible(), true);
      assert.match(await page.locator('#settings-update-summary').textContent(), /Restart to update/);
      assert.equal(await page.evaluate(() => window.__renderState.appDownloads ?? 0), 0);
      await page.click('#restart-update');
      assert.equal(await page.evaluate(() => window.__renderState.appApplies.at(-1).explicit), true);
    } },

  ...["available", "current", "failed", "notify-off", "pending", "native-error", "policy-error"].map(mode => ({
    name: `installer-only-${mode}`,
    state: { installed: true, signedIn: true, connected: true, nativeCheckPending: mode === "pending", nativeCheckError: mode === "native-error", policyError: mode === "policy-error",
      update: { ...update, ...(mode === "current" ? { latest: "0.156.0" } : {}), ...(mode === "failed" ? { latest: undefined, lastResult: "check failed" } : {}), notify: mode !== "notify-off" } },
    act: page => page.click("#view-settings"),
    expect: async page => {
      assert.equal(await page.locator("#update-preference-label").textContent(), "Notify me about updates");
      assert.equal(await page.locator("#update-preference").isChecked(), mode !== "notify-off");
      assert.equal(await page.locator("#update-preference").isEnabled(), true);
      assert.equal(await page.locator("#settings-update-summary").textContent(), mode === "current" ? "You are up to date." : mode === "failed" ? "The update check failed. Try again." : "Version 0.161.0 is available.");
      if (!["pending", "native-error", "policy-error"].includes(mode)) assert.match(await page.locator("#update-policy").textContent(), /This build updates through the installer/);
      if (mode === "notify-off") {
        await page.check("#update-preference");
        await page.waitForFunction(() => window.__renderState.update.notify === true);
        assert.equal(await page.evaluate(() => window.__renderState.autoUpdates), undefined, "notify does not write shared auto");
      }
      await page.click("#view-connection");
      assert.equal(await page.locator("#update-banner").isVisible(), !["current", "failed"].includes(mode));
    },
  })),
  ...["current", "failed"].map(phase => ({
    name: `app-manual-check-${phase}`,
    state: { installed: true, signedIn: true, connected: true, autoUpdates: false, appUpdate: { phase, checkedAt: Date.now(), reason: "Network unavailable" }, update },
    act: async page => { await page.click("#view-settings"); await page.click("#check-updates"); },
    expect: async page => { assert.deepEqual(await page.evaluate(() => window.__renderState.appChecks), [{ manual: false }, { manual: true }]); },
  })),

  ...["checking", "current", "downloading", "ready", "preparing", "unconfigured", "failed", "off"].map(phase => ({
    name: `app-updater-${phase}`,
    state: { installed: true, signedIn: true, connected: true, autoUpdates: phase !== "off", update,
      appUpdate: { phase: phase === "off" ? "available" : phase, ...(phase === "preparing" || phase === "unconfigured" || phase === "current" || phase === "checking" ? {} : { version: "0.161.0" }), downloaded: 25, total: 100, ...(phase === "failed" ? { reason: "Signature verification failed" } : {}) } },
    act: page => page.click("#view-settings"),
    expect: async page => {
      assert.equal(await page.locator("#settings-update-summary").getAttribute("data-update-state"), phase === "unconfigured" ? null : phase === "off" ? "available" : phase);
      assert.equal(await page.locator("#update-preference-label").textContent(), phase === "unconfigured" ? "Notify me about updates" : "Install updates automatically");
      assert.equal(await page.locator("#update-preference").isChecked(), phase !== "off");
      if (phase === "off") { assert.match(await page.locator("#settings-update-summary").textContent(), /Automatic updates are off/); assert.equal(await page.evaluate(() => window.__renderState.appDownloads ?? 0), 0); }
      if (phase === "preparing") {
        assert.equal(await page.locator("#settings-update-summary").textContent(), "The newest release is still being prepared.");
        assert.equal(await page.evaluate(() => window.__renderState.trayUpdate ?? null), null);
        assert.equal(await page.locator("#settings-download-row").isVisible(), false);
      }
      if (phase === "unconfigured") {
        assert.equal(await page.locator("#settings-update-summary").textContent(), "Version 0.161.0 is available.");
        assert.match(await page.locator("#update-policy").textContent(), /This build updates through the installer/);
      }
      if (phase === "failed") assert.match(await page.locator("#settings-update-summary").textContent(), /Signature verification failed/);
    },
  })),
  { name: "connected-short-spaces-padding", state: { installed: true, signedIn: true, connected: true, readyAccountSpaces: true, account: { mode: "account", hostSupport: "supported", spaces: Array.from({ length: 6 }, (_, i) => ({ space: `team-${i + 1}`, desired: true, observed: "connected" })) } } },
  { name: "connected-short-spaces-6", state: { installed: true, signedIn: true, connected: true, readyAccountSpaces: true, account: { mode: "account", hostSupport: "supported", spaces: Array.from({ length: 6 }, (_, i) => ({ space: `team-${i + 1}`, desired: true, observed: "connected" })) } }, expect: async page => {
    const inline = await page.locator('[data-testid="connected-space-row"] > span').evaluateAll(copies => copies.every(copy => {
      const boxes = [...copy.children].map(child => child.getBoundingClientRect());
      return Math.max(...boxes.map(box => box.top)) < Math.min(...boxes.map(box => box.bottom));
    }));
    assert.ok(inline, "short names, pills and statuses share one line");
    const heights = await page.locator('[data-testid="connected-space-row"]').evaluateAll(rows => rows.map(row => row.getBoundingClientRect().height));
    assert.ok(heights.every(height => height < 70), "short names retain natural compact row heights");
    assert.equal(heights.length, 6, "all six short-name rows are rendered");
  } },
  { name: "account-manager-starting", state: { installed: true, signedIn: true, connected: true, account: { mode: "account", hostSupport: "supported", spaces: [{ space: "research", desired: true, observed: "connected" }] } }, expect: async page => {
    assert.equal(await page.locator('[data-space="research"] .space-state').textContent(), "Starting", "a space without a ready Manager must not claim Connected");
  } },
  ...[
    ["offline", "No internet connection", "Cotal reconnects by itself when this computer is back online.", "Offline", "this computer cannot look up cotal.cloud (ENOTFOUND)", "No internet connection"],
    ["unreachable", "Can't reach your space", "Cotal reconnects by itself when the space answers again.", "Can't connect", "cotal.cloud is not answering", "Can't reach this space"],
  ].map(([kind, title, description, pill, reason, row]) => ({
    name: `account-connection-${kind}`,
    state: { installed: true, signedIn: true, connected: true, managers: [{ space: "research", state: "answering", instanceId: "machine-1", connectors: [{ agent: "claude", state: "available" }], connection: { state: kind, reason } }], account: { mode: "account", hostSupport: "supported", spaces: [{ space: "research", desired: true, observed: kind }] } },
    expect: async page => {
      assert.equal(await page.locator("#connection-title").textContent(), title, "a lost connection must not claim Connected or Starting");
      assert.equal(await page.locator("#connection-description").textContent(), description);
      assert.equal(await page.locator("#sidebar-status-word").textContent(), pill);
      assert.equal(await page.locator("#sidebar-status-dot").getAttribute("data-tone"), "problem");
      assert.deepEqual(await page.evaluate(() => window.__renderState.nativeConnection), { connected: false, label: pill }, "the native command must receive the sidebar's words");
      assert.equal(await page.locator("#recovery-panel").isHidden(), true, "automatic reconnect must not show a Setup action");
      assert.equal(await page.locator('[data-space="research"] small').last().textContent(), `${row}: ${reason}`);
    },
  })),

  ...["edit", "invalid", "current"].map(mode => ({
    name: `audit-settings-name-location-${mode}`, state: { installed: true, signedIn: true, connected: true, update: { ...update, ...(mode === "current" ? { latest: "0.156.0" } : {}) } },
    act: async page => { await page.click("#view-settings"); await page.click("#settings-name"); if (mode === "invalid") { await page.fill("#computer-name-input", ""); await page.press("#computer-name-input", "Enter"); } },
    expect: async page => {
      assert.equal(await page.locator("#settings-panel #computer-name-form").isVisible(), true);
      assert.equal(await page.locator("#computer-name-input").evaluate(el => el === document.activeElement), true);
      if (mode === "invalid") assert.match(await page.locator("#computer-name-error").textContent(), /1 to 128/);
      await page.press("#computer-name-input", "Escape");
      assert.equal(await page.locator("#computer-name-form").isVisible(), false);
      assert.equal(await page.locator("#settings-name").evaluate(el => el === document.activeElement), true);
      assert.equal(await page.locator("#settings-computer").isVisible(), true);
    },
  })),
  ...[false, true].map(missingAsset => ({
    name: `audit-settings-installer-outcome-${missingAsset ? "missing" : "available"}`, state: { installed: true, signedIn: true, connected: true, missingAsset, update },
    act: async page => { await page.click("#view-settings"); await page.click("#settings-download"); },
    expect: async page => {
      assert.equal(await page.locator("#settings-last-check").textContent(), missingAsset ? "No installer for this platform is on this release. Opening its release page." : "Install the downloaded version, then reopen Cotal.");
      assert.equal(await page.locator("#settings-last-check").isVisible(), true);
      assert.equal(await page.locator("#announcer").textContent(), await page.locator("#settings-last-check").textContent());
    },
  })),
  ...["connected-label", "settings-label", "add-space", "approval-copy"].map(mode => ({
    name: `audit-account-${mode}`,
    state: mode === "approval-copy" ? { installed: true, signedIn: true, serviceState: "approval-pending" } : { installed: true, signedIn: true, connected: true, multiple: true, account: { mode: "account", hostSupport: "supported", label: "david@cotal.ai", spaces: [{ space: "acme-team", desired: true, observed: "connected" }, { space: "research", desired: true, observed: "starting" }] } },
    act: async page => {
      if (mode === "settings-label") await page.click("#view-settings");
      if (mode === "add-space") await page.click("#another-space");
    },
    expect: async page => {
      if (mode === "connected-label") assert.equal(await page.locator('[data-space="acme-team"] strong').textContent(), "Acme team");
      if (mode === "settings-label") {
        assert.match(await page.locator("#settings-account").textContent(), /david@cotal\.ai/);
        assert.equal(await page.locator("#settings-spaces").textContent(), "Signed in · 2 spaces");
      }
      if (mode === "add-space") {
        assert.equal(await page.locator("#space").isVisible(), true);
        assert.deepEqual(await page.locator("#space option").evaluateAll(options => options.filter(option => option.value).map(option => ({ value: option.value, label: option.textContent }))), [{ value: "acme-team", label: "Acme team" }, { value: "research", label: "Research" }]);
      }
      if (mode === "approval-copy") {
        assert.match(await page.locator("#connection-description").textContent(), /approve this computer/i);
        assert.doesNotMatch(await page.locator("#connection-description").textContent(), /approve this machine/i);
      }
    },
  })),
  { name: "audit-settings-name-edit", state: { installed: true, signedIn: true, connected: true, update }, act: async page => { await page.click("#view-settings"); await page.click("#settings-name"); } },
  { name: "audit-settings-name-invalid", state: { installed: true, signedIn: true, connected: true, update }, act: async page => { await page.click("#view-settings"); await page.click("#settings-name"); await page.fill("#computer-name-input", ""); await page.press("#computer-name-input", "Enter"); } },
  { name: "audit-settings-current-name-edit", state: { installed: true, signedIn: true, connected: true, update: { ...update, latest: "0.156.0" } }, act: async page => { await page.click("#view-settings"); await page.click("#settings-name"); } },
  { name: "audit-settings-download-click", state: { installed: true, signedIn: true, connected: true, update }, act: async page => { await page.click("#view-settings"); await page.click("#settings-download"); } },
  { name: "audit-settings-missing-click", state: { installed: true, signedIn: true, connected: true, missingAsset: true, update }, act: async page => { await page.click("#view-settings"); await page.click("#settings-download"); } },
  { name: "audit-account-several-spaces", state: { installed: true, signedIn: true, connected: true, multiple: true, account: { mode: "account", hostSupport: "supported", label: "david@cotal.ai", spaces: [{ space: "acme-team", desired: true, observed: "connected" }, { space: "research", desired: true, observed: "starting" }] } } },
  { name: "audit-move-offer", state: { installed: true, relocationOffer: true }, expect: presenceOffer("move-offer") },
  { name: "audit-pin-offer", state: { installed: true, signedIn: true, connected: true, pinOffer: true }, act: page => page.click("#view-settings"), expect: presenceOffer("pin-offer") },
  // Settings keeps its Startup row while the main card asks for attention behind it.
  ...[["sign-in-required", { installed: true, account: { mode: "sign-in-required", hostSupport: "supported", spaces: [{ space: "acme-team", desired: true, observed: "starting" }] } }],
    ["service-update", { installed: true, signedIn: true, connected: true, version: "0.155.0" }]].map(([mode, state]) => ({
    name: `settings-startup-${mode}`, state,
    act: page => page.click("#view-settings"),
    expect: async page => {
      assert.equal(await page.locator("#settings-panel").isVisible(), true);
      assert.equal(await page.locator("#settings-startup #preferences").isVisible(), true, "the Startup row shows in Settings");
      assert.match(await page.locator("#settings-startup").innerText(), /Open at login/);
    },
  })),
  { name: "audit-pin-message", state: { installed: true, signedIn: true, connected: true, pinMessage: "Cotal is pinned to your taskbar." }, act: page => page.click("#view-settings"), expect: async page => assert.equal(await page.locator("#settings-startup > #pin-availability").count(), 1) },
  ...[1.25, 1.5].map(factor => ({ name: `audit-zoom-${factor * 100}-connected`, state: { installed: true, signedIn: true, connected: true, agents: auditAgents }, act: zoom(factor), expect: async page => {
    await page.locator("#dashboard").scrollIntoViewIfNeeded();
    assert.ok(await page.locator("#dashboard").evaluate(el => { const box = el.getBoundingClientRect(); const card = el.closest(".connection-card").getBoundingClientRect(); return box.top >= card.top && box.bottom <= card.bottom && box.bottom <= innerHeight; }), "dashboard stays fully reachable inside the connection card");
  } })),
  ...[1.25, 1.5].map(factor => ({ name: `audit-zoom-${factor * 100}-settings`, state: { installed: true, signedIn: true, connected: true, update }, act: async page => { await page.click("#view-settings"); await zoom(factor)(page); }, expect: reachable })),

  { name: "audit-update-banner-agents", state: { installed: true, signedIn: true, connected: true, update, agents: auditAgents } },
  { name: "audit-account-spaces-agents", state: { installed: true, signedIn: true, connected: true, multiple: true, account: { mode: "account", hostSupport: "supported", spaces: [{ space: "acme-team", desired: true, observed: "connected" }, { space: "research", desired: true, observed: "connected" }] }, agents: auditAgents } },
  { name: "audit-account-refusal-agents", state: { installed: true, signedIn: true, connected: true, multiple: true, account: { mode: "account", hostSupport: "supported", spaces: [{ space: "acme-team", desired: true, observed: "connected" }, { space: "research", desired: true, observed: "refusal", lastRefusal: "No available connector in the hosted Manager environment. Install Claude Code or Codex, then check again." }] }, agents: auditAgents } },
  { name: "audit-agents-unavailable", state: { installed: true, signedIn: true, connected: true, omitAgents: true }, expect: async page => { assert.equal(await page.locator("#view-apps").isVisible(), true); } },

  ...["signed-out", "pending", "unconnected"].map(mode => ({
    name: `agents-hidden-${mode}`,
    state: { installed: true, signedIn: mode !== "signed-out", account: { mode: mode === "signed-out" ? "sign-in-required" : "account", hostSupport: "supported", spaces: mode === "unconnected" ? [] : [{ space: "acme-team", desired: true, observed: mode === "pending" ? "approval-pending" : "starting" }] } },
    expect: async page => { assert.equal(await page.locator("#running-agents").isVisible(), false); assert.equal(await page.locator("#view-apps").isVisible(), true); },
  })),
  ...[12, 30].map(count => ({
    name: `connected-long-spaces-${count}`,
    state: { installed: true, signedIn: true, connected: true, readyAccountSpaces: true, account: { mode: "account", hostSupport: "supported", spaces: Array.from({ length: count }, (_, index) => ({ space: `team-${index + 1}-${"nested-project-path-".repeat(5)}`, desired: true, observed: "connected" })) } },
    expect: async page => {
      assert.equal(await page.locator("#connected-panel").isVisible(), true);
      assert.equal(await page.locator('[data-testid="connected-space-row"]').count(), count);
      assert.equal(await page.locator("#spaces-heading").textContent(), `Spaces using this computer (${count})`);
      assert.ok(await page.locator("footer").evaluate(el => el.getBoundingClientRect().bottom <= innerHeight), "long-space footer stays inside the viewport");
      assert.equal(await page.locator("#connection-title").textContent(), "This computer is connected");
      assert.deepEqual(await page.locator('[data-testid="connected-space-row"] .space-state').allTextContents(), Array(count).fill("Connected"));
      assert.equal(await page.locator("#settings-panel").isVisible(), false);
      const main = page.getByRole("main");
      assert.equal(await main.getAttribute("tabindex"), "0");
      const lastRow = page.locator('[data-testid="connected-space-row"]').last();
      await main.press("End");
      await page.waitForFunction(() => { const el = document.querySelector("main"); return el.scrollTop > 0 && el.scrollTop + el.clientHeight >= el.scrollHeight - 2; });
      await lastRow.scrollIntoViewIfNeeded();
      const lastButton = lastRow.locator("button").last();
      await lastButton.focus();
      assert.equal(await lastButton.evaluate(el => el === document.activeElement), true);
      assert.equal(await lastButton.evaluate(el => { const row = el.getBoundingClientRect(); const bounds = el.closest("main").getBoundingClientRect(); return row.top >= bounds.top && row.bottom <= bounds.bottom; }), true);
      assert.equal(await page.locator("#dashboard").isVisible(), true);
      await page.click("#view-settings", { timeout: 5000 });
      assert.equal(await page.locator("#settings-panel").isVisible(), true);
      assert.equal(await page.locator("#view-settings").getAttribute("aria-selected"), "true");
      await page.click("#view-connection", { timeout: 5000 });
      assert.equal(await page.locator("#connected-panel").isVisible(), true);
    },
  })),
  ...["none", "one", "many", "unreadable", "long", "spaces"].map(mode => ({
    name: `agents-${mode}`,
    state: { installed: true, signedIn: true, connected: true, agents: mode === "none" ? [] : mode === "unreadable" ? [{ space: "acme-team", state: "unreadable" }] :
      ["acme-team", ...(mode === "spaces" ? ["research"] : [])].map(space => ({ space, state: "read", agents: Array.from({ length: mode === "many" ? 12 : 1 }, (_, i) => ({ name: mode === "long" ? "writer-with-a-very-long-agent-name-".repeat(3) : `writer-${i + 1}`, application: "codex", model: "gpt-model", cwd: mode === "long" ? `/projects/${"long-folder/".repeat(20)}work` : "/projects/cotal", startedAt: "2026-11-11T20:00:00.000Z", state: "running" })) })) },
    expect: async page => { assert.equal(await page.locator("#running-agents").isVisible(), true); if (mode === "unreadable") assert.match(await page.locator("#agents-unavailable").textContent(), /Could not read/); else assert.equal(await page.locator(".agent-row").count(), mode === "none" ? 0 : mode === "many" ? 12 : mode === "spaces" ? 2 : 1); },
  })),
  ...["started", "refused"].map(outcome => ({
    name: `agent-terminal-${outcome}`,
    state: { installed: true, signedIn: true, connected: true, agents: [{ ...auditAgents[0], agents: auditAgents[0].agents.slice(0, 2).map((agent, index) => ({ ...agent, lifecycleUid: `test-${index}` })) }] },
    act: async page => {
      await page.evaluate(outcome => {
        const invoke = window.__TAURI_INTERNALS__.invoke;
        window.__TAURI_INTERNALS__.invoke = async (command, args) => {
          if (command === 'daemon_request' && args.request.op === 'agent-terminal') {
            window.__terminalRequest = args.request;
            return new Promise(resolve => { window.__finishTerminal = () => resolve(outcome === 'started'
              ? { v: 1, event: 'result', ok: true, result: { started: true } }
              : { v: 1, event: 'result', ok: false, error: { code: 'TARGET_NOT_FOUND', message: 'The selected local agent is no longer running.' } }); });
          }
          return invoke(command, args);
        };
        window.__renderState.agentTerminal = true;
        window.__pushStatus();
      }, outcome);
      await page.getByRole('button', { name: 'Open in Terminal writer-1', exact: true }).click();
    },
    expect: async page => {
      assert.deepEqual(await page.evaluate(() => window.__terminalRequest), { op: 'agent-terminal', space: 'acme-team', lifecycleUid: 'test-0' });
      assert.equal(await page.getByRole('button', { name: 'Opening terminal… writer-1' }).isDisabled(), true);
      const chip = page.locator('.agent-row .application-chip').first();
      assert.equal(await chip.getAttribute('title'), await chip.textContent(), 'pending terminal chip exposes its full text');
      assert.equal(await page.getByRole('button', { name: 'Open in Terminal writer-2' }).isEnabled(), true);
      assert.equal(await page.locator('#view-settings').isEnabled(), true);
      await page.evaluate(() => window.__finishTerminal());
      await page.getByRole('button', { name: 'Open in Terminal writer-1', exact: true }).waitFor();
      assert.equal(await chip.getAttribute('title'), await chip.textContent(), 'completed terminal chip exposes its full text');
      if (outcome === 'refused') {
        assert.match(await page.locator('#refusal-detail').textContent(), /The selected local agent is no longer running/);
        assert.equal(await page.locator('#details').evaluate(el => el.open), true);
      } else await page.getByText('Terminal opened for writer-1.', { exact: true }).first().waitFor();
    },
  })),
  ...["success", "refused", "exited"].map(outcome => ({
    name: `agent-stop-${outcome}`,
    state: { installed: true, signedIn: true, connected: true, agents: [{ ...auditAgents[0], agents: auditAgents[0].agents.slice(0, 2).map((agent, index) => ({ ...agent, lifecycleUid: `test-${index}` })) }] },
    act: async page => {
      await page.evaluate(outcome => {
        const invoke = window.__TAURI_INTERNALS__.invoke;
        window.__TAURI_INTERNALS__.invoke = (command, args) => {
          if (command !== 'daemon_request' || args.request.op !== 'agent-stop') return invoke(command, args);
          window.__selectedAgent = args.request.lifecycleUid;
          return new Promise(resolve => { window.__finishStop = () => {
            if (outcome !== 'success') return resolve({ v: 1, event: 'result', ok: false, error: { code: 'TARGET_NOT_FOUND', message: 'The selected local agent is no longer running.' } });
            window.__renderState.agents[0].agents.shift();
            resolve({ v: 1, event: 'result', ok: true, result: {} });
          }; });
        };
      }, outcome);
      await page.getByRole('button', { name: 'Stop writer-1', exact: true }).click();
    },
    expect: async page => {
      assert.equal(await page.evaluate(() => window.__selectedAgent), 'test-0');
      assert.equal(await page.getByRole('button', { name: /Open in Terminal/ }).count(), 0);
      assert.equal(await page.getByRole('button', { name: 'Stopping… writer-1' }).isDisabled(), true);
      assert.equal(await page.getByRole('button', { name: 'Stop writer-2' }).isEnabled(), true);
      assert.equal(await page.locator('#view-settings').isEnabled(), true);
      if (outcome === 'exited') {
        await page.evaluate(() => {
          window.__renderState.agents[0].agents.shift();
          const remaining = window.__renderState.agents[0].agents[0];
          remaining.model = 'updated-model';
          window.__pushStatus();
        });
        await page.getByText('Codex · updated-model').waitFor();
        assert.equal(await page.getByRole('button', { name: 'Stopping… writer-1' }).isDisabled(), true);
      }
      await page.evaluate(() => window.__finishStop());
      if (outcome !== 'success') {
        await page.waitForFunction(() => document.querySelector('#refusal-detail').textContent.includes('The selected local agent is no longer running.'));
        assert.equal(await page.locator('#details').evaluate(el => el.open), true);
      }
      if (outcome !== 'refused') {
        await page.locator('.agent-row').filter({ hasText: 'writer-1' }).waitFor({ state: 'detached' });
      }
    },
  })),
  { name: "account-disconnect-long-confirmation", state: { installed: true, signedIn: true, connected: true, accountAction: "disconnect-confirmation", catalogSpaces: longAccountSpaces, account: { idpUrl: "https://cloud.cotal.ai/api/auth", mode: "account", hostSupport: "supported", spaces: [{ space: longAccountSpaces[0].space, desired: true, observed: "connected" }] } }, act: async page => {
    await page.click("#view-settings");
    await page.evaluate(spaces => {
      window.__renderState.catalogSpaces = spaces;
      window.__renderState.account.spaces = spaces.map(({ space }) => ({ space, desired: true, observed: "connected" }));
      window.__pushStatus();
    }, longAccountSpaces);
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="connected-space-row"]').length === 12, null, { timeout: 6000 });
    await page.click("#settings-disconnect");
    await page.locator("#account-confirmation:not([hidden])").waitFor();
  }, expect: async page => {
    assert.equal(await page.locator("#account-confirm-spaces li").count(), 12);
    assert.match(await page.locator("#account-confirm-spaces li").first().textContent(), /Organization \/ engineering \/ projects/);
    const bounds = await page.locator("#account-confirm-spaces").evaluate(el => {
      const main = el.closest("main");
      return { range: main.scrollHeight - main.clientHeight, right: el.getBoundingClientRect().right, width: window.innerWidth };
    });
    assert.ok(bounds.range > 0, "long lists remain scrollable in the pane");
    assert.ok(bounds.right <= bounds.width, "pathlike names stay within the window");
    assert.equal(await page.locator("#account-confirm").isVisible(), true);
    assert.equal(await page.locator("#account-cancel").isVisible(), true);
    assert.deepEqual(await page.evaluate(() => window.__renderState.accountRequests), []);
  } },
  { name: "account-signedout-connected", state: { installed: true, signedIn: false, connected: true, account: { idpUrl: "https://cloud.cotal.ai/api/auth", sub: "stale-account-owner", mode: "account", hostSupport: "supported", spaces: [{ space: "acme-team", desired: true, observed: "connected" }] } }, act: page => page.click("#view-settings"), expect: async page => {
    assert.equal(await page.locator("#settings-signout").isDisabled(), true);
    assert.equal(await page.locator("#settings-disconnect").isEnabled(), true);
    assert.equal(await page.evaluate(() => window.__renderState.connected), true);
    assert.deepEqual(await page.evaluate(() => window.__renderState.accountRequests), []);
  } },
  { name: "account-signedout-window", state: { installed: true, signedIn: false, connected: false, account: { idpUrl: "https://cloud.cotal.ai/api/auth", mode: "signed-out", hostSupport: "unknown", spaces: [] } }, expect: async page => {
    assert.equal(await page.locator("#connection-title").textContent(), "You signed out");
    assert.equal(await page.locator("#connection-description").textContent(), "Sign in to use this computer from your spaces again.");
    assert.equal(await page.locator("#sign-in-again").isVisible(), true);
    assert.equal(await page.locator("#sign-in-again").textContent(), "Sign in");
    assert.deepEqual(await page.locator("#connection-view button:visible").allTextContents(), ["Sign in"]);
    assert.equal(await page.locator("#sidebar-status-word").textContent(), "Not set up");
    assert.equal(await page.locator("#sidebar-status-dot").getAttribute("data-tone"), "waiting");
    assert.deepEqual(await page.evaluate(() => window.__renderState.nativeConnection), { connected: false, label: "Not set up" });
    assert.equal(await page.locator("#dashboard").isVisible(), false);
  } },
  ...["signout", "disconnect"].flatMap(action => (action === "signout" ? ["confirmation", "agents-confirmation", "cancel", "success", "refusal", "disconnect-refusal", "retry", "busy"] : ["confirmation", "cancel", "success", "refusal", "partial", "unknown", "outcome-back", "busy"]).map(mode => ({
    name: `account-${action}-${mode}`,
    state: { installed: true, signedIn: true, connected: true, multiple: true, ...(mode === "agents-confirmation" || mode === "disconnect-refusal" ? { agents: [{ space: "acme-team", state: "read", agents: [{ name: "writer-1", application: "codex", cwd: "/projects/cotal", startedAt: "2026-11-11T20:00:00.000Z", state: "running" }] }] } : {}), accountAction: `${action}-${mode === "retry" ? "refusal" : mode}`, account: { idpUrl: "https://cloud.cotal.ai/api/auth", sub: "account-owner", mode: "account", hostSupport: "supported", spaces: ["acme-team", "research"].map(space => ({ space, desired: true, observed: "connected" })) } },
    act: async page => {
      await page.click("#view-settings");
      await page.click(`#settings-${action}`);
      await page.locator("#account-confirmation:not([hidden])").waitFor();
      if (mode === "confirmation" || mode === "agents-confirmation") return;
      if (mode === "cancel") await page.click("#account-cancel");
      else {
        await page.click("#account-confirm");
        if (mode === "busy") await page.waitForFunction(() => window.__renderState.accountRequests.length === 1);
        else if (action === "signout" && mode === "success") {
          await page.locator("#settings-panel").waitFor({ state: "hidden" });
        } else {
          await page.locator("#account-confirmation").waitFor({ state: "hidden" });
          await page.locator("#account-outcome:not([hidden])").waitFor();
          if (mode === "outcome-back") await page.click("#account-outcome-back");
          if (mode === "retry") {
            await page.click("#account-outcome-retry");
            await page.locator("#settings-panel").waitFor({ state: "hidden" });
          }
        }
      }
    },
    expect: async page => {
      const snapshot = await page.evaluate(() => ({ requests: window.__renderState.accountRequests, connected: window.__renderState.connected, signedIn: window.__renderState.signedIn, spaces: window.__renderState.account.spaces }));
      if (mode === "confirmation" || mode === "agents-confirmation" || mode === "cancel") {
        assert.deepEqual(snapshot.requests, []);
        assert.equal(snapshot.connected, true);
        assert.equal(snapshot.signedIn, true);
        assert.equal(await page.locator("#account-confirmation").isVisible(), mode !== "cancel");
        if (mode !== "cancel") {
          assert.equal(await page.locator("#account-confirm-title").textContent(), action === "signout" ? "Sign out of Cotal Cloud, cloud.cotal.ai?" : "Disconnect this computer from Cotal Cloud, cloud.cotal.ai?");
          assert.equal(await page.locator("#account-confirm-copy").textContent(), action === "signout" ? (mode === "agents-confirmation" ? "Signing out stops 1 running agent (writer-1 (Codex)) and disconnects this computer from your spaces. Your spaces come back automatically when you sign in again." : "Signing out disconnects this computer from your spaces and ends your sign-in here. Your spaces come back automatically when you sign in again.") : "Stop the following spaces one by one. This does not remove this computer from the dashboard, uninstall the service, revoke provider authority or erase retained renewal records. Disconnect before signing out if you want both.");
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
        assert.equal(await page.locator("#settings-title").evaluate(el => el === document.activeElement), true);
        for (const id of ["settings-name", "check-updates", "update-preference", "autostart", "settings-signout", "settings-disconnect", "settings-versions", "release-notes"]) {
          await page.locator(`#${id}`).scrollIntoViewIfNeeded();
          const geometry = await page.locator(`#${id}`).evaluate(el => { const rect = el.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom, right: rect.right, height: window.innerHeight, width: window.innerWidth }; });
          assert.equal(await page.locator(`#${id}`).isVisible(), true);
          assert.ok(geometry.top >= 0 && geometry.bottom <= geometry.height && geometry.right <= geometry.width, `${id} fully restored within viewport`);
        }
        assert.equal(await page.locator("#account-outcome-back").isVisible(), false);
        assert.equal(snapshot.connected, false);
        return;
      }
      if (action === "signout" && (mode === "success" || mode === "retry")) {
        assert.equal(snapshot.requests.length, mode === "retry" ? 2 : 1);
        assert.equal(snapshot.requests[0].idp, "https://cloud.cotal.ai/api/auth");
        assert.equal(snapshot.requests[0].stopAgents, true);
        assert.equal(snapshot.connected, false);
        assert.equal(snapshot.signedIn, false);
        assert.equal(await page.locator("#settings-panel").isVisible(), false);
        assert.equal(await page.locator("#view-connection").getAttribute("aria-selected"), "true");
        assert.equal(await page.locator("#connection-title").textContent(), "You signed out");
        assert.equal(await page.locator("#connection-description").textContent(), "Sign in to use this computer from your spaces again.");
        assert.equal(await page.locator("#sign-in-again").isVisible(), true);
        assert.deepEqual(await page.locator("#connection-view button:visible").allTextContents(), ["Sign in"]);
        assert.equal(await page.locator("#sidebar-status-word").textContent(), "Not set up");
        assert.equal(await page.locator("#sidebar-status-dot").getAttribute("data-tone"), "waiting");
        assert.deepEqual(await page.evaluate(() => window.__renderState.nativeConnection), { connected: false, label: "Not set up" });
        return;
      }
      assert.equal(await page.locator("#settings-panel").evaluate(el => el.classList.contains("account-outcome-view")), true);
      assert.equal(await page.locator("#settings-versions").isVisible(), false);
      const outcome = (await page.locator("#account-outcome").textContent()).trim();
      assert.ok(outcome, "completed actions always describe their outcome");
      if (action === "signout") {
        assert.equal(snapshot.requests.length, 1);
        assert.equal(snapshot.requests[0].idp, "https://cloud.cotal.ai/api/auth");
        assert.equal(snapshot.requests[0].stopAgents, true);
        assert.equal(snapshot.connected, true);
        assert.equal(snapshot.signedIn, true);
        assert.equal(await page.locator("#account-outcome-retry").isVisible(), true);
        assert.equal(await page.locator("#account-outcome-back").isVisible(), false);
        if (mode === "disconnect-refusal") {
          assert.equal(outcome, "You're still signed in. Cotal couldn't disconnect Research, so it stopped signing out.\nStill connected: Research.\nThese agents were stopped: writer-1 (Codex).");
          await page.locator("#account-outcome-details summary").click();
          const detailText = await page.locator("#account-outcome-detail").textContent();
          assert.equal(detailText, "the governing auth service refused endpoint deregistration");
          assert.ok(!detailText.includes("cotal "), "Details never includes command lines");
        } else {
          assert.equal(outcome, "You're still signed in. Cotal couldn't finish signing out.");
          assert.equal(await page.locator("#account-outcome-detail").textContent(), "The provider refused to revoke this sign-in. Try again.");
        }
      } else {
        assert.equal(await page.locator("#account-outcome-back").isVisible(), true);
        assert.equal(await page.locator("#account-outcome-retry").isVisible(), false);
        assert.deepEqual(snapshot.requests.map(request => request.space), ["acme-team", "research"]);
        assert.match(outcome, /Acme team/);
        assert.match(outcome, /Research/);
        assert.equal(snapshot.connected, mode !== "success");
        assert.deepEqual(snapshot.spaces.map(space => space.desired), mode === "success" ? [false, false] : mode === "partial" ? [false, true] : [true, true]);
        assert.equal(snapshot.signedIn, true, "disconnecting does not sign out");
        if (mode === "refusal" || mode === "partial") {
          for (const space of mode === "partial" ? ["Research"] : ["Acme team", "Research"]) assert.ok(outcome.includes(`${space}: Active sessions prevent disconnecting this space.`));
          if (mode === "partial") assert.ok(outcome.includes("Acme team: disconnected, confirmed by refresh."));
        }
        if (mode === "success") for (const space of ["Acme team", "Research"]) assert.ok(outcome.includes(`${space}: disconnected, confirmed by refresh.`));
        if (mode === "unknown") for (const space of ["Acme team", "Research"]) assert.ok(outcome.includes(`${space}: Disconnect not confirmed (unknown).`));
      }
    },
  }))),
  ...["available", "missing", "current", "failed", "off", "linux", "windows", "toggle-off", "toggle-on", "check"].map(mode => ({
    name: `settings-${mode}`,
    state: { installed: true, signedIn: true, connected: true, missingAsset: mode === "missing", platform: mode === "linux" ? "linux" : mode === "windows" ? "win32" : "darwin", update: { ...update, ...(mode === "current" ? { latest: "0.156.0" } : mode === "failed" ? { latest: undefined, lastResult: "check failed" } : mode === "off" || mode === "toggle-on" ? { notify: false } : {}) } },
    act: async page => { await page.click("#view-settings"); if (mode.startsWith("toggle-")) await page.click("#update-preference"); if (mode === "check") await page.click("#check-updates"); },
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
      await page.click("#view-settings");
      await page.click("#settings-name");
      if (mode === "edit" || mode === "settings") return;
      await page.fill("#computer-name-input", mode === "invalid" ? "" : mode === "long" ? "Very long computer name ".repeat(5) : "My named computer");
      if (mode === "cancel") await page.press("#computer-name-input", "Escape");
      else await page.press("#computer-name-input", "Enter");
    },
    expect: async page => {
      if (mode === "invalid") {
        assert.match(await page.locator("#computer-name-error").textContent(), /1 to 128/);
        assert.equal(await page.locator("#settings-panel #computer-name-form").isVisible(), true);
      }
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
    await page.evaluate(() => { window.__renderState.account.spaces.push({ space: "research", desired: true, observed: "connecting" }); window.__pushStatus(); });
    await page.locator('[data-space="research"]').waitFor({ timeout: 6000 });
    await page.evaluate(() => { window.__renderState.account.spaces.pop(); window.__pushStatus(); });
    await page.locator('[data-space="research"]').waitFor({ state: "detached", timeout: 6000 });
  } },
  { name: "account-first-sign-in", state: { accountAfterLogin: { mode: "account", hostSupport: "supported", spaces: [] } }, act: async page => { await page.click("#login"); await page.locator("#connected-panel:not([hidden])").waitFor(); }, expect: async page => {
    assert.equal(await page.locator("#connection-title").textContent(), "This computer is connected to your account");
    assert.equal(await page.locator("#sidebar-status-word").textContent(), "Connected");
  } },
  { name: "account-ready", state: { installed: true, signedIn: true, account: { mode: "account", hostSupport: "supported", spaces: [] } }, expect: async page => {
    assert.equal(await page.locator("#another-space").textContent(), "Add a space");
    assert.equal(await page.locator("#connection-title").textContent(), "This computer is connected to your account");
    assert.equal(await page.locator("#sidebar-status-word").textContent(), "Connected");
    assert.equal(await page.locator("#dashboard").isVisible(), true);
    assert.equal(await page.locator("#dashboard-spaces-note").isVisible(), false);
    assert.equal(await page.locator("#sidebar-status-dot").getAttribute("data-tone"), "ok");
  } },
  { name: "account-sign-in-lost-on-connect", state: { installed: true, signedIn: true, platform: "win32", serviceState: "unavailable", waiting: true, trackAppNavigation: true }, act: async page => {
    await page.waitForFunction(() => window.__pushStatus && !document.querySelector("#connect-panel").hidden);
    await page.evaluate(() => {
      const state = window.__renderState;
      // The first account heartbeat can return 401 before this daemon has recorded host support.
      state.account = { mode: "sign-in-required", hostSupport: "unknown", idpUrl: "https://cloud.cotal.ai/api/auth", spaces: [] };
      state.signedIn = false;
      window.__pushStatus();
    });
    await page.waitForFunction(() => document.querySelector("#sidebar-status-word").textContent === "Sign in required");
  }, expect: async page => {
    assert.equal(await page.locator("#connection-title").textContent(), "Sign in to keep this computer connected", "the page follows the canonical sign-in-required state");
    assert.equal(await page.locator("#sidebar-status-dot").getAttribute("data-tone"), "problem");
    assert.match(await page.locator("#connection-status").getAttribute("title"), /^Sign in required · /);
    assert.deepEqual(await page.evaluate(() => window.__renderState.nativeConnection), { connected: false, label: "Sign in required" });
    assert.equal(await page.locator("#journey [data-stage=sign-in][data-state=done]:visible").count(), 0);
    assert.equal(await page.locator("#connect:visible, #refresh:visible, #retry-login:visible").count(), 0);
    assert.deepEqual(await page.locator(".connection-card button.primary:visible").allTextContents(), ["Sign in"]);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.locator("#approval-code").waitFor();
    assert.deepEqual(await page.evaluate(() => window.__renderState.connectionActions), ["login"]);
    assert.equal(await page.evaluate(() => window.__renderState.loginRequests[0].idp), "https://cloud.cotal.ai/api/auth");
  } },
  { name: "connect-refresh-action-row", state: { installed: true, signedIn: true, platform: "win32", serviceState: "unavailable" }, expect: async page => {
    const connect = await page.locator("#connect").boundingBox(), refresh = await page.locator("#refresh").boundingBox();
    assert.ok(connect && refresh, "both connection actions are reachable");
    assert.ok(Math.abs(connect.y - refresh.y) <= 2 && refresh.x >= connect.x + connect.width, `Refresh status is beside Connect this computer (${JSON.stringify({ connect, refresh })})`);
    await page.locator("#refresh").click();
    assert.equal(await page.locator("#connect").isVisible(), true);
  } },
  ...["connected", "starting", "approval-pending", "removed on this computer", "refusal", "sign-in-required"].map(observed => ({
    name: `account-${observed.replaceAll(" ", "-")}`,
    state: { installed: true, signedIn: true, connected: observed === "connected", account: { mode: observed === "sign-in-required" ? observed : "account", hostSupport: "supported", spaces: [{ space: "acme-team", desired: true, observed, ...(observed === "refusal" ? { lastRefusal: "Ask the space owner to approve this computer." } : {}) }] } },
    expect: async page => {
      assert.equal(await page.locator("#connected-panel").isVisible(), true);
      assert.equal(await page.locator("#sign-in-again").isVisible(), observed === "sign-in-required");
      const pill = observed === "sign-in-required" ? "Sign in required" : observed === "refusal" ? "Can't connect" : ["connected", "removed on this computer"].includes(observed) ? "Connected" : "Starting";
      assert.equal(await page.locator("#sidebar-status-word").textContent(), pill);
      assert.equal(await page.locator("#sidebar-status-dot").getAttribute("data-tone"), pill === "Connected" ? "ok" : pill === "Starting" ? "waiting" : "problem");
      assert.deepEqual(await page.evaluate(() => window.__renderState.nativeConnection), { connected: pill === "Connected", label: pill });
      if (observed === "refusal") {
        assert.equal(await page.locator("#connection-title").textContent(), "Can't connect to your spaces");
      }
      if (observed === "sign-in-required") {
        assert.equal(await page.locator("#connection-title").textContent(), "Sign in to keep this computer connected");
        assert.equal(await page.locator("#connection-description").textContent(), "Approve this computer in your browser to keep managing its spaces.");
        assert.equal(await page.locator("#sign-in-again").textContent(), "Sign in");
        assert.deepEqual(await page.locator("#connection-view button:visible").allTextContents(), ["Sign in"]);
        assert.equal(await page.locator("#sign-in-again").evaluate(el => el.classList.contains("primary")), true);
      }
    },
  })),
  ...[["offline", "Offline", "No internet connection"], ["unreachable", "Can't connect", "Can't reach your space"]].map(([observed, word, title]) => ({
    name: `account-network-${observed}`,
    state: { installed: true, signedIn: true, account: { mode: "account", hostSupport: "supported", spaces: [{ space: "acme-team", desired: true, observed }] } },
    expect: async page => {
      assert.equal(await page.locator("#connection-title").textContent(), title);
      assert.equal(await page.locator("#sidebar-status-word").textContent(), word);
      assert.equal(await page.locator("#sidebar-status-dot").getAttribute("data-tone"), "problem");
      assert.deepEqual(await page.evaluate(() => window.__renderState.nativeConnection), { connected: false, label: word });
    },
  })),
  ...[
    ["disk-full", { ...connectedApps, statusFields: { diskFull: true } }, "Disk full", "Your disk is full", "problem", "Check again"],
    ["explicit-stop", { installed: true, serviceStopped: true, explicitStop: true }, "Service stopped", "The background service is stopped", "problem", "Start"],
    ["updating", { ...connectedApps, statusFields: { generation: { state: "starting" } } }, "Updating", "Cotal is updating", "waiting"],
    ["repair", { ...accountOnly }, "Repair needed", "This computer needs a repair", "problem"],
  ].map(([name, state, word, title, tone, action]) => ({
    name: `sidebar-status-${name}`, state,
    ...(name === "repair" ? { act: async page => {
      await page.waitForFunction(() => window.__pushStatus);
      await page.evaluate(() => {
        window.__renderState.statusFields = { recovery: { reason: "test recovery" } };
        window.__pushStatus();
      });
    } } : {}),
    expect: async page => {
      assert.equal(await page.locator("#connection-title").textContent(), title);
      assert.equal(await page.locator("#sidebar-status-word").textContent(), word);
      assert.equal(await page.locator("#sidebar-status-dot").getAttribute("data-tone"), tone);
      assert.deepEqual(await page.evaluate(() => window.__renderState.nativeConnection), { connected: false, label: word });
      if (action) assert.equal(await page.locator("#recover:visible").textContent(), action);
      if (name === "disk-full") {
        const requests = await page.evaluate(() => window.__renderState.statusRequests);
        await page.evaluate(() => { window.__renderState.statusFields.diskFull = false; });
        await page.click("#recover");
        await page.waitForFunction(before => window.__renderState.statusRequests > before && document.querySelector("#sidebar-status-word").textContent === "Connected", requests, { timeout: 5000 });
      }
      if (name === "explicit-stop") {
        await page.click("#recover");
        await page.waitForFunction(() => window.__renderState.statusRequests > 0 && document.querySelector("#sidebar-status-word").textContent !== "Service stopped");
        assert.deepEqual(await page.evaluate(() => window.__renderState.startRequests), [{ op: "start" }]);
        assert.equal(await page.evaluate(() => window.__renderState.installRequests ?? 0), 0);
      }
    },
  })),
  { name: "loading", state: { loading: true }, expect: async page => {
    assert.equal(await page.locator("#sidebar-status-word").textContent(), "Starting");
    assert.equal(await page.locator("#loading-icon .icon-spinner").count(), 1);
    assert.ok(await page.locator(".connection-card").evaluate(el => el.getBoundingClientRect().height) < 100);
  } },
  ...[
    ["disk-full", { diskFull: true }, "Disk full", "Your disk is full", "Free up space on this computer. Cotal continues by itself once there is room."],
    ["updating", { generation: { installed: "0.157.0", running: "0.156.0", waiting: "preparing" } }, "Updating", "Cotal is updating", "It finishes by itself. Agents keep running."],
    ["repair", { recovery: { code: "DAEMON_LOST" } }, "Repair needed", "This computer needs a repair", "Repair it to use it from your spaces again."],
  ].map(([name, extra, word, title, description]) => ({
    name: `surface-${name}`,
    state: { installed: true, signedIn: true, connected: true, account: { mode: "account", hostSupport: "supported", spaces: [{ space: "acme-team", desired: true, observed: "connected" }] }, ...extra },
    expect: async page => {
      assert.equal(await page.locator("#sidebar-status-word").textContent(), word);
      assert.equal(await page.locator("#connection-title").textContent(), title);
      assert.equal(await page.locator("#connection-description").textContent(), description);
      if (name === "disk-full") {
        assert.equal(await page.locator("#recover").textContent(), "Check again");
        const before = await page.evaluate(() => window.__renderState.statusRequests ?? 0);
        await page.locator("#recover").click();
        await page.waitForFunction(seen => (window.__renderState.statusRequests ?? 0) > seen, before);
      }
      // The word comes from the field. Dropping it returns the computer to Connected.
      await page.evaluate(key => { delete window.__renderState[key]; window.__pushStatus(); }, Object.keys(extra)[0]);
      await page.waitForFunction(expected => document.querySelector("#sidebar-status-word").textContent === expected, "Connected");
    },
  })),
  { name: "surface-service-stopped", state: { installed: true, signedIn: true, serviceStopped: true, stoppedByYou: true, account: { mode: "account", hostSupport: "supported", spaces: [] } }, expect: async page => {
    assert.equal(await page.locator("#sidebar-status-word").textContent(), "Service stopped");
    assert.equal(await page.locator("#connection-description").textContent(), "You stopped the background service. Start it to run agents on this computer again.");
  } },
  // A daemon that answers is not an account. A Manager that is still starting stays Starting.
  { name: "surface-starting-manager", state: { installed: true, managers: [{ space: "acme-team", state: "starting", reason: "Synthetic Manager is still starting." }] }, expect: async page => {
    assert.equal(await page.locator("#sidebar-status-word").textContent(), "Starting");
    assert.equal(await page.locator("#connection-title").textContent(), "This computer is starting");
    assert.equal(await page.locator("#sidebar-status-dot").getAttribute("data-tone"), "waiting");
    assert.notEqual(await page.evaluate(() => window.__renderState.nativeConnection?.label), "Connected");
  } },
  // An intentional stop publishes its word and dot before any account frame exists.
  { name: "surface-stopped-no-account", state: { installed: true, serviceStopped: true, stoppedByYou: true }, expect: async page => {
    assert.equal(await page.locator("#sidebar-status-word").textContent(), "Service stopped");
    assert.equal(await page.locator("#connection-title").textContent(), "The background service is stopped");
    assert.equal(await page.locator("#sidebar-status-dot").getAttribute("data-tone"), "problem");
    assert.equal(await page.evaluate(() => window.__renderState.nativeConnection?.label), "Service stopped");
  } },
  // A sign-out frame follows an account. The window must not keep saying Connected from memory.
  { name: "surface-signed-out-after-account", state: { installed: true, account: { mode: "account", hostSupport: "supported", spaces: [] } }, act: async page => {
    await page.waitForFunction(() => document.querySelector("#sidebar-status-word")?.textContent === "Connected");
    await page.evaluate(() => { window.__renderState.signedOut = true; window.__pushStatus(); });
  }, expect: async page => {
    assert.equal(await page.locator("#sidebar-status-word").textContent(), "Not set up");
    assert.equal(await page.locator("#connection-title").textContent(), "This computer is not set up");
  } },
  { name: "surface-not-set-up", state: { signedIn: true, installed: true, missingAfterSignIn: true, account: { mode: "account", hostSupport: "supported", spaces: [] } }, expect: async page => {
    assert.equal(await page.locator("#sidebar-status-word").textContent(), "Not set up");
    assert.equal(await page.locator("#connection-title").textContent(), "This computer is not set up");
  } },
  { name: "surface-both-refused", state: { installed: true, signedIn: true, connected: true, readyAccountSpaces: true, account: { mode: "account", hostSupport: "supported", spaces: ["acme-team", "research"].map(space => ({ space, desired: true, observed: "connected", lastRefusal: "This space is set up under another sign-in on this computer." })) } }, expect: async page => {
    assert.equal(await page.locator("#sidebar-status-word").textContent(), "Can't connect");
    assert.equal(await page.locator("#connection-title").textContent(), "Can't connect to your spaces");
    assert.equal(await page.locator("#sidebar-status-dot").getAttribute("data-tone"), "problem");
  } },
  { name: "welcome", state: {} },
  { name: "four-steps", state: {}, expect: async page => assert.equal(await page.locator('#connection-view #journey li').count(), 4) },
  { name: "link", state: { link } },
  { name: "custom-host", state: {}, act: page => page.click("#other-host") },
  { name: "custom-host-back-to-cloud", state: {}, act: async page => { await page.click("#other-host"); await page.getByRole("button", { name: "Use Cotal Cloud", exact: true }).click(); }, expect: async page => {
    assert.equal(await page.locator("#custom-host").isHidden(), true, "the host field closes");
    assert.equal(await page.locator("#login").textContent(), "Continue with Cotal Cloud");
    assert.equal(await page.locator("#other-host").isVisible(), true, "another host can be chosen again");
    await page.click("#login");
    await page.waitForFunction(() => window.__renderState.loginRequests?.some(request => request.idp === "https://cotal.cloud/api/auth"));
  } },
  { name: "settings-before-sign-in-tray", state: {}, act: page => page.evaluate(() => window.__emitTauri("desktop-open-settings", null)), expect: async page => {
    assert.equal(await page.locator("#settings-panel").isVisible(), true, "the tray's Settings opens Settings before sign-in");
    assert.match(await page.locator("#settings-versions").textContent(), /^App /);
    assert.equal(await page.locator("#service-log").isVisible(), true, "the service log is reachable before sign-in");
    assert.equal(await page.locator("#settings-account").textContent(), "No account selected");
    assert.equal(await page.locator("#settings-spaces").isHidden(), true);
    assert.equal(await page.locator("#settings-signout").isDisabled(), true);
    assert.equal(await page.locator("#settings-disconnect").isDisabled(), true);
    await page.locator("#view-connection").click();
    assert.equal(await page.locator("#settings-panel").isHidden(), true);
    assert.equal(await page.locator("#sign-in-panel").isVisible(), true, "Connection returns to Welcome");
  } },
  { name: "settings-before-sign-in-sidebar", state: {}, act: page => page.click("#view-settings"), expect: async page => {
    assert.equal(await page.locator("#settings-panel").isVisible(), true, "sidebar Settings opens before sign-in");
    await page.locator("#service-log summary").click();
    await page.locator("#refresh-log").click();
    await page.waitForFunction(() => (window.__renderState.logReads ?? 0) > 0);
  } },
  { name: "welcome-not-installed-quiet", state: {}, expect: async page => {
    assert.equal(await page.locator("#recovery-panel").isHidden(), true, "before the first sign-in a missing service is not a problem");
    assert.equal(await page.locator("#sign-in-panel").isVisible(), true);
  } },
  // Start service shows the service's latest phase while it runs, and leaves no step spinning once it answers.
  { name: "start-service-progress-clears", state: { installed: true, serviceStopped: true, stoppedByYou: true, startHold: true },
    act: page => page.click("#recover"),
    expect: async page => {
      await page.waitForFunction(() => typeof window.__releaseStart === "function");
      await page.evaluate(() => window.__releaseStart());
      await page.waitForFunction(() => document.querySelector("#recovery-panel")?.hidden === true);
      assert.equal(await page.locator("#sign-in-panel").isVisible(), true, "the started service returns to Welcome");
      assert.equal(await page.locator("#setup-progress").isHidden(), true, "no step keeps spinning after the service started");
    } },
  { name: "sign-in-service-progress-clears", state: { waiting: true, installProgress: ["verifying the recorded installation and owned task before startup"] }, act: page => page.click("#login"), expect: async page => {
    await page.locator("#approval").waitFor();
    assert.equal(await page.locator("#setup-progress").isHidden(), true, "no service step keeps spinning while sign-in waits");
  } },
  // A failed Start service keeps its reason after a background status check, until the person acts on it.
  { name: "start-service-failure-stays", state: { installed: true, serviceStopped: true, stoppedByYou: true, startFails: true }, act: page => page.click("#recover"), expect: async page => {
    await page.waitForFunction(() => document.querySelector("#connection-title")?.textContent === "Something on this computer needs fixing");
    assert.equal(await page.locator("#recover").textContent(), "Repair", "an unknown Start outcome offers Repair");
    const reason = "OPERATION_UNKNOWN (OPERATION_UNKNOWN)\nWindows daemon restart failed during waiting for a fresh daemon to answer (up to 60s): replacement exited during proof";
    assert.equal(await page.locator("#refusal-detail").textContent(), reason);
    const checks = await page.evaluate(() => window.__renderState.stoppedStatusChecks ?? 0);
    await page.evaluate(() => { window.__emitTauri("desktop-hidden", null); window.__emitTauri("desktop-shown", null); });
    await page.waitForFunction(count => (window.__renderState.stoppedStatusChecks ?? 0) > count, checks);
    await page.waitForTimeout(500);
    assert.equal(await page.locator("#connection-title").textContent(), "Something on this computer needs fixing", "a background status check does not replace the failure");
    assert.equal(await page.locator("#refusal-detail").textContent(), reason, "the reason stays");
    // Acting on it opens Repair, which reads a plan; closing it reads the service again.
    await page.locator("#recover").click();
    await page.locator("#repair-panel").waitFor();
    await page.locator("#repair-cancel").click();
    await page.waitForFunction(() => document.querySelector("#connection-title")?.textContent === "The background service is stopped");
    assert.equal(await page.locator("#recover").textContent(), "Start", "acting on it shows the stopped service again");
  } },
  { name: "welcome-service-stopped", state: { serviceStopped: true }, expect: async page => {
    assert.equal(await page.locator("#connection-title").textContent(), "The background service is not running");
    assert.equal(await page.locator("#recover").textContent(), "Start service");
    await page.locator("#recover").click();
    await page.waitForFunction(() => document.querySelector("#recovery-panel")?.hidden === true);
    assert.equal(await page.locator("#sign-in-panel").isVisible(), true, "the started service returns to Welcome");
  } },
  { name: "waiting", state: { waiting: true }, act: page => page.click("#login") },
  ...[1, 2].map(browserFailureAt => ({
    name: `approval-browser-${browserFailureAt === 1 ? "auto" : "manual"}-failure`,
    state: { waiting: true, platform: "linux", browserFailureAt },
    act: async page => {
      await page.click("#login");
      if (browserFailureAt === 2) await page.click("#open-approval");
      await page.waitForFunction(attempt => window.__renderState.browserOpens === attempt, browserFailureAt);
    },
    expect: async page => {
      assert.equal(await page.locator("#approval").isVisible(), true, "browser failure must not hide the pending approval");
      assert.equal(await page.locator("#approval-code").textContent(), "WDJB-MJHT");
      assert.match(await page.locator("#approval-expiry").textContent(), /^Expires in /);
      assert.equal(await page.locator("#approval-browser-help").isVisible(), true);
      assert.equal(await page.locator("#approval-link").textContent(), "https://cloud.cotal.ai/device?user_code=WDJB-MJHT");
      await page.getByRole("button", { name: "Copy link" }).click();
      assert.equal(await page.evaluate(() => window.__renderState.clipboard), "https://cloud.cotal.ai/device?user_code=WDJB-MJHT");
      assert.equal(await page.locator("#recovery-panel").isHidden(), true);
    },
  })),
  { name: "signed-in", state: {}, act: signIn },
  { name: "spaces", state: { multiple: true }, act: signIn },
  { name: "personal", state: { multiple: true, personal: true }, act: signIn },
  { name: "add-space", state: { installed: true, signedIn: true, connected: true, multiple: true }, act: async page => { await page.click('#another-space'); await page.selectOption('#space', 'research'); } },
  { name: "connecting", state: { connecting: true }, act: connect },
  { name: "other-installation", state: { otherInstallation: true }, act: connect, expect: async page => {
    assert.equal(await page.locator("#connection-title").textContent(), "Another copy of Cotal runs the background service");
    assert.equal(await page.locator("#recover").textContent(), "Repair", "Repair, not a setup that cannot succeed, is the one button");
    assert.equal(/\/|`/.test(await page.locator("#refusal-detail").textContent()), false, "Details shows no command line");
  } },
  { name: "ready", state: {}, act: connect },
  { name: "later-open", state: { installed: true, signedIn: true, connected: true }, expect: async page => assert.equal(await page.locator("#journey").isVisible(), false) },
  { name: "no-application", state: { noApp: true }, act: connect },
  { name: "no-application-opens-apps", state: { noApp: true }, prepare: connect, act: async page => {
    await page.click("#recover-apps");
    await page.locator("#app-list .app-row").first().waitFor();
  }, expect: async page => {
    assert.equal(await page.locator("#view-apps").getAttribute("aria-selected"), "true");
    await page.click("#view-connection");
    assert.equal(await page.locator("#recover-apps").isVisible(), true);
  } },
  { name: "sessions-active", state: { setupError: "SEATS_ACTIVE" }, act: connect },
  { name: "expired", state: { expired: true }, act: page => page.click("#login"), expect: async page => assert.equal(await page.locator("#recover .icon-spinner").count(), 0) },
  { name: "declined", state: { loginError: "DENIED" }, act: page => page.click("#login") },
  { name: "offline", state: { installed: true, signedIn: true, offline: true } },
  { name: "service-not-answering", state: { installNotAnswering: true }, act: signIn, expect: async page => {
    assert.equal(await page.locator("#connection-title").textContent(), "The background service has not started");
    assert.equal(await page.locator("#connection-description").textContent(), "Cotal asked the background service on this computer to start, and it has not answered. Repair checks why and fixes what it can.");
    assert.equal(await page.locator("#recover").textContent(), "Repair");
    assert.equal(await page.locator("#refusal-detail").textContent(), "DEPENDENCY_UNAVAILABLE (NOT_ANSWERING)\nCotal asked the background service on this computer to start, and it did not answer within 15 seconds. It refused to start: the native daemon source names another installation; startup refused\nNext: choose Repair.");
  } },
  // The service is killed while sign-in waits on it: say so, and clear once it answers again.
  { name: "sign-in-service-lost", state: { installed: true, loginLost: true }, act: page => page.click("#login"), expect: async page => {
    assert.equal(await page.locator("#connection-title").textContent(), "The background service stopped");
    assert.equal(await page.locator("#connection-description").textContent(), "The background service stopped before Cotal could confirm the result. Repair checks what changed and starts the service again if needed.");
    assert.equal(await page.locator("#recover").textContent(), "Repair");
    assert.ok(!(await page.locator("body").textContent()).includes("cotal daemon"), "no CLI is offered to a desktop user");
    await page.evaluate(() => window.__pushStatus());
    await page.waitForFunction(() => document.querySelector("#connection-title")?.textContent !== "The background service stopped");
    assert.equal(await page.locator("#details").isHidden(), true, "the stopped-service details clear when it answers again");
  } },
  // The app was updated and the background service still runs the previous version while agents work.
  { name: "update-waits-for-agents", state: { installed: true, signedIn: true, connected: true, multiple: true, version: "0.155.0", serviceBehind: true, account: { mode: "account", hostSupport: "supported", label: "david@cotal.ai", spaces: [{ space: "acme-team", desired: true, observed: "connected" }, { space: "research", desired: true, observed: "connected" }] }, agents: [{ space: "acme-team", state: "read", agents: [{ name: "acp_mx2ngejyr3", application: "claude-code", cwd: "/projects/cotal", startedAt: new Date(Date.now() - 600_000).toISOString(), state: "running" }, { name: "acp_uoeconhmic", application: "codex", cwd: "/projects/site", startedAt: new Date(Date.now() - 120_000).toISOString(), state: "running" }] }] }, expect: async page => {
    await page.locator("#notice:not([hidden])").waitFor();
    assert.equal(await page.locator("#notice").textContent(), "An update for the background service is waiting for 2 agents on this computer to finish: acp_mx2ngejyr3 (Claude Code) and acp_uoeconhmic (Codex). It installs by itself when they end.");
    assert.notEqual(await page.locator("#connection-title").textContent(), "Cotal was updated");
    assert.equal(await page.locator("#recovery-panel").isHidden(), true, "the window stays usable");
    assert.equal(await page.locator("#agent-list .agent-row").count(), 2, "the waiting agents are listed");
    assert.equal(await page.evaluate(() => window.__renderState.serviceUpdates ?? 0), 0, "no update is attempted while agents run");
    assert.ok(!(await page.locator("body").textContent()).includes("cotal daemon"), "no CLI is offered");
    await page.evaluate(() => { window.__renderState.agents = [{ space: "acme-team", state: "read", agents: [] }]; window.__emitTauri("desktop-hidden", null); window.__emitTauri("desktop-shown", null); });
    await page.waitForFunction(() => window.__renderState.serviceUpdates === 1 && !window.__renderState.serviceBehind);
    await page.waitForFunction(() => document.querySelector("#notice")?.hidden !== false && document.querySelector("#recovery-panel")?.hidden === true && document.querySelector("#connected-panel")?.hidden === false);
  } },
  // A refusal with several spaces listed keeps its explanation; the multi-space layout hides it only for the space list.
  { name: "refusal-several-spaces-explained", state: { installed: true, signedIn: true, connected: true, multiple: true, version: "0.155.0", omitAgents: true, account: { mode: "account", hostSupport: "supported", label: "david@cotal.ai", spaces: [{ space: "acme-team", desired: true, observed: "connected" }, { space: "research", desired: true, observed: "connected" }] } }, expect: async page => {
    await page.waitForFunction(() => document.querySelector("#connection-title")?.textContent === "Cotal was updated");
    assert.ok(await page.evaluate(() => document.querySelectorAll("#connected-spaces li").length) >= 2, "both spaces are listed behind the refusal");
    assert.equal(await page.locator("#connection-description").isVisible(), true, "the refusal explains itself");
    assert.equal(await page.locator("#connection-icon").count(), 0, "no separate pane status icon");
  } },
  { name: "no-spaces", state: { empty: true }, act: signIn },
  { name: "connected-and-pending", state: { installed: true, signedIn: true, connected: true, multiple: true, serviceState: "approval-pending" }, expect: async page => {
    assert.equal(await page.locator("#connection-title").textContent(), "This computer is connected");
    assert.equal(await page.locator('[data-testid="connected-space-row"]').count(), 2);
  } },
  { name: "approval-pending", state: { installed: true, signedIn: true, serviceState: "approval-pending" }, expect: async page => {
    assert.equal(await page.locator("#refresh").isVisible(), true);
    assert.equal(await page.locator("#refresh").textContent(), "Check approval");
    assert.equal(await page.locator("#connection-title").textContent(), "Waiting for owner approval");
    assert.equal(await page.locator("#dashboard").isVisible(), false);
    assert.equal(await page.locator("#view-apps").isVisible(), true);
    assert.match(await page.locator("#connected-spaces").textContent(), /Waiting for owner approval/);
    assert.equal(await page.locator(".connection-card.has-refusal").count(), 0);
  } },
  { name: "approval-refresh", state: { installed: true, signedIn: true, serviceState: "approval-pending" }, act: async page => {
    await page.evaluate(() => { window.__renderState.connected = true; window.__renderState.serviceState = "connected"; });
    await page.click("#refresh");
    await page.waitForFunction(() => document.querySelector("#connection-title").textContent === "This computer is connected");
  }, expect: async page => { assert.equal(await page.locator("#refresh").isVisible(), false); assert.equal(await page.locator("#dashboard").isVisible(), true); } },
  { name: "version-mismatch", state: { installed: true, signedIn: true, version: "old" }, expect: async page => {
    // The approved words: what happened, what the button does, and that agents are never stopped.
    assert.equal(await page.locator("#connection-title").textContent(), "Cotal was updated");
    assert.equal(await page.locator("#connection-description").textContent(), "Restart the background service to finish the update. If agents are running, the restart waits until they finish, then happens by itself.");
    assert.equal(await page.locator("#recover").textContent(), "Restart background service");
    assert.match(await page.locator("#refusal-detail").textContent(), /App version 0\.156\.0 · background service old\./);
    assert.ok(!(await page.locator(".connection-card").textContent()).includes("connection needs"), "the internal word is gone");
  } },
  { name: "progress-done", state: { connecting: true }, prepare: connect, act: async page => {
    const row = page.getByTestId("progress-3");
    await row.locator('.progress-mark[data-icon="spinner"]').waitFor();
    await page.evaluate(() => window.__advanceSetup());
    await row.locator('.progress-mark[data-icon="check"]').waitFor();
    assert.equal(await row.getAttribute("data-state"), "done");
    assert.equal(await row.locator(".icon-spinner").count(), 0);
  } },
  { name: "disconnected", state: { installed: true, signedIn: true, connected: true }, act: page => page.click("#connected-spaces button"), expect: async page => { assert.equal(await page.locator("#notice").isVisible(), false); assert.equal(await page.locator("#spaces-heading").isVisible(), false); assert.equal(await page.locator(".connected-spaces-scroll").isVisible(), false); assert.equal(await page.locator("#another-space").textContent(), "Add a space"); } },
  { name: "notice", state: { waiting: true, copyFailure: true }, prepare: page => page.click("#login"), act: page => page.click("#copy-code") },
  { name: "details-open", state: { noApp: true }, prepare: connect, act: page => page.locator("#details summary").click() },
  { name: "audit-service-install", state: { installWait: true }, act: page => page.click("#login"), expect: async page => { assert.equal(await page.locator("#connection-title").textContent(), "Preparing your sign-in"); assert.match(await page.locator("#notice").textContent(), /Preparing the background service/); } },
  { name: "audit-credential-expired", state: { loginError: "CREDENTIAL_EXPIRED" }, act: page => page.click("#login"), expect: async page => { assert.equal(await page.locator("#connection-title").textContent(), "Sign in again"); assert.equal(await page.locator("#recover").textContent(), "Sign in again"); } },
  { name: "audit-unreachable", state: { loginError: "UNREACHABLE" }, act: page => page.click("#login"), expect: async page => { assert.equal(await page.locator("#connection-title").textContent(), "We cannot reach your connection"); assert.equal(await page.locator("#recover").textContent(), "Try again"); } },
  { name: "audit-approval-refusal", state: { installed: true, offline: true, offlineCode: "APPROVAL_PENDING" }, expect: async page => { assert.equal(await page.locator("#connection-title").textContent(), "Waiting for owner approval"); assert.equal(await page.locator("#recover").textContent(), "Check approval"); } },
  { name: "audit-default-refusal", state: { installed: true, offline: true, offlineCode: "OPERATION_FAILED" }, expect: async page => { assert.equal(await page.locator("#connection-title").textContent(), "Something on this computer needs fixing"); assert.equal(await page.locator("#recover").textContent(), "Repair"); } },
  { name: "audit-close-explained", state: { installed: true, signedIn: true, connected: true }, act: page => page.evaluate(() => window.__emitTauri("desktop-close-explained", "Cotal stays in your system tray. Open it from the tray or menu bar. Quit app leaves the background service running.")), expect: async page => { assert.match(await page.locator("#notice").textContent(), /Cotal stays in your system tray/); } },
  { name: "audit-settings-npm-linux", state: { installed: true, signedIn: true, connected: true, platform: "linux", update: { ...update, channel: "npm", latest: "0.156.0", lastResult: "up to date" } }, act: page => page.click("#view-settings"), expect: async page => { assert.equal(await page.locator("#update-preference-label").textContent(), "Install updates automatically"); } },
  { name: "audit-settings-unchecked", state: { installed: true, signedIn: true, connected: true, update: { ...update, latest: undefined, lastCheck: undefined, lastResult: "none" } }, act: page => page.click("#view-settings"), expect: async page => { assert.equal(await page.locator("#settings-last-check").textContent(), "Not checked yet"); } },
  { name: "audit-settings-unavailable", state: { installed: true, signedIn: true, connected: true }, act: page => page.click("#view-settings"), expect: async page => {
    assert.equal(await page.locator("#settings-update-summary").textContent(), "Version 0.156.0");
    for (const id of ["settings-name", "check-updates", "settings-signout", "release-notes"]) {
      const outline = await page.locator(`#${id}`).evaluate(el => {
        const style = getComputedStyle(el);
        return style.borderTopStyle === "solid" && parseFloat(style.borderTopWidth) > 0 && style.borderTopColor !== "rgba(0, 0, 0, 0)";
      });
      assert.ok(outline, `${id} has a visible outline`);
    }
    assert.equal(await page.getByRole("button", { name: "Sign out", exact: true }).count(), 1);
    const disconnect = page.locator('section[aria-labelledby="advanced-heading"] .settings-row').filter({ has: page.locator("#settings-disconnect") });
    assert.equal(await disconnect.getByRole("button", { name: "Disconnect", exact: true }).count(), 1);
    assert.equal(await disconnect.getByRole("heading").textContent(), "Disconnect this computer");
    assert.match(await disconnect.textContent(), /Your spaces stop using this computer\. It stays in your account\./);
  } },
  { name: "audit-app-found-later", state: { noApp: true }, prepare: connect, act: async page => { await page.evaluate(() => { window.__renderState.noApp = false; }); await page.click("#recover"); }, expect: async page => { assert.equal(await page.locator("#connection-title").textContent(), "This computer is connected"); assert.equal(await page.locator("#recovery-panel").isVisible(), false); } },
  { name: "hidden-status-cadence", state: { installed: true, signedIn: true, connected: true, readyAccountSpaces: true, account: { mode: "account", hostSupport: "supported", spaces: [{ space: "acme-team", desired: true, observed: "connected" }] } }, expect: async page => {
    assert.equal(await page.evaluate(() => document.documentElement.dataset.watchMode), "push");
    assert.equal(await page.evaluate(() => window.__renderState.statusWatchRequests), 1);
    const afterStart = await page.evaluate(() => window.__renderState.statusRequests);
    await page.evaluate(() => window.__emitTauri("desktop-hidden", null));
    await page.waitForTimeout(1500);
    await page.evaluate(() => window.__emitTauri("desktop-tray-open", null));
    await page.evaluate(() => window.__emitTauri("desktop-shown", null));
    assert.equal(await page.evaluate(() => window.__renderState.statusRequests), afterStart, "status-watch stays open across hide, tray open, and show without polling status");
  } },
];

// Audit regressions use the same real UI entry points as the original fixtures.
const auditCase = (source, name, expect) => {
  const original = scenarios.find(scenario => scenario.name === source);
  assert.ok(original, `audit fixture exists: ${source}`);
  scenarios.push({ ...original, name, expect: async page => {
    if (original.expect) await original.expect(page);
    await expect(page);
  } });
};
for (const source of ["settings-available", "settings-missing", "audit-pin-offer", "audit-pin-message"]) {
  auditCase(source, `audit-e1-${source}`, async page => {
    await page.locator("#release-notes").scrollIntoViewIfNeeded();
    const geometry = await page.locator("#settings-panel").evaluate(card => {
      const about = document.querySelector("#settings-versions").closest(".settings-row");
      const box = card.closest("main").getBoundingClientRect();
      const row = about.getBoundingClientRect();
      return { nestedScroll: getComputedStyle(card).overflowY,
        contained: row.top >= box.top - 1 && row.bottom <= box.bottom + 1 };
    });
    assert.equal(geometry.contained, true, "About is fully reachable in the main scroller");
    assert.doesNotMatch(geometry.nestedScroll, /^(auto|scroll)$/, "Settings has no separate scroller");
  });
}
auditCase("audit-pin-message", "audit-e4-pin-message-order", async page => {
  const renders = [];
  for (let render = 0; render < 3; render++) {
    renders.push(await page.locator("#settings-startup").evaluate(startup => {
      const preferences = startup.querySelector("#preferences");
      const message = startup.querySelector("#pin-availability");
      return !!preferences && !!message && !!(preferences.compareDocumentPosition(message) & Node.DOCUMENT_POSITION_FOLLOWING)
        && preferences.getBoundingClientRect().bottom <= message.getBoundingClientRect().top;
    }));
    await page.click("#check-updates");
    await page.waitForFunction(() => !document.querySelector("#check-updates").disabled);
  }
  console.log(`E4 startup order: ${JSON.stringify(renders)}`);
  assert.deepEqual(renders, [true, true, true], "E4: Open at login precedes the pin message across repeated Settings renders");
});
auditCase("audit-move-offer", "audit-e4-move-offer-spacing", async page => {
  const spacing = await page.locator("#move-offer").evaluate(offer => {
    const style = getComputedStyle(offer);
    const explanation = document.querySelector("#service-explanation").getBoundingClientRect();
    return { margin: parseFloat(style.marginTop), divider: parseFloat(style.borderTopWidth),
      gap: offer.getBoundingClientRect().top - explanation.bottom };
  });
  assert.ok(spacing.margin >= 16 && spacing.divider >= 1 && spacing.gap >= 16,
    `E4: move offer has a top divider and breathing room: ${JSON.stringify(spacing)}`);
});
auditCase("account-signout-disconnect-refusal", "audit-e5-post-signout-labels", async page => {
  const copy = await page.locator("#account-outcome").textContent();
  console.log(`E5 signout disconnect refusal: ${copy}`);
  assert.match(copy, /Research/, "E5: sign-out disconnect refusal names Research");
  assert.doesNotMatch(copy, /acme-team|research/, "E5: sign-out disconnect refusal does not fall back to raw slugs");
  await page.click("#view-connection");
  assert.deepEqual(await page.locator('[data-testid="connected-space-row"] strong').allTextContents(),
    ["Acme team", "Research"], "E5: Connected view retains labels after sign-out refusal");
});
for (const outcome of ["success", "partial", "refusal", "unknown"]) {
  auditCase(`account-disconnect-${outcome}`, `audit-e5-disconnect-${outcome}-labels`, async page => {
    const copy = await page.locator("#account-outcome").textContent();
    console.log(`E5 disconnect ${outcome}: ${copy}`);
    assert.match(copy, /Acme team:/, `E5: ${outcome} outcome names Acme team`);
    assert.match(copy, /Research:/, `E5: ${outcome} outcome names Research`);
    assert.doesNotMatch(copy, /(?:acme-team|research):/, `E5: ${outcome} outcome does not use raw slug labels`);
  });
}
