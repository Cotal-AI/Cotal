import { accessSync, constants, existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { isAbsolute, sep } from "node:path";
import { agentFilePath, assertLifecycleToken, assertValidChannel, DEFAULT_SERVER, digestIdToken, EpEnvelopeError, eventChannel, eventChannelPrincipal, grantOverreach, grantParts, isIssuedCaller, issuedSpawnerStanding, MAX_SCHEDULE_MS, parsePersonaEndpoints, principalKey, registry, rejectionText, renderOnceTask, resolveReadAcl, runDriverCaller, shownSpawner, withIssuerSession, type AgentDef, type Connector, type ControlReply, type CotalEndpoint, type DelegatedGrant, type EpCaller, type EpCapability, type EpServeGrant, type GrantOverreach, type InlinePersona, type IssuedStore, type IssuedSubjectPermissions, type LifecycleStateTransport, type RunAdmission, type RunRevocation, type SpaceAuth } from "@cotal-ai/core";
import { loadLaunchPersonaFile, manifestExtensionNames, PersonaSourceError, resolveAgentType } from "@cotal-ai/workspace";
import type { KV } from "@nats-io/kv";
import { inlinePersonaDir } from "./launch.js";
import { listDirectory } from "./list-dir.js";
import { MANAGER_ENDPOINT, type ManagerConnectorStatus } from "./manager-service-contract.js";
import type { Manager } from "./manager.js";
import type { RunHosting } from "./run-hosting.js";
import type { Runtime } from "./runtime/index.js";
import { SeatStart } from "./seat-start.js";
import type { SpawnHooks, StartAgentOpts } from "./seat-types.js";
import { onceTurnNote, turnHoldToken } from "./turn-relay.js";

/** The goal index's bound on a relay note (core `GOAL_INDEX_NOTE_MAX`). A once task's note must
 *  fit it, and is refused at admission when it cannot. */
const TURN_NOTE_MAX = 65536;

/** The caller keeps the arrays it passed, so a launch form is admitted with its own copies: a later
 *  write to the caller's array cannot change what the manager grants, shares or preserves. */
export function ownLists<T extends { subscribe?: readonly string[]; allowSubscribe?: readonly string[]; allowPublish?: readonly string[]; capabilities?: readonly string[]; shareTools?: readonly string[] }>(form: T): T {
  return {
    ...form,
    ...(form.subscribe && { subscribe: [...form.subscribe] }),
    ...(form.allowSubscribe && { allowSubscribe: [...form.allowSubscribe] }),
    ...(form.allowPublish && { allowPublish: [...form.allowPublish] }),
    ...(form.capabilities && { capabilities: [...form.capabilities] }),
    ...(form.shareTools && { shareTools: [...form.shareTools] }),
  };
}

/** The inline record is admitted the same way, one level deeper: the record itself, its lists, and
 *  each `endpoints` entry with its commands. It is still untrusted here, so a shape the validator
 *  will refuse is copied as far as it goes and refused where it is read. */
export function ownPersona(record: InlinePersona): InlinePersona {
  if (record === null || typeof record !== "object" || Array.isArray(record)) return record;
  const owned = ownLists({ ...record });
  const endpoints: unknown = owned.endpoints;
  if (Array.isArray(endpoints))
    owned.endpoints = endpoints.map((e: unknown) => {
      if (e === null || typeof e !== "object" || Array.isArray(e)) return e;
      const entry = { ...(e as Record<string, unknown>) };
      if (Array.isArray(entry.commands)) entry.commands = [...entry.commands];
      return entry;
    }) as InlinePersona["endpoints"];
  return owned;
}

/** What bounds the grant a spawn hands its helper on a static mesh (SPEC 13.15). Nothing for the
 *  manager's own composition root, an operator instrument or a spawner holding the admin set; no
 *  grant at all for a caller whose evidence does not resolve; no spawn at all for a run that was
 *  revoked or whose revocation marker cannot be read; a run's admitted ceiling for its spawns;
 *  otherwise the caller's evidence. */
export type StaticSpawnBound =
  | { kind: "exempt" }
  | { kind: "none"; reason: string }
  | { kind: "refused"; reason: string }
  | { kind: "bounded"; caller: EpCaller; ceiling: IssuedSubjectPermissions; run?: string };

/** The workflow run a spawn acts for (SPEC 14.8): the run this manager drives under the spawn's
 *  caller, or, on a static mesh, a run hosted elsewhere whose spawn reached this manager, read from
 *  its admission. That run's revocation marker is read with the admission; a hosted run's is read at
 *  the bound. */
export type SpawnRun = { admission: RunAdmission; hosted: boolean } | { refused: string };

/** Why a revoked run starts no helper, the same words wherever the marker is read. */
function revokedRunRefusal(runId: string, revoked: RunRevocation): string {
  return `run ${runId} was revoked by ${revoked.by} (${revoked.reason}); a revoked run starts no helper (SPEC 14.8)`;
}

const INLINE_PERSONA_KEYS = ["prompt", "role", "model", "variant", "description", "subscribe", "allowSubscribe", "allowPublish", "capabilities", "endpoints", "save"];

/** Read an inline persona into the definition a catalog file would load as, refusing what a file
 *  load refuses plus any shape the closed record does not take. The body is literal text: nothing in
 *  it becomes a field, so a body that starts with `---` stays body. */
function inlinePersonaDef(name: string, raw: unknown): { def: AgentDef; save: boolean } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("persona: expected an object");
  const rec = raw as Record<string, unknown>;
  const extra = Object.keys(rec).filter((k) => !INLINE_PERSONA_KEYS.includes(k));
  if (extra.length) throw new Error(`persona: unknown key ${extra[0]}; it takes ${INLINE_PERSONA_KEYS.join(", ")}`);
  const text = (k: string): string | undefined => {
    const v = rec[k];
    if (v === undefined) return undefined;
    if (typeof v !== "string" || !v.trim()) throw new Error(`persona.${k}: expected a non-blank string`);
    return v;
  };
  const list = (k: string): string[] | undefined => {
    const v = rec[k];
    if (v === undefined) return undefined;
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new Error(`persona.${k}: expected an array of strings`);
    return [...v] as string[];
  };
  const prompt = text("prompt");
  if (prompt === undefined) throw new Error("persona.prompt: required; it is the persona body");
  if (rec.save !== undefined && typeof rec.save !== "boolean") throw new Error("persona.save: expected a boolean");
  const def: AgentDef = {
    name,
    persona: prompt.trim(),
    role: text("role"),
    model: text("model"),
    variant: text("variant"),
    description: text("description"),
    subscribe: list("subscribe"),
    allowSubscribe: list("allowSubscribe"),
    allowPublish: list("allowPublish"),
    capabilities: list("capabilities"),
    endpoints: parsePersonaEndpoints(rec.endpoints, "persona"),
  };
  // The checks a file load makes on these fields: channel names, and the read set within the read ACL.
  try {
    for (const ch of [...(def.subscribe ?? []), ...(def.allowSubscribe ?? []), ...(def.allowPublish ?? [])]) assertValidChannel(ch);
    resolveReadAcl(def.subscribe ?? [], def.allowSubscribe);
  } catch (e) {
    throw new Error(`persona: ${rejectionText(e)}`);
  }
  return { def, save: rec.save === true };
}

