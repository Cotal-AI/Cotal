/** The desktop app's agent applications: the harness each installed connector runs, whether this
 *  account's PATH finds it, and its maker's installer and sign-in. The webview names a connector and
 *  nothing else; every command comes from that connector's cached install declaration. */
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, dirname, join, posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import type { HarnessInstall, HarnessInstaller } from "@cotal-ai/core";
import { checkedHarnessInstall, cmdSpawnSpec, CommandFailure, extensionConnectors, extensionsManifestPath, loadExtensionsManifest, OFFICIAL_CONNECTORS, resolveOnPath } from "@cotal-ai/workspace";
import { discoverDesktopApplicationPath, serviceApplicationPath } from "./desktop-path.js";

export type AgentAppState = "signed-in" | "installed" | "signed-out" | "missing";

/** One application row the app shows. */
export interface AgentApp {
  readonly name: string;
  readonly title: string;
  readonly maker?: string;
  readonly state: AgentAppState;
  readonly version?: string;
  /** Required executables this account's PATH does not find. */
  readonly missing?: readonly string[];
  /** The maker's installer for this system: where it downloads from, and the executables it needs
   *  that PATH does not find yet. */
  readonly install?: { readonly source: string; readonly needs?: readonly string[] };
  /** Whether the app can start the harness's own sign-in. */
  readonly signIn?: true;
  /** The npm package of a connector that is not Cotal's own, so the person sees who declared the
   *  installer before choosing Install. Absent for an official connector. */
  readonly package?: string;
}

interface Declared { readonly name: string; readonly pkg: string; readonly requires: readonly string[]; readonly install?: HarnessInstall }
type Emit = (line: string) => void;

/** The Windows system directory, from which PowerShell and taskkill run. Never a PATH lookup. */
function systemRoot(): string | undefined {
  const root = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  return root && win32.isAbsolute(root) ? root : undefined;
}

const system = process.platform === "darwin" || process.platform === "linux" || process.platform === "win32" ? process.platform : undefined;

/** Every installed connector that runs an external harness, with its checked install declaration. */
function declaredApps(): readonly Declared[] {
  if (!existsSync(extensionsManifestPath())) return shippedInstallers()?.apps ?? [];
  return loadExtensionsManifest().extensions.flatMap(ext => extensionConnectors(ext).map(connector => ({ connector, pkg: ext.pkg })))
    .filter(({ connector }) => connector.requires.length > 0)
    .map(({ connector, pkg }) => ({ name: connector.name, pkg, requires: connector.requires, ...(connector.install === undefined ? {} : { install: checkedHarnessInstall(connector.name, connector.requires, connector.install) }) }));
}

function declared(name: string): Declared {
  const app = declaredApps().find(candidate => candidate.name === name);
  if (!app) throw new CommandFailure("refused", "TARGET_NOT_FOUND", `no installed connector runs an application named ${name}`);
  return app;
}

/** Use the same seeded installer directories as the background service. */
async function accountPath(): Promise<string> {
  const { path } = await discoverDesktopApplicationPath();
  return process.platform === "win32" ? path : serviceApplicationPath(path);
}

