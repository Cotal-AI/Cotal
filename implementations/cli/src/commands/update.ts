import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { globalConfigDir, type FlagSpec, type ParsedArgs } from "@cotal-ai/core";
import {
  CommandFailure, jsonFlag, plainFlag, presentationOf, protectedLocalDirectory, renderReport, writeResult, type OutputWarning,
  cmdSpawnSpec,
  beginGlobalUpdateChild,
  clearUpdateRecovery,
  writeUpdateRecovery,
  readUpdateSettings,
  setUpdateSetting,
  bindExtensionPeers,
  claimGlobalNpmUpdateLock,
  launcherInstallRoot,
  loadExtensionsManifest,
  provenance,
  SEEDED_EXTENSIONS,
  type InstalledExtension,
  targetFlags,
  resolveControlTarget,
} from "@cotal-ai/workspace";
import { EXT_UPDATE_PARENT_ENV } from "./ext.js";
import { claimExtensionUpdatePass } from "../lib/ext-mutation.js";
import { selfArgv } from "../lib/self-exec.js";
import { repairInstallModes, withInstallUmask } from "../lib/install-umask.js";
import { cliVersion } from "../lib/version.js";
import { runSeed, compareSemver } from "../seed/reconcile.js";
import { operatorInstallDiffers } from "../seed/verify.js";
import { cliPackageRoot, entryScript, seedWriterKind } from "../seed/paths.js";
import { refreshConnectorInstalls } from "./setup.js";
import { c } from "../ui.js";
import { assertEndpointUnreachable } from "../lib/endpoint-cut.js";
import { supervisorMayServe } from "../lib/manager-proc.js";
import { processGone, readStackJournal, stackScopeRefusals } from "../lib/stack-journal.js";
import { observeServiceProcess, serviceInstances } from "../lib/service-instances.js";
import {
  ConnectRefusal,
  isWorkspaceTargetError,
  localMeshesForRoot,
  preparedNeverStarted,
  pruneStaleMeshes,
  renderWorkspaceError,
  resolveMeshTarget,
  type ControlTarget,
  type MeshTarget,
  type MeshTargetErrorDetails,
} from "@cotal-ai/workspace";
import { refreshOwnedCompletions } from "../lib/completion-install.js";
import { legacyManagerReport, type LegacyManagerReport } from "../lib/legacy-manager-report.js";
import { askManager } from "@cotal-ai/workspace/control";
import { cliControl, onFlag } from "../lib/control.js";
import { managerPin } from "../lib/manager-choice.js";

const UPDATE_TARGET_ENV = "COTAL_UPDATE_TARGET_VERSION";
const UPDATE_PARENT_ENV = "COTAL_UPDATE_PARENT";