/** The refusal a user-auth mesh gives a persona that names `endpoints`. */
export function userMeshEndpointsRefusal(door: "spawn" | "define-persona"): string {
  return `${door}: this mesh has per-user auth, where endpoint access comes from the service owner's grants and a persona cannot hand it on (SPEC 13.15). ` +
    "Drop `endpoints` from the persona, and ask the operator to grant the helper with `cotal service-endpoint grant` once it runs.";
}

/**
 * Event channels in `channels` that do NOT belong to `{owner, actor}`.
 *
 * ONE HELPER FOR EVERY SEAM THAT ARMS AN ACL, and that is the whole design. The rule first existed
 * only at the spawn accept seam, and a security review found the hole that shape guarantees: resume
 * re-arms a managed row straight from the inventory document, and `renewManagedStaticCred` re-mints
 * the JWT from that row, so an admin-supplied inventory could carry a foreign concrete event channel
 * past a fence that only ever looked at spawns. A rule with one call site is a rule that covers one
 * door.
 *
 * IT COMPARES PRINCIPALS, NOT STRINGS. `eventChannelPrincipal` decodes the channel back to the
 * `{owner, actor}` it names, so this is mode-independent: static keys the actor on the allocated
 * nkey and user mode keys it on the alias, and neither needs its own branch here.
 *
 * STATED LIMIT, unchanged and asserted by a cell: the decode refuses anything that is not exactly
 * two principal tokens, so a WILDCARD is not an event channel to it. `events.<owner>.>` and
 * `events.>` pass untouched and are governed by ordinary ACL authority. This closes the concrete
 * form, which is what a caller writes when it knows which agent it wants to read, and not the
 * wildcard form, which is what an operator writes deliberately for an observer.
 */
export function foreignEventChannels(channels: readonly string[], owner: string, actor: string): string[] {
  return channels.filter((ch) => {
    const p = eventChannelPrincipal(ch);
    return p !== null && !(p.owner === owner && p.actor === actor);
  });
}

/** What {@link SeatLaunch} reads from the Manager. Every entry is read at use, so a field the
 *  Manager assigns after construction is always current, and a Manager method a test replaces is
 *  the one that runs. */
