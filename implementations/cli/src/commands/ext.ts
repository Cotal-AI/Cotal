import { spawn } from "node:child_process";
import { closeSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, relative, sep } from "node:path";
import { registry, type Command, type Connector, type FlagSpec, type FlagValues, type ParsedArgs } from "@cotal-ai/core";
import { CommandFailure, RESERVED_CONNECTOR_NAMES, beginExtensionNpmMutation, bindExtensionPeers, cacheExtensionServiceMetadata, cacheServicePreset, cacheCommand, cacheConnector, cacheExtension, cacheLocalProcess, cmdSpawnSpec, extensionLocalProcesses, extensionPackageDir, extensionProvides, extensionsDir, extensionsManifestPath, importExtensionEntry, installedExtensionPackage, readInstalledExtensionPackage, loadExtensionsManifest, loadMeshes, localProcessPath, parsePid, probeLiveness, providedWords, jsonFlag, plainFlag, presentationOf, provenance, saveExtensionsManifest, seededCommandsMismatch, writeResult, type InstalledExtension, type InstalledExtensionPackage, type LocalProcess, type LocalProcessContext, type Presentation, type Report, type ServicePreset } from "@cotal-ai/workspace";
import { c } from "../ui.js";
import { shellWord } from "../lib/endpoint-errors.js";
import { assertExtensionServiceInstancesStopped } from "../lib/service-instances.js";
import { cotalRoot } from "../lib/paths.js";
import { resolveSpace } from "../lib/status.js";
import { claimExtensionMutation, extensionUpdatePassOwnedBy } from "../lib/ext-mutation.js";
import { withInstallUmask } from "../lib/install-umask.js";
import { npmInvocation, npmLifecycleEnvironment } from "../lib/npm-invocation.js";
import { assertExtensionCorePeer } from "../lib/extension-core-peer.js";
import { runSeed } from "../seed/reconcile.js";
import { assertStageVerifier, stageExtensions } from "../lib/extension-stage.js";
import { connectorConfigDir, extensionReinstallAdvice, isExtensionPathSpec as isPathSpec, resolveExtensionEntry } from "@cotal-ai/workspace";
import { codeSpan, CorruptExtensionPackageError, CorruptExtensionsManifestError, inspectLock, extensionNpmMutationPath, oneLine, windowsShellWord, type OutputWarning } from "@cotal-ai/workspace";
import { displayCmd, selfArgv } from "../lib/self-exec.js";
import { spawnSync } from "node:child_process";
import { isAuthenticSeedChild, markSeedChildLive, clearChildMarker } from "../seed/lock.js";
import { cliVersion, seedStoreDir } from "../seed/paths.js";

export const extFlags = [
  jsonFlag,
  plainFlag,
  { name: "repair", type: "boolean", description: "seed: recover a lost ever-seeded authority from its durable backup" },
  { name: "reset", type: "boolean", description: "seed: discard the authority and re-seed all built-in connectors (resurrects removed ones)" },
  { name: "force", type: "boolean", description: "seed: re-seed the built-in connectors even when the stamp is current or a downgrade" },
] as const satisfies readonly FlagSpec[];

const usage = (message: string): CommandFailure => new CommandFailure("refused", "USAGE_INVALID", message);
const REGISTRY_SPEC = /^(@[^/@]+\/[^/@]+|[^/@]+)(@.*)?$/;
const EXT_USAGE = "usage: cotal ext [list] [--json|--plain] | ext add <npm-package> | ext remove <name> | ext root | ext seed [--repair|--reset|--force]";

/** Parent binding for update's internal isolated re-add. Ordinary `ext add` never reads it. */
export const EXT_UPDATE_PARENT_ENV = "COTAL_EXT_UPDATE_PARENT";

export { isPathSpec };

/** A first-party package named without a version installs this cotal's own version, as setup and
 *  `update` install it: the official packages release in lockstep with the core they link to, so the
 *  registry's newest may be a release this binary does not match. A version or tag given is kept. */
function atThisVersion(spec: string): string {
  return /^@cotal-ai\/[^/@]+$/.test(spec) ? `${spec}@${cliVersion()}` : spec;
}

export function validateExtArguments(args: ParsedArgs): void {
  const [sub, operand] = args.positionals;
  const v = args.values as FlagValues<typeof extFlags>;
  presentationOf(v);
  if (sub !== "seed" && (v.repair || v.reset || v.force)) {
    const flag = v.repair ? "--repair" : v.reset ? "--reset" : "--force";
    throw usage(`${flag} belongs to \`cotal ext seed\``);
  }
  if (sub === "seed" && [v.repair, v.reset, v.force].filter(Boolean).length > 1) {
    throw usage("cotal ext seed takes only one of --repair, --reset, or --force");
  }
  // `ext root` stays a raw path for `$(cotal ext root)`.
  if (sub !== undefined && (sub !== "list" || args.positionals.length !== 1) && (v.json || v.plain)) {
    throw usage(sub === "root" ? "ext root prints its path raw and has no --json or --plain" : `ext ${sub}: --json and --plain are taken by the listing only`);
  }
  if ((sub === "add" || sub === "remove") && (args.positionals.length !== 2 || !operand)) throw usage(EXT_USAGE);
  if (sub === "add" && operand && !isPathSpec(operand) && !REGISTRY_SPEC.test(operand))
    throw usage("unsupported extension spec - use a local path or a registry name[@version]; prefix a relative folder with ./");
  // A scope can start with a dot. The package after the slash cannot.
  if (sub === "remove" && operand && !/^(?:[a-z0-9-]|@[a-z0-9._-][a-z0-9._~-]*\/[a-z0-9_-])[a-z0-9._~-]*$/i.test(operand)) {
    throw usage(`invalid extension package name "${oneLine(operand)}". Give the package name as shown by \`cotal ext list\``);
  }
  if (sub === "seed" && args.positionals.length !== 1) throw usage("cotal ext seed takes no operands");
}

/**
 * `cotal ext` — operator-installed extensions. `add` installs an npm package into the
 * cotal-owned prefix (never the user's project), imports it ONCE so it self-registers into the
 * live `Registry`, verifies the registration actually landed, and caches every contributed key
 * plus command display metadata. From then on, help and <TAB> read the cache (no import), and
 * dispatch/provider resolution imports the package lazily with live objects.
 *
 * Add-time guarantees (design-review conditions — each converts a silent failure into a loud one):
 *  - shared `@cotal-ai/*` packages must be PEER dependencies of the extension; each is linked to
 *    the running binary's copy (core is mandatory — otherwise the extension registers into ITS
 *    OWN module's registry singleton and the binary never sees the commands; others, e.g.
 *    `@cotal-ai/workspace`, would silently drift from the binary's).
 *  - after import, the expected commands must have appeared in OUR registry, else the add fails.
 *  - a contributed name colliding with an existing command fails the add (builtins win).
 */

