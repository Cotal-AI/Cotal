import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import type { Frame, Request } from "../src/model.ts";

const { JSDOM } = createRequire(import.meta.url)("jsdom");

test("launch readiness, application retry and polling follow the selected space", async () => {
  const output = await build({ root: fileURLToPath(new URL("..", import.meta.url)), logLevel: "silent", build: { write: false } });
  assert.ok(!Array.isArray(output) && "output" in output);
  const bundle = output.output.find((file) => file.type === "chunk" && file.isEntry);
  assert.ok(bundle && "code" in bundle);
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8").replace(/<script\b[^>]*><\/script>/g, "");
  const dom = new JSDOM(html, { url: "http://localhost/", pretendToBeVisual: true, runScripts: "outside-only" });
  const win = dom.window;
  const doc = win.document as Document;
  const calls: Request[] = [];
  const states = new Map([["first", "approval-pending"], ["second", "disconnected"]]);
  let approved = false;
  let daemonVersion = "test";
  const browserUrls: string[] = [];
  const managers = new Map<string, Record<string, unknown>>();
  let tick: (() => Promise<void>) | undefined;
  const heldStatus: { release?: () => void } = {};
  let holdOperation: string | undefined;
  let rejectHeld = false;
  const callbacks = new Map<number, (frame: unknown) => void>();
  let callback = 0;
  win.setTimeout = (fn: () => Promise<void>, ms: number) => {
    assert.equal(ms, 60_000);
    tick = fn;
    return 1;
  };
  win.clearTimeout = () => { tick = undefined; };
  win.isTauri = true;
  win.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  win.__TAURI_INTERNALS__ = {
    transformCallback: (fn: (frame: unknown) => void) => { callbacks.set(++callback, fn); return callback; },
    unregisterCallback() {},
    async invoke(cmd: string, args: { request?: Request; url?: string; onEvent?: { id: number } } = {}) {
      if (cmd === "plugin:event|listen") return ++callback;
      if (cmd === "plugin:deep-link|get_current") return ["cotal://connect?idp=https://example.com/auth&space=sp_first"];
      if (cmd === "desktop_presence") return { loginEnabled: false, relocationOffer: false, pinOffer: false, pinMessage: "" };
      if (cmd === "set_connection_state") return;
      if (cmd === "app_update_receipt") return undefined;
      if (cmd === "app_update_check") return { phase: "unconfigured" };
      if (cmd === "open_browser") { browserUrls.push(args.url!); return; }
      assert.equal(cmd, "daemon_request");
      const req = args.request!;
      calls.push(req);
      let result: Record<string, unknown>;
      switch (req.op) {
        case "update-policy": result = { auto: req.auto ?? true }; break;
        case "about": result = { machine: "test", version: "test", platform: "linux", arch: "x64", memoryBytes: 0 }; break;
        case "status": result = { state: "ready", version: daemonVersion, managers: [...managers.values()] }; break;
        case "status-watch": result = { closed: false }; break;
        case "spaces": result = { spaces: ["first", "second"].map((space) => ({ space, catalogId: `sp_${space}`, mode: "user", idp: "https://example.com/auth" })) }; break;
        case "setup": {
          callbacks.get(args.onEvent!.id)!({ index: 0, message: { v: 1, event: "setup-progress", line: "connectors: 0 available", progress: { step: "applications", outcome: approved ? "available" : "unavailable", detail: "inventory", applications: ["Claude Code", "Codex"] } } satisfies Frame });
          if (!approved) return { v: 1, event: "result", ok: false, error: { code: "DEPENDENCY_UNAVAILABLE", message: "no available connector in the hosted Manager's environment", native: { code: "NO_AVAILABLE_CONNECTOR" }, remedy: "install Claude Code or Codex and choose Check again" } };
          const manager = { space: req.space, state: "answering", instanceId: "test-manager", connectors: [{ state: "available" }] };
          managers.set(req.space!, manager); states.set(req.space!, "connected"); result = { launchReady: true, manager, state: "approval-pending" }; break;
        }
        case "service-disconnect": managers.delete(req.space!); states.set(req.space!, "disconnected"); result = { state: "disconnected" }; break;
        case "service-status": {
          result = { state: states.get(req.space!) };
          break;
        }
        default: throw new Error(`Unexpected request ${req.op}`);
      }
      if (req.op === holdOperation) {
        holdOperation = undefined;
        const fail = rejectHeld;
        await new Promise<void>((resolve, reject) => {
          heldStatus.release = () => fail ? reject(new Error("delayed status failure")) : resolve();
        });
      }
      return { v: 1, event: "result", ok: true, result };
    },
  };
  const button = (id: string) => doc.getElementById(id) as HTMLButtonElement;
  const title = () => doc.getElementById("connection-title")!.textContent;
  const disconnectedTitle = () => doc.getElementById("connected-panel")!.hidden ? "Ready to connect" : managers.size ? "This computer is connected" : "This computer is connected to your account";
  const settle = async () => { for (let i = 0; i < 30; i++) await new Promise<void>((resolve) => setImmediate(resolve)); };
  const select = async (space: string) => {
    (doc.getElementById("space") as HTMLSelectElement).value = space;
    doc.getElementById("space")!.dispatchEvent(new win.Event("change"));
    await settle();
  };
  const holdRefresh = async (op = "status", fail = false) => {
    holdOperation = op;
    rejectHeld = fail;
    heldStatus.release = undefined;
    const polling = tick!();
    await settle();
    const release = heldStatus.release as (() => void) | undefined;
    assert.ok(release, `refresh reached ${op}`);
    return async () => { release(); await polling; };
  };
  try {
    win.eval(bundle.code);
    await settle();
    assert.ok(tick, "renderer starts its visible idle status poll");
    assert.equal((doc.getElementById("space") as HTMLSelectElement).value, "first", "canonical catalog ID selects its local space");
    assert.ok(!calls.some(call => ["install", "login", "setup"].includes(call.op)), "deep links only prefill, never sign in or connect");
    await select("first");
    button("connect").click();
    await settle();
    assert.equal(title(), "No agent app is installed");
    assert.equal(button("connect").disabled, false, "application discovery can be retried");
    assert.equal(button("connect").textContent, "Check again");
    assert.match(doc.getElementById("refusal-detail")!.textContent!, /Claude Code or Codex/);
    await tick!();
    assert.equal(title(), "No agent app is installed");
    await select("second");
    assert.equal(title(), disconnectedTitle());
    await select("first");
    assert.equal(title(), "No agent app is installed");
    approved = true;
    button("connect").click();
    await settle();
    assert.equal(title(), "This computer is connected");
    button("dashboard").click(); await settle();
    assert.equal(browserUrls.at(-1), "https://example.com/machines?space=sp_first&machine=test-manager");
    assert.equal(button("connect").disabled, true);
    const registrations = calls.filter((call) => call.op === "setup").length;
    button("connect").click();
    button("connect").dispatchEvent(new win.Event("click"));
    await settle();
    assert.equal(calls.filter((call) => call.op === "setup").length, registrations);
    const releaseOldSelection = await holdRefresh();
    assert.equal(title(), "This computer is connected", "poll does not temporarily replace a verified state with local readiness");
    assert.equal(button("connect").disabled, true);
    await select("second");
    assert.equal(button("connect").disabled, false, "another space is not blocked by the connected selection");
    await releaseOldSelection();
    assert.equal(title(), disconnectedTitle(), "late status for the old selection is ignored");
    const beforeOtherSpace = browserUrls.length;
    assert.equal(button("dashboard").disabled, true);
    button("dashboard").click(); button("dashboard").dispatchEvent(new win.Event("click")); await settle();
    assert.equal(browserUrls.length, beforeOtherSpace, "a space without a ready Manager cannot open the previous space's dashboard");
    await select("first");
    assert.equal(button("connect").disabled, true);
    const releaseConnected = await holdRefresh();
    button("disconnect").click();
    await settle();
    assert.equal(title(), disconnectedTitle());
    assert.equal(doc.getElementById("notice")!.textContent, "", "disconnect uses one status sentence without a duplicate notice");
    assert.equal(button("connect").disabled, false);
    await releaseConnected();
    assert.equal(title(), disconnectedTitle(), "old connected status cannot undo disconnect");
    assert.equal(button("connect").disabled, false, "reconnect stays available");
    const beforeDisconnected = browserUrls.length;
    assert.equal(button("dashboard").disabled, true);
    button("dashboard").click(); button("dashboard").dispatchEvent(new win.Event("click")); await settle();
    assert.equal(browserUrls.length, beforeDisconnected, "disconnect clears the old Manager dashboard target");

    const releaseDisconnected = await holdRefresh();
    button("connect").click();
    await settle();
    assert.equal(title(), "This computer is connected");
    await releaseDisconnected();
    assert.equal(title(), "This computer is connected", "old disconnected status cannot undo connect");
    assert.equal(button("connect").disabled, true);
    const afterReconnect = calls.filter((call) => call.op === "setup").length;
    button("connect").click();
    button("connect").dispatchEvent(new win.Event("click"));
    await settle();
    assert.equal(calls.filter((call) => call.op === "setup").length, afterReconnect);

    const releaseReady = await holdRefresh("status");
    button("disconnect").click();
    await settle();
    const serviceReads = calls.filter((call) => call.op === "service-status").length;
    await releaseReady();
    assert.equal(calls.filter((call) => call.op === "service-status").length, serviceReads, "stale readiness reply cannot continue a refresh");
    assert.equal(title(), disconnectedTitle());
    button("connect").click();
    await settle();

    for (const op of ["status"]) {
      const releaseError = await holdRefresh(op, true);
      button("disconnect").click();
      await settle();
      await releaseError();
      assert.equal(title(), disconnectedTitle(), `stale ${op} failure cannot overwrite disconnect`);
      assert.equal(button("connect").disabled, false, "stale error cannot clear daemon readiness");
      assert.notEqual(doc.getElementById("notice")!.textContent, "Error: delayed status failure");
      button("connect").click();
      await settle();
      assert.equal(title(), "This computer is connected");
    }

    const releaseBeforeReselect = await holdRefresh();
    await select("second");
    states.set("first", "disconnected"); managers.delete("first");
    await select("first");
    assert.equal(title(), disconnectedTitle());
    await releaseBeforeReselect();
    assert.equal(title(), disconnectedTitle(), "returning to the same space does not revive an old refresh");
    assert.equal(button("connect").disabled, false);
    managers.set("first", { space: "first", state: "refused", reason: "The space could not be verified.", next: "Run cotal daemon restart" });
    button("refresh").click(); await settle();
    assert.equal(doc.getElementById("refusal-detail")!.textContent, "DEPENDENCY_UNAVAILABLE\nThe space could not be verified.");
    managers.delete("first");
    daemonVersion = "older";
    button("recover").click(); await settle();
    assert.equal(button("connect").disabled, false, "an app replacement keeps stock setup available");
    assert.equal(title(), "Cotal was updated");
  } finally { win.close(); }
});