export const updateFlags: readonly FlagSpec[] = [
  { name: "auto", type: "boolean", description: "show automatic updates, or set them with --auto off|on" },
  { name: "notify", type: "boolean", description: "show update notices, or set them with --notify off|on" },
  { name: "self", type: "boolean", description: "install the validated latest cotal-ai globally, then reconcile through it" },
  { name: "check", type: "boolean", description: "read version availability and the recorded extension inventory; install and restart nothing" },
  jsonFlag, plainFlag,
  ...targetFlags,
  onFlag,
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
  /** The binary may await its daemon's replacement generation before the bound child's read. */
  waitForInstalledGeneration?(version: string): Promise<void>;
  extensions(): readonly InstalledExtension[];
  /** Why a first-party extension still needs its reinstall at `generation`, or undefined once it is kept. */
  verifyExtension(entry: InstalledExtension, generation: string): string | undefined;
  claimUpdatePass(): () => void;
  /** Reserve empty hosted Manager admission after continuity checks, before replacement. */
  prepareReplacement?(): Promise<() => Promise<void>>;
  claimGlobalUpdate(root: string): () => void;
  selfArgv(): string[];
  /** Whether this CLI runs from a source checkout, where `--self` installs a separate global copy. */
  checkout(): boolean;
  /** The verified prefix of an installed POSIX npm CLI, absent for a checkout or local/npx copy. */
  installPrefix(): string | undefined;
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

export const updateRuntime: UpdateRuntime = {
  env: process.env,
  pid: process.pid,
  parentPid: process.ppid,
  nodePath: process.execPath,
  version: cliVersion,
  refreshConnectors: refreshConnectorInstalls,
  reconcile: async () => {
    await runSeed({ verify: true });
    const completion = refreshOwnedCompletions();
    if (completion.changed.length || completion.preserved.length) process.stdout.write(`${renderReport({ sections: [
      { title: "Owned shell completion", blocks: [
        { kind: "fields", rows: [["Changed files", String(completion.changed.length)], ["Preserved integrations", String(completion.preserved.length)]] },
        { kind: "lines", lines: [...completion.preserved.map((entry) => ({ text: `${entry.shell}: ${entry.reason}`, tone: "waiting" as const })), { text: "Startup files were not rewritten. Run `cotal completion` to inspect local integration.", tone: "hint" }] },
      ] },
    ] }, "rich", process.stdout)}\n`);
  },
  reportRunningManager: (target) => reportRunningManagers(target),
  extensions: () => loadExtensionsManifest().extensions,
  verifyExtension: verifyCurrentExtension,
  claimUpdatePass: () => claimExtensionUpdatePass(),
  claimGlobalUpdate: (root) => claimGlobalNpmUpdateLock(root),
  selfArgv,
  checkout: () => seedWriterKind() === "checkout",
  installPrefix: () => installedUpdatePrefix(cliPackageRoot(), entryScript()),
  npm: runNpm,
  spawn: runProcess,
  spawnGlobal: runGlobalProcess,
  verifyGlobalEntry,
  out: console.log,
  err: console.error,
  stdout: (message) => void process.stdout.write(message),
  stderr: (message) => void process.stderr.write(message),
};

export async function update(args: ParsedArgs, rt: UpdateRuntime = updateRuntime): Promise<void> {
  validateUpdateArguments(args);
  if (args.values.auto || args.values.notify) {
    const key = args.values.auto ? "auto" : "notify";
    const value = args.positionals[0];
    if (value !== undefined) setUpdateSetting(key, value === "on");
    const settings = readUpdateSettings();
    rt.out(`${key === "auto" ? "Automatic updates" : "Update notices"}: ${settings[key] ? "on" : "off"}${rt.env.COTAL_NO_UPDATE_CHECK === "1" ? " (disabled by COTAL_NO_UPDATE_CHECK=1)" : ""}`);
    return;
  }
  if (args.values.check === true) return checkUpdate(args, rt);
  if (args.values.self === true && existsSync(join(cliPackageRoot(), "desktop-runtime.json"))) {
    throw new CommandFailure("refused", "UNSUPPORTED", "this Cotal runtime belongs to the desktop app; npm self-update would separate it from its bundled runtime", {
      remedy: "update the desktop app with its signed platform installer; no npm self-update was attempted",
    });
  }
  // A folder above the config folder is not one this command repairs. Refuse it before the mode
  // repair and before seeding, so a refusal writes nothing and does not replace the binary.
  try {
    assertConfigAncestorProtected();
  } catch (e) {
    rt.err(c.red(`✗ config folder protection: ${refusal(e)}`));
    process.exitCode = 1;
    return;
  }
  // Removing group and other write from Cotal's install and config folder changes nothing a running
  // manager reads, so their modes are repaired before the continuity check rather than only when the
  // reconcile is allowed to run.
  const install = launcherInstallRoot();
  for (const { what, root } of [...(install ? [{ what: "install", root: install }] : []), { what: "config", root: globalConfigDir() }]) {
    const repaired = repairInstallModes(root);
    if (repaired) rt.out(c.green(`✓ removed group and other write from ${repaired} ${repaired === 1 ? "entry" : "entries"} in Cotal's ${what} at ${root}`));
  }
  const code = await executeUpdate(Boolean(args.values.self), rt, args.values);
  if (code !== 0) process.exitCode = code;
  else clearUpdateRecovery();
}

/** Check mode is installation metadata only; target and mutation inputs are never ignored. */
export function validateUpdateArguments(args: ParsedArgs): void {
  presentationOf(args.values);
  if (args.values.auto || args.values.notify) {
    if (args.values.auto && args.values.notify || args.values.self || args.values.check || args.values.json || args.values.plain || args.values.space || args.values.server || args.values.creds || args.values.on || args.positionals.length > 1 || args.positionals.some(value => value !== "on" && value !== "off"))
      throw new CommandFailure("refused", "USAGE_INVALID", "use cotal update --auto [off|on] or cotal update --notify [off|on] without other update flags");
    return;
  }
  if (args.positionals.length) throw new CommandFailure("refused", "USAGE_INVALID", "off or on requires --auto or --notify");
  if (args.values.check === true) {
    if (args.values.self || args.values.space !== undefined || args.values.server !== undefined || args.values.creds !== undefined || args.values.on !== undefined)
      throw new CommandFailure("refused", "USAGE_INVALID", "update --check reads this installation and takes no --self, mesh selection or --on");
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
    { title: "Next", blocks: [{ kind: "commands", items: [{ command: "cotal update", description: "Reconcile the current generation through the existing guarded updater" }, ...(r.updateAvailable ? [{ command: "cotal update --self", description: rt.checkout() ? "Install the verified latest CLI as a separate global copy and reconcile through it; this checkout does not change" : "Install the verified latest CLI and reconcile its generation" }] : []), { command: "cotal status", description: "Inspect this machine and its selected space" }] }] },
  ] }));
}