export async function ext(args: ParsedArgs): Promise<void> {
  validateExtArguments(args);
  const [sub, ...rest] = args.positionals;
  const v = args.values as FlagValues<typeof extFlags>;
  // Bare `cotal ext` lists the inventory: it is the most natural probe for "what's installed / where",
  // and these extensions never appear in `npm list -g` (they live in a cotal-owned prefix, not npm's
  // global tree), so erroring here left the honest answer undiscoverable.
  if (sub === undefined || (sub === "list" && !rest.length)) return list(presentationOf(v));
  if (sub === "add") return addExtension(atThisVersion(rest[0]!)).catch(exitOnInterruptedAdd);
  if (sub === "__update-add" && rest[0] && rest[1]) {
    if (Number(process.env[EXT_UPDATE_PARENT_ENV]) !== process.ppid)
      throw new Error("internal update extension replay must be launched by its recorded parent");
    if (!extensionUpdatePassOwnedBy(process.ppid))
      throw new Error("internal update extension replay requires its parent to own the extension update pass");
    return addExtension(rest[1], rest[0], true).catch(exitOnInterruptedAdd);
  }
  if (sub === "__stage-verify" && rest.length === 6) {
    const [pkg, spec, ownerConfig, nonce, parent, source] = rest as [string, string, string, string, string, string];
    assertStageVerifier(Number(parent), ownerConfig, nonce);
    const lines = await verifyCandidate(pkg, spec, extensionsDir(), loadExtensionsManifest().extensions, source === "seeded", false, console.error);
    for (const line of lines) console.log(line);
    return;
  }
  if (sub === "remove") return remove(rest[0]!);
  // `cotal ext root` prints just the prefix path — a one-line scripting primitive (cf. `npm root -g`,
  // `brew --prefix`) so tooling can locate the store without parsing the human inventory.
  if (sub === "root" && !rest.length) {
    console.log(extensionsDir());
    return;
  }
  if (sub === "seed") {
    const { repair, reset, force } = args.values as { repair?: boolean; reset?: boolean; force?: boolean };
    return runSeed({ repair, reset, force });
  }
  throw usage(EXT_USAGE);
}

async function npm(args: string[], prefix: string, seeding = false): Promise<{ status: number | null; output: string }> {
  // On Windows `npm` is `npm.cmd`; Node refuses to spawn a `.cmd` without a shell (CVE-2024-27980),
  // and a naive shell re-parses cmd metachars, so run it through cmd.exe with a byte-for-byte command
  // line (shared with the manager's PtyRuntime launch).
  // Use the same peer policy for installs and removals, including failed-add cleanup. Cotal links
  // its shared peers to the running binary's copies after npm changes the prefix.
  // The prefix verifier requires every host-compatible dependency, including native optional
  // packages. CLI inclusion wins over an ambient omit=optional, also when npm removes a sibling.
  // Select the extension prefix explicitly so Corepack never treats its ancestors as a project.
  const env = { ...process.env };
  delete env[EXT_UPDATE_PARENT_ENV];
  const npm = npmInvocation(env, [...args, "--prefix", prefix, "--include=optional", "--legacy-peer-deps"]);
  if (npm.missingOnPath && args[0] === "install" && !seeding)
    throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", "npm is not on PATH; the extension install did not start", {
      remedy: "make npm available on PATH, check that `npm --version` works, then retry the original extension install",
    });
  const { file, args: spawnArgs, windowsVerbatimArguments } = cmdSpawnSpec(npm.file, npm.args, npm.env);
  const seedGroup = seeding && process.platform === "linux";
  const mutation = beginExtensionNpmMutation(undefined, seedGroup);
  let published = false;
  let preservePending = false;
  let stopForwarding = () => {};
  let lifecycle: ReturnType<typeof npmLifecycleEnvironment>;
  try {
    lifecycle = npmLifecycleEnvironment(npm, prefix);
    const child = withInstallUmask(() => spawn(file, spawnArgs, { cwd: npm.cwd, env: lifecycle?.env ?? npm.env, windowsVerbatimArguments, detached: seedGroup, windowsHide: true }));
    if (seedGroup && child.pid !== undefined) {
      const pid = child.pid;
      const forward = (signal: NodeJS.Signals) => {
        try { process.kill(-pid, signal); } catch { /* npm's process group may have already exited */ }
      };
      const onInt = () => forward("SIGINT"), onTerm = () => forward("SIGTERM");
      process.on("SIGINT", onInt); process.on("SIGTERM", onTerm);
      stopForwarding = () => { process.off("SIGINT", onInt); process.off("SIGTERM", onTerm); };
    }
    let spawnError = "";
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer | string) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer | string) => { stderr += chunk.toString(); });
    child.once("error", (e) => { spawnError = `spawn error: ${e.message}\n`; });
    if (child.pid !== undefined) {
      try {
        mutation.markLive(child.pid);
        published = true;
      } catch (e) {
        spawnError = `could not journal npm child ${child.pid}: ${(e as Error).message}\n`;
        preservePending = true;
      }
    }
    let drain: ReturnType<typeof setTimeout> | undefined;
    if (seedGroup) child.once("exit", () => {
      // A descendant can keep npm's output pipes open after npm itself has exited. The
      // custody check below protects the prefix, so do not wait indefinitely on those pipes.
      drain = setTimeout(() => { child.stdout?.destroy(); child.stderr?.destroy(); }, 1000);
      drain.unref();
    });
    const closed = await new Promise<{ status: number | null; signal: NodeJS.Signals | null }>((resolveClose) =>
      child.once("close", (status, signal) => { clearTimeout(drain); resolveClose({ status, signal }); }),
    );
    if (published) mutation.complete(
      closed.status,
      closed.signal,
      closed.signal !== null
        ? `npm intermediary terminated by ${closed.signal}`
        : `Windows npm intermediary exited ${closed.status}; descendant completion is unproved`,
    );
    const output = `${spawnError}${stdout}${stderr}`.trim();
    return { status: spawnError ? null : closed.status, output: output || (closed.signal ? `npm terminated by ${closed.signal}` : "") };
  } catch (e) {
    return { status: null, output: `spawn error: ${(e as Error).message}` };
  } finally {
    stopForwarding();
    if (!published && !preservePending) mutation.clear();
    lifecycle?.dispose();
  }
}

/** Rebuild each installed package's private links after npm mutates the shared prefix: every
 * `recorded` package's and, with `candidate`, the operation's own. Keeping the links inside the
 * owning package prevents a later sibling add/remove from pruning its peers. A recorded package whose
 * directory is gone has no links to keep. `note` reports it with the command that reinstalls it and
 * the one that drops its entry, and the entry stays in the manifest. The reinstall command names a
 * third-party package's spec as a placeholder, because a recorded spec can be a URL that carries a
 * credential. */
