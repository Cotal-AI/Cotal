import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const app = readFileSync(new URL("../src-tauri/src/app.rs", import.meta.url), "utf8");
const launcher = readFileSync(new URL("../src-tauri/src/main.rs", import.meta.url), "utf8");
test("native request diagnostics are debug-only metadata with paired timestamps", () => {
  assert.match(app, /#\[cfg\(all\(feature = "e2e", debug_assertions\)\)\]\nfn trace_native_request/);
  for (const field of ["atUnixMs", "requestId", "elapsedMs", "phase"]) assert.ok(app.includes(`"${field}"`));
  assert.match(app, /home\.join\("native-errors\.jsonl"\)/);
  assert.match(app, /static LOCK: std::sync::Mutex/);
  assert.match(app, /bytes\.push\(b'\\n'\)/);
  assert.match(app, /file\.write_all\(&bytes\)/);
  assert.ok(app.indexOf('LOCK.lock()') < app.indexOf('SystemTime::now()'));
  assert.match(app, /impl Drop for NativeRequestTrace/);
  assert.match(app, /if answer\.is_err\(\) \{ trace\.phase = "timeout"; \}/);
  assert.ok(app.indexOf('trace_native_request(&request, "start"') < app.indexOf('.spawn()'));
  assert.doesNotMatch(app.slice(app.indexOf("fn trace_native_request"), app.indexOf("struct NativeRequestTrace")), /get\("result"\)|get\("data"\)/);
});
test("launcher output context takes priority without rewriting daemon arguments", () => {
  assert.match(launcher, /let trace_home = cotal_desktop::e2e_trace_home\(\)\.or_else/);
  assert.match(launcher, /\.args\(args\)/);
  assert.ok(launcher.indexOf('command.env("COTAL_DESKTOP_E2E_TRACE_HOME", home)') > launcher.indexOf('.env_clear()'));
});
