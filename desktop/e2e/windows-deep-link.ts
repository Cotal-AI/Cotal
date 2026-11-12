import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WindowDriver, until } from "./webdriver.js";

assert.equal(process.platform, "win32", "Windows diagnostic requires native Windows");
assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted", "probe requires a disposable runner");
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const output = join(process.env.RUNNER_TEMP ?? tmpdir(), "desktop-windows-deep-link");
mkdirSync(output, { recursive: true });
const root = mkdtempSync(join(tmpdir(), "cotal-public-link-"));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("COTAL_") && !["NODE_OPTIONS", "NODE_PATH"].includes(key.toUpperCase())));
for (const key of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR", "COTAL_HOME"]) {
  env[key] = join(root, key); mkdirSync(env[key]!, { mode: 0o700 });
}
// No product imports, provider, auth stack, or service installation in this probe.
const binary = realpathSync(process.env.DESKTOP_E2E_BINARY ?? join(repo, "desktop/src-tauri/target/debug/cotal-desktop.exe"));
const context = join(dirname(binary), "desktop-e2e.json");
const traceHome = join(root, "trace"); mkdirSync(traceHome, { mode: 0o700 });
const config = JSON.stringify({ env, traceHome });
const link = new URL("cotal://connect");
link.searchParams.set("idp", "http://127.0.0.1:9/api/auth");
link.searchParams.set("space", "e2e-public-link");
assert.equal(link.href, "cotal://connect?idp=http%3A%2F%2F127.0.0.1%3A9%2Fapi%2Fauth&space=e2e-public-link");
class ProbeDriver extends WindowDriver {
  override async call(method: string, path: string, body?: unknown): Promise<any> {
    const response = await fetch(`${this.url}${path}`, { method, signal: AbortSignal.timeout(15_000),
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
    const reply = await response.json() as { value: any };
    if (!response.ok || reply.value?.error) throw new Error(`${method} ${path}: ${JSON.stringify(reply.value)}`);
    return reply.value;
  }
}
const driver = new ProbeDriver(undefined, join(output, "webdriver-launch.jsonl"));
let server: ReturnType<typeof spawn> | undefined;
let ownsConfig = false;
let cleanupSafe = true;
const observations: Record<string, unknown> = { url: link.href, root, outcome: "not-started" };
try {
  writeFileSync(context, config, { flag: "wx", mode: 0o600 }); ownsConfig = true;
  // Use the already matched native driver. Do not download or install a driver here.
  server = spawn(process.env.TAURI_DRIVER ?? "tauri-driver", [], { env: { ...env, USERPROFILE: process.env.USERPROFILE, APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA, COTAL_DESKTOP_E2E_CONTEXT: context }, cwd: env.HOME, stdio: ["ignore", "pipe", "pipe"] });
  let driverError: string | undefined;
  server.on("error", error => { driverError = String(error); });
  await until("native driver ready", async () => {
    if (driverError) throw new Error(driverError);
    return driver.call("GET", "/status");
  }, value => Boolean(value), 20_000);
  await driver.openWindowsLink(binary, link.href, { env: { ...env, USERPROFILE: process.env.USERPROFILE, APPDATA: process.env.APPDATA,
    LOCALAPPDATA: process.env.LOCALAPPDATA, COTAL_DESKTOP_E2E_CONTEXT: context }, cwd: env.HOME!, receipts: join(traceHome, "deep-link-receipts.jsonl") });
  observations.nativeVersion = await until("native about metadata", () => driver.text("version"), value => /^v\d/.test(value), 15_000);
  await driver.screenshot(join(output, "after-launch.png"));
  observations.window = await driver.call("POST", driver.path("execute/sync"), {
    script: "return {title:document.title, linkContext:document.getElementById('link-context')?.textContent ?? null, linkContextVisible:document.getElementById('link-context')?.checkVisibility() ?? false};", args: [],
  });
  observations.pluginCurrent = await driver.call("POST", driver.path("execute/async"), {
    script: "const expected=arguments[0],done=arguments[arguments.length-1]; window.__TAURI_INTERNALS__.invoke('plugin:deep-link|get_current').then(value=>done({ok:true,value:value===null?null:Array.isArray(value)?value.map(v=>v===expected||v==='--'+expected||v==='\\\"'+expected+'\\\"'?v:{redacted:true,bytes:typeof v==='string'?v.length:null}):{unexpectedType:typeof value}}),()=>done({ok:false,error:'plugin invocation failed'}));", args: [link.href],
  });
  const argv = readFileSync(join(traceHome, "deep-link-receipts.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line)).filter(row => row.source === "process-argv");
  assert.equal(argv.length, 1, "one owned diagnostic process argv receipt");
  assert.equal(argv[0].publicProbeShapes?.length, 1);
  assert.equal(argv[0].publicProbeShapes[0].publicProbeForm, "literal", "diagnostic proves plain public URL delivery");
  assert.equal(argv[0].publicProbeShapes[0].publicArgument, link.href);
  assert.deepEqual(observations.pluginCurrent, { ok: true, value: [link.href] }, "plain URL must reach the deep-link plugin");
  await until("plain public link context visible", () => driver.displayed("link-context"), Boolean, 15_000);
  observations.window = await driver.call("POST", driver.path("execute/sync"), {
    script: "return {title:document.title, linkContext:document.getElementById('link-context')?.textContent ?? null, linkContextVisible:document.getElementById('link-context')?.checkVisibility() ?? false};", args: [],
  });
  assert.equal((observations.window as { linkContextVisible: boolean }).linkContextVisible, true, "plain delivery without link context is a product failure");
  observations.outcome = "plain-delivery-pass";
} catch (error) {
  observations.outcome = "probe-error"; observations.error = String(error);
  process.exitCode = 1;
} finally {
  try { await driver.close(); } catch (error) { observations.sessionCleanupError = String(error); cleanupSafe = false; process.exitCode = 1; }
  if (server && server.exitCode === null && server.signalCode === null) {
    server.kill();
    try { await until("owned driver exits", async () => server!.exitCode !== null || server!.signalCode !== null, Boolean, 10_000); }
    catch (error) { observations.driverCleanupError = String(error); cleanupSafe = false; process.exitCode = 1; }
  }
  try {
    if (ownsConfig && cleanupSafe) {
      assert.equal(readFileSync(context, "utf8"), config, "remove only this probe's unchanged config");
      unlinkSync(context);
    }
  } catch (error) { observations.configCleanupError = String(error); process.exitCode = 1; }
  const receipts = join(traceHome, "deep-link-receipts.jsonl");
  if (existsSync(receipts)) copyFileSync(receipts, join(output, "deep-link-receipts.jsonl"));
  observations.receiptsPresent = existsSync(receipts);
  writeFileSync(join(output, "result.json"), JSON.stringify(observations, null, 2));
  console.log(JSON.stringify(observations, null, 2));
}