function linkExtensionPeers(recorded: readonly InstalledExtension[], operationPkg: string, note: (line: string) => void, candidate = false, operationMetadata?: InstalledExtensionPackage): void {
  const onAbsent = (owner: string): void => {
    // Only a recorded package is skipped: the binder never skips the operation's own.
    const entry = recorded.find((e) => e.pkg === owner)!;
    const reinstall = entry.source === "seeded" ? "cotal ext seed --repair" : "cotal ext add <original-spec>";
    note(c.yellow(`! ${owner} is in the extensions manifest but not installed at ${extensionPackageDir(owner)}, so its shared peers were not linked`) +
      c.dim(` - \`${reinstall}\` reinstalls it, or \`cotal ext remove ${shellWord(owner)}\` drops the entry`));
  };
  const owners = [...recorded.map((entry) => entry.pkg), ...(candidate ? [operationPkg] : [])];
  for (const link of bindExtensionPeers(owners, operationPkg, { force: true, onAbsent, operationMetadata }))
    provenance.wrote(`${link.peer} link (${link.owner} → this CLI's copy)`, link.destination);
}

/** `cotal ext add <spec>`: install one extension into the operator prefix and record what it provides.
 *  `announce` takes the closing `✓ added` line; `cotal setup` sends it to stderr when stdout carries
 *  a result. A signal during the add rolls it back and throws {@link ExtensionAddInterrupted}. */