export interface SeatLaunchDeps {
  space: () => string;
  servers: () => string | undefined;
  workspaceRoot: () => string;
  installedExtensions: () => boolean;
  ep: () => CotalEndpoint;
  auth: () => SpaceAuth | undefined;
  userMode: () => boolean;
  managerInstanceId: () => string;
  serviceServe: () => { grant: EpServeGrant } | undefined;
  runHosting: () => RunHosting | undefined;
  connectorStatuses: () => readonly ManagerConnectorStatus[];
  execution: () => "runtime" | "none";
  requiredRuntime: () => Runtime;
  meshMode: () => "open" | "static" | "user";
  executionRefusal: () => string;
  nameError: (name: string) => string | undefined;
  canReadPersona: (owner: string | undefined, caller: string, admin: boolean) => boolean;
  epAdminReach: (caller: EpCaller) => Promise<boolean>;
  startAgent: (opts: StartAgentOpts) => Promise<ControlReply>;
  awaitReadiness: (...args: Parameters<Manager["awaitReadiness"]>) => ReturnType<Manager["awaitReadiness"]>;
  awaitStartupOutcome: (...args: Parameters<Manager["awaitStartupOutcome"]>) => ReturnType<Manager["awaitStartupOutcome"]>;
  capabilityRefusal: (...args: Parameters<Manager["capabilityRefusal"]>) => ReturnType<Manager["capabilityRefusal"]>;
  delegatedLaunched: () => Manager["delegatedLaunched"];
  dropInlineSnapshot: (...args: Parameters<Manager["dropInlineSnapshot"]>) => ReturnType<Manager["dropInlineSnapshot"]>;
  endOnceBeforeServe: (...args: Parameters<Manager["endOnceBeforeServe"]>) => ReturnType<Manager["endOnceBeforeServe"]>;
  eventPayloadsWithheld: () => Manager["eventPayloadsWithheld"];
  eventsRefusal: (...args: Parameters<Manager["eventsRefusal"]>) => ReturnType<Manager["eventsRefusal"]>;
  eventsRequired: () => Manager["eventsRequired"];
  fileDigest: (...args: Parameters<Manager["fileDigest"]>) => ReturnType<Manager["fileDigest"]>;
  hostLaunchFields: (...args: Parameters<Manager["hostLaunchFields"]>) => ReturnType<Manager["hostLaunchFields"]>;
  issuanceSeam: (...args: Parameters<Manager["issuanceSeam"]>) => ReturnType<Manager["issuanceSeam"]>;
  launchHarness: (...args: Parameters<Manager["launchHarness"]>) => ReturnType<Manager["launchHarness"]>;
  launchOwner: (...args: Parameters<Manager["launchOwner"]>) => ReturnType<Manager["launchOwner"]>;
  leaseStopping: () => Manager["leaseStopping"];
  loadSeatRuntime: (...args: Parameters<Manager["loadSeatRuntime"]>) => ReturnType<Manager["loadSeatRuntime"]>;
  managerLifecycleUid: () => Manager["managerLifecycleUid"];
  namesCapacity: () => Manager["namesCapacity"];
  openOnceDelivery: (...args: Parameters<Manager["openOnceDelivery"]>) => ReturnType<Manager["openOnceDelivery"]>;
  personaOwner: (...args: Parameters<Manager["personaOwner"]>) => ReturnType<Manager["personaOwner"]>;
  place: (...args: Parameters<Manager["place"]>) => ReturnType<Manager["place"]>;
  provisionUserAgent: (...args: Parameters<Manager["provisionUserAgent"]>) => ReturnType<Manager["provisionUserAgent"]>;
  readerRemedy: (...args: Parameters<Manager["readerRemedy"]>) => ReturnType<Manager["readerRemedy"]>;
  readinessTimeoutMs: () => Manager["readinessTimeoutMs"];
  refreshUnavailableConnectors: (...args: Parameters<Manager["refreshUnavailableConnectors"]>) => ReturnType<Manager["refreshUnavailableConnectors"]>;
  remoteAuthority: () => Manager["remoteAuthority"];
  resolveConnector: (...args: Parameters<Manager["resolveConnector"]>) => ReturnType<Manager["resolveConnector"]>;
  retirement: () => Manager["retirement"];
  runtimeFor: (...args: Parameters<Manager["runtimeFor"]>) => ReturnType<Manager["runtimeFor"]>;
  seatCapRefusal: (...args: Parameters<Manager["seatCapRefusal"]>) => ReturnType<Manager["seatCapRefusal"]>;
  seatCustody: () => Manager["seatCustody"];
  secrets: () => Manager["secrets"];
  sessionRecovery: () => Manager["sessionRecovery"];
  shredUserSecrets: (...args: Parameters<Manager["shredUserSecrets"]>) => ReturnType<Manager["shredUserSecrets"]>;
  staticLifecycle: () => Manager["staticLifecycle"];
  stopAndTrack: (...args: Parameters<Manager["stopAndTrack"]>) => ReturnType<Manager["stopAndTrack"]>;
  trackDeprovision: (...args: Parameters<Manager["trackDeprovision"]>) => ReturnType<Manager["trackDeprovision"]>;
  transcripts: () => Manager["transcripts"];
  userProvision: () => Manager["userProvision"];
  watchExit: (...args: Parameters<Manager["watchExit"]>) => ReturnType<Manager["watchExit"]>;
  watchOnceExit: (...args: Parameters<Manager["watchOnceExit"]>) => ReturnType<Manager["watchOnceExit"]>;
  withIssuer: <T>(fn: (i: { store: IssuedStore; accepted: KV }) => Promise<T>) => Promise<T>;
  withLifecycleExecutor: <T>(pin: { owner: string; actor: string; lifecycleUid: string; alias: string }, fn: (t: LifecycleStateTransport) => Promise<T>) => Promise<T>;
  withProvisioner: <T>(fn: (prov: CotalEndpoint) => Promise<T>) => Promise<T>;
}

/** The launch pipeline's leaf steps: spawn-directory checks, the connector inventory reads, the
 *  once-spawn and spawn-grant refusals, and the persona a spawn resolves to. */
export class SeatLaunch {
  /** The agent-start path. Shares this component's deps, and calls back into it for its leaf steps. */
  private readonly seatStart: SeatStart;

