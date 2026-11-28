import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import type { AppUpdate, AppUpdateReceipt } from "../src/app-update";
import type { UpdateStatus } from "../src/updates";
import { COTAL_CLOUD_IDP, CONNECTOR_CONFIG_UNPROTECTED, CONNECTOR_CONFIG_REPAIR, type Frame, type Request } from "../src/model.ts";

const { JSDOM } = createRequire(import.meta.url)("jsdom");
const settle = async () => { for (let i = 0; i < 25; i++) await new Promise<void>(resolve => setImmediate(resolve)); };
const bundle = build({ root: fileURLToPath(new URL("..", import.meta.url)), logLevel: "silent", build: { write: false } }).then(output => {
  assert.ok(!Array.isArray(output) && "output" in output);
  const entry = output.output.find(file => file.type === "chunk" && file.isEntry);
  assert.ok(entry && "code" in entry); return entry.code;
});
async function app(options: { appReceipt?: AppUpdateReceipt; platform?: string; appVersion?: string; update?: UpdateStatus; nativeCheckError?: boolean; nativeCheckPending?: boolean; policyError?: boolean; appUpdate?: AppUpdate; autoUpdates?: boolean; registryLatest?: string; personal?: boolean; label?: string; kind?: string; account?: Record<string, unknown>; provider?: string; link?: string; installed?: boolean; installNotAnswering?: string | boolean; connected?: boolean; count?: number; serviceState?: string; loginReason?: string; setupCode?: string; statusError?: boolean; interrupted?: boolean; interruptedAbout?: boolean; mismatch?: boolean; loading?: boolean; otherProviderFailed?: boolean; ownProviderFailed?: boolean; oldDaemon?: boolean; switched?: boolean; credentialsKept?: { space: string; path: string; reason: string }[]; folder?: { path: string; mode: number; owned: boolean } } = {}) {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8").replace(/<script\b[^>]*><\/script>/g, "");
  const dom = new JSDOM(html, { url: "http://localhost/", pretendToBeVisual: true, runScripts: "outside-only" });
  const win = dom.window, doc = win.document as Document;
  const calls: Request[] = [], urls: string[] = [], nativeCalls: string[] = [], checkArgs: { manual?: boolean }[] = [], applyArgs: { explicit?: boolean }[] = [];
  const realTimeout = setTimeout;
  let update = options.update;
  let autoUpdates = options.autoUpdates ?? true;
  const callbacks = new Map<number, (frame: unknown) => void>(); let next = 0;
  const listeners = new Map<string, number>();
  let installed = options.installed ?? false, stopped = false, connected = options.connected ?? false;
  let releaseLogin: (() => void) | undefined, releaseSetup: (() => void) | undefined;
  let closeWatch: ((frame: Frame) => void) | undefined;
  let pushWatchStatus: (() => void) | undefined;
  const manager = { space: "team", state: "answering", instanceId: "instance", connectors: [{ state: "available" }] };
  let tick: (() => Promise<void>) | undefined;
  let clock: (() => void) | undefined;
  let now = Date.now();
  win.Date.now = () => now;
  win.setTimeout = (fn: () => Promise<void>) => { tick = fn; return 1; }; win.clearTimeout = () => {};
  win.setInterval = (fn: () => void) => { clock = fn; return 2; }; win.clearInterval = () => { clock = undefined; };
  let copied = "";
  Object.defineProperty(win.navigator, "clipboard", { value: { writeText: async (value: string) => { copied = value; } } });
  win.HTMLImageElement.prototype.decode = async () => {};
  win.isTauri = true;
  win.__TAURI_INTERNALS__ = {
    transformCallback(fn: (frame: unknown) => void) { callbacks.set(++next, fn); return next; }, unregisterCallback() {},
    async invoke(cmd: string, args: { explicit?: boolean; manual?: boolean; request?: Request; url?: string; onEvent?: { id: number }; event?: string; handler?: number } = {}) {
      if (cmd === "plugin:deep-link|get_current") return options.link ? [options.link] : null;
      if (cmd === "plugin:event|listen") { listeners.set(args.event!, args.handler!); return ++next; }
      if (cmd === "desktop_presence") return { loginEnabled: false, relocationOffer: false, pinOffer: false, pinMessage: "" };
      if (cmd === "first_paint") return;
      if (cmd === "set_connection_state") return;
      nativeCalls.push(cmd);
      if (cmd === "app_update_check") {
        checkArgs.push({ manual: args.manual });
        if (options.nativeCheckError) throw new Error("Native check unavailable");
        if (options.nativeCheckPending) await new Promise(() => {});
        return options.appUpdate ?? { phase: "unconfigured" };
      }
      if (cmd === "app_update_receipt") return options.appReceipt;
      if (cmd === "app_update_apply") { applyArgs.push({ explicit: args.explicit }); return options.appUpdate ?? { phase: "unconfigured" }; }
      if (cmd === "app_update_download") return { phase: "ready", version: options.appUpdate?.version };
      if (cmd === "open_browser") { urls.push(args.url!); return; }
      assert.equal(cmd, "daemon_request"); const r = args.request!; calls.push(r);
      const ok = (result: Record<string, unknown>): Frame => ({ v: 1, event: "result", ok: true, result });
      const send = (frame: Frame, index: number) => callbacks.get(args.onEvent!.id)!({ message: frame, index });
      if (r.op === "update-policy") { if (options.policyError) throw new Error("Preference unavailable"); if (r.auto !== undefined) autoUpdates = r.auto; return ok({ auto: autoUpdates }); }
      if (r.op === "update-settings") { update = { ...update!, ...(r.notify !== undefined ? { notify: r.notify } : {}), ...(r.auto !== undefined ? { automatic: r.auto } : {}) }; return ok({ update }); }
      if (r.op === "update-check") return ok({ update });
      if (r.op === "update-release") return ok({ assets: [] });
      if (r.op === "about") {
        if (options.interruptedAbout) return { v: 1, event: "result", ok: false, error: { code: "SETUP_INTERRUPTED", message: "Run the installer again to finish updating Cotal." } };
        if (options.loading) await new Promise(() => {});
        return ok({ version: options.appVersion ?? "test", machine: "My computer", platform: options.platform ?? "darwin", arch: "arm64", memoryBytes: 36 * 1024 ** 3 });
      }
      if (r.op === "install") {
        installed = true;
        if (options.installNotAnswering) {
          stopped = true;
          const reason = typeof options.installNotAnswering === "string" ? ` It refused to start: ${options.installNotAnswering}` : "";
          return { v: 1, event: "result", ok: false, error: { code: "DEPENDENCY_UNAVAILABLE", message: `Cotal asked the background service on this computer to start, and it did not answer within 15 seconds.${reason}`, remedy: "choose Check status.", native: { code: "NOT_ANSWERING" } } } satisfies Frame;
        }
        stopped = false;
        return ok({ installed: true });
      }
      if (!installed) return { v: 1, event: "result", ok: false, error: { code: "NOT_RUNNING", message: "The daemon is not running. Install its background service first." } } satisfies Frame;
      if (stopped) return { v: 1, event: "result", ok: false, error: { code: "NOT_RUNNING", message: "The background service is installed but stopped. Choose Start service to start it." } } satisfies Frame;
      const folderRow = options.folder ? { space: "team", state: "refused", reason: "the connector config folder is writable by every local account", reasonCode: CONNECTOR_CONFIG_UNPROTECTED, reasonDetail: options.folder } : undefined;
      const statusPayload = () => ({ account: options.account ? { idpUrl: COTAL_CLOUD_IDP, sub: "user-1", mode: "static", hostSupport: "none", spaces: [], ...options.account } : undefined, state: "ready", version: options.mismatch ? "old" : (options.appVersion ?? "test"), update: update ?? (options.registryLatest ? { channel: "desktop", current: options.appVersion ?? "test", latest: options.registryLatest, automatic: false, notify: true, lastResult: "available" } : undefined), managers: folderRow ? [folderRow] : connected ? [manager] : [] });
      if (r.op === "status-watch") {
        if (options.interrupted) return { v: 1, event: "result", ok: false, error: { code: "SETUP_INTERRUPTED", message: "Run the installer again to finish updating Cotal." } };
        if (options.statusError) return { v: 1, event: "result", ok: false, error: { code: "NOT_ANSWERING", message: "The service did not answer." } };
        if (options.mismatch) {
          return {
            v: 1,
            event: "result",
            ok: false,
            error: {
              code: "VERSION_MISMATCH",
              message: "The running daemon and this app have different versions. Update them together before making changes.",
              native: { code: "UNKNOWN_OP", detail: { watchMode: "refused-unknown-op", appVersion: options.appVersion ?? "test", daemonVersion: "old" } },
            },
            result: { status: statusPayload() },
          } satisfies Frame;
        }
        let watchIndex = 0;
        pushWatchStatus = () => send({ v: 1, event: "status", ok: true, watchMode: "push", result: statusPayload() }, watchIndex++);
        pushWatchStatus();
        return await new Promise<Frame>(resolve => { closeWatch = resolve; });
      }
      if (r.op === "status") {
        if (options.interrupted) return { v: 1, event: "result", ok: false, error: { code: "SETUP_INTERRUPTED", message: "Run the installer again to finish updating Cotal." } };
        if (options.statusError) return { v: 1, event: "result", ok: false, error: { code: "NOT_ANSWERING", message: "The service did not answer." } };
        return ok(statusPayload());
      }
      if (r.op === "spaces") return ok({ ...((options.otherProviderFailed || options.ownProviderFailed || options.oldDaemon) && r.refresh ? { refresh: "partial", ...(options.oldDaemon ? {} : { failedProviders: [options.ownProviderFailed ? COTAL_CLOUD_IDP : "https://hack.cotal.ai/api/auth"] }) } : {}), spaces: Array.from({ length: options.count ?? 1 }, (_, i) => ({ space: i ? "other" : "team", catalogId: i ? "sp_other" : "sp_team", label: i ? "Other team" : options.label ?? "My team", kind: !i && options.kind !== undefined ? options.kind : options.personal && !i ? "personal" : "team", role: "owner", mode: "user", idp: options.provider ?? COTAL_CLOUD_IDP })) });
      if (r.op === "name") return ok({ computer: r.name ?? "My computer" });
      if (r.op === "service-status") return ok({ state: options.serviceState ?? "disconnected" });
      if (r.op === "service-disconnect") { connected = false; return ok({ state: "disconnected" }); }
      if (r.op === "login") {
        send({ v: 1, event: "login-prompt", prompt: { verificationUriComplete: "https://example.com/device?user_code=ABCD", userCode: "ABCD", expiresAt: new Date(now + 581000).toISOString() } }, 0);
        await new Promise<void>(resolve => { releaseLogin = resolve; }); return options.loginReason ? ok({ outcome: "failed", reason: options.loginReason, message: `Exact sign-in reason: ${options.loginReason}` }) : ok({ outcome: "signed-in", ...(options.switched || options.credentialsKept ? { previousSub: "previous-account" } : {}), ...(options.credentialsKept ? { credentialsKept: options.credentialsKept } : {}) });
      }
      if (r.op === "setup") {
        const metadata = [
          { step: "install", outcome: "ready", detail: "service" },
          { step: "sign-in", outcome: "already-signed-in", detail: "session" },
          { step: "discover", outcome: "registered", detail: "space" },
          { step: "manager", outcome: "running", detail: "application check" },
        ] as const;
        metadata.forEach((progress, i) => send({ v: 1, event: "setup-progress", line: `opaque diagnostic ${i}`, progress }, i));
        await new Promise<void>(resolve => { releaseSetup = resolve; });
        if (options.setupCode) return { v: 1, event: "result", ok: false, error: { code: "LIFECYCLE_BLOCKED", message: options.folder ? "the connector config folder is writable by every local account" : `Exact setup reason: ${options.setupCode}`, native: { code: options.setupCode, ...(options.folder ? { detail: options.folder } : {}) } } };
        connected = true; return ok({ launchReady: true, manager });
      }
      if (r.op === CONNECTOR_CONFIG_REPAIR) {
        assert.deepEqual(Object.keys(r).sort(), ["op"]);
        options.folder = undefined;
        return ok({ path: "/Users/ada/.cotal/config", mode: 0o755 });
      }
      throw new Error(`Unexpected ${r.op}`);
    },
  };
  const NativeURL = win.URL;
  win.URL = class extends NativeURL {
    constructor(value: string | URL, base?: string | URL) {
      if (/^cotal:/i.test(String(value))) throw new Error("Custom-scheme URL parsing unavailable");
      super(value, base);
    }
  };
  win.eval(await bundle); await settle();
  const node = <T extends HTMLElement = HTMLElement>(id: string) => doc.getElementById(id) as T;
  const click = async (id: string) => { node<HTMLButtonElement>(id).click(); await settle(); };
  return { dom, doc, node, click, calls, urls, nativeCalls, checkArgs, applyArgs, options, arm: () => { installed = true; stopped = false; }, stop: () => { stopped = true; pushWatchStatus = undefined; closeWatch?.({ v: 1, event: "result", ok: true, result: { closed: true, watchMode: "push" } }); closeWatch = undefined; return new Promise(resolve => realTimeout(resolve, 0)); }, emit: async (event: string, payload: unknown = null) => { const handler = listeners.get(event); assert.ok(handler); callbacks.get(handler)!({ event, payload }); await settle(); }, copied: () => copied, advance: (ms: number) => { now += ms; clock?.(); }, tick: async () => { pushWatchStatus?.(); await tick?.(); await settle(); }, login: async () => { assert.ok(releaseLogin); releaseLogin(); await settle(); }, setup: async () => { assert.ok(releaseSetup); releaseSetup(); await settle(); } };
}

