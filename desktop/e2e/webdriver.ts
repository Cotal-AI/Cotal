import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export async function until<T>(name: string, read: () => Promise<T>, accept: (value: T) => boolean, ms = 90_000): Promise<T> {
  const deadline = Date.now() + ms;
  let last: unknown;
  do {
    try { const value = await read(); if (accept(value)) return value; last = value; }
    catch (error) { last = String(error); }
    await delay(250);
  } while (Date.now() < deadline);
  throw new Error(`${name} timed out: ${JSON.stringify(last)}`);
}

/** Small W3C client. Tests interact through native WebDriver, never invoke stubs. */
export class WindowDriver {
  session?: string;
  private application?: ChildProcess;
  constructor(readonly url = "http://127.0.0.1:4444", readonly launchLog?: string) {}
  private receipt(value: Record<string, unknown>): void {
    if (this.launchLog) writeFileSync(this.launchLog, `${JSON.stringify({ at: new Date().toISOString(), ...value })}\n`, { flag: "a", mode: 0o600 });
  }
  async call(method: string, path: string, body?: unknown, timeoutMs = 120_000): Promise<any> {
    const response = await fetch(`${this.url}${path}`, { method, signal: AbortSignal.timeout(timeoutMs),
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
    const reply = await response.json() as { value: any };
    if (!response.ok || reply.value?.error) throw new Error(`${method} ${path}: ${JSON.stringify(reply.value)}`);
    return reply.value;
  }
  async open(application: string, args: string[] = []): Promise<void> {
    const capabilities = { alwaysMatch: { "tauri:options": { application, args } } };
    this.receipt({ source: "webdriver-session-request", capabilities: { alwaysMatch: { "tauri:options": { application, args: args.map(argumentShape) } } } });
    await this.startSession(capabilities);
  }
  private async startSession(capabilities: object): Promise<void> {
    assert.ok(!this.session, "close the previous native session before opening another");
    const result = await this.call("POST", "/session", { capabilities });
    this.session = result.sessionId;
    assert.ok(this.session, "native WebDriver returned a session");
    await this.call("POST", this.path("timeouts"), { implicit: 0, script: 10_000, pageLoad: 60_000 });
  }
  async attachWindows(port: number): Promise<void> {
    assert.ok(Number.isInteger(port) && port > 0 && port < 65536, "valid loopback debugger port");
    // tauri-driver forwards native capabilities unchanged when tauri:options is absent:
    // https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-driver/src/server.rs
    const capabilities = windowsAttachCapabilities(port);
    this.receipt({ source: "webdriver-session-request", capabilities });
    await this.startSession(capabilities);
  }
  /** Start only the pinned test binary with a plain protocol argument, then attach to its WebView2. */
  async openWindowsLink(application: string, link: string, options: { env: NodeJS.ProcessEnv; cwd: string; receipts: string }): Promise<void> {
    assert.equal(process.platform, "win32", "plain WebView2 launch requires Windows");
    assert.ok(options.env.SystemRoot, "Windows listener verification requires SystemRoot");
    assert.ok(!this.application && !this.session, "previous owned application must be closed");
    const parsed = new URL(link);
    assert.ok(parsed.protocol === "cotal:" && parsed.hostname === "connect" && !parsed.username && !parsed.password && !parsed.port && ["", "/"].includes(parsed.pathname), "plain connect URL required");
    const binary = realpathSync(application);
    const receiptOffset = existsSync(options.receipts) ? statSync(options.receipts).size : 0;
    const reservation = createServer();
    await new Promise<void>((resolve, reject) => { reservation.once("error", reject); reservation.listen(0, "127.0.0.1", resolve); });
    const address = reservation.address(); assert.ok(address && typeof address !== "string");
    const port = address.port;
    await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
    // Microsoft documents external launch + remote-debugging-port + DebuggerAddress:
    // https://learn.microsoft.com/en-us/microsoft-edge/webview2/how-to/webdriver#step-4b-attaching-microsoft-edge-webdriver-to-a-running-webview2-app
    // Do not pass URLs through Edge's switch-oriented ms:edgeOptions.args.
    this.receipt({ source: "plain-launch-request", application: binary, args: [argumentShape(link)], capabilities: windowsAttachCapabilities(port) });
    const started = Date.now();
    const child = this.application = spawn(binary, [link], { cwd: options.cwd, env: { ...options.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1` }, stdio: "ignore", windowsHide: false });
    let launchError = false;
    child.once("error", () => { launchError = true; });
    await until("owned app plain process argument", async () => {
      assert.ok(!launchError && child.pid && child.exitCode === null && child.signalCode === null, "owned application must stay alive");
      if (!existsSync(options.receipts)) return false;
      assert.ok(statSync(options.receipts).size <= 1024 * 1024, "bounded native argument receipts");
      let rows: any[];
      try { rows = readFileSync(options.receipts).subarray(receiptOffset).toString("utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); }
      catch { throw new Error("native argument receipts are incomplete or invalid"); }
      const row = rows.find(row => row.source === "process-argv" && row.pid === child.pid && row.atUnixMs >= started && row.atUnixMs <= Date.now());
      if (!row) return false;
      this.receipt({ source: "owned-process-argv", pid: child.pid, application: binary, args: row.publicProbeShapes?.map((shape: any) => ({ bytes: typeof shape.bytes === "number" ? shape.bytes : null,
        leadingDashes: shape.leadingDashes === true, publicProbeForm: ["literal", "leading-dashes", "quoted", "other"].includes(shape.publicProbeForm) ? shape.publicProbeForm : "unknown" })) });
      assert.equal(row.values?.length, 1, "owned app receives one URL argument");
      assert.ok(row.values[0]?.url === "cotal://connect", "native argv contains a plain connect URL");
      assert.equal(row.publicProbeShapes?.length, 1);
      assert.equal(row.publicProbeShapes[0].bytes, Buffer.byteLength(link));
      assert.equal(row.publicProbeShapes[0].leadingDashes, false, "native argv must not have Edge switch dashes");
      return true;
    }, Boolean, 30_000);
    await until("owned WebView2 debugger ready", async () => {
      assert.ok(child.exitCode === null && child.signalCode === null, "owned application must stay alive");
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
      return response.ok;
    }, Boolean, 20_000);
    // The ephemeral-port reservation has a release/launch gap. Refuse attachment unless
    // the listening PID is a descendant of this exact owned application, not another app.
    const listener = await verifyWindowsDebuggerOwner(port, child.pid!, started, binary, options.env);
    assert.ok(child.exitCode === null && child.signalCode === null, "owned app is alive before attach");
    this.receipt({ source: "debugger-owner-verified", pid: child.pid, port, ...listener });
    await this.attachWindows(port);
  }
  path(path: string): string { assert.ok(this.session); return `/session/${this.session}/${path}`; }
  async element(id: string): Promise<string> {
    assert.match(id, /^[a-z][a-z0-9-]*$/);
    const result = await this.call("POST", this.path("element"), { using: "css selector", value: `#${id}` });
    return result["element-6066-11e4-a52e-4f735466cecf"];
  }
  async text(id: string): Promise<string> { return this.call("GET", this.path(`element/${await this.element(id)}/text`)); }
  async textContent(id: string): Promise<string> {
    assert.match(id, /^[a-z][a-z0-9-]*$/);
    return this.call("POST", this.path("execute/sync"), {
      script: "const matches=document.querySelectorAll('#'+arguments[0]); if(matches.length!==1) throw new Error('stable ID must name one element'); const e=matches[0]; if(!e.checkVisibility()) throw new Error('stable ID must be visible'); return e.textContent;",
      args: [id],
    });
  }
  async displayed(id: string): Promise<boolean> { return this.call("GET", this.path(`element/${await this.element(id)}/displayed`)); }
  async enabled(id: string): Promise<boolean> { return this.call("GET", this.path(`element/${await this.element(id)}/enabled`)); }
  async click(id: string, deadlineUnixMs?: number): Promise<void> {
    if (deadlineUnixMs !== undefined) {
      assert.match(id, /^[a-z][a-z0-9-]*$/);
      const remaining = () => { const ms = deadlineUnixMs - Date.now(); assert.ok(ms > 0, "native input deadline elapsed"); return ms; };
      const result = await this.call("POST", this.path("element"), { using: "css selector", value: `#${id}` }, remaining());
      const key = result["element-6066-11e4-a52e-4f735466cecf"];
      assert.equal(await this.call("GET", this.path(`element/${key}/displayed`), undefined, remaining()), true);
      assert.equal(await this.call("GET", this.path(`element/${key}/enabled`), undefined, remaining()), true);
      await this.call("POST", this.path(`element/${key}/click`), {}, remaining());
      return;
    }
    await until(`${id} actionable`, async () => await this.displayed(id) && await this.enabled(id), Boolean);
    await this.call("POST", this.path(`element/${await this.element(id)}/click`), {});
  }
  async clickTestId(id: string): Promise<void> {
    assert.match(id, /^[a-z][a-z0-9-]*$/);
    const element = await until(`${id} actionable`, async () => {
      const values = await this.call("POST", this.path("elements"), { using: "css selector", value: `[data-testid="${id}"]` });
      assert.equal(values.length, 1, "test ID names one owned control");
      const key = values[0]["element-6066-11e4-a52e-4f735466cecf"];
      return await this.call("GET", this.path(`element/${key}/displayed`)) && await this.call("GET", this.path(`element/${key}/enabled`)) ? key as string : undefined;
    }, Boolean);
    await this.call("POST", this.path(`element/${element}/click`), {});
  }
  async testIdAttributes(id: string, attribute: string): Promise<string[]> {
    assert.match(id, /^[a-z][a-z0-9-]*$/); assert.match(attribute, /^data-[a-z-]+$/);
    const values = await this.call("POST", this.path("elements"), { using: "css selector", value: `[data-testid="${id}"]` });
    return Promise.all(values.map((value: Record<string, string>) => this.call("GET", this.path(`element/${value["element-6066-11e4-a52e-4f735466cecf"]}/attribute/${attribute}`))));
  }
  async fill(id: string, text: string): Promise<void> {
    const element = await this.element(id);
    await this.call("POST", this.path(`element/${element}/clear`), {});
    await this.call("POST", this.path(`element/${element}/value`), { text });
  }
  async enter(id: string): Promise<void> {
    await this.call("POST", this.path(`element/${await this.element(id)}/value`), { text: "\uE007" });
  }
  async select(id: string, value: string): Promise<void> {
    // The only script sets the value of the stable-ID native select and dispatches its user event.
    await this.call("POST", this.path("execute/sync"), { script: "const e=document.getElementById(arguments[0]); e.value=arguments[1]; e.dispatchEvent(new Event('change',{bubbles:true})); return e.value;", args: [id, value] });
  }
  async screenshot(path: string): Promise<void> {
    writeFileSync(path, Buffer.from(await this.call("GET", this.path("screenshot")), "base64"));
  }
  async close(): Promise<void> {
    try {
      if (this.session) {
        try { await this.call("DELETE", `/session/${this.session}`); }
        finally { this.session = undefined; }
      }
    } finally {
      // Attached sessions do not own the native host. Retain and reap our child
      // even when session creation or DELETE fails, never kill by process name.
      const child = this.application;
      if (child) {
        if (child.pid && child.exitCode === null && child.signalCode === null) {
          child.kill();
          await until("owned plain-launch app exits", async () => child.exitCode !== null || child.signalCode !== null, Boolean, 15_000);
        }
        this.receipt({ source: "owned-application-closed", pid: child.pid ?? null, exitCode: child.exitCode, signal: child.signalCode });
        this.application = undefined;
      }
    }
  }
}

function argumentShape(value: string): object {
  return { bytes: Buffer.byteLength(value), leadingDashes: value.startsWith("--"),
    ...(value === "--background" ? { flag: value } : { redacted: true }) };
}

function windowsAttachCapabilities(port: number): object {
  return { alwaysMatch: { browserName: "webview2", "ms:edgeChromium": true,
    "ms:edgeOptions": { debuggerAddress: `127.0.0.1:${port}` } } };
}

async function verifyWindowsDebuggerOwner(port: number, pid: number, started: number, binary: string, env: NodeJS.ProcessEnv): Promise<{ listenerPid: number; appBirthUnixMs: number }> {
  const ps = join(env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe");
  // Only local listener/process identity, no command lines, environments, registry writes or termination.
  const script = `$ErrorActionPreference='Stop'; Import-Module NetTCPIP; Import-Module CimCmdlets; $root=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if(!$root -or $root.ExecutablePath -ne '${binary.replaceAll("'", "''")}'){throw 'owned executable mismatch'}; $birth=([DateTimeOffset]$root.CreationDate).ToUnixTimeMilliseconds();if($birth -lt ${started} -or $birth -gt [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()){throw 'owned generation mismatch'}; $listeners=@(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction Stop); if($listeners.Count -ne 1 -or $listeners[0].LocalAddress -ne '127.0.0.1'){throw 'unexpected listener'}; $ownerId=[int]$listeners[0].OwningProcess; $listenerId=$ownerId; $seen=@{};$youngest=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); for($i=0;$i -lt 16;$i++){if($ownerId -eq ${pid}){[Console]::Write(([string]$listenerId)+','+([string]$birth));exit 0}; if($seen.ContainsKey($ownerId)){break};$seen[$ownerId]=$true;$p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$ownerId);if(!$p){break};$created=([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds();if($created -lt $birth -or $created -gt $youngest){throw 'reused parent generation'};$youngest=$created;$ownerId=[int]$p.ParentProcessId};throw 'debugger not owned by launched application'`;
  return new Promise((resolve, reject) => execFile(ps, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    { env, windowsHide: true, timeout: 30_000, maxBuffer: 4096 }, (error, stdout) => {
      if (error || !/^\d+,\d+$/.test(stdout.trim())) reject(new Error("owned WebView2 debugger listener verification failed"));
      else {
        const [listenerPid, appBirthUnixMs] = stdout.trim().split(",").map(Number);
        resolve({ listenerPid, appBirthUnixMs });
      }
    }));
}