/** Injectable command body: production keeps one process seam; the smoke covers every decision branch. */
export async function executeUpdate(self: boolean, rt: UpdateRuntime = updateRuntime, target: Record<string, unknown> = {}): Promise<number> {
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
    try {
      await rt.waitForInstalledGeneration?.(current);
    } catch (error) {
      rt.err(c.red(`✗ installed daemon generation: ${refusal(error)}`));
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
      reportVersion(current, latest.version, rt, reconciled);
      return reconciled ? 0 : 1;
    });
  }

  return reconcileCurrent(current, rt, target, (reconciled) => {
    const latest = latestVersion(rt);
    if (!latest.ok) {
      rt.err(c.red(`✗ cotal-ai version check failed: ${latest.error}`));
      return 1;
    }
    reportVersion(current, latest.version, rt, reconciled);
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
      let differs: string | undefined;
      try {
        differs = rt.verifyExtension(entry, current);
      } catch (e) {
        rt.err(c.red(`✗ ${entry.pkg}: ${message(e)}`));
        ok = false;
        continue;
      }
      if (differs === undefined) {
        rt.out(c.green(`✓ verified ${entry.pkg}@${current}`) + c.dim(` - current generation (recorded spec: ${entry.spec})`));
        continue;
      }
      rt.err(c.dim(`${entry.pkg}: ${differs}; reinstalling`));
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

/** Keep a first-party extension that npm's record in the prefix proves installed at `generation`,
 *  rebinding its shared peers to this binary's copies as its reinstall would; otherwise say why it
 *  still needs that reinstall. The update pass calls it under its own claim, so it needs no child. */
export function verifyCurrentExtension(entry: InstalledExtension, generation: string): string | undefined {
  const differs = operatorInstallDiffers(entry, generation);
  if (differs !== undefined) return differs;
  for (const link of bindExtensionPeers([entry.pkg], entry.pkg))
    provenance.wrote(`${link.peer} link (${link.owner} → this CLI's copy)`, link.destination);
  return undefined;
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

/** A prepared controller that completed ordinary down is cold only while its own instance records
 *  prove every process gone, no supervisor may serve it, and its recorded broker has no listener.
 *  The target resolver refuses before returning a MeshTarget for this lifecycle. */
async function stoppedController(d: MeshTargetErrorDetails): Promise<boolean> {
  if (typeof d.space !== "string" || typeof d.root !== "string" || !d.stopped ||
      d.rootMissing === true || d.unsettled !== undefined || d.home !== undefined || d.stackSpace !== undefined) return false;
  const journal = readStackJournal(d.root)?.journal;
  if (!journal || journal.space !== d.space || journal.operation.kind !== "down" || journal.operation.phase !== "completed") return false;
  const instances = serviceInstances(d.space);
  if (journal.members.some((member) => member.instanceId !== null &&
      !instances.some((row) => row.name === member.instanceId && row.record.value.definition === member.definition))) return false;
  if (instances.some((row) => !["stopped", "failed"].includes(row.record.value.state) || !processGone(observeServiceProcess(row.record.value)))) return false;
  stackScopeRefusals(journal, `\`cotal update --space ${d.space}\``);
  if (supervisorMayServe(d.space)) return false;
  return assertEndpointUnreachable(journal.server).then(() => true, () => false);
}

/** The refusal sentence this command prints. A {@link MeshTargetError} arrives RAW here — the
 *  control resolver rethrows the codes it does not absorb before the connect helper can wrap them —
 *  so its `message` is the resolver's bare, command-agnostic text, with none of the recovery copy
 *  every other surface shows. Render it the way `status` and `ps` do, dropping the rendered line's
 *  own `✗` because this one is already printed under the command's marker; a `ConnectRefusal`
 *  already carries that rendering as its message. Keep a CommandFailure's recovery step too. */
function refusal(e: unknown): string {
  const text = isWorkspaceTargetError(e)
    ? renderWorkspaceError({ kind: "target", error: e }).replace(/^✗ /, "")
    : message(e);
  const remedy = e instanceof CommandFailure ? e.remedy : undefined;
  return remedy === undefined ? text : `${text}\n\nNext\n  ${remedy}`;
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
    const selected = ["space", "server", "creds", "on"].some((name) => typeof flags[name] === "string");
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
  // `--on` names the manager whose custody this install carries. An owner with several live
  // managers on a user-auth mesh (one per machine, say) gets the exchange's selection refusal
  // without it, naming `--on` as the remedy; the flag has to exist here for that remedy to be real,
  // and it has to reach the MINT below, since a credential cannot gain an instance rail after it is
  // issued. A name or host resolves to an instance id the same way `ps` resolves it.
  const on = await managerPin(flags, "cotal update");
  let remote = false;
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
      offline = space ? [] : (await pruneStaleMeshes(server)).offline;
      peek = resolveMeshTarget(process.cwd(), { server, space, offline });
    } catch (e) {
      if (!isWorkspaceTargetError(e)) throw e;
      // A space prepared here that never started (`cotal setup --configure-only`, `space create`)
      // has no broker, no stack journal and no manager: a supervisor serves a started stack, and
      // this one never launched a member, so there is nothing this update could interrupt. Run from
      // its folder, or with it selected or named, the resolver refuses it as not started before
      // dialing anything, which is the right answer for a command that needs a mesh and the wrong
      // one for a software update, which needs only to know that no manager here holds custody.
      if (e.code === "not-started" && preparedNeverStarted(e.details)) {
        console.log(c.dim(`  ${e.details.space}: prepared in ${e.details.root}, not started; no manager running`));
        return "none";
      }
      if (e.code === "not-started" && server === undefined && await stoppedController(e.details)) {
        console.log(c.dim(`  ${e.details.space}: stopped; no manager running`));
        return "none";
      }
      if (e.code !== "unknown-space" && e.code !== "no-meshes") throw e;
    }
    // The skip holds only while no supervisor that loaded THIS install may be serving that space.
    // A `cotal manager start` or `cotal supervise` process here that loaded this install and serves a
    // remote mesh is read like a local manager. A supervisor whose command resolves in another
    // install is untouched by replacing this one, so it is no custody here, the same as a manager
    // that runs on another machine.
    if (peek?.mode === "user" && peek.userAuth?.remote === true) {
      if (!supervisorMayServe(peek.space)) {
        console.log(c.dim(`  ${peek.space}: this mesh's manager runs elsewhere; no custody on this machine`));
        return "none";
      }
      remote = true;
      console.log(c.dim(`  ${peek.space}: a manager for this mesh runs on this machine; reading its custody`));
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
    }, "control-caller-admin", on, { onRefusal: "throw" });
  } catch (e) {
    // No running manager means no custody to preserve and nothing this update could interrupt. Only
    // the "no mesh running" refusal reads as "none": no recorded mesh, or every recorded mesh down
    // with none selected. A selected stopped mesh was already read above; a named space that is not
    // running, a broken record, or a broker that did not answer still names a manager this command
    // was asked about, and stays a refusal.
    if (isNoMeshRefusal(e)) return "none";
    throw e;
  }
  const pin = on === undefined ? {} : { instanceId: on };
  const status = await askManager(cliControl, target.space, target.server, "managerStatus", undefined, target.auth, "owner", undefined, pin);
  if (!status.ok) {
    // The MARKER, not the sentence. `unanswered` is the structural fact `epRailFailure` sets from
    // core's answer-provenance marker; the headline beside it is operator prose and is now scoped to
    // the rail the caller rode (#1630), so this call, which runs under an issued control caller, saw
    // the headline naming the versioned rail and threw instead of reporting "none". Unpinned, an
    // unanswered reply is the verdict that no manager holds custody. Pinned, it is a manager the
    // operator named and this command could not read, which is not "none".
    if (status.unanswered && on === undefined) return "none";
    throw new Error(status.error ?? "manager status request failed");
  }
  const seats = await askManager(cliControl, target.space, target.server, "ps", undefined, target.auth, "owner", undefined, pin);
  if (!seats.ok) throw new Error(seats.error ?? "manager seat inventory request failed");
  const report = await legacyManagerReport(
    (status.data ?? {}) as { custody?: unknown },
    Array.isArray(seats.data)
      ? seats.data.map((seat) => ({ name: String((seat as { name?: unknown }).name ?? ""), agent: String((seat as { agent?: unknown }).agent ?? "") }))
      : [],
  );
  if (!report) return "none";
  printLegacyReport(report, target.space, remote ? `cotal manager stop --space ${target.space}` : `cotal down --space ${target.space}`);
  return "legacy";
}

