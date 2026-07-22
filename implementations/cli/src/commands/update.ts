import { spawn, spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { FlagSpec, ParsedArgs } from "@cotal-ai/core";
import {
  cmdSpawnSpec,
  beginGlobalUpdateChild,
  claimGlobalNpmUpdateLock,
  loadExtensionsManifest,
  SEEDED_EXTENSIONS,
  type InstalledExtension,
} from "@cotal-ai/workspace";
import { EXT_UPDATE_PARENT_ENV } from "./ext.js";
import { claimExtensionUpdatePass } from "../lib/ext-mutation.js";
import { selfArgv } from "../lib/self-exec.js";
import { cliVersion } from "../lib/version.js";
import { runSeed, compareSemver } from "../seed/reconcile.js";
import { c } from "../ui.js";

const UPDATE_TARGET_ENV = "COTAL_UPDATE_TARGET_VERSION";
const UPDATE_PARENT_ENV = "COTAL_UPDATE_PARENT";

export const updateFlags: readonly FlagSpec[] = [
  { name: "self", type: "boolean", description: "install the validated latest cotal-ai globally, then reconcile through it" },
];

interface CommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: string;
}

export interface UpdateRuntime {
  readonly env: NodeJS.ProcessEnv;
  readonly pid: number;
  readonly parentPid: number;
  readonly nodePath: string;
  version(): string;
  reconcile(): Promise<void>;
  extensions(): readonly InstalledExtension[];
  claimUpdatePass(): () => void;
  claimGlobalUpdate(root: string): () => void;
  selfArgv(): string[];
  npm(args: string[], inherit?: boolean): CommandResult;
  spawn(file: string, args: string[], env: NodeJS.ProcessEnv, inherit?: boolean): CommandResult;
  spawnGlobal(
    root: string,
    operation: "install" | "reconcile",
    file: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    inherit?: boolean,
    windowsVerbatimArguments?: boolean,
  ): Promise<CommandResult>;
  verifyGlobalEntry(root: string, expectedVersion: string): string;
  out(message: string): void;
  err(message: string): void;
  stdout(message: string): void;
  stderr(message: string): void;
}

const runtime: UpdateRuntime = {
  env: process.env,
  pid: process.pid,
  parentPid: process.ppid,
  nodePath: process.execPath,
  version: cliVersion,
  reconcile: () => runSeed({ force: true }),
  extensions: () => loadExtensionsManifest().extensions,
  claimUpdatePass: () => claimExtensionUpdatePass(),
  claimGlobalUpdate: (root) => claimGlobalNpmUpdateLock(root),
  selfArgv,
  npm: runNpm,
  spawn: runProcess,
  spawnGlobal: runGlobalProcess,
  verifyGlobalEntry,
  out: console.log,
  err: console.error,
  stdout: (message) => void process.stdout.write(message),
  stderr: (message) => void process.stderr.write(message),
};

export async function update(args: ParsedArgs, rt: UpdateRuntime = runtime): Promise<void> {
  const code = await executeUpdate(Boolean(args.values.self), rt);
  if (code !== 0) process.exitCode = code;
}

/** Injectable command body: production keeps one process seam; the smoke covers every decision branch. */
export async function executeUpdate(self: boolean, rt: UpdateRuntime = runtime): Promise<number> {
  const current = rt.version();
  const child = childBinding(rt);
  if (child.kind === "invalid") {
    rt.err(c.red(`✗ invalid global update child binding: ${child.reason}; refusing to mutate extensions`));
    return 1;
  }
  if (child.kind === "bound") {
    if (current !== child.target) {
      rt.err(c.red(`✗ global update child is cotal-ai ${current}, expected ${child.target}; refusing to mutate extensions`));
      return 1;
    }
    return reconcileCurrent(current, rt, (ok) => ok ? 0 : 1);
  }

  if (self) {
    const latest = latestVersion(rt);
    if (latest.ok && compareSemver(latest.version, current) > 0) return upgradeAndReconcile(latest.version, current, rt);

    return reconcileCurrent(current, rt, (reconciled) => {
      if (!latest.ok) {
        rt.err(c.red(`✗ cotal-ai version check failed: ${latest.error}`));
        return 1;
      }
      reportVersion(current, latest.version, rt);
      return reconciled ? 0 : 1;
    });
  }

  return reconcileCurrent(current, rt, (reconciled) => {
    const latest = latestVersion(rt);
    if (!latest.ok) {
      rt.err(c.red(`✗ cotal-ai version check failed: ${latest.error}`));
      return 1;
    }
    reportVersion(current, latest.version, rt);
    return reconciled ? 0 : 1;
  });
}

