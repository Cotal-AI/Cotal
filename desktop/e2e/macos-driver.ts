import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { appendFile, writeFile } from "node:fs/promises";
import { until } from "./webdriver.js";

const execute = promisify(execFile);
const helper = fileURLToPath(new URL("./macos-driver.swift", import.meta.url));

/** Native AX/CGEvent driver. Requires a logged-in macOS desktop and Accessibility permission. */
export class MacOSDriver {
  private child?: ChildProcess;
  private launchError?: Error;
  private launchEnv: NodeJS.ProcessEnv;
  session?: string;
  constructor(readonly env: NodeJS.ProcessEnv = process.env) { this.launchEnv = env; }
  private alive(): number {
    assert.ifError(this.launchError);
    assert.ok(this.child?.pid && this.child.exitCode === null && this.child.signalCode === null, "owned app is alive");
    return this.child.pid;
  }
  private async command<T>(operation: string, ...args: string[]): Promise<T> {
    const pid = this.alive();
    let stderr = "";
    try {
      const result = await execute("/usr/bin/swift", [helper, String(pid), operation, ...args], {
        env: this.launchEnv, timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
      });
      stderr = result.stderr;
      if (operation !== "quit") this.alive();
      return JSON.parse(result.stdout) as T;
    } catch (error) {
      try { if (typeof (error as { stderr?: unknown })?.stderr === "string") stderr = (error as { stderr: string }).stderr; }
      catch { /* Preserve the original native failure if diagnostic metadata is unreadable. */ }
      throw error;
    } finally {
      const nativeLog = this.launchEnv.COTAL_DESKTOP_E2E_NATIVE_LOG;
      if (operation === "disable-login" && nativeLog) {
        const prefix = "macOS driver login diagnostic: ";
        const receipts = stderr.split(/\r?\n/).filter(line => line.startsWith(prefix)).map(line => line.slice(prefix.length));
        if (receipts.length) await appendFile(join(dirname(nativeLog), "macos-login-input.jsonl"), `${receipts.join("\n")}\n`, { mode: 0o600 })
          .catch(() => console.error("macOS login input receipt unavailable"));
      }
    }
  }
  async open(application: string, args: string[] = [], env: NodeJS.ProcessEnv = this.env, cwd?: string): Promise<void> {
    assert.equal(process.platform, "darwin", "MacOSDriver requires macOS");
    assert.ok(!this.child, "close the owned app before reopening");
    // Launch the bundle executable directly so ownership never depends on pgrep or a shared bundle ID.
    const binary = application.endsWith(".app") ? join(application, "Contents/MacOS/cotal-desktop") : application;
    this.launchError = undefined;
    this.launchEnv = env;
    this.child = spawn(resolve(binary), args, { env, cwd, stdio: "ignore" });
    this.child.once("error", error => { this.launchError = error; });
    this.session = String(this.child.pid);
    await until("owned macOS application", () => this.command<boolean>("ready"), Boolean, 45_000);
  }
  async text(id: string): Promise<string> { return this.command("text", id); }
  async displayed(id: string): Promise<boolean> { return this.command("displayed", id); }
  async enabled(id: string): Promise<boolean> { return this.command("enabled", id); }
  async click(id: string): Promise<void> {
    await until(`${id} actionable`, async () => await this.displayed(id) && await this.enabled(id), Boolean);
    await this.command("click", id);
  }
  async clickTestId(id: string): Promise<void> { await this.command("click-test-id", id); }
  async testIdAttributes(id: string, attribute: string): Promise<string[]> {
    assert.match(attribute, /^data-[a-z-]+$/);
    return this.command("test-id-attributes", id, attribute);
  }
  async fill(id: string, text: string): Promise<void> { await this.command("fill", id, text); }
  async enter(id: string): Promise<void> { await this.command("enter", id); }
  async select(id: string, value: string): Promise<void> { await this.command("select", id, value); }
  async screenshot(path: string): Promise<void> { await this.command("screenshot", resolve(path)); }
  /** Save the owned PID's native AX tree without activating the app or evaluating JavaScript. */
  async dump(path: string): Promise<void> {
    const tree = await this.command<{ pid: number; nodes: Record<string, unknown>[] }>("ax-dump");
    await writeFile(resolve(path), `${JSON.stringify(tree, null, 2)}\n`, "utf8");
  }
  async native(action: "describe" | "close-window" | "settings" | "quit" | "login-entry" | "settings-back" | "disable-login"): Promise<{ pid: number; visible: boolean; path?: string; args?: string[]; source?: string; title?: string; label?: string }> {
    const result = await this.command<{ pid: number; visible: boolean; path?: string; args?: string[]; source?: string; title?: string; label?: string }>(action);
    if (action === "quit") {
      await until("owned macOS app quits", async () => this.child!.exitCode !== null || this.child!.signalCode !== null, Boolean, 15_000);
    }
    return result;
  }
  async closeWindow(): Promise<void> { await this.native("close-window"); }
  async openSettings(): Promise<void> { await this.command("settings"); }
  /** Does not activate or show the application, suitable after open(..., ["--background"]). */
  async windowVisible(): Promise<boolean> { return this.command("window-visible"); }
  async quit(): Promise<void> {
    if (!this.child) return;
    if (this.child.exitCode === null && this.child.signalCode === null) {
      await this.native("quit");
    }
    this.child = undefined;
    this.session = undefined;
  }
  async close(): Promise<void> { await this.quit(); }
}

export { MacOSDriver as WindowDriver, MacOSDriver as MacWindowDriver };