const installerStatus: UpdateStatus = { channel: "desktop", current: "0.164.7", latest: "0.165.0", lastCheck: "2026-11-14T07:00:00Z", lastResult: "available", automatic: false, notify: true };
for (const mode of ["unconfigured", "pending", "native-error", "policy-error"] as const) {
  test(`installer-only ${mode} keeps the registry summary notice link and notification control`, async () => {
    const a = await app({ installed: true, connected: true, appVersion: "0.164.7", update: installerStatus, nativeCheckPending: mode === "pending", nativeCheckError: mode === "native-error", policyError: mode === "policy-error" });
    try {
      assert.equal(a.node("update-banner").hidden, false);
      await a.emit("desktop-open-settings");
      assert.equal(a.node("settings-update-summary").textContent, "Version 0.165.0 is available.");
      assert.equal(a.node("update-preference-label").textContent, "Notify me about updates");
      assert.equal(a.node<HTMLInputElement>("update-preference").checked, true);
      assert.equal(a.node<HTMLInputElement>("update-preference").disabled, false);
      assert.equal(a.node("settings-download-row").hidden, false);
      assert.equal(a.node<HTMLButtonElement>("settings-download").disabled, false);
      assert.notEqual(a.node("settings-last-check").textContent, "Not checked yet");
      assert.ok(!a.nativeCalls.includes("app_update_download"));
    } finally { a.dom.window.close(); }
  });
}
test("unconfigured notifications can be restored without changing shared auto", async () => {
  const a = await app({ installed: true, connected: true, appVersion: "0.164.7", autoUpdates: false, update: { ...installerStatus, notify: false } });
  try {
    assert.equal(a.node("update-banner").hidden, true);
    await a.emit("desktop-open-settings");
    assert.equal(a.node<HTMLInputElement>("update-preference").checked, false);
    a.node<HTMLInputElement>("update-preference").checked = true;
    a.node("update-preference").dispatchEvent(new a.dom.window.Event("change")); await settle();
    assert.deepEqual(JSON.parse(JSON.stringify(a.calls.filter(call => call.op === "update-settings").at(-1))), { op: "update-settings", notify: true });
    assert.ok(!a.calls.some(call => call.op === "update-policy" && call.auto !== undefined));
    await a.click("view-connection");
    assert.equal(a.node("update-banner").hidden, false);
  } finally { a.dom.window.close(); }
});
for (const phase of ["current", "failed"] as const) {
  test(`configured Check now dispatches a manual native request after automatic ${phase}`, async () => {
    const a = await app({ installed: true, connected: true, autoUpdates: false, appUpdate: { phase, reason: "Network unavailable", checkedAt: Date.now() } });
    try {
      await a.emit("desktop-open-settings");
      await a.click("check-updates");
      assert.equal(a.checkArgs.length, 2, "manual check must bypass the app day timer");
      assert.equal(a.checkArgs[1]!.manual, true, "native side must be asked to bypass its day gate");
      assert.ok(!a.calls.some(call => call.op === "update-check"), "configured manifest checks do not depend on the registry request");
      await a.tick();
      assert.equal(a.checkArgs.length, 2, "automatic polling remains daily");
    } finally { a.dom.window.close(); }
  });
}