export async function addExtension(spec: string, expectedPkg?: string, borrowMutation = false, announce: (line: string) => void = console.log): Promise<void> {
  const dir = extensionsDir();
  // A file:/path spec is resolved to an absolute path so the prefix install works from any cwd.
  const isPath = isPathSpec(spec);
  const resolved = isPath ? resolve(spec) : spec;
  // The installed NAME is known BEFORE npm runs — never recovered afterwards by diffing the prefix
  // dependencies (a heuristic that binds to the wrong key if the prefix ever drifted, and that made
  // re-adding an installed extension impossible).
  const pkg = packageNameFromSpec(resolved, isPath);
  if (expectedPkg !== undefined && pkg !== expectedPkg)
    throw new Error(`recorded extension ${expectedPkg} now resolves to ${pkg} from spec "${spec}" - refusing to install a different package`);
  // A seed child runs UNDER the reconcile's mutation lock (its parent already holds it for the whole
  // run); claiming again would deadlock against the parent's live PID. It skips the claim, records a
  // liveness marker (so a post-crash repair won't race it), and stamps its entry `source:"seeded"`.
  // Authenticated: only an `ext add` whose marker matches the LIVE reconcile lock AND whose spec is a
  // staged official-connector path qualifies — a forged `COTAL_EXT_SEEDING` can't skip the lock.
  const seeding = isAuthenticSeedChild() && isPath && resolved.startsWith(seedStoreDir() + sep);
  const releaseMutation = seeding
    ? () => {}
    : claimExtensionMutation(borrowMutation ? { borrowUpdateParent: process.ppid } : {});
  // Upgrade the parent's pending marker to a live one carrying this child's PID, as the first act — so
  // a repair after a parent SIGKILL sees the exact orphan identity and refuses to race it.
  if (seeding) markSeedChildLive(process.env.COTAL_EXT_SEEDING as string, Number(process.env.COTAL_EXT_SEEDING_PARENT));
  try {
    if (seeding || expectedPkg !== undefined) {
      mkdirSync(dir, { recursive: true, mode: 0o755 });
      if (!existsSync(join(dir, "package.json"))) {
        // `wx`: a dangling link at the name passes the check above, and must not be followed.
        writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: "cotal-extensions", private: true }, null, 2)}\n`, { flag: "wx", mode: 0o644 });
        provenance.wrote("extensions prefix", join(dir, "package.json"));
      }
    }
    if (seeding) await addTransaction(pkg, resolved, expectedPkg, true, announce);
    else {
      // Official registry releases can be pinned out of lockstep and reconciled by update.
      const selector = resolved.slice(pkg.length + 1);
      const officialRelease = !isPath && pkg.startsWith("@cotal-ai/") && /^[a-z0-9._~^*<>=|+ -]*$/i.test(selector)
        && !/\.(?:tgz|tar(?:\.gz)?)$/i.test(selector);
      await installExtensionSet([{ pkg, spec: resolved }], announce, { checkCorePeer: expectedPkg === undefined && !officialRelease, ...(isPath ? { localOperand: spec } : {}) });
    }
  } finally {
    if (seeding) clearChildMarker();
    releaseMutation();
  }
}

export interface ExtensionInstallRequest {
  readonly pkg: string;
  readonly spec: string;
  readonly version?: string;
  readonly source?: "seeded";
}

// Out-of-prefix extraneous entries describe another tree, not dependencies of this prefix.
function dropForeignLockEntries(lock: { packages?: Record<string, { extraneous?: boolean }> }): void {
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    if (entry.extraneous === true && (key.startsWith("../") || isAbsolute(key))) delete lock.packages![key];
  }
}

/** Install a verified set off-line from readers, then promote its complete prefix once. Caller owns writer. */
export async function installExtensionSet(
  requests: readonly ExtensionInstallRequest[],
  announce: (line: string) => void = console.error,
  opts?: { isolate?: boolean; localOperand?: string; offline?: true; keep?: readonly string[]; checkCorePeer?: boolean },
): Promise<void> {
  if (!requests.length) return;
  const ownerConfig = connectorConfigDir();
  const owner = inspectLock(join(ownerConfig, ".extensions.lock"));
  if (owner.state !== "active" || owner.owner.pid !== process.pid) throw new Error("extension set requires its caller's prefix writer lock");
  const stage = stageExtensions();
  const manifestBefore = loadExtensionsManifest();
  const closing: string[] = [];
  const originalConfig = process.env.XDG_CONFIG_HOME;
  let interrupted = false;
  const interrupt = (): void => { interrupted = true; };
  process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt);
  try {
    // npm reads installed package paths physically. Use that spelling for its prefix and local file specs.
    const npmPrefix = realpathSync(stage.prefix);
    const livePrefix = join(realpathSync(ownerConfig), "extensions");
    // npm's hidden lock describes the copied node_modules at its original path.
    rmSync(join(npmPrefix, "node_modules", ".package-lock.json"), { force: true });
    // Keep missing local extensions in the inventory for explicit repair/removal, but do not ask npm
    // to reinstall them while reconciling other packages. Their original download directory may be gone.
    const absent = manifestBefore.extensions.filter(entry =>
      !requests.some(request => request.pkg === entry.pkg) &&
      lstatSync(join(stage.prefix, "node_modules", entry.pkg), { throwIfNoEntry: false }) === undefined);
    // Make all local dependency specs independent of the stage directory's later promotion.
    for (const name of ["package.json", "package-lock.json"]) {
      const path = join(stage.prefix, name);
      if (!existsSync(path)) continue;
      const value = JSON.parse(readFileSync(path, "utf8"), (_key, item: unknown) =>
        typeof item === "string" && item.startsWith("file:") ? `file:${resolve(livePrefix, item.slice(5))}` : item) as {
          dependencies?: Record<string, string>;
          packages?: Record<string, { dependencies?: Record<string, string>; extraneous?: boolean }>;
        };
      if (name === "package-lock.json") dropForeignLockEntries(value);
      const dependencies = name === "package.json" ? value.dependencies : value.packages?.[""]?.dependencies;
      for (const entry of absent) {
        if (!dependencies?.[entry.pkg]?.startsWith("file:")) continue;
        delete dependencies[entry.pkg];
        for (const key of Object.keys(value.packages ?? {})) {
          if (key === `node_modules/${entry.pkg}` || key.startsWith(`node_modules/${entry.pkg}/node_modules/`)) delete value.packages![key];
        }
      }
      writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
    }
    const kept = opts?.offline ? [...(opts.keep ?? [])] : [];
    const installing = requests.filter(request => !kept.includes(request.pkg));
    for (const request of installing) {
      if (packageNameFromSpec(request.spec, isPathSpec(request.spec)) !== request.pkg) throw new Error("extension set spec does not match its package");
      rmSync(join(stage.prefix, "node_modules", request.pkg), { recursive: true, force: true });
    }
    const mutationPath = extensionNpmMutationPath();
    const specs = installing.map(({ spec }) => isPathSpec(spec) ? realpathSync(spec) : spec);
    // npm's own update notifier can query the registry even in offline mode.
    const cacheOnly = opts?.offline ? ["--offline", "--update-notifier=false"] : [];
    const result = await npm(["install", "--save", "--no-audit", "--no-fund", "--install-links", ...cacheOnly, ...specs], npmPrefix);
    if (existsSync(mutationPath)) stage.retain();
    if (interrupted) throw new ExtensionAddInterrupted(requests[0]!.pkg);
    if (result.status !== 0) {
      const localFailure = opts?.localOperand === undefined ? undefined : localTarballFailure(result.output, npmPrefix, requests[0]!, opts.localOperand);
      throw new Error(localFailure ?? `extension set npm install failed: ${npmInstallFailure(result.output)}`);
    }
    process.env.XDG_CONFIG_HOME = stage.config;
    for (const request of installing) {
      const dir = join(npmPrefix, "node_modules", request.pkg);
      const meta = readInstalledExtensionPackage(request.pkg, dir);
      if (!meta || request.version !== undefined && meta.version !== request.version) throw new Error(`extension set installed an unexpected version of ${request.pkg}`);
      if (opts?.checkCorePeer) assertExtensionCorePeer(request.pkg, meta.peerDependencies?.["@cotal-ai/core"]);
      const entry = resolveExtensionEntry(dir, meta);
      if (!existsSync(entry)) {
        const path = codeSpan(`./${oneLine(relative(dir, entry).split(sep).join("/"))}`);
        const message = `the installed npm package ${oneLine(request.pkg)} is missing its entry ${path}.`;
        const operand = opts?.localOperand;
        if (operand === undefined) throw new Error(message);
        const word = oneLine(operand) !== operand ? undefined : process.platform === "win32" ? windowsShellWord(operand) : shellWord(operand);
        const pack = codeSpan(`npm pack --dry-run ${word ?? "<local-path>"}`);
        const retry = codeSpan(`${displayCmd()} ext add ${word ?? "<local-path>"}`);
        throw new Error(`${message} Check the package with ${pack}, then include the entry in \`files\` or generate it before rerunning ${retry}.`);
      }
    }
    const invocation = installing.length > 1 || opts?.isolate ? selfArgv() : undefined;
    for (const request of installing) {
      if (!invocation) {
        closing.push(...await verifyCandidate(request.pkg, request.spec, stage.prefix, loadExtensionsManifest().extensions, request.source === "seeded", false, console.error));
        continue;
      }
      const [file, ...argv] = invocation;
      const child = spawnSync(file!, [...argv, "ext", "__stage-verify", request.pkg, request.spec, ownerConfig, owner.owner.nonce, String(process.pid), request.source ?? "operator"], {
        encoding: "utf8", env: { ...process.env, COTAL_SKIP_CONNECTOR_SEED: "1" }, windowsHide: true,
      });
      if (child.stderr) process.stderr.write(child.stderr);
      if (child.status !== 0) throw new Error(`extension set verification failed for ${request.pkg}: ${child.stderr || child.error?.message || child.status}`);
      if (child.stdout) closing.push(child.stdout.trimEnd());
    }
    // The verifiers wrote one complete inventory inside the stage. Rebind every retained package,
    // including packages not changed by this pass, just as each former individual add did.
    linkExtensionPeers(loadExtensionsManifest().extensions, requests[0]!.pkg, console.error);
    for (const name of ["package.json", "package-lock.json"]) {
      const path = join(stage.prefix, name);
      if (!existsSync(path)) continue;
      const value = JSON.parse(readFileSync(path, "utf8"), (_key, item: unknown) => {
        if (typeof item !== "string" || !item.startsWith("file:")) return item;
        const destination = resolve(npmPrefix, item.slice(5));
        return `file:${relative(livePrefix, destination).split(sep).join("/")}`;
      });
      if (name === "package-lock.json") dropForeignLockEntries(value);
      writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
    }
    const verified = loadExtensionsManifest();
    const ordered = [...manifestBefore.extensions.map(entry => verified.extensions.find(candidate => candidate.pkg === entry.pkg)!).filter(Boolean),
      ...verified.extensions.filter(entry => !manifestBefore.extensions.some(prior => prior.pkg === entry.pkg))];
    saveExtensionsManifest({ extensions: ordered });
    if (originalConfig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalConfig;
    if (interrupted) throw new ExtensionAddInterrupted(requests[0]!.pkg);
    stage.promote();
    for (const line of closing) announce(line);
  } finally {
    process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt);
    if (originalConfig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalConfig;
    stage.discard();
  }
}

/** An `ext add` stopped by SIGINT or SIGTERM. `addExtension` throws it once the prefix and manifest
 *  are back as they were and its lock is released. */
export class ExtensionAddInterrupted extends Error {
  override readonly name = "ExtensionAddInterrupted";
  constructor(readonly pkg: string) {
    super(`adding ${pkg} was interrupted, so the extensions are as they were before it`);
  }
}

/** Ends a command whose add was interrupted with exit 130, and rethrows any other error. */
export function exitOnInterruptedAdd(e: unknown): void {
  if (!(e instanceof ExtensionAddInterrupted)) throw e;
  console.error(c.yellow(`! ${e.message}`));
  process.exitCode = 130;
}

