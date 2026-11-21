import { spawn as spawnProcess } from "node:child_process";
import { realpathSync, rmSync, statSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { resolve as resolvePath } from "node:path";
import {
  assertValidChannel,
  assertValidRole,
  agentFilePath,
  connectorServers,
  spawnEnvAllow,
  deprovisionAgent,
  discardLaunchArtifacts,
  reclaimWithChild,
  loadCotalConfig,
  modelPolicyRefusal,
  mintCreds,
  newIdentity,
  DEV_OWNER,
  parseShareSelection,
  assertLifecycleToken,
  mintLifecycleUid,
  MANAGED_HANDOFF_FILE_ENV,
  parseManagedLifecycleHandoff,
  provisionAgent,
  lowerPersonaEndpoints,
  copyPersonaEndpoints,
  registry,
  resolveAuthProvider,
  resolveReadAcl,
  peerLabel,
  type AgentDef,
  type CompletionResult,
  type Connector,
  type CotalConfig,
  type ExtensionRef,
  type FlagValues,
  type LaunchOpts,
  type LaunchSpec,
  type ParsedArgs,
  attemptCleanup,
  describeCleanupFailures,
  rejectionText,
  type CleanupFailure,
} from "@cotal-ai/core";
import {
  parseCommaList,
  CommandFailure,
  loadLaunchPersonaFile,
  personaFileReference,
  PersonaSourceError,
  inputDisabledByFlag,
  presentationOf,
  renderReport,
  agentLifecycleSecretFilePaths,
  agentSecretKeyForFile,
  cachedPreferences,
  findMesh,
  materializeSecretToFile,
  mergeLaunchOptions,
  parseLaunchOptions,
  preflightOrThrow,
  provenance,
  resolveAgentType,
  resolveOnPath,
  resolveTargetOrThrow,
  spaceKey,
  workspaceSecretStore,
  refreshRegistrationPolicy,
  oneLine,
  codeSpan,
  activateTerminalSeat,
  issueTerminalSeat,
  retireTerminalSeat,
  seatExpiryAt,
} from "@cotal-ai/workspace";
import { c, stderrLine } from "../ui.js";
import { withProvisioner } from "../lib/provisioner.js";
import { displayCmd } from "../lib/self-exec.js";
import { completedFlagValue, completingFlagValue, hasCompletedFlagValue, positionalsForCompletion } from "../lib/completion.js";
import { preflightOrExit, resolveTargetOrExit } from "../lib/connect.js";
import { onInstance } from "../lib/control.js";
import { askSpawnPlace } from "../lib/manager-choice.js";
import { canPrompt } from "./meshes-wizard.js";
import { listDeclaredChannels, listDeclaredRoles, listPersonaNames } from "../lib/personas.js";
import { personaCatalog } from "../lib/persona-files.js";
import { callerHarness, missingConnector, missingPersona, spawnPersona, spawnUsesManager } from "../lib/spawn-defaults.js";
import { writeDefaultPersonaForLaunch } from "../lib/default-persona.js";
import { spawnLaunchPreview } from "./spawn-preview.js";
import { protectedCredentialReference, readLocalRecordSource } from "../lib/protected-records.js";
import { AgentAlreadyRunning } from "../lib/held-name.js";
import { shellWord } from "../lib/endpoint-errors.js";
import { extensionNames, materializeExtension } from "../ext-loader.js";
import { claimManagedHandoff, holdsManagedHandoff, managedHandoffRefusal } from "../managed-handoff.js";
import {
  ENROLLMENT_URL_ENV,
  ENROLLMENT_FILE_ENV,
  stripTrailingNewline,
  enrollmentInput,
  scrubEnrollmentEnv,
  applyHandoffManagerInstance,
  checkEnrollmentBundle,
  HANDOFF_REFUSALS,
  handoffEnrollmentBundle,
  registerEnrollmentMesh,
  noExchangeEndpoint,
} from "./spawn-enrollment.js";
import { spawnFlags, spawnRerun } from "./spawn-flags.js";
import { connectorListed, refuseUnmintableName, launchManagedPersona, reportAlreadyRunning } from "./spawn-managed-launch.js";
import { uniqueMeshName, provisionFreshForeground, provisionRemoteUserForeground, provisionUserForeground } from "./spawn-foreground.js";
export { runBearerPreflight } from "./spawn-foreground.js";
export { launchServedHere, managedLaunchView, launchManagedPersona } from "./spawn-managed-launch.js";
export type { ManagedLaunchObserver } from "./spawn-managed-launch.js";
export { spawnFlags } from "./spawn-flags.js";
export { enrollmentInput, scrubEnrollmentEnv, applyHandoffManagerInstance, checkEnrollmentBundle, handoffEnrollmentBundle } from "./spawn-enrollment.js";
export type { EnrollmentBundle } from "./spawn-enrollment.js";
/** Completion for `cotal spawn` — `--space <TAB>` lists the running meshes, and the first positional
 *  is a persona from the mesh this spawn would target. Resolved OFFLINE (registry + `current`, no
 *  probe — a <TAB> must stay cheap and never open the network), so it lists the *target* mesh's
 *  personas, not the cwd's. */
export function spawnComplete(argv: string[]): CompletionResult {
  const flag = completingFlagValue(argv, spawnFlags);
  if (flag?.name === "agent" || flag?.name === "harness")
    return { items: registry.all<Connector>("connector").map((c) => ({ value: c.name })), directive: "nofiles" };
  if (flag?.name === "role")
    return { items: declaredFrom(argv, listDeclaredRoles).map((value) => ({ value, description: "declared role" })), directive: "nofiles" };
  if (flag?.name === "config") {
    const current = argv[argv.length - 1] ?? "";
    if (current.includes("/") || current.includes("\\") || current.endsWith(".md")) return { items: [], directive: "default" };
    return { items: personaItems(argv), directive: "nofiles" };
  }
  if (flag && ["subscribe", "allow-subscribe", "allow-publish"].includes(flag.name))
    return { items: declaredFrom(argv, listDeclaredChannels).map((value) => ({ value, description: "declared channel" })), directive: "nofiles" };
  if (flag && ["cwd", "file", "creds", "enrollment-file"].includes(flag.name)) return { items: [], directive: "default" };
  if (flag?.name === "runtime")
    return { items: ["pty", ...extensionNames("runtime")].filter((value, i, all) => all.indexOf(value) === i).map((value) => ({ value })), directive: "nofiles" };

  const positionals = positionalsForCompletion(argv, spawnFlags);
  // Only the first word after `spawn` is the persona positional; once it's typed, defer to the shell.
  if (positionals.length <= 1 && !hasCompletedFlagValue(argv, spawnFlags, "config") && !hasCompletedFlagValue(argv, spawnFlags, "file"))
    return { items: personaItems(argv), directive: "nofiles" };
  return { items: [], directive: "nofiles" };
}

/** The persona catalog root this spawn would read, resolved read-only as `persona show` resolves it,
 *  so a prepared space that is not started still lists its personas. */
const catalogRoot = (argv: string[]): string => personaCatalog({
  space: completedFlagValue(argv, spawnFlags, "space"),
  server: completedFlagValue(argv, spawnFlags, "server"),
}).root;

/** The personas this spawn would launch from. With no single target (no mesh, or several with no
 *  `current`) it fails CLOSED and offers none; `cotal spawn --space <TAB>` still lists the running
 *  meshes. A catalog folder that cannot be read throws, so the completion fails and names it. */
function personaItems(argv: string[]) {
  let root: string;
  try { root = catalogRoot(argv); }
  catch { return []; }
  return listPersonaNames(root).map((value) => ({ value }));
}

/** Channels/roles declared by the TARGET mesh's personas — the same root {@link personaItems}
 *  uses, so `--role`/`--subscribe` complete from the personas this spawn would actually launch
 *  rather than from whatever project the operator is standing in. Offline (no probe). With no single
 *  resolvable target it offers nothing. A resolved catalog that cannot be read, or a malformed persona
 *  file (see `declaredValues`), throws, so the completion fails and names the reason. */
function declaredFrom(argv: string[], list: (root: string) => string[]): string[] {
  let root: string;
  try { root = catalogRoot(argv); }
  catch { return []; }
  return list(root);
}

export { spawnPersona } from "../lib/spawn-defaults.js";

/** The expiry a seat started in this terminal asked for, in unix seconds, or `undefined` for none.
 *  A managed seat's credential is renewed by its manager, so the flags belong to this terminal. */
function seatExpiry(values: { "expires-in"?: string; "expires-at"?: string }, direct: boolean): number | undefined {
  if (!direct && (values["expires-in"] !== undefined || values["expires-at"] !== undefined))
    throw new CommandFailure("refused", "USAGE_INVALID", "--expires-in and --expires-at set the expiry of a seat this terminal starts; a manager renews its own seats' credentials", { remedy: "drop the flag, or drop -d and --on to run the seat here" });
  return seatExpiryAt(values);
}

/** Check the public mode and spelling before catalog preparation or identity allocation.
 *  Return the parsed channel overrides for the foreground policy. */
export function validateSpawnArguments(args: ParsedArgs) {
  const values = args.values as FlagValues<typeof spawnFlags>;
  const handoffRefusal = managedHandoffRefusal();
  if (handoffRefusal) throw handoffRefusal;
  presentationOf(values);
  if (args.positionals[0] !== undefined && !args.positionals[0].trim())
    throw new CommandFailure("refused", "USAGE_INVALID", "persona cannot be empty", { remedy: "name a persona, or omit it to use the default persona" });
  if (values.resume !== undefined && !values.resume.trim())
    throw new CommandFailure("refused", "USAGE_INVALID", "--resume needs a session id (got an empty value)");
  // `runCli` has already taken the handoff into custody and deleted its variable.
  const internal = holdsManagedHandoff() || Boolean(process.env[ENROLLMENT_URL_ENV] || process.env[ENROLLMENT_FILE_ENV]);
  if (!holdsManagedHandoff() && (values["expect-owner"] !== undefined || values["expect-lifecycle-uid"] !== undefined))
    throw new CommandFailure("refused", "USAGE_INVALID", `--expect-owner and --expect-lifecycle-uid apply only with ${MANAGED_HANDOFF_FILE_ENV}`);
  const direct = values.foreground === true || internal || !spawnUsesManager(values);
  if (values.file !== undefined && (args.positionals.length || values.config !== undefined)) throw new CommandFailure("refused", "USAGE_INVALID", "choose one positional persona or --file/-f, not multiple explicit persona sources");
  if (!internal && values.config !== undefined) throw new CommandFailure("refused", "USAGE_INVALID", "--config is reserved for persisted internal launch callers", {
    remedy: "use `cotal spawn <persona>` for a catalog name or `cotal spawn --file <persona-file>` for a file",
  });
  if (values.file !== undefined) { try { personaFileReference(values.file); } catch (error) { throw new CommandFailure("refused", "SCHEMA_INVALID", (error as Error).message); } }
  if (values["allow-stale"] !== undefined) throw new CommandFailure("refused", "USAGE_INVALID", "manifest deployment options belong to `cotal team deploy <file>`, not spawn");
  if (values.runtime !== undefined && !values.runtime.trim()) throw new CommandFailure("refused", "USAGE_INVALID", "--runtime cannot be empty");
  if (values.runtime !== undefined && direct) throw new CommandFailure("refused", "USAGE_INVALID", "--runtime chooses the runtime of one managed seat; a spawn in this terminal has no manager runtime to choose", { remedy: "add -d, or --on <instance>, to launch it through a manager" });
  // Every manager refuses `auto` for one seat, so it is refused here on any host.
  if (values.runtime?.trim() === "auto") throw new CommandFailure("refused", "USAGE_INVALID", "--runtime auto chooses a manager's own runtime, not the runtime of one seat", { remedy: "omit --runtime to use the serving manager's runtime" });
  if (values["enrollment-file"] !== undefined && !values.space) throw new CommandFailure("refused", "USAGE_INVALID", "--enrollment-file requires an explicit --space");
  if (values["enrollment-file"] !== undefined && !direct) throw new CommandFailure("refused", "UNSUPPORTED", "this native enrollment path runs one foreground seat. It does not substitute for managed enrollment authority");
  if (values["enrollment-file"] !== undefined && (internal || values.detach || values.creds !== undefined || values.on !== undefined)) throw new CommandFailure("refused", "USAGE_INVALID", "choose one foreground enrollment source without a manager pin, credential override or internal handoff");
  if (values.harness !== undefined && values.agent !== undefined) throw new CommandFailure("refused", "USAGE_INVALID", "choose --harness/-H or the legacy --agent spelling, not both");
  if (values.detach && direct) throw new CommandFailure("refused", "USAGE_INVALID", "--detach and direct foreground execution are different launch modes");
  if (direct && ((!values["dry-run"] && (values.json || values.plain)) || values.creds !== undefined || values.on !== undefined)) {
    const without = [...(!values["dry-run"] && values.json ? ["--json"] : []), ...(!values["dry-run"] && values.plain ? ["--plain"] : []), ...(values.creds !== undefined ? ["--creds"] : []), ...(values.on !== undefined ? ["--on"] : [])];
    const foreground = `omit ${without.join(", ")} to launch in this terminal`;
    const managed = values.foreground ? "replace --foreground with -d" : "add -d";
    throw new CommandFailure("refused", "USAGE_INVALID", "a spawn in this terminal takes no structured receipt, manager credential or manager pin", { remedy: internal ? foreground : `${foreground}, or ${managed} to launch through a manager and get a receipt once the agent joins`, selfContained: true });
  }
  if ((values.restarts === undefined) !== (values["restart-window"] === undefined)) throw new CommandFailure("refused", "USAGE_INVALID", "--restarts and --restart-window must be supplied together");
  if (values.restarts !== undefined) {
    if (direct) throw new CommandFailure("refused", "USAGE_INVALID", "restart supervision belongs to a managed launch, not a spawn in this terminal", { remedy: "add -d, or --on <instance>, to launch it through a manager" });
    for (const field of ["restarts", "restart-window"] as const) if (!/^[1-9][0-9]*$/.test(values[field]!) || !Number.isSafeInteger(Number(values[field])))
      throw new CommandFailure("refused", "USAGE_INVALID", `--${field} must be a positive safe integer`);
  }
  if (values["live-only"] && !direct) throw new CommandFailure("refused", "USAGE_INVALID", "--live-only belongs to direct foreground execution");
  seatExpiry(values, direct);
  if (!values["dry-run"] && !direct && !values.detach && (values.json || values.plain || inputDisabledByFlag() || !process.stdin.isTTY || !process.stdout.isTTY))
    throw new CommandFailure("refused", "USAGE_INVALID", "attaching to a manager's launch needs usable input and output terminals before an identity is allocated", { remedy: "add -d to wait for readiness without attaching, or drop --on to run it in this terminal", selfContained: true });
  for (const field of ["harness", "agent", "model", "variant", "name", "cwd"] as const) if (values[field] !== undefined && !values[field]!.trim())
    throw new CommandFailure("refused", "USAGE_INVALID", `--${field} cannot be empty`);
  if (values.events && values["no-events"]) throw new CommandFailure("refused", "USAGE_INVALID", "choose --events or --no-events, not both");
  if (values.on !== undefined) onInstance(values.on, spawnRerun(values, args.positionals));
  try {
    parseLaunchOptions(values.opt);
    if (values.role !== undefined) assertValidRole(values.role);
    parseShareSelection(values["share-tools"]);
  } catch { throw new CommandFailure("refused", "USAGE_INVALID", "invalid launch options, native role or tool-sharing selection; use declared keys and unique key=value option pairs"); }
  const channels = {
    subscribe: parseCommaList(values.subscribe),
    "allow-subscribe": parseCommaList(values["allow-subscribe"]),
    "allow-publish": parseCommaList(values["allow-publish"]),
  };
  for (const [flag, list] of Object.entries(channels)) {
    for (const channel of list ?? []) {
      try { assertValidChannel(channel); }
      catch (error) {
        throw new CommandFailure("refused", "USAGE_INVALID", `--${flag}: ${oneLine((error as Error).message)}`, {
          selfContained: true,
          ...(channel.startsWith("#") ? { remedy: `pass the channel without its #, as ${JSON.stringify(channel.slice(1))}` } : {}),
        });
      }
    }
  }
  if (channels.subscribe !== undefined && channels["allow-subscribe"] !== undefined) {
    try { resolveReadAcl(channels.subscribe, channels["allow-subscribe"]); }
    catch (error) {
      throw new CommandFailure("refused", "USAGE_INVALID", oneLine((error as Error).message), {
        remedy: "include every --subscribe channel in --allow-subscribe", selfContained: true,
      });
    }
  }
  if (!internal && args.positionals.length > 1) throw new CommandFailure("refused", "USAGE_INVALID", "spawn takes one persona; pass the kickoff request with --prompt/-p");
  if (!internal && values.config !== undefined && args.positionals.length) throw new CommandFailure("refused", "USAGE_INVALID", "choose one persona input, not both a positional name and --config");
  return channels;
}

/** Foreground `cotal spawn` resolves its `--agent` connector from the registry (spawn.ts below); on
 *  the published binary nothing static-imports connectors, so the resolved one is materialized as a
 *  required extension (seeded or `ext add`ed), failing loud if absent. The `-f` manifest launch
 *  preflights every type via `preflightConnectors`, and `--detach` resolves the connector
 *  manager-side, so both skip this.
 *
 *  #869: the persona file's `agent:` pin participates — flag > file > COTAL_DEFAULT_AGENT > default
 *  — but the pin is only knowable from the TARGET mesh's root, which `resolveTargetOrExit` owns and
 *  this pre-parse hook cannot reach without duplicating the five-tier target precedence. An earlier
 *  revision read the persona from the cwd walk here; that made a spawn from a cwd outside the
 *  target pre-materialize the WRONG connector, and a wrong pre-materialization hard-aborts the
 *  command (materializeExtension throws on an uninstalled extension) before the body ever loads
 *  the correct persona. The materialization is therefore DEFERRED into the spawn body, immediately
 *  after the authoritative persona load and before registry.resolve — one resolver, one root, and
 *  the hook stays root-free exactly as it was before #869. */
export function spawnRequiredExtensions(_args: ParsedArgs): readonly ExtensionRef[] {
  return [];
}

/**
 * `cotal spawn [<persona>] [--file <persona-file>]` runs the native application in this terminal.
 * `--detach` launches it through a manager and returns after readiness, and `--on <instance>`
 * launches it through that manager and attaches to its allocated incarnation. File validation
 * belongs to the execution host.
 *
 * The launch recipe is the connector's `buildLaunch` (the single source of truth,
 * shared with the manager); only *how the spec runs* differs — foreground exec
 * here vs. a supervised runtime in the manager. The connector is resolved from
 * the registry by agent type, composed at the root.
 *
 * The mesh it joins — creds and personas together — is resolved by `resolveMeshTarget` (in @cotal-ai/workspace), so a
 * bare `cotal spawn <persona>` from any directory finds the running mesh (one up, or the `current`
 * default) instead of mistaking `~/.cotal` for a space.
 */
export async function spawn(args: ParsedArgs): Promise<void> {
  const positionals = args.positionals;
  const channels = validateSpawnArguments(args);
  const values = { ...args.values, ...(typeof args.values.harness === "string" ? { agent: args.values.harness } : {}), ...(typeof args.values.file === "string" ? { config: personaFileReference(args.values.file) } : {}) } as FlagValues<typeof spawnFlags>;
  if (values["dry-run"]) return spawnLaunchPreview({ ...args, values });
  // Claimed first: custody already removed the file and its variable, so the text lives only here
  // and no refusal below can leave it anywhere.
  const handoffText = claimManagedHandoff();
  let enrollmentUrl: string | undefined;
  try {
    if (values["enrollment-file"] !== undefined) {
      const path = resolvePath(values["enrollment-file"]);
      protectedCredentialReference(path);
      const bytes = readLocalRecordSource(path, 256 * 1024, true);
      if (!bytes) throw new CommandFailure("refused", "TARGET_NOT_FOUND", "the enrollment input file was not found; no enrollment was redeemed");
      let source: string;
      try { source = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new CommandFailure("refused", "SCHEMA_INVALID", "the private enrollment file is not valid UTF-8; its contents were not echoed"); }
      enrollmentUrl = stripTrailingNewline(source);
      if (!enrollmentUrl) throw new CommandFailure("refused", "SCHEMA_INVALID", "the private enrollment file is empty");
    } else enrollmentUrl = enrollmentInput();
  } catch (e) {
    if (e instanceof CommandFailure) throw e;
    throw new CommandFailure("refused", "SCHEMA_INVALID", "the one-seat enrollment source could not be read; its contents were not echoed and no enrollment was redeemed");
  } finally {
    // The URL is the credential. Keep the local value, but remove both input forms before this
    // command can start extension, bearer-preflight, or harness children.
    scrubEnrollmentEnv(process.env);
  }
  let redeemedEnrollment: ReturnType<typeof checkEnrollmentBundle> | undefined;
  let handoffManagerInstanceId: string | undefined;
  if (handoffText !== undefined) {
    const refusal =
      enrollmentUrl ? `${MANAGED_HANDOFF_FILE_ENV} cannot be combined with ${ENROLLMENT_URL_ENV}/${ENROLLMENT_FILE_ENV}`
      : values.detach || values.file || values.creds ? `${MANAGED_HANDOFF_FILE_ENV} applies only to a foreground persona spawn without --creds`
      : !values.space || !values.name || !values["expect-owner"] || !values["expect-lifecycle-uid"]
        ? `${MANAGED_HANDOFF_FILE_ENV} requires --space, --name, --expect-owner and --expect-lifecycle-uid`
      : !values.config ? `${MANAGED_HANDOFF_FILE_ENV} requires --config <persona-file>`
      : !process.env.COTAL_MANAGER_INSTANCE?.trim() ? `${MANAGED_HANDOFF_FILE_ENV} requires COTAL_MANAGER_INSTANCE`
      : undefined;
    if (refusal) {
      stderrLine("✗ ", `${refusal}`, c.red);
      process.exit(1);
    }
    try {
      loadLaunchPersonaFile(resolvePath(values.config!));
    } catch (e) {
      stderrLine("✗ ", `cannot load the managed handoff persona: ${(e as Error).message}`, c.red);
      process.exit(1);
    }
    try {
      handoffManagerInstanceId = assertLifecycleToken(process.env.COTAL_MANAGER_INSTANCE!.trim(), "COTAL_MANAGER_INSTANCE");
      const handoff = parseManagedLifecycleHandoff(handoffText, {
        space: values.space!, owner: values["expect-owner"]!, actor: values.name!, lifecycleUid: values["expect-lifecycle-uid"]!,
      });
      try {
        spaceKey(handoff.space);
      } catch {
        throw new Error(HANDOFF_REFUSALS.space);
      }
      const { bundle, stock } = handoffEnrollmentBundle(handoff);
      redeemedEnrollment = { bundle, stock };
      let registered: boolean;
      try {
        registered = findMesh(handoff.space) !== undefined;
      } catch {
        throw new Error(HANDOFF_REFUSALS.registration);
      }
      if (!registered) await registerEnrollmentMesh(stock, resolvePath(values.config!, ".."), HANDOFF_REFUSALS);
    } catch (e) {
      stderrLine("✗ ", `${(e as Error).message}`, c.red);
      process.exit(1);
    }
  }
  if (enrollmentUrl && values.detach) {
    stderrLine("✗ ", `${ENROLLMENT_URL_ENV}/${ENROLLMENT_FILE_ENV} apply only to a foreground persona spawn`, c.red);
    process.exit(1);
  }
  if (enrollmentUrl && !values.space) {
    stderrLine("✗ ", `${ENROLLMENT_URL_ENV}/${ENROLLMENT_FILE_ENV} require --space <s>`, c.red);
    process.exit(1);
  }
  // On a terminal, keep the native default and announce live Manager alternatives.
  // Only --detach or --on requests managed placement.
  if (handoffText === undefined && enrollmentUrl === undefined && values.foreground !== true && !spawnUsesManager(values) && values.file === undefined
    && values.config === undefined && !values["live-only"] && !values.json && !values.plain && canPrompt()) {
    const place = await askSpawnPlace(values, process.argv.slice(2));
    if (place === null) process.exit(0);
    if (place) values.on = place.instanceId;
  }
  const direct = values.foreground === true || handoffText !== undefined || enrollmentUrl !== undefined || !spawnUsesManager(values);
  const enrollmentBootstrap = Boolean(enrollmentUrl && values.space && !findMesh(values.space));
  if (enrollmentBootstrap) {
    if (!values.config || (!values.config.includes("/") && !values.config.includes("\\") && !values.config.endsWith(".md"))) {
      stderrLine("✗ ", "enrollment bootstrap needs --config <persona-file>; no remote persona catalog exists on this machine yet", c.red);
      process.exit(1);
    }
    try {
      loadLaunchPersonaFile(resolvePath(values.config));
    } catch (e) {
      stderrLine("✗ ", `cannot load the enrollment bootstrap persona: ${(e as Error).message}`, c.red);
      process.exit(1);
    }
  }

  // Explicit files retain the execution host's path semantics. A manager pin is meaningful for
  // either managed persona spelling; direct execution has no manager placement to select.
  if (values.on !== undefined && direct) {
    stderrLine("✗ ", "--on pins a managed imperative launch; a spawn in this terminal does not take that manager selector", c.red);
    process.exit(1);
  }
  if (values.model !== undefined && !values.model.trim()) {
    console.error("--model needs a model name (got an empty value)");
    process.exit(1);
  }
  if (values.variant !== undefined && !values.variant.trim()) {
    console.error("--variant needs a variant name (got an empty value)");
    process.exit(1);
  }
  // Parse `--opt k=v` pairs once, up front — a malformed pair fails loud before either launch path
  // (foreground or detached) does any work. The opaque map is core-agnostic; the connector validates.
  let cliLaunchOptions: Record<string, string> | undefined;
  try {
    cliLaunchOptions = parseLaunchOptions(values.opt);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
  // The AG-UI event plane is ON by default. `--events` still forces on; `--no-events` is the only
  // opt-out. The flag ARMS the emitter; the manager separately
  // grants publish on the channel the connector names. Both are required, which is what stops a
  // hand-written grant from turning events on by itself.
  if (values.events && values["no-events"]) {
    stderrLine("✗ ", "--events and --no-events are mutually exclusive", c.red);
    process.exit(1);
  }
  // #373: the detached path sends the bit ONLY when the operator chose it. `--events` gives
  // true, `--no-events` gives false, neither gives undefined — the manager's spawn gate treats
  // an explicit true from a non-admin caller as operator reach and serves an omission unarmed
  // with a notice, so an unconditional default-true would be refused for an ordinary actor.
  const events = values.events ? true : values["no-events"] ? false : undefined;

  // A manager runs it only with --detach or --on, and the persona then stays on the manager's
  // execution host. Every other spawn keeps the native custody path below, in this terminal.
  if (!direct) return launchManagedPersona(values, positionals, events, cliLaunchOptions);
  // `--creds` names a CONTROL-CALLER credential (reach an off-registry manager) — meaningless for
  // a foreground launch, which provisions the agent's own creds. Fail loud, never ignore.
  if (values.creds) {
    stderrLine("✗ ", "--creds is only valid with --detach (it authenticates the manager control call)", c.red);
    process.exit(1);
  }
  let launchCwd: string | undefined;
  if (values.cwd !== undefined) {
    const requestedCwd = resolvePath(values.cwd);
    let reason: string | undefined;
    try {
      launchCwd = realpathSync(requestedCwd);
      if (!statSync(launchCwd).isDirectory()) reason = "is not a directory";
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      reason = code === "ENOENT" ? "does not exist" : code === "ENOTDIR" ? "is not a directory" : `cannot be used (${oneLine((error as Error).message)})`;
    }
    if (reason !== undefined) throw new CommandFailure("refused", "TARGET_UNAVAILABLE", `--cwd ${JSON.stringify(requestedCwd)} ${reason}. Nothing was launched.`, {
      target: { path: requestedCwd }, remedy: "pass an existing directory to --cwd",
    });
  }

  // An enrollment may bootstrap the stock remote user-mesh record before normal target resolution.
  // Redeem only when the named space is not registered; an existing entry defers redemption until
  // after persona resolution so the response actor can be checked against the requested identity.
  if (enrollmentBootstrap) {
    let provider: ReturnType<typeof resolveAuthProvider>;
    try {
      provider = resolveAuthProvider();
      if (!provider.postAgentEnrollment)
        throw new Error(`the registered auth provider "${provider.name}" cannot redeem remote agent enrollments`);
      const body = await provider.postAgentEnrollment({ url: enrollmentUrl! });
      const actor = typeof (body as { actor?: unknown })?.actor === "string" ? (body as { actor: string }).actor : "";
      if (!actor) throw new Error("the enrollment endpoint returned no actor - it cannot launch this seat");
      redeemedEnrollment = checkEnrollmentBundle(body, actor);
      if (redeemedEnrollment.bundle.space !== values.space)
        throw new Error(`the enrollment is for space "${redeemedEnrollment.bundle.space}" but --space names "${values.space}"`);
      if (!redeemedEnrollment.stock)
        throw new Error("space is not registered and the enrollment bundle carries no stock { server, tlsRequired, userAuth } mesh material");
      await registerEnrollmentMesh(redeemedEnrollment.stock, resolvePath(values.config!, ".."));
    } catch (e) {
      stderrLine("✗ ", `${(e as Error).message}`, c.red);
      process.exit(1);
    }
  }

  // Which mesh this spawn joins — creds + personas together, resolved from --server/--space, the
  // selected `current` mesh, a local project, or the registry's only running mesh. A handoff's
  // resolution diagnostics quote its space, and only a remote user-auth record can host the
  // lifecycle it carries, so any other record is refused before a later step reads it.
  const target = handoffText === undefined
    ? await resolveTargetOrExit({ server: values.server, space: values.space })
    : await resolveTargetOrThrow({ server: values.server, space: values.space }).catch(() => {
      stderrLine("✗ ", `${HANDOFF_REFUSALS.target}`, c.red);
      process.exit(1);
    });
  if (handoffText !== undefined && !(target.mode === "user" && target.userAuth?.remote)) {
    stderrLine("✗ ", "the managed handoff's space is registered here as a local mesh, so it cannot host a managed handoff", c.red);
    process.exit(1);
  }
  let policy: typeof target.policy;
  try {
    policy = await refreshRegistrationPolicy(target);
  } catch (e) {
    stderrLine("✗ ", `${handoffText === undefined ? (e as Error).message : HANDOFF_REFUSALS.policy}`, c.red);
    process.exit(1);
  }
  const eventsRequired = policy?.events === "required";
  // A handoff's space is a value from the document, so its policy refusals name the field instead.
  const policySpace = handoffText === undefined ? `space "${target.space}"` : "the managed handoff's space";
  if (eventsRequired && values["no-events"]) {
    stderrLine("✗ ", `${policySpace} requires the event plane by registration policy; --no-events is not allowed`, c.red);
    process.exit(1);
  }
  const { space, server, auth } = target;
  // Only a static mesh's seat carries an issuance whose expiry the person sets here.
  if ((values["expires-in"] !== undefined || values["expires-at"] !== undefined) && (target.mode === "user" || !auth))
    throw new CommandFailure("refused", "USAGE_INVALID", `--expires-in and --expires-at set the expiry of a seat's issued credential on a static mesh, and mesh "${space}" is ${target.mode === "user" ? "a user-auth mesh, where the seat's bearer comes from your login" : "open and mints no credential"}`, { remedy: "drop the flag" });

  // Where the config lives: --config, else the positional <persona>, else the persona preference
  // (.cotal/agents/<name>.md under the TARGET mesh's root). With none, fall back to its `default`
  // persona — `cotal spawn` with no args launches `<root>/.cotal/agents/default.md`.
  const { ref, from: personaFrom } = spawnPersona(values.config, positionals, { space, preferences: cachedPreferences() });
  const personaProject = resolvePath(target.personaRoot, "..", "..");
  const path = values.file !== undefined || (redeemedEnrollment && values.config) ? resolvePath(ref) : agentFilePath(personaProject, ref);
  // The product default of a catalog nothing prepared, as a Cloud space's is until a spawn, is
  // written from the shipped template here and launched. A named or preferred persona is the
  // user's own choice, so one that is missing is still refused.
  const implicitDefault = ref === "default" && personaFrom === undefined && values.config === undefined && handoffText === undefined && redeemedEnrollment === undefined;
  let def: AgentDef;
  try {
    def = loadLaunchPersonaFile(path);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (!(implicitDefault && code === "ENOENT")) {
      if (e instanceof PersonaSourceError) throw new CommandFailure("refused", "SCHEMA_INVALID", e.message, { target: { space, path }, ...(e.remedy ? { remedy: e.remedy } : {}) });
      // The not-found text names the mesh's space and server, which for a handoff are its values.
      if (handoffText !== undefined) {
        stderrLine("✗ ", `cannot load the managed handoff persona: ${(e as Error).message}`, c.red);
      } else if (code === "ENOENT") {
        const missing = missingPersona(target, ref, personaFrom, path);
        throw new CommandFailure("refused", "TARGET_NOT_FOUND", missing.message, { target: { space, path }, remedy: missing.remedy });
      } else {
        stderrLine("✗ ", `${(e as Error).message}`, c.red);
      }
      process.exit(1);
    }
    let written: string | undefined;
    try {
      written = writeDefaultPersonaForLaunch(personaProject);
    } catch (writeError) {
      const missing = missingPersona(target, ref, personaFrom, path);
      throw new CommandFailure("refused", "PERMISSION_DENIED", `${missing.message}, and the shipped one could not be written there: ${(writeError as Error).message}`, { target: { space, path }, remedy: missing.remedy });
    }
    if (written !== undefined) provenance.wrote("default persona", written);
    def = loadLaunchPersonaFile(path);
  }

  // Provenance: say which persona file WON resolution (--config > positional > preference > default)
  // — the user must never wonder which directory their agent's definition came from.
  provenance.read("persona", path);

  // --name / --role override the file (name defaults from the file's frontmatter).
  const requested = values.name ?? def.name;
  const role = values.role ?? def.role;
  // Flags win over the file, resolved once: the model policy below judges these values and the
  // connector launches on them. Left to the connector, the model is re-read from the persona at
  // launch, after the check, so an edit in between would launch a model the policy never saw.
  const model = values.model ?? def.model;
  const variant = values.variant ?? def.variant;
  // Opaque connector options: `--opt` flags win per key over the persona's `launchOptions:`.
  const launchOptions = mergeLaunchOptions(def.launchOptions, cliLaunchOptions);
  if (redeemedEnrollment && redeemedEnrollment.bundle.actor !== requested) {
    stderrLine("✗ ", `the enrollment is for actor "${redeemedEnrollment.bundle.actor}" but this spawn names "${requested}"`, c.red);
    process.exit(1);
  }
  // #867: same door as the detached path — the effective identity (flag or file) must be mintable
  //  before any provision work; core's own refusal names the offender and the `_` remedy.
  refuseUnmintableName(requested, target.mode === "user");
  // #581: the same per-role model allowlist the manager enforces on a detached spawn, judged on the
  // effective role, model (flag over file) and launch options before anything is provisioned or launched.
  let cotalConfig: CotalConfig;
  try {
    cotalConfig = loadCotalConfig(personaProject);
    const refusal = modelPolicyRefusal(cotalConfig, {
      persona: `persona "${ref}" (${path})`,
      role, model, variant,
      modelFlag: values.model !== undefined,
      variantFlag: values.variant !== undefined,
      launchOptions,
    });
    if (refusal) {
      stderrLine("✗ ", `${refusal}`, c.red);
      process.exit(1);
    }
  } catch (e) {
    stderrLine("✗ ", `${(e as Error).message}`, c.red);
    process.exit(1);
  }

  // Preflight: fail with one sentence if the mesh is down or won't take our creds, instead of
  // crashing mid-connect with a raw NATS Authorization Violation.
  if (handoffText === undefined) await preflightOrExit(target);
  else
    await preflightOrThrow(target).catch(() => {
      stderrLine("✗ ", `${HANDOFF_REFUSALS.preflight}`, c.red);
      process.exit(1);
    });

  // User mode allocates during guarded provisioning below, without a static operator credential.
  // Static/open mode keeps its advisory roster check. Every launch field uses the allocated name.
  // That numbering is uncapped: static and open mode key the actor on the minted nkey, so the name
  // has no length to fit. The user-mode numbering, which stops at the actor bound, happens inside the
  // guarded provisioning below.
  let name = target.mode === "user" ? requested : await uniqueMeshName(requested, { space, server, auth });

  const agentType = resolveAgentType({ flag: values.agent, pin: def.agent, callerDefault: callerHarness(space) });
  // Materialize the connector HERE, after the authoritative persona load (#869): the harness choice
  // (flag > persona pin > env > default) is only final once the target root has supplied the file.
  // On the published binary nothing static-imports connectors, so this import-from-manifest is what
  // puts the chosen one in the registry before the resolve below; an uninstalled connector fails
  // loud with its install hint. Doing this in `spawnRequiredExtensions` (pre-parse, pre-target)
  // instead would need a SECOND root resolution that can disagree with this one — the regression a
  // cold read of this PR caught — so the hook stays root-free and the materialization lives here.
  try {
    await materializeExtension({ kind: "connector", name: agentType });
  } catch (e) {
    if (!connectorListed(agentType)) throw missingConnector(agentType, { space, path });
    stderrLine("✗ ", `${(e as Error).message}`, c.red);
    process.exit(1);
  }
  let connector: Connector;
  try {
    connector = registry.resolve<Connector>("connector", agentType);
  } catch (e) {
    stderrLine("✗ ", `${(e as Error).message}`, c.red);
    process.exit(1);
  }
  const binaryPins: Record<string, string | undefined> = { opencode: process.env.COTAL_OPENCODE_BIN, codex: process.env.COTAL_CODEX_BIN };
  const missing = (connector.requires ?? []).filter((bin) => !resolveOnPath(binaryPins[bin]?.trim() || bin));
  if (missing.length) {
    const binaries = missing.join(", ");
    const guide = ["claude", "codex", "opencode", "jcode", "hermes", "pi"].includes(agentType) ? `https://docs.cotal.ai/docs/connect-${agentType}/` : "https://docs.cotal.ai/docs/connectors/";
    const message = `${agentType} needs ${binaries} on PATH; nothing was launched`;
    const install = `Follow ${guide} to install ${binaries}`;
    if (agentType === "hermes") {
      if (process.env.COTAL_HERMES_ADOPT_HOME?.trim()) {
        throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", message, {
          target: { space, path },
          remedy: `${install} and check the adopted Hermes profile's requirements before retrying.`,
        });
      }
      if (!model) {
        const example = codeSpan(`${displayCmd()} spawn --harness hermes --no-events --model <model>`);
        throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", `${message}. A managed Hermes profile needs a model. Set one with --model or the agent file's model: field.`, {
          target: { space, path },
          remedy: `${install}. For a basic launch: ${example}`,
        });
      }
    }
    throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", message, {
      target: { space, path },
      remedy: `${install}, then retry: \`${displayCmd()} spawn ${args.raw.map(shellWord).join(" ")}\``,
    });
  }
  if (variant && !connector.supportsModelVariant) {
    throw new CommandFailure("refused", "USAGE_INVALID", `${agentType} connector does not support model variants (variant)`, { target: { space, path } });
  }
  if (values.prompt !== undefined && !connector.supportsPrompt) {
    throw new CommandFailure("refused", "USAGE_INVALID", `${agentType} connector does not support an initial prompt (prompt)`, { target: { space, path } });
  }
  // Which of the operator's personal MCP servers to share with this agent: declared in the cotal
  // config (global ~/.config/cotal + the target mesh's .cotal), narrowed by an optional
  // --share-tools selection. Without a selection the connector keeps its native discovery default.
  // Resolved before provisioning, so a selection naming an undeclared server refuses while there is
  // still nothing to roll back.
  const shareTools = parseShareSelection(values["share-tools"]);
  const mcpServers = connectorServers(cotalConfig, agentType, shareTools);
  // The operator's spawn-env policy travels the same route: absent means no extras (the OS
  // allow-list + operator knobs + connector-declared inputs), present means those names too.
  // Resolved HERE, like the servers above, because a connector never reads the config file itself.
  const envAllow = spawnEnvAllow(cotalConfig);

  // Auth mode (`.cotal/auth` present): mint a stable identity + scoped creds for this agent
  // and pre-create its bind-only durables, via a short-lived privileged provisioner — the
  // same onboarding the manager does, so the foreground launch joins the authed mesh too.
  // Open mode (no `.cotal/auth`): the session connects without creds, under an allocated id.
  let id: string | undefined;
  let credsPath: string | undefined;
  // A static seat's issuance (SPEC 13.15): the token it reads its generation with, and the
  // lifecycle whose gate the retirement closes.
  let acceptedToken: string | undefined;
  let seat: { actor: string; alias: string; lifecycleUid: string } | undefined;
  // The incarnation's lifecycle UID (SPEC 13.1), minted once per spawn: the launched endpoint binds
  // its lifecycle-keyed dm/dlv/chathist durables by it (auth modes pin the same names in the cred;
  // open mode still needs it for the durable names). A foreground spawn is one lifecycle. `let`
  // because a REMOTE provisioning replaces it below: the mesh minted that incarnation, and its
  // durables and ledger row are keyed on ITS uid — a locally minted one can never match them.
  let lifecycleUid = mintLifecycleUid();
  let userAuth: LaunchOpts["userAuth"];
  // Which user-auth arm produced `userAuth`: the REMOTE provisioning path (an enrollment or the
  // advertised endpoint) or the local provider. The departure sentence below names what THAT arm's
  // cleanup actually does (#1837): the local arm's cleanup revokes the row, the remote arm's
  // shreds only this machine's credential files and leaves the mesh-side grant standing.
  let remoteUserAuth = false;
  let userCleanup: (() => Promise<void>) | undefined;
  // The agent's access policy (flags > persona file) — minted into the creds AND forwarded to the
  // connector (COTAL_SUBSCRIBE / COTAL_ALLOW_*) so the session's runtime read/post set matches its
  // credentials. One source, so a `--subscribe` override can't land in the creds yet be lost at
  // runtime (the connector would otherwise read only the persona file and miss the override).
  let subscribe = channels.subscribe ?? def.subscribe;
  let allowSubscribe: string[];
  try {
    allowSubscribe = resolveReadAcl(subscribe ?? [], channels["allow-subscribe"] ?? def.allowSubscribe);
  } catch (e) {
    stderrLine("✗ ", `${(e as Error).message}`, c.red);
    process.exit(1);
  }
  let allowPublish = channels["allow-publish"] ?? def.allowPublish;
  // The AG-UI event plane, refused HERE for the same reason the manager refuses it before
  // provisioning: a connector that cannot emit must stop the launch while there is still nothing to
  // roll back. The GRANT cannot be derived yet, because it is keyed on the principal and in user
  // mode the owner is resolved inside the provisioning call below.
  // Default events on only where supported. An explicit request or registration policy still refuses below.
  const launchEvents = eventsRequired || events === true || (events !== false && !!connector.eventChannel);
  const eventPayloads = policy?.eventPayloads !== "withheld" && !values["no-event-payloads"] && def.eventPayloads !== false;
  if (launchEvents && !connector.eventChannel) {
    console.error(c.red(eventsRequired
      ? `✗ ${policySpace} requires the event plane by registration policy, but connector "${connector.name}" does not publish one`
      : `✗ connector "${connector.name}" does not publish an AG-UI event plane; omit --events to launch it without one`));
    process.exit(1);
  }
  const launchOpts: LaunchOpts = {
    space, name, role, servers: server, configPath: path,
    model, variant, launchOptions, subscribe, allowSubscribe, allowPublish,
    endpoints: copyPersonaEndpoints(def.endpoints) ?? [], prompt: values.prompt,
    resume: values.resume, events: launchEvents, eventPayloads, eventsRequired,
    mcpServers, mcpServersExclusive: shareTools !== undefined, envAllow,
    // Keep the foreground directory on the child spawn. Connector cwd marks a supervised seat.
    workspaceRoot: target.root,
  };
  try {
    if (connector.supportsLaunchValidation) connector.buildLaunch({ ...launchOpts, validateOnly: true });
  } catch (error) {
    throw new CommandFailure("refused", "USAGE_INVALID", rejectionText(error), { target: { space, path } });
  }
  // A REMOTE user mesh (registered with `meshes add --from`) that advertises a provisioning
  // endpoint: the mesh grants the row and pre-creates the durables inside the owner's envelope,
  // because the material to do that locally — the space's owner secret and account signer — only
  // exists where the mesh runs. Checked BEFORE the local user branch, whose first act would be to
  // ask for exactly that absent material and refuse.
  const remoteProvisioningUrl = target.mode === "user" && target.userAuth?.remote
    ? target.userAuth.endpoints?.agentProvisioningUrl
    : undefined;
  if (target.mode === "user" && target.userAuth?.remote && !remoteProvisioningUrl && !enrollmentUrl && !redeemedEnrollment) {
    stderrLine("✗ ", `mesh "${target.space}" runs elsewhere and advertises no agent-provisioning endpoint, so agents cannot be provisioned from this machine`, c.red);
    console.error(c.dim(`  a user-mode agent's credentials are granted where the mesh's signer lives; ask the mesh operator to advertise one (\`cotal up --agent-provisioning-url …\`), run the agent there, or add -d to launch it through one of your managers`));
    process.exit(1);
  }
  // The persona's endpoint commands (SPEC 13.15). A user-auth mesh grants endpoint access through the
  // service owner's records, so a persona that names the field is refused there, `[]` included. On a
  // static mesh the operator's own spawn mints them; an open mesh mints nothing.
  if (target.mode === "user" && def.endpoints !== undefined)
    throw new CommandFailure("refused", "UNSUPPORTED", `persona ${path} names \`endpoints\`, and on a per-user auth mesh endpoint access comes from the service owner's grants, which a persona cannot hand on (SPEC 13.15)`, { target: { space, path }, remedy: "drop `endpoints` from the persona, and grant the agent with `cotal service-endpoint grant` once it runs" });
  const endpointCapabilities = lowerPersonaEndpoints(def.endpoints);
  // Said once every check above has passed, so a refusal is never read as a launch that started.
  console.error(renderReport({ space, sections: [{ title: "Direct application", blocks: [{ kind: "lines", lines: ["This is native foreground execution, not a detachable Cotal view.", { text: "Native exit, Ctrl-C or terminal loss may end this process. No crash or reboot survival is promised.", tone: "hint" }] }] }] }, "rich", process.stderr));
  // Auth mode provisions the identity and writes its creds after launch-argument validation, but
  // launch materialization or child exec can still fail. The SAME
  // retirement serves a failed provisioning or launch (rollback) and the normal foreground
  // departure: each spawn mints a fresh identity, so an exited agent's footprint (creds file, DM/DLV
  // durables, ACL row) is dead weight no future spawn reuses — mirror the manager's `deprovision`
  // with an ephemeral, target-pinned deprovisioner cred. Best-effort like the manager's (a SIGKILLed
  // CLI can't run it; the residue is the same class a crashed manager leaves). A no-op in open mode.
  let retired = false;
  const retireProvision = async (why: string): Promise<void> => {
    // Bound when called: the static arm assigns id and credsPath after this closure is created.
    const targetId = id;
    const credsFile = credsPath;
    if (retired || !auth || !targetId || !credsFile) return;
    retired = true;
    // The store delete is the authoritative removal; the rmSync clears the FS materialization
    // (byte-identical locally). The broker teardown mints its own credential, so a creds file that
    // cannot be removed must not leave the durables and ACL row behind.
    const failed: CleanupFailure[] = [];
    // Retiring the seat's issuance gate ends its evidence, so a helper it spawned can no longer be
    // bounded against a seat that has gone.
    const issuedSeat = seat;
    if (issuedSeat) await attemptCleanup(failed, "issuance gate", () => retireTerminalSeat({ server, space, tlsRequired: target.tlsRequired, auth }, issuedSeat));
    await attemptCleanup(failed, "creds secret", () => workspaceSecretStore(target.root).delete(agentSecretKeyForFile(credsFile, space)));
    await attemptCleanup(failed, "creds file", () => rmSync(credsFile, { force: true }));
    await attemptCleanup(failed, "broker teardown", () =>
      mintCreds(auth, newIdentity(), "deprovisioner", { deprovisionTarget: { principal: targetId, lifecycleUid } })
        .then((dc) => deprovisionAgent({ servers: server, space, targetId, lifecycleUid, creds: dc })));
    if (failed.length) stderrLine("✗ ", `cleaning up after ${name}: ${describeCleanupFailures(failed)}`, c.red);
    else console.error(`  ↩ retired creds for ${name} (${why})`);
  };
  if (target.mode === "user" && target.userAuth?.remote && (enrollmentUrl || redeemedEnrollment)) {
    if (!redeemedEnrollment) {
      // The record alone decides this refusal, and the redemption below spends the enrollment.
      if (!target.userAuth.endpoints?.url) {
        stderrLine("✗ ", `${noExchangeEndpoint(space)}`, c.red);
        process.exit(1);
      }
      try {
        const provider = resolveAuthProvider();
        if (!provider.postAgentEnrollment)
          throw new Error(`the registered auth provider "${provider.name}" cannot redeem remote agent enrollments`);
        const body = await provider.postAgentEnrollment({ url: enrollmentUrl!, idpUrl: target.userAuth.idp.url });
        redeemedEnrollment = checkEnrollmentBundle(body, name);
      } catch (e) {
        stderrLine("✗ ", `${(e as Error).message}`, c.red);
        process.exit(1);
      }
    }
    const enrolled = redeemedEnrollment.bundle;
    if (enrolled.space !== space) {
      stderrLine("✗ ", `the enrollment is for space "${enrolled.space}" but this spawn targets "${space}"`, c.red);
      process.exit(1);
    }
    if (enrolled.idp.url !== target.userAuth.idp.url || enrolled.idp.issuer !== target.userAuth.idp.issuer || enrolled.idp.audience !== target.userAuth.idp.audience) {
      stderrLine("✗ ", "the enrollment's IdP pins do not match the registered mesh", c.red);
      process.exit(1);
    }
    if (target.userAuth.endpoints?.url !== enrolled.authServiceUrl) {
      stderrLine("✗ ", "the enrollment's authServiceUrl does not match the registered mesh exchange", c.red);
      process.exit(1);
    }
    const remote = await provisionRemoteUserForeground(target, name, { body: enrolled, exchangeUrl: enrolled.authServiceUrl },
      handoffText === undefined ? undefined : HANDOFF_REFUSALS);
    userAuth = remote.userAuth;
    userCleanup = remote.cleanup;
    remoteUserAuth = true;
    if (remote.material.subscribe) subscribe = remote.material.subscribe;
    if (remote.material.allowSubscribe) allowSubscribe = remote.material.allowSubscribe;
    if (remote.material.allowPublish) allowPublish = remote.material.allowPublish;
    lifecycleUid = remote.material.lifecycleUid;
  } else if (remoteProvisioningUrl) {
    const selected = await provisionFreshForeground(requested, values.name === undefined, target.mode === "user", (candidate) =>
      provisionRemoteUserForeground(target, candidate, { provisioningUrl: remoteProvisioningUrl }))
      .catch((e: unknown) => { if (e instanceof AgentAlreadyRunning) return e; throw e; });
    if (selected instanceof AgentAlreadyRunning) return reportAlreadyRunning(selected, values, target.space, target.server);
    name = selected.name;
    const remote = selected.provisioned;
    userAuth = remote.userAuth;
    userCleanup = remote.cleanup;
    remoteUserAuth = true;
    // The mesh's grant is the authority on what this agent may read and post; the launch forwards
    // it verbatim so the session's runtime set matches the credentials it was actually issued.
    // A local --subscribe that the mesh did not grant would be a lie told to the connector.
    if (remote.material.subscribe) subscribe = remote.material.subscribe;
    if (remote.material.allowSubscribe) allowSubscribe = remote.material.allowSubscribe;
    if (remote.material.allowPublish) allowPublish = remote.material.allowPublish;
    // Same authority rule for the incarnation uid: the mesh provisioned the durables and wrote the
    // ledger row keyed on THIS uid, and the auth callout mints the agent's dm/dlv/chathist grants
    // from the row. Launching with the locally minted uid instead leaves the agent asking for
    // durables its credential does not name — an endless bind/violation loop, not a clean refusal.
    lifecycleUid = remote.material.lifecycleUid;
  } else if (target.mode === "user") {
    // USER mesh: the agent runs as a ledger-granted (owner, actor) principal under the LOGGED-IN
    // operator's owner — never a static identity (U10). Provisioning + grant + a one-shot bearer
    // preflight all happen BEFORE launch, so the spawned agent is never the first to discover a
    // dead auth plane.
    let eventGrant: string | undefined;
    const selected = await provisionFreshForeground(requested, values.name === undefined, true, (candidate) =>
      provisionUserForeground(target, candidate, ref, {
        eventPayloads,
        subscribe,
        allowSubscribe,
        allowPublish,
        role,
        capabilities: def.capabilities,
        lifecycleUid,
        liveOnly: values["live-only"] as boolean | undefined,
        ...(launchEvents ? { eventChannel: connector.eventChannel! } : {}),
      }));
    name = selected.name;
    ({ userAuth, cleanup: userCleanup, eventChannel: eventGrant } = selected.provisioned);
    // The launch's post-set is forwarded to the session as COTAL_ALLOW_PUBLISH, so it has to carry
    // whatever was actually minted. Letting the two diverge is how an agent ends up holding a right
    // its own runtime does not know it has.
    if (eventGrant) allowPublish = [...(allowPublish ?? []), eventGrant];
  } else if (auth) {
    const identity = newIdentity();
    // What the retirement needs is recorded before the first durable exists, so a throw anywhere from
    // provisioning through the creds write can still find and remove the footprint.
    id = identity.id;
    // LIFECYCLE-KEYED, as the manager keys its own spawns: the file embeds this incarnation's uid, so
    // the retirement can only remove this incarnation's credential, never a same-name spawn's or the
    // operator's standing `<name>.creds` (#3857).
    credsPath = agentLifecycleSecretFilePaths(target.root, space, name, lifecycleUid).creds;
    // THE EVENT GRANT, from the principal this spawn ALLOCATED. Static mode keys on the nkey, never
    // on the display name: a name is not an identity, and the manager derives the same subject from
    // the same connector function, so a foreground and a detached spawn of one persona land on one
    // channel rather than two.
    if (launchEvents) allowPublish = [...(allowPublish ?? []), connector.eventChannel!({ owner: DEV_OWNER, actor: identity.id })];
    // Foreground provisions the SAME durable footprint as `--detach` (DM/DLV durables + read-ACL
    // row): the daemon authorizes durable joins off the ACL row and leave is agent self-service, so
    // no managing host is required — and a silently live-only foreground agent permanently loses
    // every channel message posted while its connection blips (reconnect deliberately re-opens the
    // core-subs without re-backfill). `--live-only` opts back out; on a mesh with no delivery
    // daemon the boot join itself reports live-only, ACL row or not. A failed provisioner stop
    // never reaches this catch, so it cannot retire a credential the provisioning already minted.
    try {
      const creds = await withProvisioner({ space, servers: server, auth }, "spawn-provisioner", async (prov) => {
        // The seat's lifecycle is activated first, so the issuance can name its gate as the source of
        // the evidence a helper's spawn is bounded by.
        const seatTarget = { server, space, tlsRequired: target.tlsRequired, auth };
        seat = { actor: identity.id, alias: name, lifecycleUid };
        await activateTerminalSeat(seatTarget, seat);
        return issueTerminalSeat(seatTarget, seat, seatExpiry(values, true), (issue) => {
          acceptedToken = issue.issued.acceptedToken;
          return provisionAgent(prov, auth, identity, {
            eventPayloads,
            subscribe,
            allowSubscribe,
            allowPublish,
            role,
            capabilities: def.capabilities,
            ...(endpointCapabilities.length ? { endpointCapabilities } : {}),
            ...(values["live-only"] ? { durableMembership: false } : {}),
            lifecycleUid,
            expiresAt: issue.expiresAt,
            issued: issue.issued,
            issuance: issue.issuance,
          });
        });
      });
      // Store first (the source of truth), then materialize — the child's launch reads this FILE.
      // The CLI is the local FS composition (byte-identical), same posture as the manager's spawn.
      const secrets = workspaceSecretStore(target.root);
      await secrets.put(agentSecretKeyForFile(credsPath, space), creds);
      await materializeSecretToFile(secrets, agentSecretKeyForFile(credsPath, space), credsPath);
    } catch (e) {
      await retireProvision("provisioning failed");
      throw e;
    }
    provenance.wrote(`creds for ${name} (auth mode)`, credsPath);
  } else {
    // Without a declared id the endpoint self-mints a fresh actor per process, which no event
    // channel can name. The manager allocates one for every non-user launch, so this does too.
    id = newIdentity().id;
  }

  // From here through a successful child launch, a THROW must undo whatever this spawn provisioned —
  // the user-mode actor grant (userCleanup) OR the static-auth creds + broker footprint
  // (retireProvision) — otherwise a buildLaunch/spawn rejection (unsupported resume/model/`--opt`,
  // a bad connector) leaves the just-granted identity standing. The planes are exclusive, so each
  // cleanup is a no-op in the other's mode.
  let child: ReturnType<typeof spawnProcess>;
  let spec: LaunchSpec;
  let artifacts: string[] | undefined;
  try {
    if (name !== requested)
      console.error(`"${requested}" is already on the mesh - spawning as ${name} instead`);
    if (target.source === "registry" || target.source === "current")
      console.error(c.dim(`→ joining mesh ${space} (${server}) as ${name}`));
    try {
      spec = connector.buildLaunch({
        ...launchOpts,
        name,
        id,
        creds: credsPath,
        ...(acceptedToken !== undefined ? { acceptedToken } : {}),
        userAuth,
        lifecycleUid,
        // Provisioning can replace the requested ACLs or add an event grant.
        subscribe,
        allowSubscribe,
        allowPublish,
      });
    } catch (error) {
      if (error instanceof CommandFailure) throw error;
      throw new CommandFailure("refused", "USAGE_INVALID", rejectionText(error), { target: { space, path } });
    }
    applyHandoffManagerInstance(spec, handoffManagerInstanceId);
    artifacts = spec.artifacts;
    scrubEnrollmentEnv(spec.env);

    // What happens next belongs to the CONNECTOR: naming one harness's first-run gate for all of
    // them sends the operator looking for a prompt that never appears, and reads as a hang.
    console.error(
      `spawning ${peerLabel({ name, role })} on the mesh${connector.launchHint ? ` - ${connector.launchHint}` : ""}`,
    );
    if (userAuth) {
      // The sentence names its own arm's departure (#1837). The LOCAL arm's cleanup revokes the
      // row (provisionUserForeground → provider.revokeAgent), so "revoked automatically" is true
      // there. The REMOTE arm's cleanup shreds only the local token/sentinel/health files; the
      // grant lives in the mesh's ledger, where this machine holds no authority to revoke it, so
      // the sentence says what does happen and names the one route that revokes it.
      const revokeNote = remoteUserAuth
        ? "(actor granted by the mesh; local credential files are removed when this process exits, and the grant stays until the mesh operator revokes it)"
        : "(actor granted; revoked automatically when this process exits)";
      console.error(c.dim(`  running as you: ${userAuth.owner}.${name} ${revokeNote}`));
    }
    // The child's watcher removes the launch's private files once it is gone, even if this process
    // is killed first (core launch-artifacts).
    const launched = reclaimWithChild(spec);
    child = spawnProcess(launched.command, launched.args, {
      stdio: "inherit",
      // P3: only the connector-declared env (OS allow-list + identity + named model key) — never
      // `...process.env`, so the operator's unrelated secrets don't bleed into the foreground agent.
      env: spec.env ?? {},
      // `--cwd` roots the agent at another folder/repo (launch-grammar parity with --detach); a
      // relative path resolves against the invoking shell's cwd. Omitted → inherit this cwd.
      cwd: launchCwd,
    });
  } catch (e) {
    // Launch construction / spawn threw AFTER provisioning — undo BOTH planes (each a no-op in the
    // other's mode): revoke the user-mode actor grant AND roll back the static-auth creds + footprint,
    // before rethrowing, so no standing grant survives a spawn that never started.
    if (userCleanup) await userCleanup().catch((err) => stderrLine("✗ ", `cleaning up after ${name}: ${(err as Error).message}`, c.red));
    await retireProvision("launch build failed");
    // The launch's private files (core launch-artifacts) go too: no child will read them.
    discardLaunchArtifacts(artifacts);
    throw e;
  }
  const FORWARDED_SIGNALS = ["SIGTERM", "SIGHUP"] as const;
  type ForwardedSignal = (typeof FORWARDED_SIGNALS)[number];
  let receivedSignal: ForwardedSignal | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const onTerminate = (sig: ForwardedSignal): void => {
    receivedSignal ??= sig;
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill(sig); } catch { /* already gone */ }
      if (killTimer === undefined) {
        killTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            try { child.kill("SIGKILL"); } catch { /* already gone */ }
          }
        }, 5_000);
        killTimer.unref();
      }
    }
  };
  for (const sig of FORWARDED_SIGNALS) process.on(sig, onTerminate);
  try {
    await new Promise<void>((resolve) => {
      child.on("error", (e) => {
        if (killTimer !== undefined) { clearTimeout(killTimer); killTimer = undefined; }
        // The exec never started, so the just-provisioned static-auth identity is orphaned; roll it
        // back. (User-mode revoke runs unconditionally once this promise settles, below.)
        stderrLine("✗ ", `failed to launch ${spec.command}: ${e.message}`, (line) => line);
        void retireProvision("exec failed").finally(() => {
          process.exitCode = 1;
          resolve();
        });
      });
      child.on("exit", (code, signal) => {
        if (killTimer !== undefined) { clearTimeout(killTimer); killTimer = undefined; }
        // A child killed by a signal, or stopped after this foreground spawn received SIGTERM or
        // SIGHUP, exits 128 plus the signal's number.
        const exitSignal = receivedSignal ?? signal;
        process.exitCode = exitSignal ? 128 + osConstants.signals[exitSignal] : (code ?? 0);
        resolve();
      });
    });
    // STATIC MODE: the departure half of the run-scoped identity; the agent is gone and no future
    // spawn reuses this identity, so retire its creds + broker footprint now (the manager's despawn
    // deprovision, foregrounded). Best-effort: a SIGKILLed CLI can't run it, and that residue is the
    // same class a crashed manager leaves.
    await retireProvision("agent exited");
    // USER MODE: the runtime-grant invariant applies to the foreground departure too; the agent is
    // gone, so its standing mint authority (ledger row + secret files) goes with it. Best-effort
    // (a SIGKILLed CLI can't run this; its retained grant needs operator recovery), loud
    // on failure, never blocking the exit code already set above.
    if (userCleanup) await userCleanup().catch((e) => stderrLine("✗ ", `cleaning up after ${name}: ${(e as Error).message}`, c.red));
    // The child has exited or never started, so nothing reads the launch's private files any more
    // (core launch-artifacts). A SIGKILLed CLI cannot run this; the child's watcher removes those.
    discardLaunchArtifacts(spec.artifacts);
  } finally {
    if (killTimer !== undefined) clearTimeout(killTimer);
    for (const sig of FORWARDED_SIGNALS) process.off(sig, onTerminate);
  }
}