  constructor(private readonly deps: SeatLaunchDeps) {
    this.seatStart = new SeatStart(deps, {
      checkSpawnCwd: (...args) => this.checkSpawnCwd(...args),
      harnessUnavailableError: (...args) => this.harnessUnavailableError(...args),
      onceRefusal: (...args) => this.onceRefusal(...args),
      spawnerName: (...args) => this.spawnerName(...args),
      spawnPersona: (...args) => this.spawnPersona(...args),
      spawnRun: (...args) => this.spawnRun(...args),
      staticSpawnBound: (...args) => this.staticSpawnBound(...args),
      spawnBoundRefusal: (...args) => this.spawnBoundRefusal(...args),
      managedStaticInstanceReads: (...args) => this.managedStaticInstanceReads(...args),
    });
  }

  /** The realpath, directory and search-permission checks a placed spawn directory must pass on this manager's host,
   * shared by the served `resolve-cwd` command and the `spawn` admission check (#385 item 2): one
   * function, so the two doors never drift. Creates nothing and never substitutes the workspace root. */
  checkSpawnCwd(resolved: string): { cwd: string; host: string } | { refusal: string } {
    let cwd = resolved;
    try {
      cwd = realpathSync(resolved);
    } catch (error) {
      return { refusal: `path cannot be resolved: ${rejectionText(error)}` };
    }
    try {
      if (!statSync(cwd).isDirectory()) return { refusal: "path is not a directory" };
      if (process.platform !== "win32") accessSync(cwd, constants.X_OK);
    } catch (error) {
      return { refusal: rejectionText(error) };
    }
    return { cwd, host: hostname() };
  }

  /** Refuse host directory reads before lookup when seats cannot use this host. */
  assertHostDirectoryExecution(): void {
    if (this.deps.execution() === "none") throw new EpEnvelopeError("unimplemented", this.deps.executionRefusal());
    if (this.deps.execution() === "runtime" && this.deps.requiredRuntime().spawnDelegated)
      throw new EpEnvelopeError("failed-precondition", `runtime "${this.deps.requiredRuntime().kind}" starts seats outside this host, so it cannot resolve a directory on this host's filesystem (cwd); the seat runs in its runtime resource's own directory`);
  }

  async listSpawnDirectory(args: Record<string, unknown>): ReturnType<typeof listDirectory> {
    this.assertHostDirectoryExecution();
    const { cwd } = this.resolveSpawnCwd(args.path ?? homedir());
    try {
      return await listDirectory(cwd, args.includeHidden === true, typeof args.limit === "number" ? args.limit : 200);
    } catch (error) {
      throw new EpEnvelopeError("failed-precondition", `directory cannot be listed on this host: ${JSON.stringify(cwd)} (${rejectionText(error)})`);
    }
  }

  /** Resolve a placed spawn directory without creating or substituting a workspace. */
  resolveSpawnCwd(value: unknown): { cwd: string; host: string } {
    this.assertHostDirectoryExecution();
    const asked = typeof value === "string" ? value : String(value ?? "");
    const refuse = (reason: string): never => {
      throw new EpEnvelopeError("failed-precondition", `cwd does not resolve on this host: ${JSON.stringify(asked)} (${reason})`);
    };
    if (!isAbsolute(asked)) refuse("expected an absolute path");
    const result = this.checkSpawnCwd(asked);
    if ("refusal" in result) return refuse(result.refusal);
    return result;
  }

  /** Connector names the manager can spawn WITHOUT importing: the manifest on the published binary,
   *  else whatever a composition root registered. Drives the `models` catalog enumeration. */
  connectorNames(): string[] {
    return this.deps.installedExtensions() ? manifestExtensionNames("connector") : registry.all<Connector>("connector").map((c) => c.name);
  }

  /** True when at least one declared connector is available. Empty inventory (or a failed
   *  inventory load) skips the class `one` subscribe for spawn/launch so this member cannot
   *  consume an unpinned request a sibling could serve. */
  classSpawnEnabled(): boolean {
    if (this.deps.execution() === "none") return false;
    return this.deps.connectorStatuses().some((row) => row.state === "available");
  }

  omitClassCommands(): readonly string[] | undefined {
    return this.classSpawnEnabled() ? undefined : ["spawn", "launch"];
  }

  /** Named harness-unavailable refusal. On the class rail a partial inventory must not look
   *  like the space cannot launch: name `--on` so the caller can pin a sibling. The standing
   *  serve credential cannot enumerate sibling `svc.*.status` inventories, so the residual
   *  is the flag, not a list of capable instance ids. Instance-pinned calls keep the local
   *  reason only. */
  harnessUnavailableError(reason: string, route: "one" | "all" | "inst"): string {
    if (route !== "one") return reason;
    return `${reason}. This manager cannot launch that harness. The space may have other managers; pin one with --on <instance> (the whole id, as ps prints it)`;
  }