test("status-watch pushes updates without polling and VERSION_MISMATCH recovers automatically on 60 s status recheck", async () => {
  const output = await build({ root: fileURLToPath(new URL("..", import.meta.url)), logLevel: "silent", build: { write: false } });
  assert.ok(!Array.isArray(output) && "output" in output);
  const bundle = output.output.find((file) => file.type === "chunk" && file.isEntry);
  assert.ok(bundle && "code" in bundle);
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8").replace(/<script\b[^>]*><\/script>/g, "");

  for (const startedHidden of [false, true]) {
    const dom = new JSDOM(html, { url: "http://localhost/", pretendToBeVisual: true, runScripts: "outside-only" });
    const win = dom.window;
    const doc = win.document as Document;
    const calls: Request[] = [];
    const delays: number[] = [];
    const timers = new Map<number, { fn: () => Promise<void>; ms: number }>();
    const callbacks = new Map<number, (frame: unknown) => void>();
    const listeners = new Map<string, number>();
    let callback = 0;
    let pushStatus: ((status: Record<string, unknown>) => void) | undefined;
    let closeWatch: (() => void) | undefined;
    let daemonRunning = true;
    win.HTMLImageElement.prototype.decode = () => Promise.resolve();
    win.setTimeout = (fn: () => Promise<void>, ms: number) => {
      delays.push(ms);
      timers.set(delays.length, { fn, ms });
      return delays.length;
    };
    win.clearTimeout = (id: number) => { timers.delete(id); };
    win.isTauri = true;
    win.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    win.__TAURI_INTERNALS__ = {
      transformCallback: (fn: (frame: unknown) => void) => { callbacks.set(++callback, fn); return callback; },
      unregisterCallback() {},
      async invoke(cmd: string, args: { request?: Request; event?: string; handler?: number; onEvent?: { id: number } } = {}) {
        if (cmd === "first_paint") return !startedHidden;
        if (cmd === "plugin:event|listen") { listeners.set(args.event!, args.handler!); return ++callback; }
        if (cmd === "plugin:deep-link|get_current") return null;
        if (cmd === "desktop_presence") return { loginEnabled: true, relocationOffer: false, pinOffer: false, pinMessage: "" };
        if (cmd === "set_connection_state" || cmd === "set_update_notice") return;
        if (cmd === "app_update_receipt") return undefined;
        if (cmd === "app_update_check" || cmd === "app_update_apply") return { phase: "unconfigured" };
        assert.equal(cmd, "daemon_request");
        const req = args.request!;
        calls.push(req);
        const statusResult = {
          state: "ready",
          version: "0.164.15",
          managers: [{ space: "first", state: "answering", instanceId: "m1", connectors: [{ agent: "claude", state: "available" }] }],
          account: { mode: "account", hostSupport: "supported", spaces: [{ space: "first", desired: true, observed: "connected" }] },
        };
        if (req.op === "about") return { v: 1, event: "result", ok: true, result: { machine: "test", version: "0.164.15", platform: "win32", arch: "x64", memoryBytes: 0 } };
        if (req.op === "status") return daemonRunning
          ? { v: 1, event: "result", ok: true, result: statusResult }
          : { v: 1, event: "result", ok: false, error: { code: "NOT_RUNNING", message: "The background service is stopped." } };
        if (req.op === "status-watch") {
          let index = 0;
          pushStatus = (nextStatus) => callbacks.get(args.onEvent!.id)!({ index: index++, message: { v: 1, event: "status", ok: true, watchMode: "push", result: nextStatus } satisfies Frame });
          pushStatus(statusResult);
          return await new Promise<Frame>(resolve => {
            closeWatch = () => resolve({ v: 1, event: "result", ok: true, result: { closed: true } });
          });
        }
        if (req.op === "spaces") return { v: 1, event: "result", ok: true, result: { signedInProviders: ["https://cloud.cotal.ai/api/auth"], spaces: [{ space: "first", label: "First", mode: "user", idp: "https://cloud.cotal.ai/api/auth", catalogId: "sp_first", kind: "team", role: "owner" }] } };
        throw new Error(`Unexpected request ${req.op}`);
      },
    };
    const emit = (event: string) => callbacks.get(listeners.get(event)!)!({ event, payload: null });
    const settle = async () => { for (let i = 0; i < 30; i++) await new Promise<void>((resolve) => setImmediate(resolve)); };
    async function runTimer(ms: number) {
      const entry = [...timers].find(([, timer]) => timer.ms === ms);
      assert.ok(entry, `${ms} ms status timer is armed`);
      timers.delete(entry[0]);
      await entry[1].fn();
      await settle();
    }
    try {
      win.eval(bundle.code);
      await settle();
      assert.equal(doc.documentElement.dataset.watchMode, "push");
      assert.equal(calls.filter(c => c.op === "status-watch").length, 1, "opens one persistent status-watch stream");
      const statusAfterInit = calls.filter(c => c.op === "status").length;
      await runTimer(60_000);
      emit("desktop-hidden");
      await settle();
      emit("desktop-tray-open");
      await settle();
      emit("desktop-shown");
      await settle();
      assert.equal(calls.filter(c => c.op === "status").length, statusAfterInit, "watchActive=true sends zero periodic or visibility status polls");
      pushStatus!({
        state: "ready",
        version: "0.164.15",
        managers: [],
        account: { mode: "account", hostSupport: "supported", spaces: [] },
      });
      await settle();
      assert.equal(doc.getElementById("connection-title")!.textContent, "This computer is connected to your account");

      daemonRunning = false;
      closeWatch!();
      await settle();
      await runTimer(1000);
      assert.equal(calls.filter(c => c.op === "status").length, statusAfterInit + 1);
      daemonRunning = true;
      await runTimer(60_000);
      assert.equal(calls.filter(c => c.op === "status-watch").length, 2, "the minute check reconnects after a slow daemon restart");
    } finally {
      win.close();
    }
  }

  // Version skew cell: older daemon refuses status-watch with UNKNOWN_OP (watchMode: "refused-unknown-op"),
  // app enters VERSION_MISMATCH, repeats one status request every 60 s, and opens status-watch automatically
  // as soon as another process updates the daemon to the matching version without a click.
  {
    const dom = new JSDOM(html, { url: "http://localhost/", pretendToBeVisual: true, runScripts: "outside-only" });
    const win = dom.window;
    const doc = win.document as Document;
    const calls: Request[] = [];
    const delays: number[] = [];
    const callbacks = new Map<number, (frame: unknown) => void>();
    let callback = 0;
    let tickFn: (() => Promise<void>) | undefined;
    let daemonUpgraded = false;
    win.HTMLImageElement.prototype.decode = () => Promise.resolve();
    win.setTimeout = (fn: () => Promise<void>, ms: number) => {
      delays.push(ms);
      tickFn = fn;
      return delays.length;
    };
    win.clearTimeout = () => {};
    win.isTauri = true;
    win.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    win.__TAURI_INTERNALS__ = {
      transformCallback: (fn: (frame: unknown) => void) => { callbacks.set(++callback, fn); return callback; },
      unregisterCallback() {},
      async invoke(cmd: string, args: { request?: Request; onEvent?: { id: number } } = {}) {
        if (cmd === "first_paint") return true;
        if (cmd === "plugin:event|listen") return ++callback;
        if (cmd === "plugin:deep-link|get_current") return null;
        if (cmd === "desktop_presence") return { loginEnabled: true, relocationOffer: false, pinOffer: false, pinMessage: "" };
        if (cmd === "set_connection_state" || cmd === "set_update_notice") return;
        if (cmd === "app_update_receipt") return undefined;
        if (cmd === "app_update_check" || cmd === "app_update_apply") return { phase: "unconfigured" };
        assert.equal(cmd, "daemon_request");
        const req = args.request!;
        calls.push(req);
        const currentVersion = daemonUpgraded ? "0.164.15" : "0.164.14";
        const statusResult = {
          state: "ready",
          version: currentVersion,
          managers: [{ space: "first", state: "answering", instanceId: "m1", connectors: [{ agent: "claude", state: "available" }] }],
          account: { mode: "account", hostSupport: "supported", spaces: [{ space: "first", desired: true, observed: "connected" }] },
        };
        if (req.op === "about") return { v: 1, event: "result", ok: true, result: { machine: "test", version: "0.164.15", platform: "win32", arch: "x64", memoryBytes: 0 } };
        if (req.op === "status") return { v: 1, event: "result", ok: true, result: statusResult };
        if (req.op === "status-watch") {
          if (!daemonUpgraded) {
            return {
              v: 1,
              event: "result",
              ok: false,
              error: {
                code: "VERSION_MISMATCH",
                message: "The running daemon and this app have different versions. Update them together before making changes.",
                native: { code: "UNKNOWN_OP", detail: { watchMode: "refused-unknown-op", appVersion: "0.164.15", daemonVersion: "0.164.14" } },
              },
              result: { status: statusResult },
            } satisfies Frame;
          }
          callbacks.get(args.onEvent!.id)!({ index: 0, message: { v: 1, event: "status", ok: true, watchMode: "push", result: statusResult } satisfies Frame });
          return await new Promise<Frame>(() => {});
        }
        if (req.op === "spaces") return { v: 1, event: "result", ok: true, result: { signedInProviders: ["https://cloud.cotal.ai/api/auth"], spaces: [{ space: "first", label: "First", mode: "user", idp: "https://cloud.cotal.ai/api/auth", catalogId: "sp_first", kind: "team", role: "owner" }] } };
        throw new Error(`Unexpected request ${req.op}`);
      },
    };
    const settle = async () => { for (let i = 0; i < 30; i++) await new Promise<void>((resolve) => setImmediate(resolve)); };
    try {
      win.eval(bundle.code);
      await settle();
      assert.equal(doc.documentElement.dataset.watchMode, "refused-unknown-op");
      assert.equal(doc.getElementById("connection-title")!.textContent, "Cotal was updated");
      assert.equal(delays.at(-1), 60_000, "VERSION_MISMATCH schedules a 60 s status recheck");

      // First 60 s recheck while daemon is still 0.164.14 stays in VERSION_MISMATCH.
      const statusBeforeStillSkewed = calls.filter(c => c.op === "status").length;
      await tickFn!();
      await settle();
      assert.equal(calls.filter(c => c.op === "status").length, statusBeforeStillSkewed + 1);
      assert.equal(doc.getElementById("connection-title")!.textContent, "Cotal was updated");

      // Another process updates the daemon to 0.164.15; next 60 s recheck notices and opens status-watch without a click.
      daemonUpgraded = true;
      await tickFn!();
      await settle();
      assert.equal(doc.documentElement.dataset.watchMode, "push");
      assert.equal(calls.filter(c => c.op === "status-watch").length, 2);
      assert.equal(doc.getElementById("connection-title")!.textContent, "This computer is connected");
    } finally {
      win.close();
    }
  }
});

