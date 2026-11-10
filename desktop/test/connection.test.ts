import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import type { Request } from "../src/model.ts";

const { JSDOM } = createRequire(import.meta.url)("jsdom");

test("connection controls follow the selected space across approval, polling and disconnect", async () => {
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
  let tick: (() => Promise<void>) | undefined;
  const heldStatus: { release?: () => void } = {};
  let holdOperation: string | undefined;
  let rejectHeld = false;
  let callback = 0;
  win.setTimeout = (fn: () => Promise<void>, ms: number) => {
    assert.equal(ms, 10_000);
    tick = fn;
    return 1;
  };
  win.clearTimeout = () => { tick = undefined; };
  win.isTauri = true;
  win.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  win.__TAURI_INTERNALS__ = {
    transformCallback: () => ++callback,
    unregisterCallback() {},
    async invoke(cmd: string, args: { request?: Request } = {}) {
      if (cmd === "plugin:event|listen") return ++callback;
      if (cmd === "plugin:deep-link|get_current") return [];
      if (cmd === "plugin:autostart|is_enabled") return false;
      if (cmd === "set_connection_state") return;
      assert.equal(cmd, "daemon_request");
      const req = args.request!;
      calls.push(req);
      let result: Record<string, unknown>;
      switch (req.op) {
        case "about": result = { machine: "test", version: "test", platform: "linux", arch: "x64", memoryBytes: 0 }; break;
        case "status": result = { state: "ready" }; break;
        case "spaces": result = { spaces: ["first", "second"].map((space) => ({ space, mode: "user" })) }; break;
        case "register": result = { outcome: approved ? "registered" : "approval-required" }; break;
        case "service-connect": states.set(req.space!, "connected"); result = { state: "connected" }; break;
        case "service-disconnect": states.set(req.space!, "disconnected"); result = { state: "disconnected" }; break;
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
  const settle = async () => { for (let i = 0; i < 30; i++) await new Promise<void>((resolve) => setImmediate(resolve)); };
  const select = async (space: string) => {
    (doc.getElementById("space") as HTMLSelectElement).value = space;
    doc.getElementById("space")!.dispatchEvent(new win.Event("change"));
    await settle();
  };
  const holdRefresh = async (op = "service-status", fail = false) => {
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
    await select("first");
    button("connect").click();
    await settle();
    assert.equal(title(), "Waiting for owner approval");
    assert.equal(button("connect").disabled, false, "approval can be retried");
    await tick!();
    assert.equal(title(), "Waiting for owner approval");
    await select("second");
    assert.equal(title(), "Disconnected from this space");
    await select("first");
    assert.equal(title(), "Waiting for owner approval");
    approved = true;
    button("connect").click();
    await settle();
    assert.equal(title(), "Connected");
    assert.equal(button("connect").disabled, true);
    const registrations = calls.filter((call) => call.op === "register").length;
    button("connect").click();
    button("connect").dispatchEvent(new win.Event("click"));
    await settle();
    assert.equal(calls.filter((call) => call.op === "register").length, registrations);
    const releaseOldSelection = await holdRefresh();
    assert.equal(title(), "Connected", "poll does not temporarily replace a verified state with local readiness");
    assert.equal(button("connect").disabled, true);
    await select("second");
    assert.equal(button("connect").disabled, false, "another space is not blocked by the connected selection");
    await releaseOldSelection();
    assert.equal(title(), "Disconnected from this space", "late status for the old selection is ignored");
    await select("first");
    assert.equal(button("connect").disabled, true);
    const releaseConnected = await holdRefresh();
    button("disconnect").click();
    await settle();
    assert.equal(title(), "Disconnected from this space");
    assert.equal(button("connect").disabled, false);
    await releaseConnected();
    assert.equal(title(), "Disconnected from this space", "old connected status cannot undo disconnect");
    assert.equal(button("connect").disabled, false, "reconnect stays available");

    const releaseDisconnected = await holdRefresh();
    button("connect").click();
    await settle();
    assert.equal(title(), "Connected");
    await releaseDisconnected();
    assert.equal(title(), "Connected", "old disconnected status cannot undo connect");
    assert.equal(button("connect").disabled, true);
    const afterReconnect = calls.filter((call) => call.op === "register").length;
    button("connect").click();
    button("connect").dispatchEvent(new win.Event("click"));
    await settle();
    assert.equal(calls.filter((call) => call.op === "register").length, afterReconnect);

    const releaseReady = await holdRefresh("status");
    button("disconnect").click();
    await settle();
    const serviceReads = calls.filter((call) => call.op === "service-status").length;
    await releaseReady();
    assert.equal(calls.filter((call) => call.op === "service-status").length, serviceReads, "stale readiness reply cannot continue a refresh");
    assert.equal(title(), "Disconnected from this space");
    button("connect").click();
    await settle();

    for (const op of ["status", "service-status"]) {
      const releaseError = await holdRefresh(op, true);
      button("disconnect").click();
      await settle();
      await releaseError();
      assert.equal(title(), "Disconnected from this space", `stale ${op} failure cannot overwrite disconnect`);
      assert.equal(button("connect").disabled, false, "stale error cannot clear daemon readiness");
      assert.notEqual(doc.getElementById("notice")!.textContent, "Error: delayed status failure");
      button("connect").click();
      await settle();
      assert.equal(title(), "Connected");
    }

    const releaseBeforeReselect = await holdRefresh();
    await select("second");
    states.set("first", "disconnected");
    await select("first");
    assert.equal(title(), "Disconnected from this space");
    await releaseBeforeReselect();
    assert.equal(title(), "Disconnected from this space", "returning to the same space does not revive an old refresh");
    assert.equal(button("connect").disabled, false);
  } finally { win.close(); }
});
