import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { COTAL_CLOUD_IDP, type Frame, type Request } from "../src/model.ts";

const { JSDOM } = createRequire(import.meta.url)("jsdom");
const settle = async () => { for (let i = 0; i < 25; i++) await new Promise<void>(resolve => setImmediate(resolve)); };
const bundle = build({ root: fileURLToPath(new URL("..", import.meta.url)), logLevel: "silent", build: { write: false } }).then(output => {
  assert.ok(!Array.isArray(output) && "output" in output);
  const entry = output.output.find(file => file.type === "chunk" && file.isEntry);
  assert.ok(entry && "code" in entry); return entry.code;
});
async function app(options: { link?: string; installed?: boolean; connected?: boolean; count?: number; serviceState?: string } = {}) {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8").replace(/<script\b[^>]*><\/script>/g, "");
  const dom = new JSDOM(html, { url: "http://localhost/", pretendToBeVisual: true, runScripts: "outside-only" });
  const win = dom.window, doc = win.document as Document;
  const calls: Request[] = [], urls: string[] = [];
  const callbacks = new Map<number, (frame: unknown) => void>(); let next = 0;
  let installed = options.installed ?? false, connected = options.connected ?? false;
  let releaseLogin: (() => void) | undefined, releaseSetup: (() => void) | undefined;
  const manager = { space: "team", state: "answering", instanceId: "instance", connectors: [{ state: "available" }] };
  win.setTimeout = () => 1; win.clearTimeout = () => {};
  win.isTauri = true;
  win.__TAURI_INTERNALS__ = {
    transformCallback(fn: (frame: unknown) => void) { callbacks.set(++next, fn); return next; }, unregisterCallback() {},
    async invoke(cmd: string, args: { request?: Request; url?: string; onEvent?: { id: number } } = {}) {
      if (cmd === "plugin:deep-link|get_current") return options.link ? [options.link] : null;
      if (cmd === "plugin:event|listen") return ++next;
      if (cmd === "plugin:autostart|is_enabled") return false;
      if (cmd === "set_connection_state") return;
      if (cmd === "open_browser") { urls.push(args.url!); return; }
      assert.equal(cmd, "daemon_request"); const r = args.request!; calls.push(r);
      const ok = (result: Record<string, unknown>): Frame => ({ v: 1, event: "result", ok: true, result });
      const send = (frame: Frame, index: number) => callbacks.get(args.onEvent!.id)!({ message: frame, index });
      if (r.op === "about") return ok({ version: "test", machine: "My computer", platform: "darwin", arch: "arm64", memoryBytes: 36 * 1024 ** 3 });
      if (r.op === "install") { installed = true; return ok({ installed: true }); }
      if (!installed) return { v: 1, event: "result", ok: false, error: { code: "NOT_RUNNING", message: "The daemon is not running. Install its background service first." } } satisfies Frame;
      if (r.op === "status") return ok({ state: "ready", version: "test", managers: connected ? [manager] : [] });
      if (r.op === "spaces") return ok({ spaces: Array.from({ length: options.count ?? 1 }, (_, i) => ({ space: i ? "other" : "team", catalogId: i ? "sp_other" : "sp_team", label: i ? "Other team" : "My team", mode: "user", idp: COTAL_CLOUD_IDP })) });
      if (r.op === "service-status") return ok({ state: options.serviceState ?? "disconnected" });
      if (r.op === "login") {
        send({ v: 1, event: "login-prompt", prompt: { verificationUriComplete: "https://example.com/device?user_code=ABCD", userCode: "ABCD", expiresAt: "2026-11-10T18:00:00Z" } }, 0);
        await new Promise<void>(resolve => { releaseLogin = resolve; }); return ok({ outcome: "signed-in" });
      }
      if (r.op === "setup") {
        const metadata = [
          { step: "install", outcome: "ready", detail: "service" },
          { step: "sign-in", outcome: "already-signed-in", detail: "session" },
          { step: "discover", outcome: "registered", detail: "space" },
          { step: "manager", outcome: "running", detail: "application check" },
        ] as const;
        metadata.forEach((progress, i) => send({ v: 1, event: "setup-progress", line: `opaque diagnostic ${i}`, progress }, i));
        await new Promise<void>(resolve => { releaseSetup = resolve; }); connected = true;
        return ok({ launchReady: true, manager });
      }
      throw new Error(`Unexpected ${r.op}`);
    },
  };
  win.eval(await bundle); await settle();
  const node = <T extends HTMLElement = HTMLElement>(id: string) => doc.getElementById(id) as T;
  const click = async (id: string) => { node<HTMLButtonElement>(id).click(); await settle(); };
  return { dom, doc, node, click, calls, urls, login: async () => { assert.ok(releaseLogin); releaseLogin(); await settle(); }, setup: async () => { assert.ok(releaseSetup); releaseSetup(); await settle(); } };
}

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

test("linked first run needs sign-in approval then connect, with one panel and structured progress", async () => {
  const a = await app({ link: `cotal://connect?idp=${encodeURIComponent(COTAL_CLOUD_IDP)}&space=sp_team`, count: 2 });
  try {
    assert.match(a.node("link-context").textContent!, /sp_team.*cloud.cotal.ai/);
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
    await a.click("dashboard"); assert.equal(a.urls.at(-1), "https://cloud.cotal.ai/machines?space=sp_team&machine=instance");
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
      assert.equal(a.node("connect-panel").hidden, count !== 1);
      if (count === 2) {
        a.node<HTMLSelectElement>("space").value = "other";
        a.node("space").dispatchEvent(new a.dom.window.Event("change")); await settle();
        await a.click("choose-space"); assert.equal(a.node("connect-panel").hidden, false);
      }
    } finally { a.dom.window.close(); }
  }
});

test("later open shows connection and secondary controls, never sign-in or space forms", async () => {
  const a = await app({ installed: true, connected: true, count: 2 });
  try {
    assert.equal(a.node("connection-title").textContent, "This computer is connected");
    assert.equal(a.node("connected-panel").hidden, false); assert.equal(a.node("preferences").hidden, false);
    assert.equal(a.node("sign-in-panel").hidden, true); assert.equal(a.node("space-panel").hidden, true);
    assert.ok(a.doc.querySelector(".app.later-open"));
    await a.click("another-space"); assert.equal(a.node("space-panel").hidden, false);
    await a.click("choose-space"); assert.equal(a.node("connected-panel").hidden, false);
    await a.click("sign-in-again"); assert.equal(a.node("sign-in-panel").hidden, false);
  } finally { a.dom.window.close(); }
});

test("unknown and service-only states cannot claim launch readiness", async () => {
  for (const serviceState of ["connected", "unknown-new-state"]) {
    const a = await app({ installed: true, serviceState });
    try { assert.equal(a.node("connected-panel").hidden, true); assert.equal(a.node<HTMLButtonElement>("dashboard").disabled, true); }
    finally { a.dom.window.close(); }
  }
});