test("a set-up computer that loses its network stays on its screen and never runs setup", async () => {
  const output = await build({ root: fileURLToPath(new URL("..", import.meta.url)), logLevel: "silent", build: { write: false } });
  assert.ok(!Array.isArray(output) && "output" in output);
  const bundle = output.output.find((file) => file.type === "chunk" && file.isEntry);
  assert.ok(bundle && "code" in bundle);
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8").replace(/<script\b[^>]*><\/script>/g, "");
  const dom = new JSDOM(html, { url: "http://localhost/", pretendToBeVisual: true, runScripts: "outside-only" });
  const win = dom.window;
  const doc = win.document as Document;
  const calls: Request[] = [];
  const tray: Record<string, unknown>[] = [];
  const callbacks = new Map<number, (frame: unknown) => void>();
  let callback = 0;
  let pushStatus: ((status: Record<string, unknown>) => void) | undefined;
  const account = (observed: string) => ({ mode: "account", hostSupport: "supported", spaces: [{ space: "first", desired: true, observed }] });
  const statusFor = (observed: string) => ({ state: "ready", version: "0.164.15", managers: [{ space: "first", state: "answering", instanceId: "m1", connectors: [{ agent: "claude", state: "available" }], ...(observed === "connected" ? {} : { connection: { state: observed, reason: "this computer cannot look up cotal.cloud" } }) }], account: account(observed) });
  win.setTimeout = () => 1;
  win.clearTimeout = () => {};
  win.isTauri = true;
  win.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  win.__TAURI_INTERNALS__ = {
    transformCallback: (fn: (frame: unknown) => void) => { callbacks.set(++callback, fn); return callback; },
    unregisterCallback() {},
    async invoke(cmd: string, args: { request?: Request; label?: string; connected?: boolean; onEvent?: { id: number } } = {}) {
      if (cmd === "first_paint") return true;
      if (cmd === "plugin:event|listen" || cmd === "plugin:deep-link|get_current" || cmd === "desktop_presence" || cmd === "set_update_notice" || cmd === "app_update_receipt" || cmd === "app_update_check" || cmd === "app_update_apply") return cmd === "desktop_presence" ? { loginEnabled: true, relocationOffer: false, pinOffer: false, pinMessage: "" } : cmd === "app_update_check" || cmd === "app_update_apply" ? { phase: "unconfigured" } : null;
      if (cmd === "set_connection_state") { tray.push({ connected: args.connected, label: args.label }); return; }
      assert.equal(cmd, "daemon_request");
      const req = args.request!;
      calls.push(req);
      if (req.op === "about") return { v: 1, event: "result", ok: true, result: { machine: "test", version: "0.164.15", platform: "darwin", arch: "arm64", memoryBytes: 0 } };
      if (req.op === "status") return { v: 1, event: "result", ok: true, result: statusFor("connected") };
      if (req.op === "status-watch") {
        let index = 0;
        pushStatus = (next) => callbacks.get(args.onEvent!.id)!({ index: index++, message: { v: 1, event: "status", ok: true, watchMode: "push", result: next } satisfies Frame });
        pushStatus(statusFor("connected"));
        return await new Promise<Frame>(() => {});
      }
      if (req.op === "spaces") return { v: 1, event: "result", ok: true, result: { signedInProviders: ["https://cloud.cotal.ai/api/auth"], spaces: [{ space: "first", label: "First", mode: "user", idp: "https://cloud.cotal.ai/api/auth", catalogId: "sp_first", kind: "team", role: "owner" }] } };
      throw new Error(`Unexpected request ${req.op}`);
    },
  };
  const settle = async () => { for (let i = 0; i < 30; i++) await new Promise<void>((resolve) => setImmediate(resolve)); };
  try {
    win.eval(bundle.code);
    await settle();
    assert.equal(doc.getElementById("connection-title")!.textContent, "This computer is connected");
    pushStatus!(statusFor("offline"));
    await settle();
    assert.equal(doc.getElementById("connection-title")!.textContent, "No internet connection", "the window names the lost connection");
    assert.equal(doc.getElementById("sidebar-status-word")!.textContent, "Offline", "the sidebar names the lost connection");
    assert.equal(doc.getElementById("sidebar-status-dot")!.dataset.tone, "problem");
    assert.equal(doc.querySelector("#journey")!.closest(".app") ? doc.querySelector(".app")!.classList.contains("later-open") : true, true, "the setup steps stay hidden");
    assert.equal(doc.getElementById("recovery-panel")!.hidden, true, "Try again is not offered for a lost connection");
    assert.deepEqual(tray.at(-1), { connected: false, label: "Offline" }, "the tray tooltip uses the pill's words");
    assert.equal(calls.some(call => call.op === "setup"), false, "losing the network never runs setup");
  } finally { win.close(); }
});