test("desktop updates wait while visible and use the manifest answer", async () => {
  const a = await app({ installed: true, connected: true, registryLatest: "0.166.0", appUpdate: { phase: "available", version: "0.165.0" } });
  try {
    assert.equal(a.nativeCalls.filter(call => call === "app_update_download").length, 0);
    assert.ok(a.nativeCalls.includes("app_update_apply"), "native side decides actual hidden-window admission");
    await a.emit("desktop-open-settings");
    assert.match(a.node("settings-update-summary").textContent!, /Version 0\.165\.0 is available/);
    assert.ok(!a.node("settings-update-summary").textContent!.includes("0.166.0"));
    assert.equal(a.node<HTMLInputElement>("update-preference").checked, true);
    await a.tick(); await a.tick();
    assert.equal(a.nativeCalls.filter(call => call === "app_update_check").length, 1, "status polling adds no update polling");
  } finally { a.dom.window.close(); }
});

test("Mac and Windows restart are explicit native admission requests and hidden notification is automatic", async () => {
  for (const platform of ["darwin", "win32"] as const) {
    const a = await app({ installed: true, connected: true, platform, appUpdate: { phase: "available", version: "0.165.0" } });
    try {
      await a.emit("desktop-open-settings");
      assert.equal(a.node("restart-update").hidden, false);
      await a.click("restart-update");
      assert.equal(a.applyArgs.at(-1)!.explicit, true);
      await a.emit("desktop-hidden");
      assert.equal(a.applyArgs.at(-1)!.explicit, false);
      assert.ok(!a.nativeCalls.includes("app_update_download"), "download only happens inside native install admission");
    } finally { a.dom.window.close(); }
  }
});

test("automatic tick retries wait ten minutes but hide, fresh check and button are immediate", async () => {
  const a = await app({ installed: true, connected: true, appUpdate: { phase: "available", version: "0.165.0", reason: "Administrator permission is needed." } });
  try {
    const initial = a.applyArgs.length;
    for (let i = 0; i < 30; i++) { a.advance(1000); await a.tick(); }
    assert.equal(a.applyArgs.length, initial, "a standing refusal must not start one native attempt per status tick");
    await a.emit("desktop-hidden");
    assert.equal(a.applyArgs.length, initial + 1, "hide bypasses tick cooldown");
    await a.emit("desktop-open-settings");
    await a.click("check-updates");
    assert.equal(a.applyArgs.length, initial + 2, "fresh check bypasses tick cooldown");
    await a.click("restart-update");
    assert.equal(a.applyArgs.length, initial + 3, "explicit button bypasses tick cooldown");
    a.advance(600_001); await a.tick();
    assert.equal(a.applyArgs.length, initial + 4, "tick retries after ten minutes");
  } finally { a.dom.window.close(); }
});

test("relaunch after a refused Windows setup shows code 20 in Settings without immediately re-running apply", async () => {
  const reason = "Setup code 20: 1 agent(s) are running. Stop them and choose Retry.";
  const a = await app({
    installed: true,
    connected: true,
    platform: "win32",
    appReceipt: { schema: 1, from: "0.164.8", target: "0.165.0", phase: "failed", reopen: true, reason },
    appUpdate: { phase: "available", version: "0.165.0", reason },
  });
  try {
    assert.equal(a.applyArgs.length, 0, "post-refusal relaunch must not immediately re-invoke apply on startup");
    assert.match(a.node("applied-update").textContent!, /Setup code 20: 1 agent\(s\) are running/);
    for (let i = 0; i < 30; i++) { a.advance(1000); await a.tick(); }
    assert.equal(a.applyArgs.length, 0, "tick cooldown holds after a refused setup relaunch");
    await a.emit("desktop-open-settings");
    assert.match(a.node("settings-update-summary").textContent!, /Version 0\.165\.0 is available\. Setup code 20: 1 agent\(s\) are running/);
    assert.equal(a.node("restart-update").hidden, false);
    await a.click("restart-update");
    assert.equal(a.applyArgs.length, 1);
    assert.equal(a.applyArgs[0]!.explicit, true);
  } finally { a.dom.window.close(); }
});

