import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

// Exercise the exact WebDriver injection, including Tauri's non-writable callback API.
const source = readFileSync(new URL("../e2e/first-run.ts", import.meta.url), "utf8");
const script = /if \(process\.platform === "win32"\) await driver\.call\("POST", driver\.path\("execute\/sync"\), \{ script: `([\s\S]*?)`, args: \[\] \}\);/.exec(source)?.[1];
assert.ok(script, "Windows renderer observer injection exists");

test("renderer observer records setup frames without replacing immutable Tauri API", () => {
  const callbacks = new Map<number, (data: unknown) => unknown>();
  const api = { callbacks };
  let next = 0;
  const register = (callback: (data: unknown) => unknown) => {
    callbacks.set(++next, callback);
    return next;
  };
  Object.defineProperty(api, "transformCallback", { value: register });
  const window: Record<string, any> = { __TAURI_INTERNALS__: api };
  assert.equal(runInNewContext(`(function(){${script}})()`, { window, Map, performance }), true);
  const frame = { event: "setup-progress", line: "service: fixture" };
  let received: unknown;
  const id = register(raw => { received = raw; return "original-result"; });
  const envelope = { index: 0, message: frame };
  assert.equal(callbacks.get(id)!(envelope), "original-result");
  assert.equal(received, envelope);
  assert.equal(window.__desktopSetupFrames.length, 1);
  assert.equal(window.__desktopSetupFrames[0].frame, frame);
  assert.equal((api as any).transformCallback, register);
  callbacks.get(id)!({ index: 1, message: { event: "login-prompt" } });
  assert.equal(window.__desktopSetupFrames.length, 1);
  callbacks.delete(id);
  assert.equal(callbacks.has(id), false);
});