async function reconcileCurrent(
  current: string,
  rt: UpdateRuntime,
  finish: (reconciled: boolean) => number,
): Promise<number> {
  rt.out(c.bold("Built-in connectors"));
  try {
    await rt.reconcile();
  } catch (e) {
    rt.err(c.red(`✗ built-in connectors: ${message(e)}`));
    return finish(false);
  }

  let releaseMutation: () => void;
  try {
    releaseMutation = rt.claimUpdatePass();
  } catch (e) {
    rt.err(c.red(`✗ could not reserve the extension update pass: ${message(e)}`));
    return finish(false);
  }

  try {
    let ok = true;
    rt.out(c.bold("Operator extensions"));
    let entries: readonly InstalledExtension[];
    try {
      // Exclude every seeded built-in (the connectors AND the bundled web dashboard) — runSeed already
      // reconciled them from the bundled store; letting web fall through here reinstalls it from npm on
      // top of the seed, drops its seeded marker, and makes `cotal update` fail offline on a bundled pkg.
      const builtIns = new Set(Object.values(SEEDED_EXTENSIONS).map((e) => e.pkg));
      entries = rt.extensions().filter((entry) => !builtIns.has(entry.pkg));
    } catch (e) {
      rt.err(c.red(`✗ could not read installed extensions: ${message(e)}`));
      return finish(false);
    }
    if (!entries.length) {
      rt.out(c.dim("operator extensions: none installed"));
      return finish(ok);
    }

    for (const entry of entries) {
      if (!entry.pkg.startsWith("@cotal-ai/")) {
        rt.out(c.dim(`${entry.pkg}@${entry.version} - not auto-updated in v1 (recorded spec: ${entry.spec})`));
        continue;
      }
      const spec = `${entry.pkg}@${current}`;
      const [bin, ...argv] = rt.selfArgv();
      const env: NodeJS.ProcessEnv = {
        ...rt.env,
        COTAL_SKIP_CONNECTOR_SEED: "1",
        [EXT_UPDATE_PARENT_ENV]: String(rt.pid),
      };
      delete env[UPDATE_TARGET_ENV];
      delete env[UPDATE_PARENT_ENV];
      const result = rt.spawn(bin, [...argv, "ext", "__update-add", entry.pkg, spec], env);
      writeChildOutput(result);
      if (result.status !== 0) {
        rt.err(c.red(`✗ ${entry.pkg}: ${failure(result)}`));
        ok = false;
        if (result.status === null) {
          rt.err(c.red("✗ extension replay process ended abnormally; refusing to start another package mutation"));
          break;
        }
        continue;
      }
      rt.out(c.green(`✓ ${entry.pkg}@${current}`) + c.dim(` - current generation (recorded spec: ${entry.spec})`));
    }
    return finish(ok);
  } finally {
    releaseMutation();
  }

  function writeChildOutput(result: CommandResult): void {
    if (result.stderr) rt.stderr(result.stderr);
    if (result.stdout) rt.stdout(result.stdout);
  }
}

function latestVersion(rt: UpdateRuntime): { ok: true; version: string } | { ok: false; error: string } {
  const result = rt.npm(["view", "cotal-ai@latest", "version", "--json"]);
  if (result.status !== 0) return { ok: false, error: failure(result) };
  try {
    return { ok: true, version: parseNpmVersion(result.stdout) };
  } catch (e) {
    return { ok: false, error: message(e) };
  }
}

