import { spawn, spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { FlagSpec, ParsedArgs } from "@cotal-ai/core";
import {
  CommandFailure, jsonFlag, plainFlag, presentationOf, renderReport, terminalWidth, writeResult, type OutputWarning,
  cmdSpawnSpec,
  beginGlobalUpdateChild,
  claimGlobalNpmUpdateLock,
  loadExtensionsManifest,
  SEEDED_EXTENSIONS,
  type InstalledExtension,
  targetFlags,
} from "@cotal-ai/workspace";
import { EXT_UPDATE_PARENT_ENV } from "./ext.js";
import { claimExtensionUpdatePass } from "../lib/ext-mutation.js";
import { selfArgv } from "../lib/self-exec.js";
import { withInstallUmask } from "../lib/install-umask.js";
import { cliVersion } from "../lib/version.js";
import { runSeed, compareSemver } from "../seed/reconcile.js";
import { refreshConnectorInstalls } from "./setup.js";
import { c } from "../ui.js";
import { askManager, resolveControlTarget } from "../lib/control.js";
import { assertEndpointUnreachable } from "../lib/endpoint-cut.js";
import { supervisorMayServe } from "../lib/manager-proc.js";
import {
  ConnectRefusal,
  isWorkspaceTargetError,
  localMeshesForRoot,
  pruneStaleMeshes,
  renderWorkspaceError,
  resolveMeshTarget,
  type ControlTarget,
  type MeshTarget,
} from "@cotal-ai/workspace";
import { refreshOwnedCompletions } from "../lib/completion-install.js";
import { legacyManagerReport } from "../lib/legacy-manager-report.js";

const UPDATE_TARGET_ENV = "COTAL_UPDATE_TARGET_VERSION";
const UPDATE_PARENT_ENV = "COTAL_UPDATE_PARENT";

export const updateFlags: readonly FlagSpec[] = [
  { name: "self", type: "boolean", description: "install the validated latest cotal-ai globally, then reconcile through it" },
  { name: "check", type: "boolean", description: "read version availability and the recorded extension inventory; install and restart nothing" },
  jsonFlag, plainFlag,
  ...targetFlags,
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
  /** Bring what connectors installed in their harnesses to this release; one line per connector. */
  refreshConnectors(): Promise<readonly string[]>;
  reportRunningManager(target: Record<string, unknown>): Promise<"none" | "legacy">;
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
  refreshConnectors: refreshConnectorInstalls,
  reconcile: async () => {
    await runSeed({ force: true });
    const completion = refreshOwnedCompletions();
    if (completion.changed.length || completion.preserved.length) process.stdout.write(`${renderReport({ sections: [
      { title: "Owned shell completion", blocks: [
        { kind: "fields", rows: [["Changed files", String(completion.changed.length)], ["Preserved integrations", String(completion.preserved.length)]] },
        { kind: "lines", lines: [...completion.preserved.map((entry) => ({ text: `${entry.shell}: ${entry.reason}`, tone: "waiting" as const })), { text: "Startup files were not rewritten. Run cotal completion to inspect local integration.", tone: "hint" }] },
      ] },
    ] }, "rich", terminalWidth(process.stdout))}\n`);
  },
  reportRunningManager: (target) => reportRunningManagers(target),
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
  validateUpdateArguments(args);
  if (args.values.check === true) return checkUpdate(args, rt);
  const code = await executeUpdate(Boolean(args.values.self), rt, args.values);
  if (code !== 0) process.exitCode = code;
}

/** Check mode is installation metadata only; target and mutation inputs are never ignored. */
export function validateUpdateArguments(args: ParsedArgs): void {
  presentationOf(args.values);
  if (args.values.check === true) {
    if (args.values.self || args.values.space !== undefined || args.values.server !== undefined || args.values.creds !== undefined)
      throw new CommandFailure("refused", "USAGE_INVALID", "update --check reads this installation and takes no --self or mesh selection");
  } else if (args.values.json || args.values.plain) throw new CommandFailure("refused", "UNSUPPORTED", "structured and plain update reports require --check; the installer keeps its native progress output");
}

function checkUpdate(args: ParsedArgs, rt: UpdateRuntime): void {
  const current = rt.version();
  const warnings: OutputWarning[] = [];
  let extensions: { package: string; version: string; firstParty: boolean; matchesCli: boolean | null }[] | null;
  try {
    extensions = rt.extensions().map((entry) => {
      if (!entry || typeof entry.pkg !== "string" || typeof entry.version !== "string" || !STRICT_SEMVER.test(entry.version)) throw new Error("invalid extension version entry");
      const firstParty = entry.pkg.startsWith("@cotal-ai/");
      return { package: entry.pkg, version: entry.version, firstParty, matchesCli: firstParty ? entry.version === current : null };
    });
  } catch {
    extensions = null;
    warnings.push({ code: "EXTENSION_INVENTORY_UNREADABLE", target: null, message: "The extension inventory could not be read. It was not repaired or treated as empty." });
  }
  const latest = latestVersion(rt);
  if (!latest.ok) warnings.push({ code: "LATEST_VERSION_UNAVAILABLE", target: null, message: "The registry did not return a valid latest version. Update availability is unknown." });
  const comparison = latest.ok ? compareSemver(latest.version, current) : null;
  const result = { kind: "update-check", current, latest: latest.ok ? latest.version : null, updateAvailable: comparison === null ? null : comparison > 0, extensions, scope: "registry version and recorded installation versions", installationChanged: false, processesRestarted: false };
  writeResult(presentationOf(args.values), {
    command: "update", target: null, result, warnings,
    ...(warnings.length ? { completeness: "partial" as const, partial: { message: "Some update information could not be established.", remedy: "Check registry access or the unreadable inventory and repeat update --check." } } : {}),
  }, (r) => ({ sections: [
    { title: "Update availability", blocks: [{ kind: "fields", rows: [["Running CLI", r.current], ["Registry latest", r.latest ?? "not established"], ["CLI update", r.updateAvailable === null ? { text: "unknown", tone: "waiting" } : r.updateAvailable ? { text: "available", tone: "waiting" } : comparison === 0 ? "matches latest tag" : "running version is ahead of latest tag"]] }] },
    { title: "Recorded extensions", blocks: [r.extensions === null ? { kind: "lines", lines: [{ text: "Inventory unavailable. No repair was attempted.", tone: "waiting" }] } : r.extensions.length ? { kind: "table", columns: [{ key: "package", label: "Package" }, { key: "version", label: "Recorded version" }, { key: "state", label: "Generation" }], rows: r.extensions.map((entry) => ({ package: entry.package, version: entry.version, state: !entry.firstParty ? { text: "third party", tone: "hint" } : entry.matchesCli ? { text: "matches running CLI", tone: "ok" } : { text: "differs from running CLI", tone: "waiting" } })) } : { kind: "lines", lines: ["No extensions in the recorded inventory."] }, { kind: "lines", lines: [{ text: "Version records only. Package contents, signatures and running processes were not checked. No installation was reconciled or restarted.", tone: "hint" }] }] },
    { title: "Next", blocks: [{ kind: "commands", items: [{ command: "cotal update", description: "Reconcile the current generation through the existing guarded updater" }, ...(r.updateAvailable ? [{ command: "cotal update --self", description: "Install the verified latest CLI and reconcile its generation" }] : []), { command: "cotal status", description: "Inspect this machine and its selected space" }] }] },
  ] }));
}

/** Injectable command body: production keeps one process seam; the smoke covers every decision branch. */
export async function executeUpdate(self: boolean, rt: UpdateRuntime = runtime, target: Record<string, unknown> = {}): Promise<number> {
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
    return reconcileCurrent(current, rt, target, (ok) => ok ? 0 : 1);
  }

  if (self) {
    const latest = latestVersion(rt);
    if (latest.ok && compareSemver(latest.version, current) > 0) return upgradeAndReconcile(latest.version, current, rt, target);

    return reconcileCurrent(current, rt, target, (reconciled) => {
      if (!latest.ok) {
        rt.err(c.red(`✗ cotal-ai version check failed: ${latest.error}`));
        return 1;
      }
      reportVersion(current, latest.version, rt);
      return reconciled ? 0 : 1;
    });
  }

  return reconcileCurrent(current, rt, target, (reconciled) => {
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
  target: Record<string, unknown>,
  finish: (reconciled: boolean) => number,
): Promise<number> {
  // OBSERVE BEFORE WRITING. `rt.reconcile()` is `runSeed({force: true})`: it rewrites the
  // operator-global seed store, manifest and npm prefix. It used to run FIRST, so an
  // `update --self` against a mesh that predates this release's authority stores rewrote the store
  // and only then failed its `running manager continuity check`, leaving the machine migrated by a
  // run that refused to proceed (#1620). The continuity check is a pure read of the running manager
  // and the selected target; nothing may be written until it has answered.
  try {
    if (await rt.reportRunningManager(target) === "legacy") return finish(false);
  } catch (e) {
    rt.err(c.red(`✗ running manager continuity check: ${refusal(e)}`));
    return finish(false);
  }

  rt.out(c.bold("Built-in connectors"));
  try {
    await rt.reconcile();
  } catch (e) {
    rt.err(c.red(`✗ built-in connectors: ${message(e)}`));
    return finish(false);
  }
  try {
    for (const line of await rt.refreshConnectors()) rt.out(c.green(`✓ ${line}`));
  } catch (e) {
    rt.err(c.red(`✗ connector installs: ${message(e)}`));
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

/** The "no mesh running" target refusal: no recorded mesh on this machine, or every recorded mesh
 *  down with none selected. Either way no manager is running. A mesh selected with `--space` or
 *  from inside its project, a named space, a broken record, or a dead broker each still names a
 *  manager this command was asked about, unless {@link isStoppedLocalMesh} proved that mesh stopped
 *  before the control connect. */
function isNoMeshRefusal(e: unknown): boolean {
  return e instanceof ConnectRefusal && isWorkspaceTargetError(e.cause) && e.cause.code === "no-meshes";
}

/** Whether `target` is a mesh this machine runs, stopped: no `cotal supervise` process here may be
 *  serving its space and nothing listens at its recorded broker. Both are required. A manager
 *  outlives its broker and reconnects when it returns, so a refused connection alone leaves its
 *  custody in place; a supervisor whose argv names this space or none, a peer that accepts, answers
 *  or stalls, a mesh registered by hand, or a `--server` the operator named may still have a manager
 *  behind it. A project that only ran setup has no registry entry yet; its implicit local default
 *  is eligible for the same process and listener checks, but an explicit server is not. */
export async function isStoppedLocalMesh(target: MeshTarget): Promise<boolean> {
  const registered = localMeshesForRoot(target.root).some((m) => m.space === target.space && m.server === target.server);
  if (!registered && target.source !== "local-space") return false;
  if (supervisorMayServe(target.space)) return false;
  return assertEndpointUnreachable(target.server).then(() => true, () => false);
}

/** The refusal sentence this command prints. A {@link MeshTargetError} arrives RAW here — the
 *  control resolver rethrows the codes it does not absorb before the connect helper can wrap them —
 *  so its `message` is the resolver's bare, command-agnostic text, with none of the recovery copy
 *  every other surface shows. Render it the way `status` and `ps` do, dropping the rendered line's
 *  own `✗` because this one is already printed under the command's marker; a `ConnectRefusal`
 *  already carries that rendering as its message, and anything else is a real fault printed as is. */
function refusal(e: unknown): string {
  return isWorkspaceTargetError(e)
    ? renderWorkspaceError({ kind: "target", error: e }).replace(/^✗ /, "")
    : message(e);
}

/** The running meshes an `ambiguous-target` named, or undefined when this refusal names none to act
 *  on (several tenants on one root, an unreadable account record) and so stands. */
function runningSpaces(e: unknown): string[] | undefined {
  if (!isWorkspaceTargetError(e) || e.code !== "ambiguous-target") return undefined;
  const spaces = e.details.spaces;
  return spaces && spaces.length > 1 ? spaces : undefined;
}

/**
 * The continuity read for every manager this update is asked about, not just one of them.
 *
 * `update --self` replaces the single `cotal-ai` install every running manager on the machine
 * shares, so with no `--space` / `--server` / `--creds` the question is asked about all of them.
 * Reporting one and staying silent about the rest is a partial answer; refusing outright leaves the
 * operator with no continuity report at all. So an ambiguous target is enumerated and read once per
 * running mesh, and every one of them is observed before this returns and anything is written
 * (#1620). A `legacy` verdict on any of them makes the whole run not a hot update. A selector flag
 * still selects one, and every other refusal stands.
 */
export async function reportRunningManagers(
  flags: Record<string, unknown>,
  readOne: (flags: Record<string, unknown>) => Promise<"none" | "legacy"> = readManagerContinuity,
): Promise<"none" | "legacy"> {
  try {
    return await readOne(flags);
  } catch (e) {
    const selected = ["space", "server", "creds"].some((name) => typeof flags[name] === "string");
    const spaces = selected ? undefined : runningSpaces(e);
    if (!spaces) throw e;
    console.log(c.dim(`${spaces.length} meshes running; reading each manager's continuity`));
    let verdict: "none" | "legacy" = "none";
    for (const space of spaces) {
      console.log(c.bold(space));
      // Every manager is read, including after a legacy verdict: the report is about all of them,
      // and stopping at the first would reintroduce the partial answer from the other direction.
      if (await readOne({ ...flags, space }) === "legacy") verdict = "legacy";
      else console.log(c.dim("  manager custody carries this update"));
    }
    return verdict;
  }
}

export async function readManagerContinuity(flags: Record<string, unknown>): Promise<"none" | "legacy"> {
  // #2158: a remote user mesh's manager runs under another install, on another machine. Replacing
  // THIS machine's binary interrupts no manager there, so there is no custody here to preserve and
  // no answer from that mesh's exchange can change what this install does. Peek the mode the same
  // way the control resolver's own peek does (offline-swept when no space is named, `--space`
  // unfiltered) and skip the mint entirely for a remote entry, before it ever reaches the exchange.
  // The control resolve below reads the same sweep, so the whole chain sees one liveness verdict.
  let offline: readonly string[] | undefined;
  if (typeof flags.creds !== "string") {
    const space = typeof flags.space === "string" ? flags.space : undefined;
    const server = typeof flags.server === "string" ? flags.server : undefined;
    let peek: MeshTarget | undefined;
    try {
      offline = space ? [] : (await pruneStaleMeshes()).offline;
      peek = resolveMeshTarget(process.cwd(), { server, space, offline });
    } catch (e) {
      if (!isWorkspaceTargetError(e) || (e.code !== "unknown-space" && e.code !== "no-meshes")) throw e;
    }
    if (peek?.mode === "user" && peek.userAuth?.remote === true) {
      console.log(c.dim(`  ${peek.space}: this mesh's manager runs elsewhere; no custody on this machine`));
      return "none";
    }
    // #3559: `cotal down` then `cotal update` is the cold path past a `legacy` verdict, so a stopped
    // mesh is no custody rather than a refusal. Decided before the control connect, whose user-mode
    // exchange would refuse on the stopped auth service first.
    if (peek && await isStoppedLocalMesh(peek)) {
      console.log(c.dim(`  ${peek.space}: stopped; no manager running`));
      return "none";
    }
  }
  let target: ControlTarget;
  try {
    target = await resolveControlTarget({
      ...(typeof flags.space === "string" ? { space: flags.space } : {}),
      ...(typeof flags.server === "string" ? { server: flags.server } : {}),
      ...(typeof flags.creds === "string" ? { creds: flags.creds } : {}),
      offline,
    }, "control-caller-admin", undefined, { onRefusal: "throw" });
  } catch (e) {
    // No running manager means no custody to preserve and nothing this update could interrupt. Only
    // the "no mesh running" refusal reads as "none": no recorded mesh, or every recorded mesh down
    // with none selected. A selected stopped mesh was already read above; a named space that is not
    // running, a broken record, or a broker that did not answer still names a manager this command
    // was asked about, and stays a refusal.
    if (isNoMeshRefusal(e)) return "none";
    throw e;
  }
  const status = await askManager(target.space, target.server, "managerStatus", undefined, target.auth);
  if (!status.ok) {
    // The MARKER, not the sentence. `unanswered` is the structural fact `epRailFailure` sets from
    // core's answer-provenance marker; the headline beside it is operator prose and is now scoped to
    // the rail the caller rode (#1630), so this call, which runs under an issued control caller, saw
    // the headline naming the versioned rail and threw instead of reporting "none". The string test
    // was redundant the day it was written: this call passes no `--on`, so an unanswered reply here
    // can only ever be the unpinned verdict.
    if (status.unanswered) return "none";
    throw new Error(status.error ?? "manager status request failed");
  }
  const seats = await askManager(target.space, target.server, "ps", undefined, target.auth);
  if (!seats.ok) throw new Error(seats.error ?? "manager seat inventory request failed");
  const report = await legacyManagerReport(
    (status.data ?? {}) as { custody?: unknown },
    Array.isArray(seats.data)
      ? seats.data.map((seat) => ({ name: String((seat as { name?: unknown }).name ?? ""), agent: String((seat as { agent?: unknown }).agent ?? "") }))
      : [],
  );
  if (!report) return "none";
  console.log(c.yellow("! legacy manager custody: PTY continuity is impossible; this update is not a hot update"));
  for (const seat of report.seats)
    console.log(c.dim(`  ${seat.name}: ${seat.continuity}`));
  return "legacy";
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

async function upgradeAndReconcile(targetVersion: string, current: string, rt: UpdateRuntime, target: Record<string, unknown>): Promise<number> {
  try {
    if (await rt.reportRunningManager(target) === "legacy") return 1;
  } catch (e) {
    rt.err(c.red(`✗ running manager continuity check: ${refusal(e)}`));
    return 1;
  }

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
  rt.out(c.dim(`installing cotal-ai@${targetVersion} into npm's global installation; this ${current} process remains loaded until the verified global copy takes over`));
  const npmInstall = cmdSpawnSpec("npm", ["install", "-g", `cotal-ai@${targetVersion}`]);
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
    rt.err(c.red(`✗ global cotal-ai@${targetVersion} install failed: ${failure(installed)}`));
    return 1;
  }

  let entry: string;
  try {
    entry = rt.verifyGlobalEntry(root, targetVersion);
  } catch (e) {
    rt.err(c.red(`✗ installed global cotal-ai could not be verified: ${message(e)}`));
    return 1;
  }
  const env: NodeJS.ProcessEnv = {
    ...rt.env,
    [UPDATE_TARGET_ENV]: targetVersion,
    [UPDATE_PARENT_ENV]: String(rt.pid),
  };
  delete env[EXT_UPDATE_PARENT_ENV];
  const child = await rt.spawnGlobal(root, "reconcile", rt.nodePath, [entry, "update", ...targetArgv(target)], env, true);
  if (child.stderr) rt.stderr(child.stderr);
  if (child.stdout) rt.stdout(child.stdout);
  if (child.status !== 0) {
    rt.err(c.red(`✗ cotal-ai@${targetVersion} installed globally, but its reconcile failed: ${failure(child)}`));
    return child.status ?? 1;
  }
  rt.out(c.green(`✓ cotal-ai@${targetVersion} installed globally and reconciled`));
  return 0;
  } finally {
    releaseGlobal();
  }
}

function targetArgv(target: Record<string, unknown>): string[] {
  const argv: string[] = [];
  for (const name of ["space", "server", "creds"] as const) {
    const value = target[name];
    if (typeof value === "string") argv.push(`--${name}`, value);
  }
  return argv;
}

function reportVersion(current: string, latest: string, rt: UpdateRuntime): void {
  const available = compareSemver(latest, current) > 0;
  rt.out(renderReport({ sections: [
    { title: "CLI version", blocks: [{ kind: "fields", rows: [["This process", current], ["Registry latest", latest], ["Update", available ? { text: "available", tone: "waiting" } : "no newer latest tag"]] }, { kind: "lines", lines: [{ text: "Running processes keep the generation they loaded. This version report does not prove every live service was upgraded.", tone: "hint" }] }] },
    { title: "Next", blocks: [{ kind: "commands", items: [{ command: available ? "cotal update --self" : "cotal status", description: available ? "Install the validated CLI and reconcile its matching extensions" : "Inspect the machine and selected space" }] }] },
  ] }, "rich", terminalWidth(process.stdout)));
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
  const result = withInstallUmask(() => spawnSync(file, args, inherit ? { stdio: "inherit", env } : { encoding: "utf8", env }));
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
    const child = withInstallUmask(() => spawn(file, args, {
      env,
      windowsVerbatimArguments,
      ...(inherit ? { stdio: "inherit" as const } : {}),
    }));
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