test("auto off and Linux deb/rpm builds never request app replacement", async () => {
  for (const options of [{ autoUpdates: false }, { platform: "linux" }]) {
    const a = await app({ installed: true, connected: true, appUpdate: { phase: "available", version: "0.165.0" }, ...options });
    try {
      await a.emit("desktop-open-settings");
      await a.emit("desktop-hidden");
      assert.equal(a.node("restart-update").hidden, true);
      assert.equal(a.applyArgs.length, 0);
    } finally { a.dom.window.close(); }
  }
});

test("desktop auto off reports the manifest version and does not download", async () => {
  const a = await app({ installed: true, connected: true, autoUpdates: false, appUpdate: { phase: "available", version: "0.165.0" } });
  try {
    await a.emit("desktop-open-settings");
    assert.match(a.node("settings-update-summary").textContent!, /0\.165\.0.*Automatic updates are off/);
    assert.equal(a.node<HTMLInputElement>("update-preference").checked, false);
    assert.ok(!a.nativeCalls.includes("app_update_download"));
    a.node<HTMLInputElement>("update-preference").checked = true;
    a.node("update-preference").dispatchEvent(new a.dom.window.Event("change")); await settle();
    assert.deepEqual(JSON.parse(JSON.stringify(a.calls.filter(call => call.op === "update-policy").at(-1))), { op: "update-policy", auto: true });
    assert.equal(a.node<HTMLInputElement>("update-preference").checked, true);
    assert.ok(!a.calls.some(call => call.op === "update-settings"), "daemon eligibility is not the preference");
  } finally { a.dom.window.close(); }
});

test("normal publication gap stays in Settings and does not advertise registry latest", async () => {
  const a = await app({ installed: true, connected: true, registryLatest: "0.166.0", appUpdate: { phase: "preparing" } });
  try {
    assert.equal(a.node("update-banner").hidden, true);
    await a.emit("desktop-open-settings");
    assert.equal(a.node("settings-update-summary").textContent, "The newest release is still being prepared.");
    assert.equal(a.node("settings-download-row").hidden, true);
    assert.ok(!a.nativeCalls.includes("app_update_download"));
  } finally { a.dom.window.close(); }
});

test("Settings timestamps the desktop manifest check, not an absent registry check", async () => {
  const a = await app({ installed: true, connected: true, appUpdate: { phase: "current", checkedAt: Date.now() } });
  try {
    await a.emit("desktop-open-settings");
    assert.match(a.node("settings-last-check").textContent!, /Last checked today/);
    assert.ok(!a.node("settings-last-check").textContent!.includes("Not checked yet"));
  } finally { a.dom.window.close(); }
});

test("interrupted setup shows installer recovery without offering Start service", async () => {
  const a = await app({ installed: true, interrupted: true });
  try {
    assert.equal(a.node("connection-title").textContent, "Setup was interrupted");
    assert.equal(a.node("connection-description").textContent, "Run the installer again to finish updating Cotal.");
    assert.equal(a.node("recover").textContent, "Check again");
    assert.equal(a.node("setup-installer").hidden, false);
    assert.match(a.node<HTMLAnchorElement>("setup-installer").href, /github.com\/Cotal-AI\/Cotal\/releases\/latest/);
    await a.click("setup-installer");
    assert.equal(a.urls.at(-1), "https://github.com/Cotal-AI/Cotal/releases/latest");
    assert.equal(a.calls.some(call => call.op === "install"), false);
  } finally { a.dom.window.close(); }
});

test("interrupted about shows truthful unavailable computer details", async () => {
  const a = await app({ interruptedAbout: true });
  try {
    assert.equal(a.node("connection-title").textContent, "Setup was interrupted");
    assert.equal(a.node("machine-details").textContent, "Computer information is unavailable while setup is incomplete.");
    assert.ok(!/undefined|NaN/.test(a.doc.body.textContent ?? ""));
    assert.equal(a.calls.some(call => call.op === "install" || call.op === "status"), false);
  } finally { a.dom.window.close(); }
});