/** What a `legacy` verdict prints: the verdict, each seat's continuity class, and the cold path past
 *  it as the next step. The verdict alone left the operator with no way on (#5027): the update exits
 *  nonzero, and the path the docs name, `cotal down` then `cotal update`, was nowhere on the screen.
 *  `stop` is the command that ends that manager: `cotal down` for a mesh this machine runs, and
 *  `cotal manager stop` for a remote mesh whose manager this machine runs. */
export function printLegacyReport(
  report: LegacyManagerReport,
  space: string,
  stop: string = `cotal down --space ${space}`,
  out: (line: string) => void = console.log,
): void {
  out(c.yellow("! legacy manager custody: PTY continuity is impossible; this update is not a hot update"));
  for (const seat of report.seats)
    out(c.dim(`  ${seat.name}: ${seat.continuity}`));
  out(`  Next: stop that mesh with \`${stop}\`, then run this update again; the stop ends the seats above, and the update after it is a cold one`);
}

/** The registry's latest tag, read through a throwaway npm cache with npm's log files and update
 *  notifier off, so the read leaves nothing in npm's own cache, log directory or notifier stamp. */
function latestVersion(rt: UpdateRuntime): { ok: true; version: string } | { ok: false; error: string } {
  const cache = mkdtempSync(join(tmpdir(), "cotal-npm-view-"));
  try {
    const result = rt.npm(["view", "cotal-ai@latest", "version", "--json", "--cache", cache, "--logs-max=0", "--update-notifier=false"]);
    if (result.status !== 0) return { ok: false, error: failure(result) };
    try {
      return { ok: true, version: parseNpmVersion(result.stdout) };
    } catch (e) {
      return { ok: false, error: message(e) };
    }
  } finally {
    rmSync(cache, { recursive: true, force: true, maxRetries: 3 });
  }
}