  /** The refusal for a `once` spawn this manager cannot run as one task: every check is made before
   *  anything is allocated, so a refused spawn leaves nothing behind. */
  onceRefusal(connector: Connector, runtime: Runtime, launch: Pick<StartAgentOpts, "once" | "supervise" | "launchOptions" | "prompt">, spawner: string | undefined, hooks: SpawnHooks | undefined): string | undefined {
    if (!hooks?.onOnce) return "once: a once task rides the spawn action, which this launch door is not";
    if (launch.prompt === undefined || launch.prompt.trim() === "") return "once: needs a prompt, which is the task";
    if (launch.supervise !== undefined) return "once: a once seat is never restarted, so it cannot carry supervise";
    if (!connector.supportsTurnRelay)
      return `once: the ${connector.name} connector cannot take a once task${connector.turnRelayRefusal ? `: ${connector.turnRelayRefusal}` : ""}`;
    if (connector.onceNeedsConfirmed !== undefined && !runtime.reportsStartupOutcome)
      return `once: runtime "${runtime.kind}" does not report how a seat's startup ended, which a once seat on the ${connector.name} connector needs`;
    if (runtime.spawnDelegated) return `once: runtime "${runtime.kind}" starts seats outside this host, where this manager cannot prove the seat's exit`;
    const operator = connector.waitsForOperator?.(launch.launchOptions);
    if (operator !== undefined) return `once: these launch options make the seat wait at ${operator} before it starts, so nothing could take its task`;
    // The task's relay record, measured with the widest deadline it could carry.
    const { note, payload } = onceTurnNote({
      prompt: launch.prompt, spawner: this.spawnerName(spawner),
      ...(launch.once!.deadlineMs !== undefined ? { deadlineAt: MAX_SCHEDULE_MS, holdToken: turnHoldToken("") } : {}),
      holdEpoch: this.deps.serviceServe()?.grant.epoch ?? 0,
      ...(connector.retireAfterExit ? { retire: connector.name } : {}),
      // The longest id token core accepts (endpoint-subjects `assertIdToken`).
      spawn: "x".repeat(64),
    });
    if (note.length > TURN_NOTE_MAX) return `once: the prompt is too long for one task (its relay record is ${note.length} characters, over ${TURN_NOTE_MAX})`;
    if (connector.turnFrameLimit !== undefined) {
      // The text the seat shows, rendered by the seat's own function with the widest values it could
      // carry: the task's goal id is a digest token, and a deadline renders as one ISO instant.
      const text = renderOnceTask({ goalId: digestIdToken("once"), payload, spawner: this.spawnerName(spawner), ...(launch.once!.deadlineMs !== undefined ? { deadlineAt: MAX_SCHEDULE_MS } : {}) });
      if (text.length > connector.turnFrameLimit)
        return `once: the prompt is too long for one ${connector.name} turn (the task renders to ${text.length} characters, over ${connector.turnFrameLimit})`;
    }
    return undefined;
  }

  /** How a once task names who sent it: the spawner's roster name, or its principal when that name is missing or only whitespace. */
  spawnerName(spawner: string | undefined): string {
    const id = spawner ?? this.deps.ep().ref().id;
    return shownSpawner(this.deps.ep().getRoster().find((p) => p.card.id === id)?.card.name, id);
  }