async function upgradeAndReconcile(target: string, current: string, rt: UpdateRuntime): Promise<number> {
  const rootResult = rt.npm(["root", "-g"]);
  if (rootResult.status !== 0) {
    rt.err(c.red(`✗ could not resolve npm's global root before install: ${failure(rootResult)}`));
    return 1;
  }
  const root = rootResult.stdout.trim();
  if (!root || /[\r\n]/.test(root)) {
    rt.err(c.red(`✗ npm returned an invalid global root: ${JSON.stringify(rootResult.stdout)}`));
    return 1;
  }

  let releaseGlobal: () => void;
  try {
    releaseGlobal = rt.claimGlobalUpdate(root);
  } catch (e) {
    rt.err(c.red(`✗ could not reserve npm's global root for update: ${message(e)}`));
    return 1;
  }

  try {
  rt.out(c.bold("cotal-ai binary"));
  rt.out(c.dim(`installing cotal-ai@${target} into npm's global installation; this ${current} process remains loaded until the verified global copy takes over`));
  const npmInstall = cmdSpawnSpec("npm", ["install", "-g", `cotal-ai@${target}`]);
  const installed = await rt.spawnGlobal(
    root,
    "install",
    npmInstall.file,
    npmInstall.args,
    rt.env,
    true,
    npmInstall.windowsVerbatimArguments,
  );
  if (installed.status !== 0) {
    rt.err(c.red(`✗ global cotal-ai@${target} install failed: ${failure(installed)}`));
    return 1;
  }

  let entry: string;
  try {
    entry = rt.verifyGlobalEntry(root, target);
  } catch (e) {
    rt.err(c.red(`✗ installed global cotal-ai could not be verified: ${message(e)}`));
    return 1;
  }
  const env: NodeJS.ProcessEnv = {
    ...rt.env,
    [UPDATE_TARGET_ENV]: target,
    [UPDATE_PARENT_ENV]: String(rt.pid),
  };
  delete env[EXT_UPDATE_PARENT_ENV];
  const child = await rt.spawnGlobal(root, "reconcile", rt.nodePath, [entry, "update"], env, true);
  if (child.stderr) rt.stderr(child.stderr);
  if (child.stdout) rt.stdout(child.stdout);
  if (child.status !== 0) {
    rt.err(c.red(`✗ cotal-ai@${target} installed globally, but its reconcile failed: ${failure(child)}`));
    return child.status ?? 1;
  }
  rt.out(c.green(`✓ cotal-ai@${target} installed globally and reconciled`));
  return 0;
  } finally {
    releaseGlobal();
  }
}

function reportVersion(current: string, latest: string, rt: UpdateRuntime): void {
  rt.out(c.bold("cotal-ai binary"));
  if (compareSemver(latest, current) > 0) {
    rt.out(c.yellow(`! cotal-ai ${current} -> ${latest} available`) + c.dim(" - run: cotal update --self"));
  } else {
    rt.out(c.green(`✓ cotal-ai ${current} is up to date`));
  }
}

function childBinding(rt: UpdateRuntime):
  | { kind: "none" }
  | { kind: "invalid"; reason: string }
  | { kind: "bound"; target: string } {
  const target = rt.env[UPDATE_TARGET_ENV];
  const parent = rt.env[UPDATE_PARENT_ENV];
  if (target === undefined && parent === undefined) return { kind: "none" };
  if (!target || !STRICT_SEMVER.test(target)) return { kind: "invalid", reason: "target version is missing or invalid" };
  if (!parent || !/^\d+$/.test(parent)) return { kind: "invalid", reason: "parent pid is missing or invalid" };
  if (Number(parent) !== rt.parentPid) return { kind: "invalid", reason: "parent pid does not match the launching process" };
  return { kind: "bound", target };
}

export function parseNpmVersion(output: string): string {
  const parsed: unknown = JSON.parse(output.trim());
  // `npm view cotal-ai@latest version --json` returns a bare string ("0.13.2") only while the
  // registry holds a single published version; once more than one exists npm wraps the field query
  // in a JSON array (["0.13.2"]) even for the @latest tag. Accept both, and take the highest valid
  // semver — the @latest query resolves the array to a single element, and the max is the right
  // answer whether npm hands back one element or the whole version list.
  const candidates = typeof parsed === "string" ? [parsed] : Array.isArray(parsed) ? parsed : [];
  const versions = candidates.filter((v): v is string => typeof v === "string" && STRICT_SEMVER.test(v));
  if (versions.length === 0)
    throw new Error(`npm returned an invalid cotal-ai version: ${JSON.stringify(parsed)}`);
  return versions.reduce((max, v) => (compareSemver(v, max) > 0 ? v : max));
}

