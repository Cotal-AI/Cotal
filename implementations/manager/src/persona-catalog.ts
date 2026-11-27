import { agentFilePath, capabilityWithin, composeWirePersona, copyPersonaEndpoints, EpEnvelopeError, listPersonaCatalog, loadAgentFile, lowerPersonaEndpoints, parsePersonaEndpoints, parsePrincipalKey, patternInAllow, personaCatalogDescription, personaCatalogReadable, readPluginChannelSpaceState, rejectionText, resolveAuthProvider, resolveReadAcl, saveAgentFile } from "@cotal-ai/core";
import type { AgentDef, ControlReply, EpCaller, EpCapability, PersonaEndpoint } from "@cotal-ai/core";
import { grantOverreach } from "@cotal-ai/core";
import { userAuthStateDir } from "@cotal-ai/workspace";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { jetstreamManager } from "@nats-io/jetstream";
import type { Manager } from "./manager.js";
import { userMeshEndpointsRefusal } from "./seat-launch.js";
import type { ManagerConfig } from "./manager-config.js";
import type { ManagerParts } from "./manager-parts.js";
import type { ManagerStartState } from "./manager-start-state.js";

type PersonaChannels = { allowSubscribe: string[]; allowPublish: string[] };
type PersonaGrant = PersonaChannels & { capabilities: string[]; endpoints: EpCapability[]; namesEndpoints: boolean };

function channelsOf(def: AgentDef): PersonaChannels {
  let allowSubscribe: string[] = [];
  try {
    allowSubscribe = resolveReadAcl(def.subscribe ?? [], def.allowSubscribe);
  } catch {
    // The writer refuses an invalid read ACL and names the rule it violates.
  }
  return { allowSubscribe, allowPublish: def.allowPublish ?? [] };
}

function channelRemedies(def: AgentDef, channels: PersonaChannels, existing: boolean): string[] {
  const remedies = [];
  if (channels.allowSubscribe.length) {
    if (def.quiet?.length || def.muted?.length) {
      remedies.push(existing
        ? "If you remove a read channel named in `quiet` or `muted`, have the operator remove that entry with `cotal persona edit <name>` on the manager host."
        : "Remove any `quiet` or `muted` entries for channels you remove from the read list in the prompt.");
    }
    remedies.push("To remove all read access, pass `subscribe: []` and `allowSubscribe: []`.");
  }
  if (channels.allowPublish.length) remedies.push("To remove all post access, pass `allowPublish: []`.");
  return remedies;
}

/** What {@link PersonaCatalog} reads from the Manager. Every entry is read at use, so a field the Manager
 *  assigns after construction is always current, and a Manager method a test replaces is the one that runs. */
export interface PersonaCatalogDeps {
  agents: () => Manager["agents"];
  meshMode: () => Manager["meshMode"];
  executionRefusal: (...args: Parameters<Manager["executionRefusal"]>) => ReturnType<Manager["executionRefusal"]>;
  managedPrincipal: (...args: Parameters<Manager["managedPrincipal"]>) => ReturnType<Manager["managedPrincipal"]>;
  nameError: (...args: Parameters<Manager["nameError"]>) => ReturnType<Manager["nameError"]>;
  spawnRun: (...args: Parameters<Manager["spawnRun"]>) => ReturnType<Manager["spawnRun"]>;
  staticSpawnBound: (...args: Parameters<Manager["staticSpawnBound"]>) => ReturnType<Manager["staticSpawnBound"]>;
  readPluginChannelsEnabled: () => Promise<boolean>;
}

/** Builds the {@link PersonaCatalogDeps} for a Manager. It reads Manager members by name at each use, so a
 *  field the Manager assigns later is current and a member a test replaces on the instance is the one that runs. */
export function personaCatalogDeps(m: Manager): PersonaCatalogDeps {
  return {
    agents: () => m["agents"],
    meshMode: () => m["meshMode"],
    executionRefusal: (...args) => m["executionRefusal"](...args),
    managedPrincipal: (...args) => m["managedPrincipal"](...args),
    nameError: (...args) => m["nameError"](...args),
    spawnRun: (...args) => m["spawnRun"](...args),
    staticSpawnBound: (...args) => m["staticSpawnBound"](...args),
    readPluginChannelsEnabled: () => m["withEndpointServeExecutor"](async ({ nc }) =>
      (await readPluginChannelSpaceState(await jetstreamManager(nc), m["config"].space)).state.enabled),
  };
}

