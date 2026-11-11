import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "vite";
const { JSDOM } = createRequire(import.meta.url)("jsdom");
const settle = async () => { for (let i = 0; i < 25; i++) await new Promise<void>(resolve => setImmediate(resolve)); };

test("presence offers are explicit, dismissible, one-time and use no renderer paths", async () => {
  const output = await build({ logLevel: "silent", configFile: false, build: { write: false, lib: { entry: fileURLToPath(new URL("../src/presence.ts", import.meta.url)), formats: ["iife"], name: "presence" } } });
  const result = Array.isArray(output) ? output[0] : output;
  assert.ok("output" in result);
  const chunk = result.output.find(file => file.type === "chunk"); assert.ok(chunk && "code" in chunk);
  const dom = new JSDOM('<main><div class="connection-card"></div><section id="preferences"><input id="autostart" type="checkbox"></section></main>', { runScripts: "outside-only", url: "http://localhost" });
  const doc = dom.window.document as Document;
  const calls: { cmd: string; args: unknown }[] = [];
  const notices: string[] = [];
  dom.window.__TAURI_INTERNALS__ = {
    transformCallback: () => 1,
    async invoke(cmd: string, args: unknown) {
      calls.push({ cmd, args: args === undefined ? undefined : JSON.parse(JSON.stringify(args)) });
      if (cmd === "plugin:event|listen") return 1;
      if (cmd === "desktop_presence") return { loginEnabled: true, relocationOffer: true, pinOffer: true, pinMessage: "" };
      if (cmd === "dismiss_presence_offer" || cmd === "set_login_preference") return;
      if (cmd === "pin_to_taskbar") return false;
      throw new Error(`Unexpected command ${cmd}`);
    },
  };
  try {
    dom.window.eval(chunk.code + ";globalThis.presence = presence;");
    const api = dom.window.presence;
    await api.startPresence((message: string) => notices.push(message));
    assert.equal(doc.querySelector<HTMLInputElement>("#autostart")!.checked, true);
    assert.ok(doc.querySelector("#move-offer"));
    assert.ok(!calls.some(call => call.cmd === "move_to_applications"));
    (doc.querySelectorAll<HTMLButtonElement>("#move-offer button")[1]).click(); await settle();
    assert.deepEqual(calls.find(call => call.cmd === "dismiss_presence_offer")?.args, { offer: "relocation" });
    await api.refreshPresence(true);
    assert.ok(doc.querySelector("#pin-offer"));
    assert.ok(!calls.some(call => call.cmd === "pin_to_taskbar"));
    (doc.querySelector<HTMLButtonElement>("#pin-offer button")!).click(); await settle();
    assert.match(notices.at(-1)!, /did not pin/);
    await api.refreshPresence(true);
    assert.equal(doc.querySelector("#pin-offer"), null);
    assert.equal(doc.querySelector("#move-offer"), null);
    await api.setLoginPreference(false);
    assert.deepEqual(calls.find(call => call.cmd === "set_login_preference")?.args, { enabled: false });
  } finally { dom.window.close(); }
});

test("presence configuration narrows renderer grants and keeps platform identity consistent", () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
  const config = JSON.parse(read("../src-tauri/tauri.conf.json"));
  assert.equal(config.identifier, "ai.cotal.desktop");
  assert.equal(config.app.windows[0].skipTaskbar, false);
  assert.ok(config.bundle.macOS.dmg.appPosition.x < config.bundle.macOS.dmg.applicationFolderPosition.x);
  const grants = JSON.parse(read("../src-tauri/capabilities/default.json")).permissions;
  assert.ok(!grants.some((grant: string) => /autostart|shell|fs:/.test(grant)));
  const wix = read("../src-tauri/installers/main.wxs");
  assert.equal([...wix.matchAll(/ShortcutProperty Key="System.AppUserModel.ID"/g)].length, 2);
  assert.match(wix, /CustomAction Id="RemoveCotalLogin"[^>]*ExeCommand="--remove-login"/);
  assert.match(wix, /Before="RemoveFiles">REMOVE = "ALL" AND NOT UPGRADINGPRODUCTCODE/);
});