/** One line of a child's output as the app may show it: no terminal codes, control characters or tokens. */
export function shownLine(raw: string): string {
  const line = raw.replace(/\u001b\[[0-9;?]*[A-Za-z]|\u001b\][^\u0007]*\u0007/g, "").replace(/eyJ[A-Za-z0-9_.-]*/g, "<redacted>")
    .replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

interface Ran { readonly code: number | null; readonly timedOut: boolean; readonly tail: readonly string[] }

/** Run a child with no terminal and report each output line. On POSIX it leads its own session, so
 *  a script that looks for /dev/tty finds none, and the whole group ends at the time limit. */
function run(file: string, args: readonly string[], opts: { env: NodeJS.ProcessEnv; timeoutMs: number; emit?: Emit; approval?: (line: string) => string | undefined; input?: NodeJS.ReadableStream; verbatim?: boolean }): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const posixGroup = process.platform !== "win32";
    const child = spawn(file, args, { env: opts.env, stdio: [opts.input ? "pipe" : "ignore", "pipe", "pipe"], detached: posixGroup, windowsHide: true, windowsVerbatimArguments: opts.verbatim === true });
    const tail: string[] = [];
    let timedOut = false, partial = "";
    const take = (chunk: Buffer) => {
      const parts = (partial + chunk.toString("utf8")).split(/\r\n|\r|\n/);
      partial = parts.pop() ?? "";
      if (partial.length > 4096) { parts.push(partial); partial = ""; }
      for (const part of parts) {
        const line = shownLine(part);
        if (!line) continue;
        tail.push(line); if (tail.length > 40) tail.shift();
        if (opts.approval) {
          const url = opts.approval(part);
          if (url) opts.emit?.(url);
        } else opts.emit?.(line);
      }
    };
    child.stdout!.on("data", take); child.stderr!.on("data", take);
    if (opts.input) opts.input.pipe(child.stdin!).on("error", () => undefined);
    const kill = () => {
      try {
        if (posixGroup && child.pid) process.kill(-child.pid, "SIGKILL");
        else if (child.pid && systemRoot()) spawn(win32.join(systemRoot()!, "System32", "taskkill.exe"), ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore", windowsHide: true });
        else child.kill("SIGKILL");
      } catch { /* already ended */ }
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, opts.timeoutMs);
    // The app waits on this bridge. When the app is gone, nothing waits on the installer or sign-in
    // either, so it stops instead of outliving the app.
    const caller = process.ppid;
    const watch = setInterval(() => { try { process.kill(caller, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") kill(); } }, 2_000);
    const settle = () => { clearTimeout(timer); clearInterval(watch); };
    child.once("error", error => { settle(); reject(error); });
    child.once("close", code => { settle(); if (partial.trim()) take(Buffer.from("\n")); resolve({ code, timedOut, tail }); });
  });
}

/** Run an executable found on `path`, through cmd.exe when Windows finds a batch shim. */
function runFound(command: string, args: readonly string[], path: string, timeoutMs: number, emit?: Emit, approval?: (line: string) => string | undefined): Promise<Ran> {
  const env = { ...process.env, PATH: path };
  const spec = cmdSpawnSpec(process.platform === "win32" ? command : resolveOnPath(command, env) ?? command, args, env);
  return run(spec.file, spec.args, { env, timeoutMs, verbatim: spec.windowsVerbatimArguments, ...(emit ? { emit } : {}), ...(approval ? { approval } : {}) });
}

async function versionOf(command: string, path: string): Promise<string | undefined> {
  try {
    const ran = await runFound(command, ["--version"], path, 10_000);
    return ran.code === 0 ? /\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?/.exec(ran.tail.join(" "))?.[0] : undefined;
  } catch { return undefined; }
}

/** Whether the harness says it is signed in: true or false from its exit status, undefined when the
 *  check could not run or did not finish. */
async function signedIn(app: Declared, path: string): Promise<boolean | undefined> {
  const status = app.install?.signIn?.status;
  if (!status) return undefined;
  try {
    const ran = await runFound(status[0]!, status.slice(1), path, 15_000);
    return ran.timedOut ? undefined : ran.code === 0 ? true : ran.code === 1 ? false : undefined;
  } catch { return undefined; }
}

async function row(app: Declared, path: string): Promise<AgentApp> {
  const env = { ...process.env, PATH: path };
  const missing = app.requires.filter(command => !resolveOnPath(command, env));
  const installer = system ? app.install?.installers[system] : undefined;
  const needs = installer?.needs?.filter(command => !resolveOnPath(command, env));
  const base = {
    name: app.name, title: app.install?.title ?? app.name, ...(app.install ? { maker: app.install.maker } : {}),
    ...(installer ? { install: { source: new URL(installer.script).host, ...(needs?.length ? { needs } : {}) } } : {}),
    ...(app.install?.signIn ? { signIn: true as const } : {}),
    ...(Object.hasOwn(OFFICIAL_CONNECTORS, app.name) && OFFICIAL_CONNECTORS[app.name] === app.pkg ? {} : { package: app.pkg }),
  };
  if (missing.length) return { ...base, state: "missing", missing };
  const [version, signed] = await Promise.all([versionOf(app.requires[0]!, path), signedIn(app, path)]);
  return { ...base, ...(version ? { version } : {}), state: signed === true ? "signed-in" : signed === false ? "signed-out" : "installed" };
}

/** Every agent application and where it stands on this account. */
export async function agentApps(): Promise<AgentApp[]> {
  const path = await accountPath();
  return await Promise.all(declaredApps().map(app => row(app, path)));
}

function userHome(home?: string): string {
  return home ?? (process.env.HOME || homedir());
}

/** `~/` and `%NAME%\` in a declared folder, made absolute for this account. */
function folder(binDir: string, home = userHome()): string {
  if (binDir.startsWith("~/")) return posix.join(home, ...binDir.slice(2).split("/"));
  const match = /^%([A-Z]+)%\\(.+)$/.exec(binDir);
  const base = match ? process.env[match[1]!] : undefined;
  if (!base || !win32.isAbsolute(base)) throw new CommandFailure("refused", "UNSUPPORTED", `the folder ${binDir} cannot be found on this account`);
  return win32.join(base, match![2]!);
}

function validPosixBinDir(binDir: unknown): binDir is string {
  return typeof binDir === "string" && /^~((?:\/[A-Za-z0-9._-]+)+)$/.test(binDir)
    && !binDir.slice(2).split("/").some(part => part === "." || part === "..");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

interface ShippedInstallers {
  readonly installers: Record<string, Partial<Record<"darwin" | "linux", string>>>;
  readonly apps?: readonly Declared[];
}

function shippedInstallers(): ShippedInstallers | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  const parent = dirname(here);
  const binRoot = basename(parent) === "dist" ? dirname(parent) : parent;
  const file = join(binRoot, "dist", "daemon", "seeded-installers.json");
  const corrupt = (cause?: unknown) => new CommandFailure(
    "refused", "DEPENDENCY_UNAVAILABLE",
    `the seeded connector installer list at ${file} is corrupt or unreadable. Reinstall Cotal and run the command again`,
    { remedy: "reinstall this Cotal installation and run the command again", ...(cause === undefined ? {} : { cause }) },
  );
  let data: unknown;
  try {
    // lstat distinguishes a missing packaged file from a broken link.
    if (!lstatSync(file, { throwIfNoEntry: false })) return undefined;
    if (!statSync(file).isFile()) throw new Error("not a regular file");
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) { throw corrupt(error); }
  if (!isRecord(data) || data.v !== 1 || !isRecord(data.installers)) throw corrupt();
  const entries = Object.values(data.installers);
  if (!entries.length || entries.some(entry => !isRecord(entry) || Object.entries(entry)
    .some(([os, dir]) => (os !== "linux" && os !== "darwin") || !validPosixBinDir(dir)))) throw corrupt();
  return { installers: data.installers as ShippedInstallers["installers"], ...(data.apps === undefined ? {} : { apps: data.apps as readonly Declared[] }) };
}

/** The absolute per-user installer folders declared by this OS's seeded and installed connectors. */
export function serviceAgentAppBinDirs(os: "darwin" | "linux", home = userHome()): string[] {
  const dirs: string[] = [];
  for (const installer of Object.values(shippedInstallers()?.installers ?? {})) {
    const binDir = installer[os];
    if (binDir) dirs.push(folder(binDir, home));
  }
  try {
    for (const app of declaredApps()) {
      const binDir = app.install?.installers[os]?.binDir;
      if (validPosixBinDir(binDir)) dirs.push(folder(binDir, home));
    }
  } catch { /* fall back to shipped declarations */ }
  return [...new Set(dirs.filter(dir => dir.startsWith("/") && dir.length <= 4096 && !/[\u0000-\u001f\u007f]/u.test(dir)))];
}

/** Run the maker's installer: on macOS and Linux its script is downloaded with curl and piped to the
 *  shell the maker names, as its instructions say; on Windows PowerShell downloads and runs it.
 *  The installer runs with the PATH the account has once the app adds its folder (prepended on macOS
 *  and Linux as the startup line does, appended on Windows as the user PATH is), so an installer
 *  that checks the PATH it runs with does not stop to ask about it with no terminal. One that reads
 *  the stored user PATH (Codex on Windows) still adds its folder there itself.
 *  curl and the shell are still found on the account's own PATH. */
async function runInstaller(installer: HarnessInstaller, path: string, emit?: Emit): Promise<Ran> {
  const env = { ...process.env, PATH: path, ...installer.env };
  const dir = folder(installer.binDir);
  const installerEnv = { ...env, PATH: process.platform === "win32" ? `${path.replace(/;+$/, "")};${dir}` : `${dir}:${path}` };
  const timeoutMs = 15 * 60_000;
  if (process.platform === "win32") {
    const root = systemRoot();
    if (!root) throw new CommandFailure("refused", "UNSUPPORTED", "the Windows system directory is unavailable; no installer was run");
    const powershell = win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    // A script that stops by throwing leaves its own sentence as the last line, not a PowerShell error record.
    const command = `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); try { irm '${installer.script}' | iex } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`;
    return await run(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command], { env: installerEnv, timeoutMs, ...(emit ? { emit } : {}) });
  }
  const curl = resolveOnPath("curl", env);
  const shell = resolveOnPath(installer.shell ?? "sh", env);
  if (!curl || !shell) throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", `${!curl ? "curl" : installer.shell} is not on this account's PATH, and the installer needs it`);
  const download = spawn(curl, ["-fsSL", "--proto", "=https", "--tlsv1.2", installer.script], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let downloadError = "";
  download.stderr.on("data", (chunk: Buffer) => { downloadError = shownLine(chunk.toString("utf8")) || downloadError; });
  const downloaded = new Promise<number | null>(resolve => { download.once("error", () => resolve(-1)); download.once("close", resolve); });
  const ran = await run(shell, [], { env: installerEnv, timeoutMs, ...(emit ? { emit } : {}), input: download.stdout });
  const code = await downloaded;
  if (code !== 0) throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", `the installer could not be downloaded from ${installer.script}${downloadError ? `: ${downloadError}` : ""}`);
  return ran;
}

/** The startup files the account's login shell reads, for the shells whose PATH grammar is known.
 *  A bash login shell reads the first of ~/.bash_profile, ~/.bash_login and ~/.profile, and a
 *  terminal's bash reads ~/.bashrc, so bash gets the line in both. A new ~/.profile is never shadowed
 *  by creating a ~/.bash_profile. */
function shellStartupFiles(): { files: string[]; line: (dir: string) => string } {
  const shell = basename(userInfo().shell ?? "");
  const home = homedir();
  const quoted = (dir: string) => dir.startsWith(`${home}/`) ? `"$HOME/${dir.slice(home.length + 1)}"` : `"${dir}"`;
  const exportLine = (dir: string) => `export PATH=${quoted(dir).slice(0, -1)}:$PATH"`;
  if (shell === "zsh") return { files: [join(home, ".zshrc")], line: exportLine };
  if (shell === "bash") {
    const login = [".bash_profile", ".bash_login", ".profile"].map(name => join(home, name)).find(file => existsSync(file)) ?? join(home, ".profile");
    return { files: [login, join(home, ".bashrc")], line: exportLine };
  }
  if (shell === "fish") return { files: [join(home, ".config", "fish", "conf.d", "cotal-path.fish")], line: dir => `fish_add_path --global ${quoted(dir)}` };
  throw new CommandFailure("refused", "UNSUPPORTED", `Cotal cannot add a folder to PATH for the login shell ${shell || "(none)"}`, { remedy: "add the folder to PATH in your shell's startup file, then choose Check again" });
}

/** Put `dir` on this account's PATH the way the makers' instructions do: the user PATH on Windows,
 *  the login shell's startup files elsewhere. Returns where it wrote. */
async function addToAccountPath(dir: string): Promise<string> {
  if (process.platform === "win32") {
    const root = systemRoot();
    if (!root) throw new CommandFailure("refused", "UNSUPPORTED", "the Windows system directory is unavailable; PATH was not changed");
    // The folder travels in the environment and the script as -EncodedCommand, so nothing in either
    // passes through command-line quoting. The
    // value is read raw and written back with its own registry type, so %VAR% entries stay as they
    // are ([Environment]::SetEnvironmentVariable would expand them and store REG_SZ); running
    // programs are then told the environment changed, as that call would have done.
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "$d = $env:COTAL_ADD_PATH",
      "$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')",
      "try {",
      "  $p = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)",
      "  $kind = if ($key.GetValueNames() -contains 'Path') { $key.GetValueKind('Path') } else { [Microsoft.Win32.RegistryValueKind]::ExpandString }",
      "  $have = @($p -split ';' | Where-Object { $_ } | ForEach-Object { [Environment]::ExpandEnvironmentVariables($_).TrimEnd('\\') })",
      "  $added = -not ($have -contains $d.TrimEnd('\\'))",
      "  if ($added) { $key.SetValue('Path', $(if ($p) { $p.TrimEnd(';') + ';' + $d } else { $d }), $kind) }",
      "} finally { $key.Close() }",
      "if ($added) {",
      "  Add-Type -Namespace Cotal -Name UserEnvironment -MemberDefinition '[DllImport(\"user32.dll\", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, UIntPtr wParam, string lParam, uint flags, uint timeout, out UIntPtr result);'",
      "  $result = [UIntPtr]::Zero",
      "  [void][Cotal.UserEnvironment]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 1000, [ref]$result)",
      "}",
    ].join("\n");
    const ran = await run(win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { env: { ...process.env, COTAL_ADD_PATH: dir }, timeoutMs: 30_000 });
    if (ran.code !== 0) throw new CommandFailure("failed", "OPERATION_FAILED", `the user PATH could not be changed: ${ran.tail.at(-1) ?? `exit ${ran.code}`}`);
    return "your user PATH";
  }
  const startup = shellStartupFiles();
  const line = startup.line(dir);
  for (const file of startup.files) {
    const current = existsSync(file) ? readFileSync(file, "utf8") : "";
    if (current.split(/\r?\n/).includes(line)) continue;
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${current && !current.endsWith("\n") ? "\n" : ""}\n# Added by Cotal so the agent applications it installs are found\n${line}\n`, { mode: 0o600 });
  }
  return startup.files.map(file => file.replace(`${homedir()}/`, "~/")).join(" and ");
}

/** Install one application with its maker's installer, then make sure this account's PATH finds it. */
async function installAgentApp(app: Declared, download: Emit, emit?: Emit) {
  const { name } = app;
  const installer = system ? app.install?.installers[system] : undefined;
  if (!app.install || !installer) throw new CommandFailure("refused", "UNSUPPORTED", `${app.install?.title ?? name} has no installer for this operating system`);
  const before = await accountPath();
  const missingNeeds = installer.needs?.filter(command => !resolveOnPath(command, { ...process.env, PATH: before })) ?? [];
  if (missingNeeds.length) throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", `the ${app.install.title} installer needs ${missingNeeds.join(" and ")} on PATH`, { native: { code: "INSTALLER_NEEDS", detail: missingNeeds.join(",") } });
  // Name what is downloaded: Hermes runs through uv, so its installer is uv's.
  const installs = app.requires.every(command => command === app.name) ? app.install.title : new Intl.ListFormat("en", { type: "conjunction" }).format(app.requires);
  download(shownLine(`Downloading the ${installs} installer from ${new URL(installer.script).host}`));
  const ran = await runInstaller(installer, before, emit);
  if (ran.timedOut) throw new CommandFailure("failed", "OPERATION_FAILED", `the ${app.install.title} installer did not finish within 15 minutes and was stopped`, { native: { code: "INSTALLER_FAILED", detail: ran.tail.join("\n") } });
  // On Windows the last line is the reason the script gave; elsewhere the output is in Details.
  const reason = process.platform === "win32" && ran.tail.length ? `: ${ran.tail.at(-1)}` : "";
  if (ran.code !== 0) throw new CommandFailure("failed", "OPERATION_FAILED", `the ${app.install.title} installer stopped with exit code ${ran.code}${reason}`, { native: { code: "INSTALLER_FAILED", detail: ran.tail.join("\n") } });
  let path = await accountPath();
  let pathAdded: string | undefined;
  const unresolved = () => app.requires.filter(command => !resolveOnPath(command, { ...process.env, PATH: path }));
  if (unresolved().length) {
    const dir = folder(installer.binDir);
    const inFolder = unresolved().every(command => resolveOnPath(command, { ...process.env, PATH: dir }));
    if (!inFolder) throw new CommandFailure("failed", "OPERATION_FAILED", `the ${app.install.title} installer finished, but ${unresolved().join(" and ")} is not on PATH or in ${dir}`, { native: { code: "INSTALLER_FAILED", detail: ran.tail.join("\n") } });
    pathAdded = await addToAccountPath(dir);
    emit?.(`Added ${dir} to PATH in ${pathAdded}`);
    path = await accountPath();
    if (unresolved().length) throw new CommandFailure("failed", "OPERATION_FAILED", `${app.install.title} is installed in ${dir} and Cotal added it to PATH in ${pathAdded}, but your login shell still does not find it`, { remedy: `add ${dir} to PATH in the startup file your login shell reads, then choose Check again` });
  }
  return { app: await row(app, path), ...(pathAdded ? { pathAdded } : {}) };
}

/** Start the harness's own browser sign-in and wait for it to finish, then check it. */
async function signInAgentApp(name: string, emit: Emit, service: boolean): Promise<AgentApp> {
  const app = declared(name);
  const login = app.install?.signIn?.login;
  if (!login) throw new CommandFailure("refused", "UNSUPPORTED", `${app.install?.title ?? name} has no sign-in the app can start`);
  const path = await accountPath();
  const ran = await runFound(login[0]!, login.slice(1), path, 10 * 60_000, emit,
    service ? line => daemonAppApproval(name, line) : undefined);
  if (ran.timedOut) throw new CommandFailure("failed", "OPERATION_FAILED", `sign-in did not finish within 10 minutes and was stopped`, { native: { code: "SIGN_IN_FAILED", detail: ran.tail.join("\n") } });
  if (ran.code !== 0) throw new CommandFailure("failed", "OPERATION_FAILED", `${app.install!.title} sign-in stopped with exit code ${ran.code}`, { native: { code: "SIGN_IN_FAILED", detail: ran.tail.join("\n") } });
  return await row(app, path);
}

export type AgentAppRequest =
  | { readonly op: "agent-apps"; readonly refresh?: boolean }
  | { readonly op: "agent-app-install"; readonly name: string }
  | { readonly op: "agent-app-sign-in"; readonly name: string };
export type AppManagement = "service" | "local" | "other-copy" | "checking" | "foreground" | "unrecorded-service" | "no-user-services" | "version-conflict" | "older-service";
type ServiceRefresh = { readonly state: "refreshed" } | { readonly state: "pending"; readonly reason: "agents-running" | "unconfirmed" };
export type AgentAppResult = ({ readonly apps: readonly AgentApp[]; readonly management: AppManagement }
  | { readonly app: AgentApp; readonly pathAdded?: string }) & { readonly serviceRefresh?: ServiceRefresh; readonly serviceOwner?: { readonly kind: "app" | "cli" } };

/** Only the authenticated service tells the bridge what its running PATH does not yet find. */
export type ServiceAppResult = AgentAppResult & { readonly serviceAppPickup?: true; readonly serviceRefreshNeeded?: true; readonly serviceAppDirs?: readonly string[] };

/** The new daemon hop must not relay arbitrary child output. Keep only the two existing local
 * browser flows' known authorization addresses. Never accept a callback URL as an approval link. */
export function daemonAppApproval(name: string, line: string): string | undefined {
  const candidate = /https:\/\/[^\s"'<>]+/.exec(line)?.[0];
  if (!candidate || candidate.length > 4096) return undefined;
  try {
    const url = new URL(candidate);
    const claude = ["claude.ai", "platform.claude.com", "console.anthropic.com"];
    if (url.username || url.password || url.hash || url.port || url.pathname !== "/oauth/authorize") return undefined;
    if (!(name === "claude" && claude.includes(url.hostname)) && !(name === "codex" && url.hostname === "auth.openai.com")) return undefined;
    const keys = [...url.searchParams.keys()];
    if (keys.length !== new Set(keys).size || keys.some(key => ![
      "client_id", "redirect_uri", "response_type", "scope", "code_challenge", "code_challenge_method",
      "state", "code", "id_token_add_organizations", "codex_cli_simplified_flow", "originator",
    ].includes(key)) || (url.searchParams.has("code") && !(name === "claude" && url.searchParams.get("code") === "true"))) return undefined;
    if (url.searchParams.get("response_type") !== "code" || url.searchParams.get("code_challenge_method") !== "S256") return undefined;
    if (!["client_id", "state", "code_challenge"].every(key => /^[A-Za-z0-9._~-]{1,256}$/.test(url.searchParams.get(key) ?? ""))) return undefined;
    const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
    if (redirect.username || redirect.password || redirect.search || redirect.hash) return undefined;
    const loopback = redirect.protocol === "http:" && ["localhost", "127.0.0.1"].includes(redirect.hostname) && !!redirect.port;
    const expectedRedirect = name === "claude"
      ? (redirect.protocol === "https:" && !redirect.port && claude.includes(redirect.hostname) && redirect.pathname === "/oauth/code/callback") || (loopback && redirect.pathname === "/callback")
      : loopback && redirect.pathname === "/auth/callback";
    if (expectedRedirect) return url.href;
  } catch { /* not a browser approval URL */ }
  return undefined;
}

function serviceAppDirs(app: Declared, path: string): string[] {
  return app.requires.flatMap(command => {
    if (resolveOnPath(command)) return [];
    const executable = resolveOnPath(command, { ...process.env, PATH: path });
    return executable ? [dirname(executable)] : [];
  });
}

function servicePickup(dirs: readonly string[]) {
  return dirs.length ? { serviceRefreshNeeded: true as const, serviceAppDirs: [...new Set(dirs)] } : {};
}

/** One host operation core. The bridge may refresh the service after the terminal reply. */
export async function agentAppRequest(req: AgentAppRequest, management: "service" | "local", progress: Emit): Promise<ServiceAppResult> {
  if (req.op === "agent-apps") {
    if (management === "local") return { apps: await agentApps(), management };
    if (!req.refresh) return { apps: await agentApps(), management, serviceAppPickup: true };
    const declared = declaredApps();
    const path = await accountPath();
    const apps = await Promise.all(declared.map(app => row(app, path)));
    const dirs = declared.flatMap((app, i) => apps[i]!.state === "missing" ? [] : serviceAppDirs(app, path));
    return { apps, management, serviceAppPickup: true, ...servicePickup(dirs) };
  }
  if (req.op === "agent-app-sign-in") return { app: await signInAgentApp(req.name, progress, management === "service") };
  try {
    return await installAgentApp(declared(req.name), progress, management === "local" ? progress : undefined);
  } catch (error) {
    if (management === "local") throw error;
    throw new CommandFailure("failed", "OPERATION_FAILED", "The agent app operation could not finish.");
  }
}