/** Fetch the target's first-party install closure through npm, including integrity verification.
 *  A private cache forces a registry read without changing the installed packages or running scripts. */
function checkReleaseArchives(version: string, rt: UpdateRuntime): void {
  const cache = mkdtempSync(join(tmpdir(), "cotal-release-check-"));
  const options = ["--cache", cache, "--logs-max=0", "--update-notifier=false", "--fetch-retries=0", "--fetch-timeout=15000", "--prefer-online"];
  const pending = new Set(["cotal-ai"]);
  try {
    for (const name of pending) {
      const spec = `${name}@${version}`;
      const manifest = rt.npm(["view", spec, "--json", ...options]);
      if (manifest.status !== 0) throw new Error(`metadata for ${spec} is unavailable`);
      let meta: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(manifest.stdout);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
        meta = parsed as Record<string, unknown>;
        if (meta.name !== name || meta.version !== version) throw new Error();
        const dist = meta.dist as { tarball?: unknown; integrity?: unknown } | undefined;
        if (typeof dist?.tarball !== "string" || !dist.tarball || typeof dist.integrity !== "string" || !dist.integrity) throw new Error();
      } catch {
        throw new Error(`metadata for ${spec} is incomplete or invalid`);
      }
      for (const field of ["dependencies", "optionalDependencies", "peerDependencies"] as const) {
        const deps = meta[field];
        if (deps === undefined) continue;
        if (!deps || typeof deps !== "object" || Array.isArray(deps)) throw new Error(`invalid ${field} for ${spec}`);
        for (const [dependency, range] of Object.entries(deps)) {
          if (!dependency.startsWith("@cotal-ai/")) continue;
          if (!/^@cotal-ai\/[a-z0-9][a-z0-9._-]*$/.test(dependency) || typeof range !== "string" ||
              (field !== "peerDependencies" && range !== version)) throw new Error(`invalid first-party dependency in ${spec}`);
          pending.add(dependency);
        }
      }
      // npm applies the configured registry, scoped authentication, proxy/TLS policy and SRI checks.
      // cache add downloads only this archive, so enumerate the dependency closure above as well.
      const archive = rt.npm(["cache", "add", spec, "--ignore-scripts", ...options]);
      if (archive.status !== 0) throw new Error(`archive for ${spec} could not be downloaded and verified`);
    }
  } finally {
    rmSync(cache, { recursive: true, force: true, maxRetries: 3 });
  }
}