/** Node's native `cpSync` (seen on 22.23 and 24.22) will not copy a symlink onto a symlink the
 *  destination already has, whatever `force` says: it throws EEXIST naming the parent directory. A
 *  staged add often carries a `.bin` link the prefix already holds, so remove each destination link
 *  the promotion is about to replace. */
function unlinkReplacedLinks(src: string, dest: string): void {
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const target = join(dest, entry.name);
    const existing = lstatSync(target, { throwIfNoEntry: false });
    if (entry.isSymbolicLink() && existing?.isSymbolicLink()) unlinkSync(target);
    else if (entry.isDirectory() && existing?.isDirectory()) unlinkReplacedLinks(join(src, entry.name), target);
  }
}

/** One add as a transaction over the prefix and its manifest: a failed or interrupted add leaves both
 *  as they were, and the add is announced only once it has committed. */
async function addTransaction(pkg: string, resolved: string, expectedPkg: string | undefined, seeding: boolean, announce: (line: string) => void): Promise<void> {
  const liveDir = extensionsDir();
  // Validate/read workstation state before npm can mutate the prefix; this snapshot also drives the
  // final replacement entry so the manifest and installed tree commit as one logical transaction.
  const manifest = loadExtensionsManifest();
  // npm installs in-place and may replace the package plus shared dependency/lock state before we
  // can validate it. A failed update must restore the previously working prefix byte-for-byte.
  const updating = manifest.extensions.some((entry) => entry.pkg === pkg) || existsSync(extensionPackageDir(pkg));
  const staging = !seeding && expectedPkg === undefined && !updating && !existsSync(extensionPackageDir(pkg));
  const rollbackRoot = updating ? mkdtempSync(join(dirname(liveDir), ".extensions.rollback-")) : undefined;
  const stageRoot = staging ? mkdtempSync(join(dirname(liveDir), ".extensions.stage-")) : undefined;
  const rollbackDir = rollbackRoot ? join(rollbackRoot, "extensions") : undefined;
  const stageDir = stageRoot ? join(stageRoot, "cotal", "extensions") : undefined;
  if (stageDir) {
    mkdirSync(stageDir, { recursive: true, mode: 0o755 });
    writeFileSync(join(stageDir, "package.json"), `${JSON.stringify({ name: "cotal-extensions", private: true }, null, 2)}\n`);
  }
  if (rollbackDir) {
    // Snapshot beside the prefix (same filesystem), preserving npm's relative symlinks verbatim.
    // npm mutates the live tree; rollback removes it and atomically renames this snapshot back.
    cpSync(liveDir, rollbackDir, { recursive: true, verbatimSymlinks: true });
    // npm otherwise treats a same-spec/same-version re-add as already current, even when the
    // installed files are stale or damaged. Remove only the disposable copy's package so install
    // must materialize it again; the untouched snapshot remains the rollback source.
    rmSync(extensionPackageDir(pkg), { recursive: true, force: true });
  }

  const configHome = process.env.XDG_CONFIG_HOME;
  let interrupted = false;
  const interrupt = (): void => {
    interrupted = true;
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  let added: string[];
  try {
    // The existing writer lock remains held while workspace helpers resolve into the stage.
    if (stageRoot) process.env.XDG_CONFIG_HOME = stageRoot;
    try {
      added = await installCandidate(pkg, resolved, stageDir ?? liveDir, manifest.extensions, seeding, stageDir !== undefined, announce);
    } finally {
      if (configHome === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = configHome;
    }
    if (interrupted) throw new ExtensionAddInterrupted(pkg);
    if (stageDir) {
      // npm records local specs relative to its prefix. Preserve their meaning after promotion.
      type NpmMetadata = { dependencies?: Record<string, string>; packages?: Record<string, { dependencies?: Record<string, string> }> };
      const metadata = (file: string, base = stageDir): NpmMetadata => JSON.parse(readFileSync(file, "utf8"), (_key, value: unknown) =>
        typeof value === "string" && value.startsWith("file:") ? "file:" + resolve(base, value.slice(5)) : value);
      const livePackage = metadata(join(liveDir, "package.json"), liveDir);
      const stagedPackage = metadata(join(stageDir, "package.json"));
      const dependencies = { ...livePackage.dependencies, ...stagedPackage.dependencies };
      const lockPath = join(liveDir, "package-lock.json");
      const liveLock = existsSync(lockPath) ? metadata(lockPath, liveDir) : {};
      const stagedLock = metadata(join(stageDir, "package-lock.json"));
      unlinkReplacedLinks(join(stageDir, "node_modules"), join(liveDir, "node_modules"));
      cpSync(join(stageDir, "node_modules"), join(liveDir, "node_modules"), { recursive: true, verbatimSymlinks: true });
      writeFileSync(join(liveDir, "package.json"), JSON.stringify({ ...livePackage, dependencies }, null, 2) + "\n");
      writeFileSync(lockPath, JSON.stringify({ ...liveLock, ...stagedLock,
        packages: { ...liveLock.packages, ...stagedLock.packages, "": { ...stagedLock.packages?.[""], dependencies } },
      }, null, 2) + "\n");
      copyFileSync(join(stageDir, "extensions.json"), extensionsManifestPath());
      rmSync(stageRoot!, { recursive: true, force: true });
    }
  } catch (e) {
    // Nothing has committed: put the prefix back the way the add found it.
    // A retained npm marker means the prefix may still have a writer. Do not roll it back underneath it.
    if (existsSync(extensionNpmMutationPath())) throw e;
    if (rollbackDir) {
      rmSync(liveDir, { recursive: true, force: true });
      renameSync(rollbackDir, liveDir);
      rmSync(rollbackRoot!, { recursive: true, force: true });
    } else if (stageRoot) {
      rmSync(stageRoot, { recursive: true, force: true });
    } else {
      await npm(["remove", "--no-audit", "--no-fund", "--install-links", pkg], liveDir, seeding);
      linkExtensionPeers(manifest.extensions, pkg, announce);
    }
    throw interrupted ? new ExtensionAddInterrupted(pkg) : e;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
  for (const line of added) announce(line);
  if (!rollbackRoot) return;
  // The add has committed, so a snapshot that cannot be removed is left over, not a failed add.
  try {
    rmSync(rollbackRoot, { recursive: true, force: true });
  } catch (e) {
    console.error(c.yellow(`! could not remove the previous copy of the extensions at ${rollbackRoot} (${(e as Error).message}); remove it by hand`));
  }
}

/** Installs `resolved` into the prefix at `dir`, checks what it registers against the `recorded`
 *  extensions and records it in that prefix's manifest. `staged`: `dir` is a fresh stage, which holds
 *  no other extension. `note` takes warnings as they happen; the returned lines announce the add, for
 *  the caller to print once it has committed. */
async function installCandidate(pkg: string, resolved: string, dir: string, recorded: readonly InstalledExtension[], seeding: boolean, staged: boolean, note: (line: string) => void): Promise<string[]> {
  console.error(c.dim(`installing ${resolved} into ${dir} …`));
  // --install-links: a file:/path spec is COPIED into the prefix, not symlinked — a symlink's
  // realpath would escape the prefix and Node could no longer resolve the linked core from it.
  const r = await npm(["install", "--save", "--no-audit", "--no-fund", "--install-links", resolved], dir, seeding);
  if (r.status !== 0) {
    fail(pkg, `npm install failed: ${npmInstallFailure(r.output)}`);
  }

  return verifyCandidate(pkg, resolved, dir, recorded, seeding, staged, note);
}

async function verifyCandidate(pkg: string, resolved: string, dir: string, recorded: readonly InstalledExtension[], seeding: boolean, staged: boolean, note: (line: string) => void): Promise<string[]> {
  // The spec's package must now be a prefix dependency — anything else is a failed install.
  let deps: Record<string, string>;
  try {
    deps = (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { dependencies?: Record<string, string> }).dependencies ?? {};
  } catch (e) {
    fail(pkg, `left unreadable prefix metadata: ${(e as Error).message}`);
  }
  if (!deps[pkg]) {
    fail(pkg, `npm install succeeded but it is not among the prefix dependencies - remove and retry`);
  }
  const pkgMeta = installedExtensionPackage(pkg);
  if (!pkgMeta) fail(pkg, `npm install left no package.json at ${extensionPackageDir(pkg)} - remove and retry`);

  // Shared @cotal-ai/* packages must be PEER dependencies — a regular dependency vendors a second
  // copy: core's would swallow the extension's registrations into its own registry singleton, and
  // any other shared package would silently drift from the binary's. Fail with the exact reason.
  const vendored = Object.keys(pkgMeta.dependencies ?? {}).filter((d) => d.startsWith("@cotal-ai/"));
  if (vendored.length) {
    fail(pkg, `declares ${vendored.join(", ")} as a regular dependency - shared @cotal-ai/* packages must be peerDependencies, or the extension runs its own copy (core's would swallow its command registrations; any other's drifts from this CLI's)`);
  }
  if (!pkgMeta.peerDependencies?.["@cotal-ai/core"]) {
    fail(pkg, `does not declare @cotal-ai/core as a peerDependency - a cotal CLI extension must (its extension objects register into core's registry)`);
  }
  // npm mutates the shared prefix, so restore every package's private shared-peer links, not only
  // the candidate's. All extensions resolve the exact same host package instances.
  try {
    linkExtensionPeers(staged ? [] : recorded.filter((entry) => entry.pkg !== pkg), pkg, note, true, pkgMeta);
  } catch (e) {
    fail(pkg, (e as Error).message);
  }

  // Import once; every registration must LAND IN OUR REGISTRY. Runtime-only and other provider
  // packages are first-class extensions too; commands are only the display/dispatch subset.
  const before = new Set(registry.all().map((ext) => `${ext.kind}:${ext.name}`));
  const version = pkgMeta.version;
  await importExtensionEntry(pkg, version, "the add was rolled back; replace this build", pkgMeta);
  const contributed = registry.all().filter((ext) => !before.has(`${ext.kind}:${ext.name}`));
  if (!contributed.length) {
    fail(pkg, `imported cleanly but registered no extensions in THIS CLI's registry - if it bundles its own @cotal-ai/core, make core a peerDependency`);
  }
  // `cotal` is reserved (the binary's own name — there is no runtime alias anymore); a connector must
  // never claim it, or `--agent cotal` would be ambiguous with the CLI.
  const reserved = contributed.find((ext) => ext.kind === "connector" && RESERVED_CONNECTOR_NAMES.includes(ext.name));
  if (reserved) fail(pkg, `contributes connector "${reserved.name}", which is a reserved name - a connector cannot be named ${RESERVED_CONNECTOR_NAMES.join(", ")}`);

  // Builtin collisions can't happen here (registry.register throws on a duplicate name or alias,
  // surfacing as failed-to-import above, naming the extension). OTHER installed extensions are
  // invisible to the registry during this add (they aren't imported), so their CACHED names and
  // aliases are checked explicitly — a duplicate fails the add under the same contract, naming both sides.
  for (const provided of contributed) {
    for (const word of providedWords(cacheExtension(provided))) {
      const other = recorded.find((e) =>
        e.pkg !== pkg && extensionProvides(e).some((ref) => ref.kind === provided.kind && providedWords(ref).includes(word)),
      );
      if (other) {
        fail(pkg, `contributes ${provided.kind} "${word}", already provided by installed extension ${other.pkg}@${other.version} - two extensions cannot claim one registry name or alias; \`cotal ext remove ${other.pkg}\` first if you want this one`);
      }
    }
  }
  const commands = contributed.filter((ext): ext is Command => ext.kind === "command");
  // The dispatcher resolves a seeded package's commands before its first seed, from the declared list.
  const mismatch = seeding ? seededCommandsMismatch(pkg, commands) : undefined;
  if (mismatch) fail(pkg, mismatch);
  const connectors = contributed.filter((ext): ext is Connector => ext.kind === "connector");
  const localProcesses = contributed.filter((ext): ext is LocalProcess => ext.kind === "local-process");
  const servicePresets = contributed.filter((ext): ext is ServicePreset => ext.kind === "service-preset").map(cacheServicePreset);
  const entry: InstalledExtension = {
    pkg,
    version,
    spec: resolved,
    ...(seeding ? { source: "seeded" as const } : {}),
    provides: contributed.map(cacheExtension),
    commands: commands.map(cacheCommand),
    connectors: connectors.map(cacheConnector),
    localProcesses: localProcesses.map(cacheLocalProcess),
    servicePresets,
    serviceMetadata: cacheExtensionServiceMetadata(pkg, version, localProcesses, servicePresets),
  };
  try {
    saveExtensionsManifest({ extensions: [...recorded.filter((e) => e.pkg !== pkg), entry] });
  } catch (e) {
    fail(pkg, `could not update the extensions manifest: ${(e as Error).message}`);
  }
  provenance.wrote(`extensions manifest (+${pkg}@${version})`, extensionsManifestPath());
  const providers = contributed.filter((ext) => ext.kind !== "commands");
  const pluralCommands = contributed.filter((ext) => ext.kind === "commands");
  return [
    c.green(`✓ added ${pkg}@${version}`) + (providers.length ? c.dim(` - provides: ${providers.map((ext) => `${ext.kind}:${ext.name}`).join(", ")}`) : ""),
    ...(pluralCommands.length
      ? [c.yellow(`  Registered ${pluralCommands.map((ext) => `commands:${oneLine(ext.name)}`).join(", ")} in the registry only. Use kind \`command\` in the extension to add a CLI command.`)]
      : []),
    ...(!entry.serviceMetadata && (servicePresets.length || localProcesses.some((component) => component.service !== undefined))
      ? [c.dim(`  its services cannot run on this platform: protected workstation file access is not available in this release`)]
      : []),
  ];
}

/** Explain a missing tarball only when npm's path matches a relative file dependency of the candidate. */
function localTarballFailure(output: string, prefix: string, request: ExtensionInstallRequest, operand: string): string | undefined {
  if (!/^npm (?:error|ERR!) code ENOENT\s*$/m.test(output)) return;
  const missing = /^npm (?:error|ERR!) path ([^\r\n]+)/m.exec(output)?.[1];
  if (!missing || !/\.(?:tgz|tar\.gz|tar)$/i.test(missing)) return;
  let meta: { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> };
  try {
    meta = JSON.parse(readFileSync(join(request.spec, "package.json"), "utf8"));
  } catch {
    return;
  }
  const installed = join(prefix, "node_modules", request.pkg);
  const match = Object.entries({ ...meta?.dependencies, ...meta?.optionalDependencies }).find(([, spec]) =>
    typeof spec === "string" && spec.startsWith("file:") && !isAbsolute(spec.slice(5)) && resolve(installed, spec.slice(5)) === missing);
  if (!match) return;
  const [dependency, spec] = match;
  const word = oneLine(operand) !== operand ? undefined : process.platform === "win32" ? windowsShellWord(operand) : shellWord(operand);
  const pack = codeSpan(`npm pack --dry-run ${word ?? "<local-path>"}`);
  const retry = codeSpan(`${displayCmd()} ext add ${word ?? "<local-path>"}`);
  return `npm could not install ${oneLine(request.pkg)}: it could not open the tarball for ${oneLine(dependency)} (${codeSpan(oneLine(spec))}). ` +
    `Check the source package with ${pack}. For local use, set the \`file:\` dependency to the absolute path of an existing archive, then rerun ${retry}. ` +
    "For distribution, use a dependency npm can install from a registry.";
}

/** Why `npm install` did not finish, as one line. A spawn that cannot find npm says so. Any other
 *  output keeps its last lines, joined, so a stored seed reason never carries a newline. */
function npmInstallFailure(output: string): string {
  const lines = output.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  if (lines.some((line) => /^spawn error: spawn npm ENOENT\b/.test(line))) return "npm is not on PATH";
  const tail = lines.slice(-8).join(" ");
  return tail || "npm install produced no output";
}

function fail(p: string, why: string): never {
  throw new Error(`${p} ${why}`);
}

/** The package NAME a spec installs, known BEFORE npm runs: a path spec reads its package.json;
 *  a registry spec carries the name (`name`, `name@range`, `@scope/name@range`). Exotic forms
 *  (git / tarball URLs) are refused rather than guessed at — there is no reliable way to know
 *  which prefix dependency such an install bound to. */
function packageNameFromSpec(resolved: string, isPath: boolean): string {
  if (isPath) {
    let meta: { name?: string };
    try {
      meta = JSON.parse(readFileSync(join(resolved, "package.json"), "utf8")) as { name?: string };
    } catch (e) {
      throw new Error(`can't read ${join(resolved, "package.json")}: ${(e as Error).message}`);
    }
    if (meta.name) return meta.name;
    throw new Error(`${join(resolved, "package.json")} declares no "name"`);
  }
  const m = REGISTRY_SPEC.exec(resolved);
  if (m) return m[1];
  throw new Error(`unsupported extension spec "${resolved}" - use a local path or a registry name[@version]`);
}

async function remove(pkg: string): Promise<void> {
  const releaseMutation = claimExtensionMutation();
  try {
    await removeUnlocked(pkg);
  } finally {
    releaseMutation();
  }
}

async function removeUnlocked(pkg: string): Promise<void> {
  const manifest = loadExtensionsManifest();
  const entry = manifest.extensions.find((e) => e.pkg === pkg);
  if (!entry) {
    console.log(`${pkg} is already absent. Nothing was removed.`);
    return;
  }
  assertExtensionServiceInstancesStopped(pkg);
  const processes = await extensionProcesses(entry);
  const recorded = processes.filter(({ pidPath }) => {
    if (!existsSync(pidPath)) return false;
    const before = lstatSync(pidPath);
    if (!before.isFile()) return true;
    const raw = readFileSync(pidPath, "utf8");
    const pid = parsePid(raw);
    if (pid === undefined || probeLiveness(pid) !== "dead") return true;
    // A concurrent startup may have replaced the stale record. Reclaim only the file we probed;
    // the create-only reservations below still fence startup for the duration of uninstall.
    const current = lstatSync(pidPath);
    if (current.dev !== before.dev || current.ino !== before.ino || readFileSync(pidPath, "utf8") !== raw) return true;
    rmSync(pidPath);
    return false;
  });
  if (recorded.length)
    throw new Error(`${pkg} still owns recorded local processes: ${recorded.map(describeProcess).join("; ")}. Stop or clean them from the listed mesh roots before removing the extension.`);

  // Reserve every provider pidfile through uninstall. A concurrent extension startup then loses
  // its own atomic pid claim instead of coming online after the liveness scan but before removal.
  const reservations: string[] = [];
  try {
    for (const { context, pidPath } of processes) {
      // Only real mesh roots participate, but reserve nested provider state directories even when
      // the process has never run so startup cannot create-and-claim them during npm removal.
      if (!existsSync(join(context.root, ".cotal"))) continue;
      mkdirSync(dirname(pidPath), { recursive: true, mode: 0o700 });
      let fd: number;
      try {
        fd = openSync(pidPath, "wx", 0o600);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST")
          throw new Error(`${pkg} acquired process state while removal was starting - stop it and retry`);
        throw e;
      }
      try { writeFileSync(fd, `removing:${process.pid}`); } finally { closeSync(fd); }
      reservations.push(pidPath);
    }
    assertExtensionServiceInstancesStopped(pkg);
    const r = await npm(["remove", "--no-audit", "--no-fund", "--install-links", pkg], extensionsDir());
    if (r.status !== 0) throw new Error(`npm remove failed:\n${r.output.split("\n").slice(-6).join("\n")}`);
    const remaining = manifest.extensions.filter((e) => e.pkg !== pkg);
    linkExtensionPeers(remaining, pkg, console.error);
    saveExtensionsManifest({ extensions: remaining });
    provenance.wrote(`extensions manifest (−${pkg})`, extensionsManifestPath());
    console.log(c.green(`✓ removed ${pkg}`) + c.dim(` - removed: ${extensionProvides(entry).map((ref) => `${ref.kind}:${ref.name}`).join(", ")}`));
  } finally {
    for (const pidPath of reservations) {
      try {
        if (readFileSync(pidPath, "utf8").trim() === `removing:${process.pid}`) rmSync(pidPath, { force: true });
      } catch {
        // A failed/racing startup may already have cleaned the reservation.
      }
    }
  }
}

interface ExtensionProcess {
  provider: LocalProcess;
  context: LocalProcessContext;
  pidPath: string;
}

/** Resolve every mesh-local pidfile owned by this extension. */
async function extensionProcesses(entry: InstalledExtension): Promise<ExtensionProcess[]> {
  const refs = extensionProvides(entry).filter((ref) => ref.kind === "local-process");
  if (!refs.length) return [];
  const providers = [...extensionLocalProcesses(entry)];
  const missing = refs.map((ref) => ref.name).filter((name) => !providers.some((provider) => provider.name === name));
  if (missing.length) {
    const reinstall = typeof entry.spec === "string" ? `\`cotal ext add ${entry.spec}\``
      : entry.source === "seeded" || entry.pkg.startsWith("@cotal-ai/") ? extensionReinstallAdvice(entry)
      : "use the original install spec";
    throw new Error(`${entry.pkg} predates cached local-process metadata for ${missing.join(", ")} - re-add it before removal: ${reinstall}`);
  }
  const currentRoot = cotalRoot();
  const contexts = new Map<string, LocalProcessContext>();
  contexts.set(currentRoot, { root: currentRoot, space: resolveSpace(currentRoot) });
  for (const mesh of loadMeshes()) contexts.set(mesh.root, { root: mesh.root, space: mesh.space });

  const processes: ExtensionProcess[] = [];
  for (const context of contexts.values()) {
    for (const provider of providers) {
      if (provider.controllerOnly) continue;
      processes.push({ provider, context, pidPath: localProcessPath(provider.pidFile, context) });
    }
  }
  return processes;
}

function describeProcess({ provider, context, pidPath }: ExtensionProcess): string {
  const raw = readFileSync(pidPath, "utf8").trim();
  if (raw.startsWith("removing:"))
    return `${provider.name} (extension-removal reservation) in ${context.root} - clean ${pidPath} if its owner is gone`;
  // "stale pidfile" is advice to delete the record, so only a pid proven dead gets it. Content
  // parsePid rejects and a pid whose liveness the kernel would not answer may each front a live
  // process, so they are named as such instead.
  const pid = parsePid(raw);
  const liveness = pid === undefined ? undefined : probeLiveness(pid);
  const state =
    pid === undefined ? `UNATTRIBUTABLE pidfile content ${JSON.stringify(raw)} - it may front a live process nobody can identify; inspect it, do not clean it blindly`
    : liveness === "alive" ? `pid ${pid}`
    : liveness === "unknown" ? `pid ${pid}, liveness INDETERMINATE - the kernel answered neither running nor gone (seccomp/LSM policy does this); verify before cleaning`
    : "stale pidfile";
  // A named `cotal down` is a service stop, and no command stops one extension's legacy process,
  // so the advice names the process or its record.
  const next =
    liveness === "alive" ? `stop pid ${pid}, then retry`
    : liveness === "dead" ? `delete ${pidPath}, then retry`
    : "resolve it, then retry";
  return `${provider.name} (${state}) in ${context.root} - ${next}`;
}

/** One recorded extension as the listing reports it. */
export interface ExtensionRow {
  readonly pkg: string;
  /** The manifest pin recorded at add time. */
  readonly version: string;
  /** What `ext add` was given, when recorded. */
  readonly spec?: string;
  /** Whether the built-in seed installed the entry. */
  readonly seeded: boolean;
  /** The `kind:name` refs the package registers. */
  readonly provides: readonly string[];
}

/** Keep every recorded pin, and check its on-disk metadata without loading the extension. */
function list(presentation: Presentation): void {
  let entries: readonly InstalledExtension[];
  try {
    entries = loadExtensionsManifest().extensions;
  } catch (error) {
    if (presentation !== "json" || !(error instanceof CorruptExtensionsManifestError)) throw error;
    throw new CommandFailure("refused", "SCHEMA_INVALID", error.diagnosis, { remedy: error.remedy, cause: error });
  }
  const warnings = entries.flatMap((entry): OutputWarning[] => {
    const dir = extensionPackageDir(entry.pkg);
    const path = join(dir, "package.json");
    let problem: string;
    try {
      const installed = installedExtensionPackage(entry.pkg);
      if (installed && installed.version === entry.version) return [];
      if (installed) problem = `is ${oneLine(installed.version)} on disk at ${dir}, but the manifest pins ${oneLine(entry.version)}`;
      else problem = lstatSync(dir, { throwIfNoEntry: false })
        ? `has a corrupt package at ${dir}: ${path} is missing`
        : `is not installed at ${dir}`;
    } catch (error) {
      problem = error instanceof CorruptExtensionPackageError
        ? `has a corrupt package.json at ${path}`
        : `could not be checked: ${path} is unreadable`;
    }
    return [{ code: "DEPENDENCY_UNAVAILABLE", target: { pkg: entry.pkg }, message: `Extension ${entry.pkg} ${problem}. ${extensionReinstallAdvice(entry)}` }];
  });
  writeResult(presentation, {
    command: "ext", target: null, result: { kind: "extensions", root: extensionsDir(), items: entries.map(extensionRow) },
    warnings,
    ...(warnings.length ? { completeness: "partial", partial: { message: "Some recorded extension packages could not be verified." } } : {}),
  }, extensionsView);
}

function extensionsView(r: { readonly root: string; readonly items: readonly ExtensionRow[] }): Report {
  return {
    sections: [
      { title: "Extensions", blocks: r.items.length ? [{
        kind: "table",
        columns: [{ key: "pkg", label: "Package" }, { key: "version", label: "Version" }, { key: "source", label: "Source" }, { key: "provides", label: "Provides" }],
        rows: r.items.map((row) => ({ pkg: row.pkg, version: row.version, source: row.seeded ? "included" : "added", provides: { text: row.provides.join(", "), tone: "hint" } })),
      }] : [{ kind: "lines", lines: ["No extensions installed."] }] },
      { blocks: [{ kind: "lines", lines: [{ text: "Cotal manages these packages separately from npm's global installation.", tone: "hint" }] }] },
      { title: "Next", blocks: [{ kind: "commands", items: [
        { command: "cotal x add <package>", description: "Install an extension" },
        { command: "cotal x remove <name>", description: "Remove one" },
        { command: "cotal x root", description: "Show the extension directory" },
      ] }] },
    ],
  };
}

function extensionRow(e: InstalledExtension): ExtensionRow {
  return {
    pkg: e.pkg,
    version: e.version,
    ...(typeof e.spec === "string" ? { spec: e.spec } : {}),
    seeded: e.source === "seeded",
    provides: extensionProvides(e).map((ref) => `${ref.kind}:${ref.name}`),
  };
}