/** The persona catalog doors: define, remove, list and show, with the definer's grant check and read reach. */
export class PersonaCatalog {
  constructor(private readonly config: Readonly<ManagerConfig>, private readonly deps: PersonaCatalogDeps, private readonly state: ManagerStartState, private readonly parts: Pick<ManagerParts, "seatLaunch">) {}

  // The Manager members these bodies read, under their Manager names. Each reads through its dep at
  // use, so a field the Manager assigns later is current and a method a test replaces on the Manager
  // is the one that runs.
  private get agents() { return this.deps.agents(); }
  private get meshMode() { return this.deps.meshMode(); }
  private get remoteAuthority() { return this.config.remoteAuthority; }
  private get userMode() { return this.state.userMode; }
  private executionRefusal(...args: Parameters<Manager["executionRefusal"]>): ReturnType<Manager["executionRefusal"]> { return this.deps.executionRefusal(...args); }
  private managedPrincipal(...args: Parameters<Manager["managedPrincipal"]>): ReturnType<Manager["managedPrincipal"]> { return this.deps.managedPrincipal(...args); }
  private nameError(...args: Parameters<Manager["nameError"]>): ReturnType<Manager["nameError"]> { return this.deps.nameError(...args); }
  private spawnRun(...args: Parameters<Manager["spawnRun"]>): ReturnType<Manager["spawnRun"]> { return this.deps.spawnRun(...args); }
  private staticSpawnBound(...args: Parameters<Manager["staticSpawnBound"]>): ReturnType<Manager["staticSpawnBound"]> { return this.deps.staticSpawnBound(...args); }