test("computer name edits save, cancel and reject invalid input before request", async () => {
  const a = await app({ installed: true });
  try {
    await a.click("login"); await a.login();
    await a.click("view-settings"); await a.click("settings-name");
    a.node<HTMLInputElement>("computer-name-input").value = "  Named laptop  ";
    a.node<HTMLFormElement>("computer-name-form").requestSubmit(); await settle();
    assert.equal(a.node("machine-name").textContent, "Named laptop");
    assert.equal(a.node("settings-computer").textContent, "Named laptop");
    assert.equal(a.calls.filter(r => r.op === "name").length, 1);
    await a.click("settings-name"); a.node<HTMLInputElement>("computer-name-input").value = "";
    a.node<HTMLFormElement>("computer-name-form").requestSubmit(); await settle();
    assert.match(a.node("computer-name-error").textContent ?? "", /1 to 128/);
    assert.equal(a.calls.filter(r => r.op === "name").length, 1);
    await a.click("cancel-computer-name"); assert.equal(a.node("machine-name").textContent, "Named laptop");
    await a.click("settings-name");
    a.node("computer-name-input").dispatchEvent(new a.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    assert.equal(a.node("computer-name-form").hidden, true);
  } finally { a.dom.window.close(); }
});

test("a later status check clears a daemon-not-running error", async () => {
  const a = await app({ installed: true });
  try {
    await a.click("login"); await a.login();
    const before = a.node("connection-title").textContent;
    await a.stop();
    await a.tick();
    assert.equal(a.node("connection-title").textContent, "The background service is not running");
    assert.equal(a.node("details").hidden, false);
    a.arm();
    await a.tick();
    assert.equal(a.node("connection-title").textContent, before);
    assert.equal(a.node("details").hidden, true);
    assert.equal(a.node("refusal-detail").textContent, "");
  } finally { a.dom.window.close(); }
});

test("a later status check keeps an error the status check did not raise", async () => {
  const a = await app({ installed: true });
  try {
    await a.click("login"); await a.login();
    await a.stop();
    await a.tick();
    a.arm();
    await a.emit("deep-link://new-url", ["cotal://one", "cotal://two"]);
    assert.equal(a.node("connection-title").textContent, "This operation could not finish");
    assert.equal(a.node("refusal-detail").textContent, "Open one computer-connection link at a time.");
    await a.tick();
    assert.equal(a.node("connection-title").textContent, "This operation could not finish");
    assert.equal(a.node("refusal-detail").textContent, "Open one computer-connection link at a time.");
  } finally { a.dom.window.close(); }
});

test("Start service starts a stopped background service and leaves no notice", async () => {
  const a = await app({ installed: true });
  try {
    await a.click("login"); await a.login();
    const before = a.node("connection-title").textContent;
    await a.stop();
    await a.tick();
    assert.equal(a.node("recover").textContent, "Start service");
    assert.equal(a.node("connection-description").textContent, "Start it again to continue.");
    assert.equal(a.node("refusal-detail").textContent, "NOT_RUNNING\nThe background service is installed but stopped. Choose Start service to start it.");
    assert.equal(a.node<HTMLButtonElement>("connect").disabled, true);
    const from = a.calls.length;
    await a.click("recover");
    assert.deepEqual(a.calls.slice(from).map(call => call.op).filter(op => op === "install"), ["install"]);
    assert.equal(a.node("connection-title").textContent, before);
    assert.equal(a.node("notice").textContent, "");
    assert.equal(a.node("notice").hidden, true);
    assert.equal(a.node("details").hidden, true);
    assert.equal(a.node<HTMLButtonElement>("connect").disabled, false);
  } finally { a.dom.window.close(); }
});

test("a service start that does not answer within 15 seconds keeps its refusal across NOT_RUNNING checks and clears when the service answers", async () => {
  const reason = "the native daemon source names another installation; startup refused";
  const expectedDetail = `DEPENDENCY_UNAVAILABLE (NOT_ANSWERING)\nCotal asked the background service on this computer to start, and it did not answer within 15 seconds. It refused to start: ${reason}\nNext: choose Check status.`;
  const a = await app({ installed: true });
  try {
    await a.click("login"); await a.login();
    const before = a.node("connection-title").textContent;
    await a.stop();
    await a.tick();
    assert.equal(a.node("connection-title").textContent, "The background service is not running");
    assert.equal(a.node("recover").textContent, "Start service");
    a.options.installNotAnswering = reason;
    await a.click("recover");
    assert.equal(a.node("connection-title").textContent, "The background service has not started");
    assert.equal(a.node("connection-description").textContent, "Cotal asked the background service on this computer to start, and it has not answered. Details shows the reason it gave, if it gave one.");
    assert.equal(a.node("recover").textContent, "Check status");
    assert.equal(a.node("details").hidden, false);
    assert.equal(a.node("refusal-detail").textContent, expectedDetail);

    // A background poll that still observes NOT_RUNNING keeps the NOT_ANSWERING card and Details.
    await a.tick();
    assert.equal(a.node("connection-title").textContent, "The background service has not started");
    assert.equal(a.node("recover").textContent, "Check status");
    assert.equal(a.node("refusal-detail").textContent, expectedDetail);

    // Clicking Check status while the service is still stopped checks status without offering Start service.
    const beforeCheck = a.calls.length;
    await a.click("recover");
    assert.deepEqual(a.calls.slice(beforeCheck).map(call => call.op), ["status"]);
    assert.equal(a.node("connection-title").textContent, "The background service has not started");
    assert.equal(a.node("recover").textContent, "Check status");
    assert.equal(a.node("refusal-detail").textContent, expectedDetail);

    // Once the service answers after 15s, the next poll clears the card and Details.
    a.arm();
    await a.tick();
    assert.equal(a.node("connection-title").textContent, before);
    assert.equal(a.node("recovery-panel").hidden, true);
    assert.equal(a.node("details").hidden, true);
    assert.equal(a.node("refusal-detail").textContent, "");
  } finally { a.dom.window.close(); }
});

test("another provider failure does not block successful sign-in", async () => {
  const a = await app({ installed: true, otherProviderFailed: true });
  try {
    await a.click("login"); await a.login();
    assert.notEqual(a.node("connection-title").textContent, "This operation could not finish");
    assert.match(a.node("notice").textContent ?? "", /hack\.cotal\.ai/);
  } finally { a.dom.window.close(); }
});

test("an account switch signs in without a notice when every previous credential file was deleted", async () => {
  const a = await app({ installed: true, switched: true });
  try {
    await a.click("login"); await a.login();
    assert.notEqual(a.node("connection-title").textContent, "This operation could not finish");
    assert.equal(a.node("notice").textContent, "");
  } finally { a.dom.window.close(); }
});

test("an account switch that kept credential files stays signed in and names each file and the cleanup", async () => {
  const kept = [{ space: "old-team", path: "/Users/me/.cotal/catalog/abc/old-team/.cotal/auth/space.6f6c64/sentinel.creds", reason: "EACCES" }];
  const a = await app({ installed: true, credentialsKept: kept });
  try {
    await a.click("login"); await a.login();
    assert.notEqual(a.node("connection-title").textContent, "This operation could not finish", "the switched account is kept");
    assert.equal(a.calls.filter(r => r.op === "spaces").length > 0, true, "it continues to the new account's spaces");
    const shown = a.node("notice").textContent ?? "";
    assert.match(shown, /could not be deleted/);
    assert.ok(shown.includes(kept[0]!.path) && shown.includes("old-team") && shown.includes("EACCES"), shown);
    assert.match(shown, /Delete each file named/);
    assert.equal(a.node("notice").classList.contains("error"), true);
  } finally { a.dom.window.close(); }
});

for (const option of ["ownProviderFailed", "oldDaemon"] as const) test(`${option} keeps sign-in refresh blocking`, async () => {
  const a = await app({ installed: true, [option]: true });
  try {
    await a.click("login"); await a.login();
    assert.equal(a.node("connection-title").textContent, "This operation could not finish");
    assert.match(a.node("refusal-detail").textContent ?? "", option === "ownProviderFailed" ? /cotal\.cloud/ : /Some space catalogs/);
  } finally { a.dom.window.close(); }
});

test("tray Settings preserves the chooser and dashboard retains the verified target while hidden polling continues", async () => {
  const a = await app({ installed: true, connected: true });
  try {
    await a.click("another-space");
    await a.emit("desktop-open-settings");
    assert.equal(a.node("view-settings").getAttribute("aria-selected"), "true");
    assert.equal(a.node("settings-panel").hidden, false);
    await a.click("view-connection");
    assert.equal(a.node("connection-view").hidden, false);
    assert.equal(a.node("space-panel").hidden, false);
    assert.equal(a.node("connected-spaces").hidden, false);
    assert.equal(a.node("connection-title").textContent, "This computer is connected");
    await a.emit("desktop-open-dashboard");
    assert.match(a.urls.at(-1)!, /\/machines\?space=sp_team&machine=instance$/);
    Object.defineProperty(a.doc, "hidden", { configurable: true, value: true });
    const before = a.calls.filter(r => r.op === "status").length;
    await a.tick();
    assert.equal(a.calls.filter(r => r.op === "status").length, before, "status-watch replaces periodic status polling");
    assert.equal(a.calls.filter(r => r.op === "status-watch").length, 1);
  } finally { a.dom.window.close(); }
});

test("tray Settings before setup preserves explicit onboarding consent", async () => {
  const a = await app();
  try {
    await a.emit("desktop-open-settings");
    assert.equal(a.node("connection-title").textContent, "Welcome to Cotal");
    assert.ok(!a.calls.some(r => ["install", "login", "setup"].includes(r.op)));
  } finally { a.dom.window.close(); }
});

test("first open is a neutral Cloud-default welcome and sign-in is an explicit action", async () => {
  const a = await app();
  try {
    assert.equal(a.node("connection-title").textContent, "Welcome to Cotal");
    assert.equal(a.node("notice").hidden, true); assert.equal(a.node("details").hidden, true);
    assert.equal(a.node("login").textContent, "Continue with Cotal Cloud");
    assert.equal(a.node<HTMLInputElement>("provider").value, COTAL_CLOUD_IDP);
    assert.equal(a.node("custom-host").hidden, true);
    assert.ok(!a.calls.some(r => ["install", "login", "setup"].includes(r.op)));
    assert.match(a.node("connection-description").textContent!, /operating-system user/);
    assert.equal(a.node("machine-details").textContent, "macOS · Apple silicon · 36 GB");
    await a.click("other-host"); assert.equal(a.node("custom-host").hidden, false);
    assert.equal(a.node<HTMLInputElement>("provider").value, "");
  } finally { a.dom.window.close(); }
});

test("legacy computer account without a selected space retains its provider on sign-in again", async () => {
  const provider = "https://cloud.cotal.ai/api/auth";
  const a = await app({ installed: true, count: 0, account: { idpUrl: provider, sub: "legacy-user", mode: "sign-in-required", hostSupport: "supported", spaces: [] } });
  try {
    await a.click("sign-in-again");
    assert.equal(a.calls.find(r => r.op === "login")?.idp, provider);
    assert.equal(a.node<HTMLInputElement>("provider").value, provider);
    assert.equal(a.node("custom-host").hidden, true);
    assert.match(a.node("settings-account").textContent ?? "", /Cotal Cloud, cloud\.cotal\.ai/);
  } finally { a.dom.window.close(); }
});

for (const source of ["typed host", "onboarding link", "typed host with saved legacy account"] as const) {
  test(`denied sign-in retry preserves ${source}`, async () => {
    const provider = "https://example.com/api/auth";
    const a = await app({
      installed: true, count: 0, loginReason: "denied",
      ...(source === "onboarding link" ? { link: `cotal://connect?idp=${encodeURIComponent(provider)}` } : {}),
      ...(source === "typed host with saved legacy account" ? { account: { idpUrl: "https://cloud.cotal.ai/api/auth", sub: "legacy-user", mode: "sign-in-required", hostSupport: "supported", spaces: [] } } : {}),
    });
    try {
      if (source === "typed host with saved legacy account") {
        await a.click("sign-in-again"); await a.login();
        await a.click("retry-login");
      }
      if (source !== "onboarding link") {
        await a.click("other-host");
        a.node<HTMLInputElement>("provider").value = provider;
      }
      await a.click("login"); await a.login();
      assert.equal(a.node("recovery-panel").hidden, false);
      assert.match(a.node("refusal-detail").textContent ?? "", /denied/);
      const loginsBeforeRetry = a.calls.filter(r => r.op === "login").length;
      await a.click("recover");
      const logins = a.calls.filter(r => r.op === "login");
      assert.equal(logins.length, loginsBeforeRetry + 1);
      assert.deepEqual(logins.slice(-2).map(r => r.idp), [provider, provider]);
      assert.equal(a.node<HTMLInputElement>("provider").value, provider);
      await a.login();
    } finally { a.dom.window.close(); }
  });
}

for (const provider of [COTAL_CLOUD_IDP, "https://cloud.cotal.ai/api/auth"]) {
  test(`Cloud retry sign-in keeps the custom host form hidden for ${provider}`, async () => {
    const a = await app({ installed: true, provider });
    try {
      await a.click("retry-login");
      assert.equal(a.node<HTMLInputElement>("provider").value, provider);
      assert.equal(a.node("custom-host").hidden, true);
    } finally { a.dom.window.close(); }
  });
}

test("linked first run needs sign-in approval then connect, with one panel and structured progress", async () => {
  const a = await app({ link: `cotal://connect?idp=${encodeURIComponent(COTAL_CLOUD_IDP)}&space=sp_team`, count: 2 });
  try {
    assert.ok(a.node("link-context").textContent!.includes(`your account at ${new URL(COTAL_CLOUD_IDP).host}`));
    assert.equal(a.node("notice").hidden, true);
    await a.click("login");
    assert.equal(a.calls.filter(r => r.op === "install").length, 1);
    assert.equal(a.node("approval").hidden, false); assert.equal(a.node("approval-code").textContent, "ABCD");
    assert.equal(a.node("space-panel").hidden, true); assert.equal(a.node("connect-panel").hidden, true);
    assert.equal(a.doc.querySelector('[data-stage="welcome"]')!.getAttribute("data-state"), "done");
    assert.equal(a.urls.length, 1);
    await a.login();
    assert.equal(a.node("sign-in-panel").hidden, true); assert.equal(a.node("space-panel").hidden, true);
    assert.equal(a.node("connect-panel").hidden, false); assert.equal(a.node<HTMLSelectElement>("space").value, "team");
    assert.equal(a.node("link-context").hidden, true);
    assert.equal(a.node<HTMLButtonElement>("connect").disabled, false);
    await a.click("connect");
    assert.equal(a.node("connect-panel").hidden, true);
    assert.deepEqual([...a.doc.querySelectorAll<HTMLElement>("#setup-progress li")].map(li => li.dataset.state), ["done", "done", "done", "running", "waiting"]);
    assert.equal(a.node<HTMLDetailsElement>("details").open, false);
    assert.match(a.node("setup-lines").textContent!, /opaque diagnostic/);
    assert.doesNotMatch(a.node("setup-progress").textContent!, /opaque diagnostic/);
    await a.setup();
    assert.equal(a.node("connection-title").textContent, "This computer is connected");
    assert.equal(a.node("connected-panel").hidden, false); assert.equal(a.node("sign-in-panel").hidden, true);
    assert.equal(a.node("space-panel").hidden, true); assert.equal(a.node("notice").hidden, true);
    assert.equal(a.node<HTMLButtonElement>("dashboard").disabled, false);
    await a.click("dashboard"); assert.equal(a.urls.at(-1), new URL("/machines?space=sp_team&machine=instance", COTAL_CLOUD_IDP).href);
    assert.equal(a.calls.filter(r => r.op === "setup").length, 1);
    await a.click("another-space"); assert.equal(a.node("space-panel").hidden, false);
  } finally { a.dom.window.close(); }
});

test("unlinked accounts choose among spaces but skip a single space", async () => {
  for (const count of [1, 2]) {
    const a = await app({ count });
    try {
      await a.click("login"); await a.login();
      assert.equal(a.node("space-panel").hidden, count === 1);
      assert.equal(a.node("connect-panel").hidden, false);
      assert.equal(a.calls.filter(r => r.op === "setup").length, 0);
      if (count === 2) {
        a.node<HTMLSelectElement>("space").value = "other";
        a.node("space").dispatchEvent(new a.dom.window.Event("change")); await settle();
        await a.click("choose-space"); assert.equal(a.node("connect-panel").hidden, false);
      }
    } finally { a.dom.window.close(); }
  }
});

test("a blank space label shows the space id", async () => {
  const a = await app({ installed: true, connected: true, label: " " });
  try {
    assert.equal(a.doc.querySelector('[data-testid="connected-space-row"] strong')?.textContent, "team");
    assert.equal(a.doc.querySelector('#space option[value="team"]')?.textContent, "team");
  } finally { a.dom.window.close(); }
  const kept = await app({ installed: true, connected: true, label: " ada" });
  try {
    assert.equal(kept.doc.querySelector('[data-testid="connected-space-row"] strong')?.textContent, " ada");
  } finally { kept.dom.window.close(); }
  const chip = await app({ installed: true, connected: true, kind: " " });
  try {
    assert.equal(chip.doc.querySelector('[data-testid="connected-space-row"] .space-kind')?.textContent, "Space");
  } finally { chip.dom.window.close(); }
  const named = await app({ installed: true, connected: true, kind: " ada" });
  try {
    assert.equal(named.doc.querySelector('[data-testid="connected-space-row"] .space-kind')?.textContent, "Ada");
  } finally { named.dom.window.close(); }
});

test("a blank account label shows the subject", async () => {
  const a = await app({ installed: true, connected: true, account: { label: " ", sub: "user-1" } });
  try {
    await a.click("view-settings");
    assert.equal(a.node("settings-account").textContent, "Cotal Cloud, cotal.cloud · user-1");
  } finally { a.dom.window.close(); }
  const kept = await app({ installed: true, connected: true, account: { label: " ada", sub: "user-1" } });
  try {
    await kept.click("view-settings");
    assert.equal(kept.node("settings-account").textContent, "Cotal Cloud, cotal.cloud ·  ada");
  } finally { kept.dom.window.close(); }
});

test("later open shows connection and secondary controls, never sign-in or space forms", async () => {
  const a = await app({ installed: true, connected: true, count: 2 });
  try {
    const startup = a.node("autostart");
    assert.equal(a.node("connection-title").textContent, "This computer is connected");
    assert.equal(a.node("connected-panel").hidden, false);
    assert.ok(startup.closest("[hidden]"));
    await a.click("view-settings");
    assert.equal(a.node("settings-panel").hidden, false);
    assert.equal(startup.closest("#settings-startup"), a.node("settings-startup"));
    assert.equal(startup.closest("[hidden]"), null);
    await a.click("view-connection");
    assert.ok(startup.closest("[hidden]"));
    assert.equal(a.node("sign-in-panel").hidden, true); assert.equal(a.node("space-panel").hidden, true);
    assert.ok(a.doc.querySelector(".app.later-open"));
    await a.click("another-space"); assert.equal(a.node("space-panel").hidden, false);
    await a.click("choose-space"); assert.equal(a.node("connected-panel").hidden, false);
    await a.click("sign-in-again"); assert.equal(a.node("sign-in-panel").hidden, false);
  } finally { a.dom.window.close(); }
});

test("personal space is selected without a chooser and still requires consent", async () => {
  const a = await app({ count: 2, personal: true });
  try {
    await a.click("login"); await a.login();
    assert.equal(a.node<HTMLSelectElement>("space").value, "team");
    assert.equal(a.node("space-panel").hidden, true);
    assert.match(a.node("selected-space").textContent!, /your personal space, My team/);
    assert.equal(a.calls.filter(r => r.op === "setup").length, 0);
  } finally { a.dom.window.close(); }
});

test("Ready removes a space and adds another only after confirmation", async () => {
  const a = await app({ installed: true, connected: true, count: 2 });
  try {
    assert.equal(a.doc.querySelectorAll('[data-testid="connected-space-row"]').length, 1);
    (a.doc.querySelector('#connected-spaces button') as HTMLButtonElement).click(); await settle();
    assert.equal(JSON.stringify(a.calls.filter(r => r.op === "service-disconnect")), JSON.stringify([{ op: "service-disconnect", space: "team" }]));
    assert.equal(a.doc.querySelectorAll('[data-testid="connected-space-row"]').length, 0);
    assert.equal(a.node("sidebar-status-word").textContent, "Connected");
    assert.equal(a.node("sidebar-status-dot").dataset.tone, "ok");
    await a.click("another-space");
    a.node<HTMLSelectElement>("space").value = "other";
    a.node("space").dispatchEvent(new a.dom.window.Event("change")); await settle();
    assert.match(a.node("selected-space").textContent!, /People authorized in Other team/);
    assert.equal(a.calls.filter(r => r.op === "setup").length, 0);
    await a.click("connect"); assert.equal(a.calls.filter(r => r.op === "setup").at(-1)?.space, "other");
    await a.setup();
    assert.match(a.node("connected-spaces").textContent!, /Other team/);
  } finally { a.dom.window.close(); }
});

test("connected and pending spaces retain the connected view and waiting row", async () => {
  const a = await app({ installed: true, connected: true, count: 2, serviceState: "approval-pending" });
  try {
    assert.equal(a.node("connection-title").textContent, "This computer is connected");
    assert.equal(a.node("sidebar-status-dot").dataset.tone, "ok");
    assert.equal(a.node("dashboard").hidden, false);
    assert.equal(a.doc.querySelectorAll('[data-testid="connected-space-row"]').length, 2);
    assert.match(a.node("connected-spaces").textContent!, /Other team.*Waiting for owner approval/);
  } finally { a.dom.window.close(); }
});

test("loading stays neutral until the native service answers", async () => {
  const a = await app({ loading: true });
  try {
    assert.ok(a.doc.querySelector(".app.loading"));
    assert.equal(a.node("sidebar-status-word").textContent, "Starting");
    assert.equal(a.node("sidebar-status-dot").dataset.tone, "waiting");
    assert.equal(a.calls.length, 1);
  }
  finally { a.dom.window.close(); }
});

test("approval code counts down, copies, expires and serializes a requested replacement", async () => {
  const a = await app({ loginReason: "expired" });
  try {
    await a.click("login"); await a.click("login");
    assert.equal(a.calls.filter(r => r.op === "login").length, 1);
    assert.equal(a.node("approval-expiry").textContent, "Expires in 9:41");
    await a.click("copy-code"); assert.equal(a.copied(), "ABCD"); assert.equal(a.node("copy-code").textContent, "Copied");
    a.advance(1000); assert.equal(a.node("approval-expiry").textContent, "Expires in 9:40");
    a.advance(580000); assert.equal(a.node("connection-title").textContent, "Your code has expired");
    assert.equal(a.node("recover").textContent, "Get a new code");
    await a.click("recover"); await a.click("recover");
    assert.equal(a.calls.filter(r => r.op === "login").length, 1, "no second request while native attempt is settling");
    await a.login(); assert.equal(a.calls.filter(r => r.op === "login").length, 2);
  } finally { a.dom.window.close(); }
});

test("polling preserves each step, entered host, focus and progress node identity", async () => {
  const a = await app({ count: 2 });
  const unchanged = async () => {
    const before = a.node("connection-title").textContent, active = a.doc.activeElement;
    const marker = a.node("setup-progress").firstElementChild;
    await a.tick(); assert.equal(a.node("connection-title").textContent, before); assert.equal(a.doc.activeElement, active);
    assert.equal(a.node("setup-progress").firstElementChild, marker);
  };
  try {
    await a.click("other-host"); a.node<HTMLInputElement>("provider").value = "https://example.com/auth"; a.node("provider").focus();
    await unchanged(); assert.equal(a.node<HTMLInputElement>("provider").value, "https://example.com/auth");
    await a.click("login"); a.node("copy-code").focus(); await unchanged();
    await a.login(); a.node("space").focus(); await unchanged();
    a.node<HTMLSelectElement>("space").value = "team";
    await a.click("choose-space"); a.node("retry-login").focus(); await unchanged();
    await a.click("connect"); await a.click("connect"); await unchanged();
    assert.equal(a.calls.filter(r => r.op === "setup").length, 1);
    await a.setup(); a.node("dashboard").focus(); await unchanged();
  } finally { a.dom.window.close(); }
});

test("Enter invokes the visible primary and Escape closes Details", async () => {
  const a = await app();
  try {
    a.node("connection-title").focus();
    a.node("connection-title").dispatchEvent(new a.dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await settle(); assert.equal(a.calls.filter(r => r.op === "login").length, 1);
    const opened = a.urls.length;
    a.node("connection-title").dispatchEvent(new a.dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })); await settle();
    assert.equal(a.urls.length, opened + 1, "Enter reopens approval, not the hidden login button");
    await a.login(); await a.click("connect");
    a.node<HTMLDetailsElement>("details").open = true;
    a.doc.dispatchEvent(new a.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    assert.equal(a.node<HTMLDetailsElement>("details").open, false);
    assert.equal(a.doc.activeElement, a.node("details").querySelector("summary"));
    assert.equal(a.doc.querySelectorAll('[aria-live="polite"]').length, 1);
  } finally { a.dom.window.close(); }
});

for (const reason of ["denied", "expired", "unreachable"]) test(`sign-in ${reason} has a designed recovery`, async () => {
  const a = await app({ loginReason: reason });
  try {
    await a.click("login"); await a.login();
    assert.equal(a.node("recovery-panel").hidden, false);
    assert.match(a.node("refusal-detail").textContent!, new RegExp(reason));
    a.options.loginReason = undefined;
    await a.click("recover");
    if (reason !== "unreachable") assert.equal(a.calls.filter(r => r.op === "login").length, 2);
    else assert.ok(a.calls.filter(r => r.op === "status").length > 1);
  } finally { a.dom.window.close(); }
});

for (const owned of [true, false]) test(`an unprotected settings folder ${owned ? "offers the one repair" : "waits for its owner"}`, async () => {
  const folder = { path: "/Users/ada/.cotal/config", mode: 0o777, owned };
  const a = await app({ installed: true, account: { mode: "account", hostSupport: "supported", spaces: [{ space: "team", desired: true, observed: "refused" }] }, folder });
  try {
    assert.equal(a.node("connection-title").textContent, "Your Cotal settings folder can be changed by other accounts on this computer");
    assert.equal(a.node("connection-description").textContent, folder.path);
    assert.equal(a.node("sidebar-status-word").textContent, "Repair needed");
    assert.equal(a.node("sidebar-status-dot").dataset.tone, "problem");
    assert.equal(a.node("recover").textContent, owned ? "Fix folder permissions" : "Check again");
    assert.equal(a.node("recovery-panel").hidden, false);
    assert.equal(a.calls.some(call => call.op === CONNECTOR_CONFIG_REPAIR), false, "opening the card sends no repair");
    if (!owned) {
      await a.click("recover");
      assert.equal(a.calls.some(call => call.op === CONNECTOR_CONFIG_REPAIR), false, "an unowned folder is not repaired from here");
      assert.equal(a.node("connection-title").textContent, "Your Cotal settings folder can be changed by other accounts on this computer");
      return;
    }
    await a.click("recover");
    assert.deepEqual(JSON.parse(JSON.stringify(a.calls.filter(call => call.op === CONNECTOR_CONFIG_REPAIR))), [{ op: CONNECTOR_CONFIG_REPAIR }], "the button sends the repair with no arguments");
    assert.equal(a.node("recovery-panel").hidden, true, "a repaired folder leaves the card");
    assert.notEqual(a.node("sidebar-status-word").textContent, "Repair needed");
  } finally { a.dom.window.close(); }
});

for (const setupCode of ["NO_AVAILABLE_CONNECTOR", "SEATS_ACTIVE"]) test(`${setupCode} retains diagnostics and retries setup`, async () => {
  const a = await app({ installed: true, setupCode });
  try {
    await a.click("connect"); await a.setup();
    assert.equal(a.node("recovery-panel").hidden, false);
    assert.equal(a.node<HTMLDetailsElement>("details").open, true);
    assert.match(a.node("refusal-detail").textContent!, new RegExp(setupCode));
    a.options.setupCode = undefined; await a.click("recover"); await a.setup();
    assert.equal(a.node("connection-title").textContent, "This computer is connected");
  } finally { a.dom.window.close(); }
});

test("empty catalog, pending approval, offline and version mismatch expose recovery", async () => {
  for (const options of [{ count: 0 }, { installed: true, serviceState: "approval-pending" }, { installed: true, statusError: true }, { installed: true, mismatch: true }]) {
    const a = await app(options);
    try {
      if (options.count === 0) { await a.click("login"); await a.login(); }
      if (options.serviceState === "approval-pending") {
        assert.equal(a.node("connection-title").textContent, "Waiting for owner approval");
        assert.ok(a.doc.querySelector('[data-testid="approval-pending"]'));
        assert.equal(a.node("apps-panel").hidden, true);
        assert.equal(a.node("dashboard").hidden, true);
        assert.equal(a.node("recovery-panel").hidden, true);
        assert.match(a.node("connected-spaces").textContent!, /Waiting for owner approval/);
        assert.equal(a.doc.querySelector(".connection-card")!.classList.contains("has-refusal"), false);
        continue;
      }
      assert.equal(a.node("recovery-panel").hidden, false);
      assert.equal(a.node<HTMLButtonElement>("recover").disabled, false);
      const calls = a.calls.length; await a.click("recover"); assert.ok(a.calls.length > calls);
    } finally { a.dom.window.close(); }
  }
});

test("reduced motion turns off the loading spinner and app progress animation", () => {
  const css = readFileSync(new URL("../src/style.css", import.meta.url), "utf8");
  const components = readFileSync(new URL("../src/components.css", import.meta.url), "utf8");
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.icon-spinner\s*\{\s*animation: none;/);
  assert.match(components, /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.app-bar::before\s*\{\s*animation: none;/);
});
test("unknown and service-only states cannot claim launch readiness", async () => {
  for (const serviceState of ["connected", "unknown-new-state"]) {
    const a = await app({ installed: true, serviceState });
    try { assert.equal(a.node("connected-panel").hidden, true); assert.equal(a.node<HTMLButtonElement>("dashboard").disabled, true); }
    finally { a.dom.window.close(); }
  }
});

test("linked space missing from discovered spaces shows an unavailable notice and chooser", async () => {
  const a = await app({ link: `cotal://connect?idp=${encodeURIComponent(COTAL_CLOUD_IDP)}&space=missing_space`, count: 2 });
  try {
    await a.click("login"); await a.login();
    assert.equal(a.node("space-panel").hidden, false);
    assert.match(a.node("notice").textContent ?? "", /The requested space is not available to this account/);
  } finally { a.dom.window.close(); }
});
