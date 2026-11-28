import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import type { Frame, Request } from "../src/model.ts";

const { JSDOM } = createRequire(import.meta.url)("jsdom");

test("a silent status watch is rechecked, not trusted forever", async () => {
  const output = await build({ root: fileURLToPath(new URL("..", import.meta.url)), logLevel: "silent", build: { write: false } });
  assert.ok(!Array.isArray(output) && "output" in output);
  const bundle = output.output.find((file) => file.type === "chunk" && file.isEntry);
  assert.ok(bundle && "code" in bundle);
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8").replace(/<script\b[^>]*><\/script>/g, "");
  const dom = new JSDOM(html, { url: "http://localhost/", pretendToBeVisual: true, runScripts: "outside-only" });
  const win = dom.window;
  const doc = win.document as Document;
  const calls: Request[] = [];
  const timers = new Map<number, { fn: () => Promise<void>; ms: number }>();
  const callbacks = new Map<number, (frame: unknown) => void>();
  const listeners = new Map<string, number>();
  let callback = 0;
  let pushStatus: ((status: Record<string, unknown>) => void) | undefined;
  let pushesEnabled = true;
  win.HTMLImageElement.prototype.decode = () => Promise.resolve();
  win.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  Object.defineProperty(win.document, "adoptedStyleSheets", { get: () => [], set: () => {}, configurable: true });
  win.setTimeout = (fn: () => Promise<void>, ms: number) => { timers.set(ms, { fn, ms }); return ms; };
  const nativeClearTimeout = win.clearTimeout.bind(win);
  win.clearTimeout = (id: number) => { nativeClearTimeout(id); timers.delete(id); };
  win.isTauri = true;
  win.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  win.__TAURI_INTERNALS__ = {
    transformCallback: (fn: (frame: unknown) => void) => { callbacks.set(++callback, fn); return callback; },
    unregisterCallback() {},
    async invoke(cmd: string, args: { request?: Request; event?: string; handler?: number; onEvent?: { id: number } } = {}) {
      if (cmd === "first_paint") return true;
      if (cmd === "plugin:event|listen") { listeners.set(args.event!, args.handler!); return ++callback; }
      if (cmd === "plugin:deep-link|get_current") return null;
      if (cmd === "desktop_presence") return { loginEnabled: true, relocationOffer: false, pinOffer: false, pinMessage: "" };
      if (cmd === "set_connection_state" || cmd === "set_update_notice") return;
      if (cmd === "app_update_receipt") return undefined;
      if (cmd === "app_update_check" || cmd === "app_update_apply") return { phase: "unconfigured" };
      assert.equal(cmd, "daemon_request");
      const req = args.request!;
      calls.push(req);
      const statusResult = { state: "ready", version: "0.164.15", managers: [{ space: "first", state: "answering", instanceId: "m1", connectors: [{ state: "available" }] }], account: { mode: "account", hostSupport: "supported", spaces: [{ space: "first", desired: true, observed: "connected" }] } };
      if (req.op === "about") return { v: 1, event: "result", ok: true, result: { machine: "test", version: "0.164.15", platform: "win32", arch: "x64", memoryBytes: 0 } };
      if (req.op === "status") return { v: 1, event: "result", ok: true, result: statusResult };
      if (req.op === "status-watch") {
        let index = 0;
        pushStatus = (nextStatus) => callbacks.get(args.onEvent!.id)!({ index: index++, message: { v: 1, event: "status", ok: true, watchMode: "push", result: nextStatus } satisfies Frame });
        pushStatus(statusResult);
        return await new Promise<Frame>(() => {}); // The stream stays open and never answers.
      }
      if (req.op === "spaces") return { v: 1, event: "result", ok: true, result: { signedInProviders: ["https://cloud.cotal.ai/api/auth"], spaces: [{ space: "first", label: "First", mode: "user", idp: "https://cloud.cotal.ai/api/auth", catalogId: "sp_first", kind: "team", role: "owner" }] } };
      throw new Error(`Unexpected request ${req.op}`);
    },
  };
  const settle = async () => { for (let i = 0; i < 30; i++) await new Promise<void>((resolve) => setImmediate(resolve)); };
  const runTimer = async (ms: number) => { const entry = timers.get(ms); assert.ok(entry, `${ms} ms timer is armed`); timers.delete(ms); await entry.fn(); await settle(); };
  try {
    win.eval(bundle.code);
    await settle();
    assert.equal(doc.documentElement.dataset.watchMode, "push");
    assert.equal(calls.filter(c => c.op === "status-watch").length, 1);
    const statusAfterInit = calls.filter(c => c.op === "status").length;

    // The watch pushes only on change: a live, idle daemon sends nothing. The stream itself
    // may also have died without a word. Silence must never be trusted as "still current":
    // within one keepalive window a status recheck must run and the watch re-establish.
    pushesEnabled = false;
    const watches = () => calls.filter(c => c.op === "status-watch").length;
    const watchesAfterSilence = watches();
    await runTimer(30_000); // watch keepalive expiry: the silent stream is presumed dead
    await runTimer(60_000); // the recheck's idle poll
    assert.ok(calls.filter(c => c.op === "status").length > statusAfterInit, "a silent watch must trigger a status recheck within two idle polls");
    assert.ok(watches() > watchesAfterSilence, "the watch must be re-established after the recheck");
    assert.equal(doc.documentElement.dataset.watchMode, "push");
  } finally { win.close(); }
});