  /** Persist a peer-defined persona as config. After this, `start name` auto-discovers
   *  .cotal/agents/<name>.md and the connector applies its persona/model at spawn.
   *
   *  CONTENT vs POLICY: `owner` has no slot, so a peer cannot claim ownership, and the
   *  capabilities, endpoint commands and channels in the written persona, including retained lists, are bounded
   *  against the definer before the write, so a peer can put only what it holds into a persona that
   *  a wider spawner might later launch. A wire persona carries no launch options. Channel grants, role and agent may
   *  arrive as explicit arguments or as a leading frontmatter block inside `persona`. A prompt
   *  that starts with `---` is parsed and merged (explicit args win) so the written file has one
   *  frontmatter block; a malformed block is refused by name rather than wrapped. A fresh name is
   *  created with the owner {@link personaOwner} records. Redefining an EXISTING file is allowed on
   *  the privileged tier only if `file.owner == caller`, else admin is required. Fail-closed: an
   *  ownerless file (legacy / operator-written) is admin-only. */
  async opDefinePersona(args: Record<string, unknown>, caller: string, admin: boolean, authenticated?: EpCaller): Promise<ControlReply> {
    if (this.config.execution === "none") throw new EpEnvelopeError("unimplemented", this.executionRefusal());
    const name = String(args.name ?? "").trim();
    if (!name) return { ok: false, error: "name required" };
    const nameErr = this.nameError(name);
    if (nameErr) return { ok: false, error: nameErr };
    const persona = String(args.persona ?? "").trim();
    if (!persona) return { ok: false, error: "persona required" };
    const path = agentFilePath(this.config.workspaceRoot, name);
    const strList = (v: unknown): string[] | undefined => {
      if (v === undefined || v === null) return undefined;
      return (Array.isArray(v) ? v : [v]).map((x) => String(x));
    };
    const capabilities = strList(args.capabilities);
    let endpointArg: PersonaEndpoint[] | undefined;
    try {
      endpointArg = parsePersonaEndpoints(args.endpoints, "define-persona");
    } catch (e) {
      return { ok: false, error: rejectionText(e) };
    }
    // Read, authorize and compose against the catalog as it is now. Nothing yields between this and
    // the write, so no other call in this manager can change the file in between. The handler does
    // not serialize with other processes; their writes are outside this single-manager guarantee.
    const compose = (): { def: AgentDef; existing: boolean } | { reply: ControlReply } => {
      let existing: AgentDef | undefined;
      if (existsSync(path)) {
        try {
          existing = loadAgentFile(path);
        } catch (e) {
          return { reply: { ok: false, error: rejectionText(e) } };
        }
        if (!admin && existing.owner !== caller) {
          const owner = existing.owner ? `owned by ${existing.owner}` : "operator-owned (legacy file - no agent owner)";
          return { reply: {
            ok: false, code: "permission-denied", outcome: "not-executed",
            error: `not authorized to redefine ${name}: ${owner}; only its owner or an operator can`,
            details: [{ kind: "ai.cotal.persona-ownership-refused", operatorOwned: existing.owner === undefined }],
          } };
        }
      }
      try {
        return {
          def: composeWirePersona(
            {
              name,
              owner: this.personaOwner(caller),
              prompt: persona,
              model: args.model as string | undefined,
              role: args.role as string | undefined,
              agent: args.agent as string | undefined,
              subscribe: strList(args.subscribe),
              allowSubscribe: strList(args.allowSubscribe),
              allowPublish: strList(args.allowPublish),
              capabilities,
              endpoints: copyPersonaEndpoints(endpointArg),
            },
            existing,
          ),
          existing: existing !== undefined,
        };
      } catch (e) {
        return { reply: { ok: false, error: rejectionText(e) } };
      }
    };
    let composed = compose();
    if ("reply" in composed) return composed.reply;
    // The bound reads the persona as written, including saved lists. Resolving the definer's
    // grant yields, so the catalog is read again after it.
    let channels = channelsOf(composed.def);
    if (composed.def.capabilities?.length || composed.def.endpoints !== undefined || channels.allowSubscribe.length || channels.allowPublish.length) {
      const refusal = await this.definerGrantRefusal(caller, authenticated);
      composed = compose();
      if ("reply" in composed) return composed.reply;
      channels = channelsOf(composed.def);
      const kept = composed.def.capabilities ?? [];
      const keptEndpoints = lowerPersonaEndpoints(composed.def.endpoints);
      // A user-auth persona may not name the field at all; elsewhere `[]` hands on nothing to bound.
      const namesEndpoints = composed.def.endpoints !== undefined;
      const refused = kept.length || keptEndpoints.length || channels.allowSubscribe.length || channels.allowPublish.length || (namesEndpoints && this.meshMode === "user")
        ? refusal({ capabilities: kept, endpoints: keptEndpoints, namesEndpoints, ...channels })
        : undefined;
      if (refused) {
        const fromSaved = [
          ...(capabilities === undefined && kept.length ? ["capabilities"] : []),
          ...(endpointArg === undefined && composed.def.endpoints?.length ? ["endpoints"] : []),
        ];
        const savedChannels = [
          ...(composed.existing && args.subscribe === undefined && args.allowSubscribe === undefined && channels.allowSubscribe.length ? ["`allowSubscribe` comes from the saved persona."] : []),
          ...(composed.existing && args.allowPublish === undefined && channels.allowPublish.length ? ["`allowPublish` comes from the saved persona."] : []),
        ];
        const savedPolicy = fromSaved.length
          ? `${fromSaved.map((f) => `\`${f}\``).join(" and ")} come${fromSaved.length === 1 ? "s" : ""} from the saved persona, which a redefine that omits ${fromSaved.length === 1 ? "it keeps" : "them keeps"}; pass what the definer holds, or [] to clear ${fromSaved.length === 1 ? "it" : "them"}.`
          : undefined;
        return {
          ok: false,
          code: "permission-denied",
          outcome: "not-executed",
          error: [refused, savedPolicy, ...savedChannels, ...channelRemedies(composed.def, channels, composed.existing)].filter(Boolean).join(" "),
        };
      }
    }
    try {
      saveAgentFile(path, composed.def);
    } catch (e) {
      return { ok: false, error: rejectionText(e) };
    }
    return { ok: true, data: { name, path } };
  }

  /** Resolve what a persona's definer may put into it, as a check that returns the refusal for
   *  capabilities, endpoint commands or channels it does not hold, or `undefined` when it holds them all. The
   *  check itself does not yield. An open mesh mints no credential, so nothing is bounded there. A
   *  static definer is bounded by its issued evidence, as a spawner is; a user-auth definer by its
   *  own ledger row's scope and channel lists, with `admin` exempt. A user-auth persona
   *  cannot name `endpoints` at all, `[]` included (SPEC 13.15). A hosted manager reads no ledger, so
   *  it refuses. A later spawn of the persona is bounded again against its own spawner. */
  private async definerGrantRefusal(caller: string, authenticated: EpCaller | undefined): Promise<(grant: PersonaGrant) => string | undefined> {
    if (this.meshMode === "open") return () => undefined;
    if (this.meshMode === "static") {
      const run = await this.spawnRun(authenticated, undefined);
      const bound = await this.staticSpawnBound(authenticated, run !== undefined && "admission" in run ? run : undefined);
      const routed = bound.kind === "bounded" && await this.deps.readPluginChannelsEnabled();
      return ({ capabilities, endpoints, allowSubscribe, allowPublish }) => {
        const grant = { capabilities, allowSubscribe, allowPublish, ...(endpoints.length ? { endpoints } : {}) };
        if (!routed || bound.kind !== "bounded")
          return this.parts.seatLaunch.spawnBoundRefusal(bound, grant, false, "define-persona");
        try {
          const over = grantOverreach(this.config.space, bound.caller, bound.ceiling, grant, true);
          return over.length ? `define-persona: this persona grants more than the definer holds: ${over.map(({ field, value }) => `${field} ${value}`).join(", ")}.` : undefined;
        } catch (e) { return `define-persona: ${rejectionText(e)}`; }
      };
    }
    if (this.remoteAuthority)
      return ({ capabilities, namesEndpoints, allowSubscribe, allowPublish }) => namesEndpoints
        ? userMeshEndpointsRefusal("define-persona")
        : capabilities.length || allowSubscribe.length || allowPublish.length
          ? "define-persona: this manager's user authority is hosted, so it cannot read the definer's grant and its persona can grant no capabilities or channels. Pass `capabilities: []` to remove all capabilities."
          : undefined;
    const p = parsePrincipalKey(caller);
    const held = p ? await resolveAuthProvider().actorGrant({ dir: userAuthStateDir(this.config.workspaceRoot, this.config.space), owner: p.owner, actor: p.actor }) : undefined;
    const pluginChannelsEnabled = held !== undefined && await this.deps.readPluginChannelsEnabled();
    return ({ capabilities, namesEndpoints, allowSubscribe, allowPublish }) => {
      if (namesEndpoints) return userMeshEndpointsRefusal("define-persona");
      const admin = held?.scope.includes("admin") === true;
      if (admin && !pluginChannelsEnabled) return undefined;
      const overCaps = admin ? [] : capabilities.filter((c) => !capabilityWithin(held?.scope ?? [], c));
      const exceeds = (allow: string[] | undefined, ch: string) =>
        !(admin && patternInAllow([">"], ch, pluginChannelsEnabled)) && !patternInAllow(allow ?? [], ch, pluginChannelsEnabled);
      const overSub = allowSubscribe.filter((ch) => exceeds(held?.allowSubscribe, ch));
      const overPub = allowPublish.filter((ch) => exceeds(held?.allowPublish, ch));
      const named: Array<[string, string[], string[]]> = [["capabilities", overCaps, held?.scope ?? []], ["allowSubscribe", overSub, held?.allowSubscribe ?? []], ["allowPublish", overPub, held?.allowPublish ?? []]];
      const over = named.filter(([, entries]) => entries.length);
      if (!over.length) return undefined;
      return held === undefined
        ? `define-persona: the definer ${caller} has no grant in this space, so its persona can grant nothing. This persona asks for ${over.map(([field, entries]) => `${field} ${entries.join(", ")}`).join("; ")}.`
        : `define-persona: this persona grants more than the definer holds: ${over.map(([field, entries, within]) => `${field} ${entries.join(", ")} beyond [${within.join(", ") || "none"}]`).join("; ")}. Drop these from the persona, or have the operator widen the definer's grant.`;
    };
  }

  /** Remove one machine-local persona definition without touching any running lifecycle that was
   *  launched from it. Removal accepts the catalog's safe filename alphabet without applying the
   *  current spawn-name length or user-mode actor rules, so an obsolete invalid-name entry remains
   *  repairable. Ownership matches redefine: the recorded owner, or admin for an ownerless file. */
  opRemovePersona(args: Record<string, unknown>, caller: string, admin: boolean): ControlReply {
    if (this.config.execution === "none") throw new EpEnvelopeError("unimplemented", this.executionRefusal());
    const name = String(args.name ?? "").trim();
    if (!name) return { ok: false, code: "bad-request", error: "name required" };
    if (!/^[A-Za-z0-9_-]+$/.test(name))
      return { ok: false, code: "bad-request", error: `unsafe persona name ${JSON.stringify(name)} (allowed: letters, digits, _ -)` };
    const path = agentFilePath(this.config.workspaceRoot, name);
    if (!existsSync(path)) return { ok: false, code: "not-found", error: `no persona "${name}"` };
    let owner: string | undefined;
    try {
      owner = loadAgentFile(path).owner;
    } catch {
      // A catalog entry may be invalid for launch solely because an older release admitted a name
      // above today's identity limit. Read only its frontmatter owner without asking the launch
      // parser to accept the identity. This does not make the file spawnable or readable.
      try {
        const source = readFileSync(path, "utf8").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
        const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(source);
        if (!match) throw new Error("missing frontmatter");
        const frontmatter: unknown = parseYaml(match[1]);
        if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter)) throw new Error("frontmatter is not a mapping");
        const fields = frontmatter as Record<string, unknown>;
        if (String(fields.name ?? "") !== name) throw new Error("frontmatter name differs from the catalog entry");
        if (fields.owner !== undefined && typeof fields.owner !== "string") throw new Error("owner is not a string");
        owner = fields.owner;
      } catch {
        return { ok: false, code: "not-found", error: `no persona "${name}"` };
      }
    }
    if (!admin && owner !== caller) {
      const heldBy = owner ? `owned by ${owner}` : "operator-owned (legacy file - no agent owner)";
      return { ok: false, code: "permission-denied", error: `not authorized to remove ${name}: ${heldBy}; only its owner or an operator can` };
    }
    try {
      rmSync(path);
    } catch (e) {
      if (!existsSync(path)) return { ok: false, code: "not-found", error: `no persona "${name}"` };
      return { ok: false, error: rejectionText(e) };
    }
    return { ok: true, data: { name } };
  }

  /** The owner a fresh wire-defined persona records. A user-auth caller's principal is stable, and
   *  so is one of this manager's own seats for its life. Any other static caller, such as the CLI's
   *  operator instrument minted for one call, would leave an owner no later call matches, so it
   *  records none and the file is operator-owned, as a local `persona create` writes it. A peer
   *  joined with its own credential is such a caller too. */
  personaOwner(caller: string): string | undefined {
    if (this.userMode) return caller;
    for (const a of this.agents.values()) if (this.managedPrincipal(a) === caller) return caller;
    return undefined;
  }

  /** Whether this caller may READ a catalog card's details (role/model/description/body). Same
   *  ownership rule as redefine: owner == caller, or admin. Ownerless / operator-written files are
   *  admin-only. Names of parseable files still appear on the list so a definer can see a taken
   *  spawn name; details stay off the wire unless this is true. */
  canReadPersona(owner: string | undefined, caller: string, admin: boolean): boolean {
    return personaCatalogReadable(owner, caller, admin);
  }

  /** Mesh-side catalog list (#402). Every parseable name is returned so a definer can see a taken
   *  spawn name. Role / model / description / owner ride only when the caller could redefine the
   *  file (same ownership as `definePersona`); other cards are name-only, so a peer cannot read a
   *  prompt it does not own. Unparseable files are omitted for non-admin (no existence leak of a
   *  broken card). */
  opListPersonas(caller: string, admin: boolean): ControlReply {
    const personas = [];
    for (const e of listPersonaCatalog(this.config.workspaceRoot)) {
      if (e.error) {
        if (!admin) continue;
        personas.push({ name: e.name, error: "unparseable" });
        continue;
      }
      const def = e.def!;
      if (!this.canReadPersona(def.owner, caller, admin)) {
        personas.push({ name: e.name });
        continue;
      }
      const description = personaCatalogDescription(def);
      personas.push({
        name: e.name,
        ...(def.role ? { role: def.role } : {}),
        ...(def.model ? { model: def.model } : {}),
        ...(description ? { description } : {}),
        ...(def.owner ? { owner: def.owner } : {}),
      });
    }
    return { ok: true, data: { personas } };
  }

  /** Mesh-side catalog show (#402). Same ownership as list. Unknown, unauthorized, or unparseable
   *  names are not-found (no existence or parser-diagnostic leak). The body is included so a peer can
   *  inspect a prompt it owns before spawn; policy fields stay off the wire. */
  opShowPersona(args: Record<string, unknown>, caller: string, admin: boolean): ControlReply {
    const name = String(args.name ?? "").trim();
    if (!name) return { ok: false, error: "name required" };
    const legacyStem = name.startsWith("-") && /^[A-Za-z0-9_-]+$/.test(name);
    const nameErr = legacyStem ? undefined : this.nameError(name);
    if (nameErr) return { ok: false, error: nameErr };
    const path = agentFilePath(this.config.workspaceRoot, name);
    if (!existsSync(path)) return { ok: false, error: `no persona "${name}"` };
    let def;
    try {
      def = loadAgentFile(path);
    } catch {
      return { ok: false, error: `no persona "${name}"` };
    }
    if (!this.canReadPersona(def.owner, caller, admin)) return { ok: false, error: `no persona "${name}"` };
    const description = personaCatalogDescription(def);
    return {
      ok: true,
      data: {
        name,
        ...(def.role ? { role: def.role } : {}),
        ...(def.model ? { model: def.model } : {}),
        ...(description ? { description } : {}),
        ...(def.owner ? { owner: def.owner } : {}),
        ...(def.persona ? { persona: def.persona } : {}),
      },
    };
  }
}