/** The nearest existing directory of the config folder. Seeding creates the folder itself, but a
 *  group-writable ancestor above it is outside the folders update repairs. */
function assertConfigAncestorProtected(): void {
  let path = globalConfigDir();
  // The config folder itself is repaired below. Only a folder above it is outside that repair.
  if (existsSync(path)) path = dirname(path);
  while (!existsSync(path)) {
    const parent = dirname(path);
    if (parent === path) return;
    path = parent;
  }
  // The seed resolves the physical directory before protectedLocalDirectory. Follow that so an
  // owned private folder reached through a symlink is not refused for being a link.
  try { path = realpathSync(path); } catch { /* the path that exists is checked below */ }
  if (!statSync(path).isDirectory()) return;
  protectedLocalDirectory(path, "the Cotal config folder");
}

async function upgradeAndReconcile(targetVersion: string, current: string, rt: UpdateRuntime, target: Record<string, unknown>): Promise<number> {
  try {
    if (await rt.reportRunningManager(target) === "legacy") return 1;
  } catch (e) {
    rt.err(c.red(`✗ running manager continuity check: ${refusal(e)}`));
    return 1;
  }

  try {
    checkReleaseArchives(targetVersion, rt);
    // A previous generation must remain downloadable and verified before replacement begins.
    checkReleaseArchives(current, rt);
  } catch (e) {
    rt.err(c.red(`✗ cotal-ai@${targetVersion} release is not ready: ${message(e)}. The release is still reaching the registry or registry access failed; no global install was attempted. Check registry access and run \`cotal update --self\` again in a few minutes.`));
    return 1;
  }

  let prefix: string | undefined;
  try {
    prefix = rt.installPrefix();
    if (prefix) {
      for (const [key, value] of Object.entries(rt.env)) {
        if (key.toLowerCase() === "npm_config_prefix" && value && realpathSync(value) !== prefix)
          throw new Error("npm's configured prefix differs from the invoked cotal install; run its installer launcher or correct npm_config_prefix");
      }
    }
  } catch (e) {
    rt.err(c.red(`✗ could not establish the invoked install prefix: ${message(e)}`));
    return 1;
  }
  const prefixArgs = prefix ? ["--prefix", prefix] : [];
  const rootResult = rt.npm(["root", "-g", ...prefixArgs]);
  if (rootResult.status !== 0) {
    rt.err(c.red(`✗ could not resolve npm's global root before install: ${failure(rootResult)}`));
    return 1;
  }
  const root = rootResult.stdout.trim();
  if (!isAbsolute(root) || /[\r\n]/.test(root)) {
    rt.err(c.red(`✗ npm returned an invalid global root: ${JSON.stringify(rootResult.stdout)}`));
    return 1;
  }

  if (prefix) {
    try {
      if (realpathSync(root) !== realpathSync(join(prefix, "lib", "node_modules")))
        throw new Error("npm's global root does not match the invoked install prefix");
    } catch (e) {
      rt.err(c.red(`✗ could not verify npm's selected global root: ${message(e)}`));
      return 1;
    }
  }

  // Seeding writes under the config folder after this install. An ancestor outside that folder,
  // such as a group-writable XDG config parent, is not repaired and still refuses. Check it now,
  // before npm replaces the binary, so a refusal leaves the installed generation unchanged.
  try {
    assertConfigAncestorProtected();
  } catch (e) {
    rt.err(c.red(`✗ config folder protection: ${refusal(e)}`));
    return 1;
  }

  let releaseGlobal: () => void;
  try {
    releaseGlobal = rt.claimGlobalUpdate(root);
  } catch (e) {
    rt.err(c.red(`✗ could not reserve npm's global root for update: ${message(e)}`));
    return 1;
  }

  let releaseAdmission: (() => Promise<void>) | undefined;
  try {
    releaseAdmission = await rt.prepareReplacement?.();
  } catch (error) {
    releaseGlobal();
    rt.err(`update admission refused: ${message(error)}`);
    return 1;
  }
  // npm replaces the live package tree. Keep custody until it and the verified reconcile
  // finish, even when the terminal sends Ctrl-C during that replacement.
  let interrupted = 0;
  const interrupt = (code: number): void => {
    if (interrupted) return;
    interrupted = code;
    rt.err(c.yellow("Interrupt received; finishing installation and reconciliation before exiting."));
  };
  const onInt = (): void => interrupt(130);
  const onTerm = (): void => interrupt(143);
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  try {
  rt.out(c.bold("cotal-ai binary"));
  rt.out(c.dim(`installing cotal-ai@${targetVersion} into npm's global installation; this ${current} process remains loaded until the verified global copy takes over`));
  writeUpdateRecovery({ previous: current, target: targetVersion, installed: current, phase: "replacing", reason: "global replacement in progress" });
  const npmInstall = cmdSpawnSpec("npm", ["install", "-g", ...prefixArgs, `cotal-ai@${targetVersion}`]);
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
    return await repairReplacement(`global install failed: ${failure(installed)}`);
  }

  let entry: string;
  try {
    entry = rt.verifyGlobalEntry(root, targetVersion);
  } catch (e) {
    rt.err(c.red(`✗ installed global cotal-ai could not be verified: ${message(e)}`));
    return await repairReplacement(`installed entry verification failed: ${message(e)}`);
  }
  const env: NodeJS.ProcessEnv = {
    ...rt.env,
    ...(prefix ? { npm_config_prefix: prefix } : {}),
    [UPDATE_TARGET_ENV]: targetVersion,
    [UPDATE_PARENT_ENV]: String(rt.pid),
  };
  delete env[EXT_UPDATE_PARENT_ENV];
  const child = await rt.spawnGlobal(root, "reconcile", rt.nodePath, [entry, "update", ...targetArgv(target)], env, true);
  if (child.stderr) rt.stderr(child.stderr);
  if (child.stdout) rt.stdout(child.stdout);
  if (child.status !== 0) {
    rt.err(c.red(`✗ cotal-ai@${targetVersion} installed globally, but its reconcile failed: ${failure(child)}`));
    return await repairReplacement(`reconcile failed: ${failure(child)}`);
  }
  clearUpdateRecovery();
  rt.out(c.green(`✓ cotal-ai@${targetVersion} installed globally and reconciled`));
  return interrupted;

  async function reconcileVersion(version: string): Promise<boolean> {
    const verified = rt.verifyGlobalEntry(root, version);
    const repairEnv: NodeJS.ProcessEnv = { ...rt.env, ...(prefix ? { npm_config_prefix: prefix } : {}), [UPDATE_TARGET_ENV]: version, [UPDATE_PARENT_ENV]: String(rt.pid) };
    delete repairEnv[EXT_UPDATE_PARENT_ENV];
    const result = await rt.spawnGlobal(root, "reconcile", rt.nodePath, [verified, "update", ...targetArgv(target)], repairEnv, true);
    if (result.stderr) rt.stderr(result.stderr);
    if (result.stdout) rt.stdout(result.stdout);
    return result.status === 0;
  }

  async function repairReplacement(reason: string): Promise<number> {
    rt.err(c.yellow("Retrying reconciliation of the installed generation before rollback."));
    try {
      if (await reconcileVersion(targetVersion)) {
        clearUpdateRecovery();
        rt.out(c.green(`✓ cotal-ai@${targetVersion} repaired and reconciled`));
        return interrupted;
      }
    } catch (error) { rt.err(`reconcile retry: ${message(error)}`); }
    rt.err(c.yellow(`Restoring verified cotal-ai@${current} through the global updater.`));
    try {
      checkReleaseArchives(current, rt);
      const command = cmdSpawnSpec("npm", ["install", "-g", ...prefixArgs, `cotal-ai@${current}`]);
      const restored = await rt.spawnGlobal(root, "install", command.file, command.args, rt.env, true, command.windowsVerbatimArguments);
      if (restored.status !== 0) throw new Error(failure(restored));
      if (!await reconcileVersion(current)) throw new Error("previous generation reconciliation failed");
      clearUpdateRecovery();
      rt.err(`Update failed; cotal-ai@${current} was restored and reconciled. Run cotal update --self to try again.`);
      return 1;
    } catch (error) {
      let installedVersion = "unknown";
      try { installedVersion = JSON.parse(readFileSync(join(root, "cotal-ai", "package.json"), "utf8")).version ?? "unknown"; } catch { /* Report an unknown install instead of claiming the previous tree survived. */ }
      const detail = `${reason}; repair failed: ${message(error)}`;
      writeUpdateRecovery({ previous: current, target: targetVersion, installed: installedVersion, phase: "paused", reason: detail });
      rt.err(c.red(`✗ Update stopped: installed cotal-ai ${installedVersion}; ${detail}. Automatic updates are paused. Run cotal update --self to repair this installation.`));
      return 1;
    }
  }
  } finally {
    try {
      try { await releaseAdmission?.(); }
      finally { releaseGlobal(); }
    } finally {
      process.off("SIGINT", onInt);
      process.off("SIGTERM", onTerm);
    }
  }
}