  /** The persona file a spawn loads and the harness it resolves, shared by `spawn` and the served
   *  `resolve-agent` read: a detached resume locates the session it carries with the connector this
   *  names, so the two doors must not drift (#2899). */
  async spawnPersona(
    opts: Pick<StartAgentOpts, "name" | "config" | "identity" | "agent" | "defaultAgent" | "resolved" | "persona">,
    spawner: string | undefined,
    authenticatedCaller: EpCaller | undefined,
  ): Promise<
    | { ref: string; configPath: string; def: AgentDef | undefined; agent: string; inline?: undefined }
    | { ref: string; configPath?: undefined; def: AgentDef; agent: string; inline: { save: boolean } }
    | { error: string; code?: "bad-request" }
  > {
    // Both config-taking wire commands and direct/roster starts enter here before interpreting
    // a path. A resolved manifest is host-built authority over its own materialized resource,
    // never a wire-supplied config override (the public schemas accept no `resolved` field).
    if (this.deps.execution() === "runtime" && this.deps.requiredRuntime().spawnDelegated && opts.config !== undefined && !opts.resolved)
      return { error: "delegated execution cannot use a manager-host persona config path; select a named persona" };
    // The spawn argument is a persona REF — a filename in `.cotal/agents` (the unique spawn KEY), or
    // a path via `--config`. It is NOT the mesh identity: the identity comes from inside the file
    // (`name:`), so a persona can be filed descriptively (review-critic.md) yet present under a
    // free-form name (socrates) — the same model `cotal spawn` already uses. You always spawn by
    // filename (unique on disk); two files can't collide on the key.
    const ref = opts.name.trim();
    if (!ref) return { error: "name required" };
    // An inline persona is its own definition, read here like a file so every later check sees a
    // def. It has no file until its snapshot is written, once the seat's lifecycle uid is final.
    if (opts.persona !== undefined) {
      if (opts.resolved || opts.config !== undefined || opts.identity !== undefined)
        return { error: "persona: an inline persona names the helper itself, so it takes no config, identity or manifest launch", code: "bad-request" };
      const refErr = this.deps.nameError(ref);
      if (refErr) return { error: refErr };
      let inline: { def: AgentDef; save: boolean };
      try {
        inline = inlinePersonaDef(ref, opts.persona);
      } catch (e) {
        return { error: rejectionText(e), code: "bad-request" };
      }
      // A save under a name the catalog already holds is refused here, before anything is allocated,
      // so the refusal starts nothing. The create-only write after the grant settles a race.
      if (inline.save) {
        const target = agentFilePath(this.deps.workspaceRoot(), ref);
        let taken = true;
        try {
          lstatSync(target);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") return { error: `persona.save: ${rejectionText(e)}` };
          taken = false;
        }
        if (taken)
          return { error: `persona.save: the catalog already holds a persona named "${ref}" (${target}). Spawn that persona by name, or pick another name to save this one under` };
      }
      return { ref, def: inline.def, agent: resolveAgentType({ flag: opts.agent, pin: undefined, callerDefault: opts.defaultAgent }), inline: { save: inline.save } };
    }
    // A bare ref maps to `.cotal/agents/<ref>.md`, so it must be a safe token (no path traversal); a
    // `--config` path is validated by existsSync below instead.
    if (!opts.config) {
      const refErr = this.deps.nameError(ref);
      if (refErr) return { error: refErr };
    }

    // Resolve the persona file (fail loud — NO silent default-ACL fallback). A missing persona used
    // to mint DEFAULT creds (read `general` only, default-deny publish, no capabilities), so a
    // typo'd / renamed / spawned-by-display-name agent became live with silently-wrong ACLs — a
    // behavioral/security bug. Fail loud instead, matching `cotal spawn` (loadAgentFile throws).
    // This runs BEFORE the spawn path resolves its connector: the file's `agent:` pin participates in
    // the harness choice (flag > file > COTAL_DEFAULT_AGENT > default, #869), which is impossible if
    // the connector is materialized first.
    let configPath: string;
    if (opts.config) {
      configPath = agentFilePath(this.deps.workspaceRoot(), opts.config);
      if (!existsSync(configPath)) return { error: `agent file not found: ${configPath}` };
    } else {
      configPath = agentFilePath(this.deps.workspaceRoot(), ref);
      if (!existsSync(configPath))
        return { error: `no persona "${ref}" in the catalog of manager ${this.deps.managerInstanceId()} on host ${hostname()}: ${configPath} not found; create it there` };
    }
    // An inline snapshot belongs to its own seat's lifecycle, which removes it at retirement and
    // refuses a restart once it changed, so no other launch may read it. Compared after symlinks
    // resolve, for a config path and a catalog entry alike.
    if (!opts.resolved && this.insideInlineDir(configPath))
      return { error: `${configPath} is an inline persona's snapshot, which belongs to the seat it was written for; spawn a saved persona by name, or pass the persona inline` };

    // Load the persona ONCE, here, ahead of the connector choice. The file's `agent:` pin feeds the
    // harness resolution below; the spawn path's identity/ACL profile block consumes the SAME def (no
    // second load). A manifest launch (`resolved`) materializes its own transient persona and the
    // file is NOT its authority, so its def (and its agent pin) is deliberately not consulted here —
    // the manifest's own `agent:` field drove the launch object already.
    let def: AgentDef | undefined;
    if (!opts.resolved) {
      try {
        def = loadLaunchPersonaFile(configPath);
      } catch (e) {
        return { error: rejectionText(e), ...(e instanceof PersonaSourceError ? { code: "bad-request" as const } : {}) };
      }
      // Shared operator files remain launchable. Owned content follows the catalog's visibility
      // decision before connector loading or any allocation. A hosted run acts for its admission;
      // only a complete authenticated caller can request the current ledger's admin decision.
      if (this.deps.userMode() && def.owner !== undefined) {
        const acting = authenticatedCaller === undefined ? undefined
          : this.deps.runHosting()?.admittedCaller(authenticatedCaller) ?? authenticatedCaller;
        const personaCaller = acting === undefined ? spawner ?? "" : principalKey(acting.owner, acting.actor).key;
        const admin = authenticatedCaller !== undefined && await this.deps.epAdminReach(authenticatedCaller);
        if (!this.deps.canReadPersona(def.owner, personaCaller, admin))
          return { error: `no persona "${ref}"` };
      }
    }
    return { ref, configPath, def, agent: resolveAgentType({ flag: opts.agent, pin: def?.agent, callerDefault: opts.defaultAgent }) };
  }

  /** Whether a persona path resolves into the inline snapshot directory, the directory itself
   *  included. A directory that does not exist holds nothing. */
  insideInlineDir(path: string): boolean {
    const dir = inlinePersonaDir(this.deps.workspaceRoot());
    if (!existsSync(dir)) return false;
    const real = realpathSync(path);
    const realDir = realpathSync(dir);
    return real === realDir || real.startsWith(realDir + sep);
  }