const PRE = "(?:0|[1-9]\\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)";
const BUILD = "[0-9A-Za-z-]+";
const STRICT_SEMVER = new RegExp(
  `^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-${PRE}(?:\\.${PRE})*)?(?:\\+${BUILD}(?:\\.${BUILD})*)?$`,
);

export function verifyGlobalEntry(root: string, expectedVersion: string): string {
  const packageDir = realpathSync(join(resolve(root), "cotal-ai"));
  const meta = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
    name?: string;
    version?: string;
    bin?: string | Record<string, string>;
  };
  if (meta.name !== "cotal-ai" || meta.version !== expectedVersion)
    throw new Error(`expected cotal-ai@${expectedVersion}, found ${meta.name ?? "unnamed"}@${meta.version ?? "unknown"}`);
  const declared = typeof meta.bin === "string" ? meta.bin : meta.bin?.cotal;
  if (!declared) throw new Error("the installed package declares no cotal executable");
  const entry = realpathSync(resolve(packageDir, declared));
  const rel = relative(packageDir, entry);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error(`the installed cotal executable escapes its package: ${entry}`);
  return entry;
}

function runNpm(args: string[], inherit = false): CommandResult {
  try {
    const { file, args: spawnArgs, windowsVerbatimArguments } = cmdSpawnSpec("npm", args);
    const result = spawnSync(file, spawnArgs, inherit
      ? { stdio: "inherit", windowsVerbatimArguments }
      : { encoding: "utf8", windowsVerbatimArguments });
    return {
      status: result.status,
      stdout: `${result.stdout ?? ""}`,
      stderr: `${result.stderr ?? ""}`,
      error: result.error?.message,
    };
  } catch (e) {
    return { status: null, stdout: "", stderr: "", error: message(e) };
  }
}

function runProcess(file: string, args: string[], env: NodeJS.ProcessEnv, inherit = false): CommandResult {
  const result = spawnSync(file, args, inherit ? { stdio: "inherit", env } : { encoding: "utf8", env });
  return {
    status: result.status,
    stdout: `${result.stdout ?? ""}`,
    stderr: `${result.stderr ?? ""}`,
    error: result.error?.message,
  };
}

async function runGlobalProcess(
  root: string,
  operation: "install" | "reconcile",
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  inherit = false,
  windowsVerbatimArguments = false,
): Promise<CommandResult> {
  const mutation = beginGlobalUpdateChild(root, operation);
  let published = false;
  let preservePending = false;
  try {
    const child = spawn(file, args, {
      env,
      windowsVerbatimArguments,
      ...(inherit ? { stdio: "inherit" as const } : {}),
    });
    let error = "";
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer | string) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer | string) => { stderr += chunk.toString(); });
    child.once("error", (e) => { error = e.message; });
    if (child.pid !== undefined) {
      try {
        mutation.markLive(child.pid);
        published = true;
      } catch (e) {
        error = `could not journal ${operation} child ${child.pid}: ${(e as Error).message}`;
        preservePending = true;
      }
    }
    const closed = await new Promise<{ status: number | null; signal: NodeJS.Signals | null }>((resolveClose) =>
      child.once("close", (status, signal) => resolveClose({ status, signal })),
    );
    if (published) mutation.complete(
      closed.status,
      closed.signal,
      closed.signal !== null
        ? `${operation} child terminated by ${closed.signal}`
        : `Windows npm intermediary exited ${closed.status}; descendant completion is unproved`,
    );
    return { status: error ? null : closed.status, stdout, stderr, ...(error ? { error } : {}) };
  } catch (e) {
    return { status: null, stdout: "", stderr: "", error: message(e) };
  } finally {
    if (!published && !preservePending) mutation.clear();
  }
}

function failure(result: CommandResult): string {
  return [result.error, result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n") || `process exited ${result.status}`;
}

function message(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