test("another installation's service offers no setup button and no command line", async () => {
  const output = await build({ root: fileURLToPath(new URL("..", import.meta.url)), logLevel: "silent", build: { write: false } });
  assert.ok(!Array.isArray(output) && "output" in output);
  const bundle = output.output.find((file) => file.type === "chunk" && file.isEntry);
  assert.ok(bundle && "code" in bundle);
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8").replace(/<script\b[^>]*><\/script>/g, "");
  const dom = new JSDOM(html, { url: "http://localhost/", pretendToBeVisual: true, runScripts: "outside-only" });
  const win = dom.window;
  const doc = win.document as Document;
  const calls: Request[] = [];
  const callbacks = new Map<number, (frame: unknown) => void>();
  let callback = 0;
  win.setTimeout = () => 1;
  win.clearTimeout = () => {};
  win.isTauri = true;
  win.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  win.__TAURI_INTERNALS__ = {
    transformCallback: (fn: (frame: unknown) => void) => { callbacks.set(++callback, fn); return callback; },
    unregisterCallback() {},
    async invoke(cmd: string, args: { request?: Request; onEvent?: { id: number } } = {}) {
      if (cmd === "first_paint") return true;
      if (cmd === "set_connection_state" || cmd === "set_update_notice") return;
      if (cmd === "plugin:event|listen" || cmd === "plugin:deep-link|get_current" || cmd === "desktop_presence" || cmd === "app_update_receipt" || cmd === "app_update_check" || cmd === "app_update_apply") return cmd === "desktop_presence" ? { loginEnabled: true, relocationOffer: false, pinOffer: false, pinMessage: "" } : cmd === "app_update_check" || cmd === "app_update_apply" ? { phase: "unconfigured" } : null;
      assert.equal(cmd, "daemon_request");
      const req = args.request!;
      calls.push(req);
      const ready = { state: "ready", version: "0.164.15", managers: [{ space: "first", state: "answering", instanceId: "m1", connectors: [{ agent: "claude", state: "available" }] }], account: { mode: "account", hostSupport: "supported", spaces: [{ space: "first", desired: true, observed: "connected" }] } };
      if (req.op === "about") return { v: 1, event: "result", ok: true, result: { machine: "test", version: "0.164.15", platform: "darwin", arch: "arm64", memoryBytes: 0 } };
      if (req.op === "status") return calls.filter(call => call.op === "status").length > 2
        ? { v: 1, event: "result", ok: false, error: { code: "CONFLICT", message: "the background service was set up by another Cotal installation, so this one cannot refresh it", remedy: "run setup from /usr/local/lib/node_modules/cotal-ai/bin/cotal.js" } }
        : { v: 1, event: "result", ok: true, result: ready };
      if (req.op === "status-watch") return await new Promise<Frame>(() => {});
      if (req.op === "spaces") return { v: 1, event: "result", ok: true, result: { signedInProviders: ["https://cloud.cotal.ai/api/auth"], spaces: [{ space: "first", label: "First", mode: "user", idp: "https://cloud.cotal.ai/api/auth", catalogId: "sp_first", kind: "team", role: "owner" }] } };
      throw new Error(`Unexpected request ${req.op}`);
    },
  };
  const settle = async () => { for (let i = 0; i < 40; i++) await new Promise<void>((resolve) => setImmediate(resolve)); };
  try {
    win.eval(bundle.code);
    await settle();
    doc.getElementById("refresh")!.click();
    await settle();
    assert.equal(doc.getElementById("connection-title")!.textContent, "Another Cotal installation runs the background service");
    assert.equal(doc.getElementById("recover")!.hidden, true, "Try again and Connect are not offered");
    assert.equal(/\/usr\/local|bin\/cotal|`/.test(doc.getElementById("refusal-detail")!.textContent ?? ""), false, "Details shows no command line");
    doc.getElementById("recover")!.click();
    await settle();
    assert.equal(calls.filter(call => call.op === "setup").length, 0, "nothing runs setup again");
  } finally { win.close(); }
});

test("a space that is not connected shows its reason and never a command line", async () => {
  const output = await build({ root: fileURLToPath(new URL("..", import.meta.url)), logLevel: "silent", build: { write: false } });
  assert.ok(!Array.isArray(output) && "output" in output);
  const bundle = output.output.find((file) => file.type === "chunk" && file.isEntry);
  assert.ok(bundle && "code" in bundle);
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8").replace(/<script\b[^>]*><\/script>/g, "");
  const dom = new JSDOM(html, { url: "http://localhost/", pretendToBeVisual: true, runScripts: "outside-only" });
  const win = dom.window;
  const doc = win.document as Document;
  const calls: Request[] = [];
  win.setTimeout = () => 1;
  win.clearTimeout = () => {};
  win.isTauri = true;
  win.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  win.__TAURI_INTERNALS__ = {
    transformCallback: () => 1,
    unregisterCallback() {},
    async invoke(cmd: string, args: { request?: Request } = {}) {
      if (cmd === "first_paint") return true;
      if (cmd !== "daemon_request") return cmd === "desktop_presence" ? { loginEnabled: true, relocationOffer: false, pinOffer: false, pinMessage: "" } : cmd === "app_update_check" || cmd === "app_update_apply" ? { phase: "unconfigured" } : null;
      const req = args.request!;
      calls.push(req);
      if (req.op === "about") return { v: 1, event: "result", ok: true, result: { machine: "test", version: "0.164.15", platform: "darwin", arch: "arm64", memoryBytes: 0 } };
      if (req.op === "status") return { v: 1, event: "result", ok: true, result: { state: "ready", version: "0.164.15", managers: [{ space: "first", state: "starting", reason: "the space is not answering", next: "run `cotal daemon status --space first`" }] } };
      if (req.op === "status-watch") return await new Promise<Frame>(() => {});
      if (req.op === "spaces") return { v: 1, event: "result", ok: true, result: { signedInProviders: ["https://example.com/auth"], spaces: [{ space: "first", label: "First", mode: "user", idp: "https://example.com/auth", catalogId: "sp_first", kind: "team", role: "owner" }] } };
      if (req.op === "service-status") return { v: 1, event: "result", ok: true, result: { state: "disconnected" } };
      throw new Error(`Unexpected request ${req.op}`);
    },
  };
  const settle = async () => { for (let i = 0; i < 40; i++) await new Promise<void>((resolve) => setImmediate(resolve)); };
  try {
    win.eval(bundle.code);
    await settle();
    (doc.getElementById("space") as HTMLSelectElement).value = "first";
    doc.getElementById("space")!.dispatchEvent(new win.Event("change"));
    await settle();
    doc.getElementById("refresh")!.click();
    await settle();
    const detail = doc.getElementById("refusal-detail")!.textContent ?? "";
    assert.match(detail, /the space is not answering/, "Details keeps the reason");
    assert.equal(/`|cotal daemon/.test(detail), false, "Details shows no command line");
  } finally { win.close(); }
});