  /** The run a spawn acts for (SPEC 14.8). The run this manager drives under `caller` answers from
   *  memory. On a static mesh, a spawn from a run hosted elsewhere names its run, whether the program
   *  placed it here or the class queue delivered it, and its caller must be that run's driver, whose
   *  triple derives from the run id; the run's admission and revocation marker are then read
   *  leader-served, so the helper is bounded as the hosting manager bounds it. Elsewhere the run id
   *  is not read: a user-auth run's issuing host bounds the helper, and an open mesh bounds none.
   *  `undefined` for a spawn that acts for no run. */
  async spawnRun(caller: EpCaller | undefined, runId: string | undefined): Promise<SpawnRun | undefined> {
    const hosted = caller !== undefined ? this.deps.runHosting()?.runAdmission(caller) : undefined;
    if (hosted !== undefined) {
      if (runId !== undefined && runId !== hosted.runId) return { refused: `it names run ${runId}, but its caller drives run ${hosted.runId}` };
      return { admission: hosted, hosted: true };
    }
    if (runId === undefined || this.deps.meshMode() !== "static") return undefined;
    let driver: EpCaller | undefined;
    try {
      driver = caller !== undefined ? runDriverCaller(runId, caller.owner) : undefined;
    } catch (e) {
      return { refused: `runId ${JSON.stringify(runId)} is not a run id (${rejectionText(e)})` };
    }
    if (driver === undefined || driver.actor !== caller!.actor || driver.uid !== caller!.uid)
      return { refused: `it names run ${runId}, but its caller is not that run's driver` };
    if (this.deps.runHosting() === undefined) return { refused: `run ${runId} asked this manager for a helper, but this manager hosts no runs, so it cannot read the run's admission` };
    let view: { admission: RunAdmission; revoked: RunRevocation | undefined };
    try {
      view = await this.deps.runHosting()!.admission(runId);
    } catch (e) {
      return { refused: `run ${runId}'s admission and revocation marker could not be read (${rejectionText(e)}), so it starts no helper (SPEC 14.8)` };
    }
    if (view.revoked !== undefined) return { refused: revokedRunRefusal(runId, view.revoked) };
    return { admission: view.admission, hosted: false };
  }

  /**
   * Resolve what bounds a spawn's grant on a STATIC mesh: the caller's issued evidence, read the way
   * keyed runs read it. A user-auth mesh bounds the mint on its ledger instead, and an open mesh
   * mints no grant, so both return `exempt`. So does a call with no authenticated caller, which is
   * the manager's own composition root (roster boot, a manifest `launch`, which a static mesh mints
   * only into operator instruments). A workflow run's spawn, whether this manager hosts the run or
   * its spawn reached this manager from another host ({@link spawnRun}), is bounded by the run's admission (SPEC 14.8):
   * the ceiling it recorded, at the starter's coordinate, unless the starter was exempt then. That
   * ceiling is the starter's evidence as resolved at admission, or for a local run the channels the
   * operator named. Any other caller with no issued generation, or whose evidence does not resolve,
   * hands on no grant. The evidence's own standing decides the rest.
   */
  async staticSpawnBound(caller: EpCaller | undefined, run: Extract<SpawnRun, { admission: RunAdmission }> | undefined): Promise<StaticSpawnBound> {
    if (this.deps.meshMode() !== "static" || caller === undefined) return { kind: "exempt" };
    // The driver's own credential is not the run's authority, and the starter's evidence may have
    // expired or changed since: the admission recorded both the ceiling and the verdict.
    if (run !== undefined) {
      const admission = run.admission;
      // Read leader-served before each of the run's spawns, so a run revoked mid-step starts no
      // helper, and a marker this manager cannot read refuses the spawn too. The marker of a run
      // hosted elsewhere was read with its admission.
      let refusal: string | undefined;
      if (run.hosted)
        try {
          const revoked = (await this.deps.runHosting()!.admission(admission.runId)).revoked;
          if (revoked !== undefined) refusal = revokedRunRefusal(admission.runId, revoked);
        } catch (e) {
          refusal = `run ${admission.runId}'s revocation marker could not be read (${rejectionText(e)}), so it starts no helper (SPEC 14.8)`;
        }
      if (refusal !== undefined) return { kind: "refused", reason: refusal };
      if (admission.spawnExempt) return { kind: "exempt" };
      // The helper is projected at the admitted coordinate, which needs a lifecycle token. A local
      // admission written before its uid was one records the CLI's own holder id, and bounds nothing.
      try {
        assertLifecycleToken(admission.caller.uid);
      } catch {
        return { kind: "refused", reason: `run ${admission.runId}'s admission records caller uid ${JSON.stringify(admission.caller.uid)}, which is not a lifecycle token, so its helpers cannot be measured and it starts none. Start the run again (SPEC 14.8)` };
      }
      return { kind: "bounded", caller: admission.caller, ceiling: admission.ceiling, run: admission.runId };
    }
    if (!isIssuedCaller(caller))
      return { kind: "none", reason: "its credential carries no issued generation (an unissued mint or a legacy rail)" };
    const ref = { space: this.deps.space(), owner: caller.owner, actor: caller.actor, uid: caller.uid, generation: caller.generation };
    try {
      const { evidence } = await withIssuerSession({ servers: this.deps.servers() ?? DEFAULT_SERVER, space: this.deps.space(), auth: this.deps.auth()!, tls: false }, (s) =>
        s.store.resolve(ref, s.sourceIsLive));
      return issuedSpawnerStanding(evidence) === "bounded" ? { kind: "bounded", caller, ceiling: evidence.permissions } : { kind: "exempt" };
    } catch (e) {
      return { kind: "none", reason: `its issued evidence does not resolve: ${rejectionText(e)}` };
    }
  }