function targetArgv(target: Record<string, unknown>): string[] {
  const argv: string[] = [];
  for (const name of ["space", "server", "creds", "on"] as const) {
    const value = target[name];
    if (typeof value === "string") argv.push(`--${name}`, value);
  }
  return argv;
}

function reportVersion(current: string, latest: string, rt: UpdateRuntime, reconciled: boolean): void {
  const available = compareSemver(latest, current) > 0;
  rt.out(renderReport({ sections: [
    { title: "CLI version", blocks: [{ kind: "fields", rows: [["This process", current], ["Registry latest", latest], ["Update", available ? { text: "available", tone: "waiting" } : "no newer latest tag"]] }, { kind: "lines", lines: [{ text: "Running processes keep the generation they loaded. This version report does not prove every live service was upgraded.", tone: "hint" }] }] },
    ...(reconciled ? [{ title: "Next", blocks: [{ kind: "commands" as const, items: [{ command: available ? "cotal update --self" : "cotal status", description: !available ? "Inspect the machine and selected space" : rt.checkout() ? "Install the validated CLI as a separate global copy and reconcile through it; this checkout does not change" : "Install the validated CLI and reconcile its matching extensions" }] }] }] : []),
  ] }, "rich", process.stdout));
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

/** Bind a POSIX npm global installation to its package and bin link before replacing it.
 * Local/npx copies and source checkouts retain npm's separate global destination. A global-shaped
 * installation with a missing, redirected or escaping entry refuses instead of guessing a prefix. */
export function installedUpdatePrefix(packageRoot: string, entry: string): string | undefined {
  const root = realpathSync(packageRoot);
  const modules = dirname(root);
  if (process.platform === "win32" || basename(modules) !== "node_modules" || basename(dirname(modules)) !== "lib")
    return undefined;
  const prefix = dirname(dirname(modules));
  const meta = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: string };
  if (basename(root) !== "cotal-ai" || !meta.version ||
      verifyGlobalEntry(modules, meta.version) !== realpathSync(entry) ||
      realpathSync(join(prefix, "bin", "cotal")) !== realpathSync(entry))
    throw new Error("the invoked cotal package and its global bin link do not identify the same install");
  return prefix;
}

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
      // A separate process group keeps terminal interrupts out of npm's live replacement.
      // Keep the ChildProcess referenced and await close; this is not a background update.
      detached: true,
      windowsHide: true,
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