  /** The refusal for a grant its static spawner does not hold, or `undefined` when it holds all of
   *  it. Each part is named, so the caller can drop exactly what overreached. `armsEvents` is whether
   *  the helper's own event plane will be minted: that row is keyed on a principal allocated later,
   *  so it is measured as the spawner's own, the rule the ledger applies. `door` names the command
   *  being bounded: a persona definition is bounded against its definer as a spawn is. */
  spawnBoundRefusal(bound: StaticSpawnBound, grant: DelegatedGrant, armsEvents: boolean, door: "spawn" | "define-persona" = "spawn"): string | undefined {
    if (bound.kind === "exempt") return undefined;
    if (bound.kind === "refused") return `${door}: ${bound.reason}`;
    let over: GrantOverreach[];
    let eventsOver: boolean;
    try {
      over = bound.kind === "none" ? grantParts(grant) : grantOverreach(this.deps.space(), bound.caller, bound.ceiling, grant);
      eventsOver = armsEvents && (bound.kind === "none"
        || grantOverreach(this.deps.space(), bound.caller, bound.ceiling, { allowPublish: [eventChannel({ owner: bound.caller.owner, actor: bound.caller.actor })] }).length > 0);
    } catch (e) {
      return `${door}: ${rejectionText(e)}`;
    }
    if (!over.length && !eventsOver) return undefined;
    const named = [
      // A role is handed on by a spawner whose credential binds that role's task queue: its own
      // role, or a `role:<r>` token in its capabilities.
      ...over.map((o) => o.field === "role" ? `role ${o.value} (a spawner hands on a role it was given as its own or as the \`role:${o.value}\` capability)` : `${o.field} ${o.value}`),
      ...(eventsOver ? ["events (the helper's own event plane; pass events: false to spawn without it)"] : []),
    ].join(", ");
    if (door === "define-persona")
      return bound.kind === "none"
        ? `define-persona: the definer holds no issued evidence (SPEC 13.15), so its persona can grant nothing: ${bound.reason}. This persona asks for ${named}. ` +
            `Define it without these, or start the definer under a manager (\`cotal spawn --detach\`), whose seats carry issued evidence.`
        : `define-persona: this persona grants more than the definer holds: ${named}. A definer hands on only what its own issued credential carries (SPEC 13.15). ` +
            `Drop these from the persona, or have the operator widen the definer's own persona.`;
    if (bound.kind === "bounded" && bound.run !== undefined)
      return `spawn: this spawn hands its helper more than run ${bound.run}'s starter held when the run was admitted: ${named}. ` +
        `A run hands on only what its admission recorded: its starter's issued credential, or for a \`--local\` run the channels named by \`--admit-read\` and \`--admit-publish\` (SPEC 14.8). ` +
        `Drop these from the persona or the spawn, or start the run from a caller that holds them.`;
    return bound.kind === "none"
      ? `spawn: the spawner holds no issued evidence (SPEC 13.15), so it hands on no grant: ${bound.reason}. This spawn asks for ${named}. ` +
          `Spawn a persona that names none of these, or start the spawner under a manager (\`cotal spawn --detach\`), whose seats carry issued evidence.`
      : `spawn: this spawn hands its helper more than the spawner holds: ${named}. A spawner hands on only what its own issued credential carries (SPEC 13.15). ` +
          `Drop these from the persona or the spawn, or have the operator widen the spawner's own persona.`;
  }

  /** Ordinary static control seats can read their holding instance. A run's recorded ceiling is
   *  authoritative, so its helpers receive no additional instance reads. */
  managedStaticInstanceReads(capabilities: readonly string[] | undefined): EpCapability[] {
    if (this.deps.meshMode() !== "static" || !this.deps.managerInstanceId() || !capabilities?.some(c => c === "spawn" || c === "run" || c === "admin")) return [];
    return ["describe", "inspect"].map(command => ({
      endpoint: MANAGER_ENDPOINT, command, instanceId: this.deps.managerInstanceId(), instanceOnly: true,
    }));
  }

  /** Spawn a teammate by persona ref (`name` loads `.cotal/agents/<name>.md`; the peer presents
   *  under that file's own `name:`), as if a peer asked via the control plane. Used to pre-spawn the
   *  demo's experts at startup so the manager owns them. */
  async startByName(name: string): Promise<ControlReply> {
    return this.deps.startAgent({ name });
  }

  /** Resolve once `name` shows up on the mesh roster (presence registered), or after `timeoutMs`.
   *  Lets the pre-spawn loop stagger heavy agent cold-starts so they don't all boot at once.
   *  Best-effort, keyed on the manager-owned (auto-numbered, unique) spawn name — NOT identity
   *  resolution: a same-named *unmanaged* peer already present could satisfy this early. That's
   *  acceptable for cold-start staggering; it never routes anything. */
  async waitForPresence(name: string, timeoutMs = 30_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.deps.ep().getRoster().some((p) => p.card.name === name)) return true;
      await new Promise((r) => setTimeout(r, 1_000));
    }
    return false;
  }

  /** {@link SeatStart.startActive}. */
  startActive(...args: Parameters<SeatStart["startActive"]>): ReturnType<SeatStart["startActive"]> { return this.seatStart.startActive(...args); }

  // Read by the resolve-cwd mutation in checkSpawnCwd (resolve-cwd.json/1); not private, so it
  // compiles while nothing else here reads it.
  get workspaceRoot() { return this.deps.workspaceRoot(); }
}
