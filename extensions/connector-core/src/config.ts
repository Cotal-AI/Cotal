import { readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { DEFAULT_SERVER, DEV_OWNER, LAUNCH_MATERIAL_ENV, discardLaunchMaterial, assertLifecycleToken, assertValidChannel, channelInAllow, credsClaims, eventChannel, idFromCreds, isConcreteChannel, loadAgentFile, parseJoinLink, resolveReadAcl, type AgentDef, type ChannelMode, type EndpointKind } from "@cotal-ai/core";
import { readMaterial } from "./session-env.js";

/** Keyed beta intake — used when a `COTAL_FEEDBACK_KEY` is configured. */
export const FEEDBACK_URL = "https://broker.cotal.ai/v1/feedback";
/** Public hosted intake — used without a key; requires a contact email. */
export const PUBLIC_FEEDBACK_URL = "https://cotal.ai/v1/feedback";

/**
 * How a connector instance presents itself on the mesh. Everything is read from
 * the environment so the *launcher* (the manager spawning an agent, or a human
 * running `cotal join` / their own terminal) decides identity once and both the
 * MCP server and the lifecycle hooks inherit it.
 */
export interface AgentConfig {
  space: string;
  /** Stable agent id (nkey public key) from the launcher; falls back to a random
   *  uuid in the endpoint when absent (unmanaged sessions). */
  id?: string;
  /** Minted creds content, or a source that re-reads a managed seat's file for standing renewal. */
  creds?: string | (() => Promise<string>);
  /** The incarnation's lifecycle UID (SPEC §13.1) from the launcher (`COTAL_LIFECYCLE_UID`): the
   *  endpoint binds its lifecycle-keyed dm/dlv/chathist durables by it — the same exact names its
   *  credential pins, so a mismatch fails at the broker, never silently. */
  lifecycleUid?: string;
  /** The CHAT stream sequence this incarnation had reached before its preservation cut
   *  (`COTAL_BACKFILL_FLOOR`): the boot backfill reads only what came after it instead of the
   *  whole retained window. Absent on a fresh launch or when the manager holds no local space
   *  authority to read the frontier at the cut. */
  backfillFloor?: number;
  /** The accepted-row token of a static credential's issuance (SPEC 13.15, `COTAL_ACCEPTED_TOKEN`):
   *  the endpoint reads the issuer-bound generation under it and pins its caller rails. */
  acceptedToken?: string;
  /** Manager selected by the launcher. User-mode control calls request authority for this instance. */
  managerInstanceId?: string;
  /** USER-MODE launch (a spawned agent on a user-auth mesh): the agent's owner+actor principal,
   *  the sentinel creds content it presents alongside its bearers, and the argv it EXECS for a
   *  fresh bearer (initial connect + every refresh — the exchange protocol stays behind that
   *  command). All four env vars come from the spawner together; mutually exclusive with creds. */
  userAuth?: { owner: string; actor: string; sentinelCreds: string; bearerCmd: string[] };
  name: string;
  role?: string;
  description?: string;
  tags?: string[];
  /** Display-only metadata from unmodelled agent-file frontmatter keys (for example `theme`).
   *  Connector-owned keys such as `connector` and `model` are overlaid later and cannot be spoofed here. */
  meta?: Record<string, string>;
  /** Control-plane capabilities this session declares (from the agent file's `capabilities:`); today
   *  only `spawn`. Used to gate the manager-op tools (cotal_spawn / cotal_persona / cotal_personas) so the advertised
   *  surface matches what the agent can actually invoke. The auth layer is the real boundary on any
   *  AUTHED mesh ({@link isAuthed} — static creds or user-mode); open mode carries no identity plane,
   *  so the gate is permissive there. Same file the manager minted creds from, so the tool gate
   *  mirrors the wire grant exactly. */
  capabilities?: string[];
  servers: string;
  /** The *active* read set — channels this agent actually subscribes to (read). May include
   *  wildcard subtrees (`team.>`). Maps to the endpoint's live filter. ⊆ {@link allowSubscribe}. */
  subscribe: string[];
  /** The read ACL — channels this agent *may* read (auth mode → broker-enforced). Defaults to
   *  {@link subscribe}. Bounds runtime `cotal_join`. */
  allowSubscribe: string[];
  /** The post ACL — channels this agent may post to (auth mode → the minted publish ACL).
   *  **Default-deny** (empty): publishing must be declared. Informational only here; the broker
   *  enforces it under auth. */
  allowPublish: string[];
  /** The trusted registration requires this session's event plane. */
  eventsRequired?: boolean;
  /** Per-channel attention DEFAULTS (operator, one-way from the agent file): channels to receive but
   *  never wake on ({@link quiet}) / to drop on receive ({@link muted}). Seeds {@link MeshAgent}'s
   *  runtime map; the runtime never writes them back. Concrete channels within {@link allowSubscribe}.
   *  Optional (absent ⇒ none), like the other discovery fields. */
  quiet?: string[];
  muted?: string[];
  kind: EndpointKind;
  /** The host connector this session runs under (`claude` / `opencode` / `hermes`). Set by the
   *  connector itself, never from user config — it rides the {@link AgentCard.meta}.connector on
   *  the wire as display-only discovery metadata (which harness an agent uses). */
  connector?: string;
  /** Buffer a live channel message that replies to another message (it carries `replyTo`) as
   *  pull-only unless it `@mention`s this seat. Set by the connector itself, for a host that posts
   *  every turn's output back to the channel the turn came from as a reply to the message that
   *  started it (Hermes): without it, two such seats on one channel start a turn on each other's
   *  output and never stop. */
  channelRepliesPullOnly?: boolean;
  /** Model the host runs this agent on (e.g. `claude-opus-4`), from `COTAL_MODEL`: the value the
   *  launcher resolved and the connector rendered, never a later read of the agent file. Rides
   *  {@link AgentCard.meta}.model as display-only discovery metadata; omitted when the operator
   *  didn't pin one (the harness default isn't knowable from here). */
  model?: string;
  /** Connector-defined model variant (for example reasoning effort), from `COTAL_VARIANT`, set the
   *  same way as {@link model}. Display-only discovery metadata. */
  variant?: string;
  token?: string;
  user?: string;
  pass?: string;
  tls: boolean;
  /** Optional beta-feedback key — routes feedback to the keyed intake at {@link FEEDBACK_URL};
   *  without it, feedback goes to the public {@link PUBLIC_FEEDBACK_URL}. */
  feedbackKey?: string;
  /** Optional intake URL override (`COTAL_FEEDBACK_URL`) for self-hosted intakes. */
  feedbackUrl?: string;
  /** Durable-consumer `ack_wait` in ms (how long an un-acked chat message waits before JetStream
   *  redelivers). Threaded straight to the endpoint; defaults to its 60s when unset. INTERNAL/TEST-ONLY:
   *  deliberately NOT parsed from env by `configFromEnv` — a test shortens it to observe redelivery /
   *  ack-commit in seconds; normal launches should not tune durability from connector config. */
  ackWaitMs?: number;
}

/**
 * Does this session's broker ENFORCE its grants?
 *
 * Named for what it means, not for the cases it happens to cover today, because the cases have
 * grown once already and the rename is the part that gets skipped. It mirrors `CotalEndpoint`'s own
 * private `authed` — "the gate every open-vs-auth branch keys on" — so connector-core and core
 * cannot drift on the question of what an authenticated session is; when a third identity plane
 * lands, this expression is the one place it has to be added.
 *
 * TWO PLANES TODAY, and they are mutually exclusive by construction: a launch carries static creds
 * OR a user-mode bearer, refused as a pair at parse (above), at launch (`materialEnv`) and at
 * connect (the endpoint). So `!config.creds` is NOT "open mode" — on a user-auth agent it is always
 * true, which is what made the advertised tool surface claim manager-op tools to every agent on a
 * user-auth mesh.
 *
 * `token` / `user` / `pass` are deliberately NOT here. Soft-shared NATS auth off a join link carries
 * no owner+actor grant and no per-agent publish ACL, so the broker gates nothing per agent for it;
 * core groups it with open mode for exactly that reason. Counting it as authenticated would hide
 * tools an agent can genuinely call, which is the same untruth in the other direction.
 */
export function isAuthed(config: Pick<AgentConfig, "creds" | "userAuth">): boolean {
  return Boolean(config.creds) || Boolean(config.userAuth);
}

function splitList(v: string | undefined): string[] {
  if (!v) return [];
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Drop the reference to the launch material once this process has read it.
 *
 * Only correct where the caller is the process that RUNS THE SESSION'S TOOL CALLS and nothing starts
 * later that has to read the material again. That is pi and the codex host, whose sessions run in the
 * seat process, and the OpenCode plugin, which runs inside the `opencode serve` process the seat shim
 * starts (the server is also what executes the tool calls, so the shim keeping the reference costs
 * nothing). There the descendants that would otherwise inherit the reference are the session's own
 * tool calls, and after this they inherit nothing at all. It is NOT correct for the Claude connector, whose readers are short-lived child processes
 * (the MCP server, each lifecycle hook) that start after the session is already running and would
 * find the reference gone.
 */
export function scrubLaunchMaterial(env: NodeJS.ProcessEnv = process.env): void {
  const path = env[LAUNCH_MATERIAL_ENV]?.trim();
  delete env[LAUNCH_MATERIAL_ENV];
  // UNLINK IT TOO, where there is provably no later reader. Dropping the pointer stops the reference
  // being inherited; deleting the file stops a same-uid process finding it by any other means, which
  // is the one part of the residual boundary that CAN be closed here. It is the only place in this
  // change where the honest limit gets smaller rather than better documented.
  //
  // Best-effort on purpose, and this is the one swallowed error in the file. The scrub has already
  // succeeded by the time this runs: throwing here would turn a tidy-up failure (a read-only tmpdir,
  // a file already reaped) into a failed session, and the state it would fail into is exactly the
  // state every launch had before this line existed.
  // The removal itself lives beside the writer, in core, because deciding what is safe to delete
  // needs the rules the writer used, and a second copy of those rules here is how a cleanup ends up
  // deleting something it did not create. See discardLaunchMaterial: the file always goes, the
  // private directory only when it is provably this module's own, and never recursively.
  if (path) discardLaunchMaterial(path);
}

/** Build an {@link AgentConfig} from `COTAL_*` environment variables. Two refs
 *  fill many fields at once: `COTAL_LINK` (cotal://token@host/space) supplies the
 *  *where* (server, auth, space); `COTAL_AGENT_FILE` (.cotal/agents/<name>.md)
 *  supplies the *who* (name, role, kind, channels, description, tags).
 *  Individual `COTAL_*` vars override both. Identity is NOT silently defaulted
 *  unless a link is present — guard with {@link hasIdentity} first. */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const link = env.COTAL_LINK?.trim() ? parseJoinLink(env.COTAL_LINK.trim()) : undefined;
  const def: AgentDef | undefined = env.COTAL_AGENT_FILE?.trim()
    ? loadAgentFile(env.COTAL_AGENT_FILE.trim())
    : undefined;
  const name = env.COTAL_NAME?.trim() || def?.name || (link ? userInfo().username : undefined);
  if (!name)
    throw new Error("COTAL_NAME, COTAL_AGENT_FILE or COTAL_LINK is required — a Cotal session needs an explicit identity from its launcher");
  const subscribe = splitList(env.COTAL_SUBSCRIBE);
  // Read set: env > persona file > join link. No implicit channel at the end of that chain — a
  // session whose launcher, persona and link all name none joins none (DM-reachable, not on `general`).
  const resolvedSubscribe = subscribe.length ? subscribe : (def?.subscribe ?? link?.channels ?? []);
  const allowSub = splitList(env.COTAL_ALLOW_SUBSCRIBE);
  // Resolved against the FINAL read set, not the file's: an env `COTAL_SUBSCRIBE` can replace the
  // persona's list, and the loader only checked the file against itself.
  let resolvedAllowSub: string[];
  try {
    resolvedAllowSub = resolveReadAcl(resolvedSubscribe, allowSub.length ? allowSub : def?.allowSubscribe);
  } catch (e) {
    throw new Error(`COTAL config: ${(e as Error).message}`);
  }
  const allowPub = splitList(env.COTAL_ALLOW_PUBLISH);
  const resolvedAllowPub = allowPub.length ? allowPub : (def?.allowPublish ?? []);
  // Reject channel names the wire layer would rewrite (env overrides bypass the file loader's check).
  for (const ch of [...resolvedSubscribe, ...resolvedAllowSub, ...resolvedAllowPub]) assertValidChannel(ch);
  // Per-channel attention defaults (env > agent-file). Re-validate here too — the loader checked them
  // against the file's read set, but an env override of allowSubscribe could have moved that boundary:
  // each must be a concrete channel within the (resolved) read ACL (allowSubscribe), and quiet/muted disjoint.
  const qEnv = splitList(env.COTAL_QUIET), mEnv = splitList(env.COTAL_MUTED);
  const resolvedQuiet = qEnv.length ? qEnv : (def?.quiet ?? []);
  const resolvedMuted = mEnv.length ? mEnv : (def?.muted ?? []);
  const bothModes = resolvedQuiet.filter((c) => resolvedMuted.includes(c));
  if (bothModes.length) throw new Error(`COTAL config: channel(s) [${bothModes.join(", ")}] are in both quiet and muted`);
  for (const [field, chans] of [["quiet", resolvedQuiet], ["muted", resolvedMuted]] as const)
    for (const ch of chans) {
      assertValidChannel(ch);
      if (!isConcreteChannel(ch)) throw new Error(`COTAL config: ${field} channel "${ch}" must be concrete (no wildcard)`);
      if (!channelInAllow(resolvedAllowSub, ch))
        throw new Error(`COTAL config: ${field} channel "${ch}" is not within allowSubscribe [${resolvedAllowSub.join(", ")}]`);
    }
  // CONNECTION MATERIAL. A launcher-spawned seat gets it as a private file it is pointed at; a
  // hand-driven session (an operator's own `claude` with the plugin, a custom launcher) still sets
  // the documented COTAL_CREDS/COTAL_SERVERS/... variables itself. Both carriers together is a
  // BROKEN LAUNCH, not a precedence question: two sources of identity for one session is exactly
  // the ambiguity that ends with a seat connected as something nobody chose, so it throws.
  const material = readMaterial(env);
  const credsPath = material?.creds ?? env.COTAL_CREDS?.trim();
  // Read once to pin the connection identity at boot, then preserve the FILE as the endpoint's
  // standing-renewal source. Every later read is checked against this id by CotalEndpoint, so a
  // re-sign can extend the JWT window but can never swap the seat's nkey.
  const initialCreds = credsPath ? readFileSync(credsPath, "utf8") : undefined;
  const credsId = initialCreds ? idFromCreds(initialCreds) : undefined;
  // An unbounded cred has no renewal point. Preserve it as the endpoint's documented static-string
  // shape instead of manufacturing a standing-renewal source that core must refuse.
  const boundedCreds = initialCreds !== undefined && typeof credsClaims(initialCreds).exp === "number";
  const declaredId = env.COTAL_ID?.trim() || undefined;
  if (declaredId && credsId && declaredId !== credsId)
    throw new Error(`COTAL config: COTAL_ID ${declaredId} != creds identity ${credsId} - they must be the same nkey`);
  // USER-MODE identity: all-or-nothing — a partial set means a broken launcher, and connecting
  // with half an identity (or silently falling back to open) is exactly the U10 hazard.
  const userVars = material?.userAuth
    ? {
        owner: material.userAuth.owner,
        actor: material.userAuth.actor,
        sentinel: material.userAuth.sentinelCredsPath,
        bearerCmd: JSON.stringify(material.userAuth.bearerCmd),
      }
    : {
        owner: env.COTAL_OWNER?.trim(),
        actor: env.COTAL_ACTOR?.trim(),
        sentinel: env.COTAL_SENTINEL_CREDS?.trim(),
        bearerCmd: env.COTAL_BEARER_CMD?.trim(),
      };
  const userSet = Object.values(userVars).filter(Boolean).length;
  if (userSet > 0 && userSet < 4)
    throw new Error("COTAL config: user-mode launch needs ALL of COTAL_OWNER, COTAL_ACTOR, COTAL_SENTINEL_CREDS, COTAL_BEARER_CMD — a partial set is a broken launcher, not a mode");
  if (userSet && credsPath)
    throw new Error("COTAL config: COTAL_CREDS (static auth) and COTAL_OWNER/... (user-mode auth) are mutually exclusive");
  // FAIL-FAST at parse (SPEC 13.1): an AUTHED mesh agent (static creds OR user-mode) is a
  // consuming, presence-registering endpoint whose dm/dlv/chathist durable names are lifecycle-
  // keyed, so the launcher-minted uid is part of the identity set - a launch without it would
  // only die later at the endpoint's fail-before-presence gate with a worse operator signal.
  // Open mode stays uid-less here (the endpoint self-mints its per-session identity).
  const lifecycleUid = env.COTAL_LIFECYCLE_UID?.trim() || undefined;
  const backfillFloorRaw = env.COTAL_BACKFILL_FLOOR?.trim() || undefined;
  let backfillFloor: number | undefined;
  if (backfillFloorRaw !== undefined) {
    const n = Number(backfillFloorRaw);
    if (!Number.isInteger(n) || n < 0)
      throw new Error(`COTAL config: COTAL_BACKFILL_FLOOR must be a non-negative integer stream sequence, got "${backfillFloorRaw}" (a broken launcher, not a mode)`);
    backfillFloor = n;
  }
  const acceptedToken = env.COTAL_ACCEPTED_TOKEN?.trim() || undefined;
  const managerInstanceId = env.COTAL_MANAGER_INSTANCE?.trim() || undefined;
  if (managerInstanceId !== undefined) assertLifecycleToken(managerInstanceId, "COTAL_MANAGER_INSTANCE");
  if (acceptedToken && !credsPath)
    throw new Error("COTAL config: COTAL_ACCEPTED_TOKEN names a static issuance and needs COTAL_CREDS beside it (a broken launcher, not a mode)");
  if ((credsPath || userSet === 4) && !lifecycleUid)
    throw new Error(
      "COTAL config: an authed launch (COTAL_CREDS or user-mode) requires COTAL_LIFECYCLE_UID - the launcher mints it at provision time (a broken launcher, not a mode)",
    );
  let userAuth: AgentConfig["userAuth"];
  if (userSet === 4) {
    let bearerCmd: unknown;
    try {
      bearerCmd = JSON.parse(userVars.bearerCmd!);
    } catch {
      throw new Error("COTAL config: COTAL_BEARER_CMD must be a JSON argv array");
    }
    if (!Array.isArray(bearerCmd) || !bearerCmd.length || !bearerCmd.every((a) => typeof a === "string"))
      throw new Error("COTAL config: COTAL_BEARER_CMD must be a non-empty JSON array of strings");
    userAuth = {
      owner: userVars.owner!,
      actor: userVars.actor!,
      sentinelCreds: readFileSync(userVars.sentinel!, "utf8"),
      bearerCmd: bearerCmd as string[],
    };
  }
  const eventsRequired = material?.eventsRequired === true || (!material && /^(1|true|yes|on)$/i.test(env.COTAL_EVENTS_REQUIRED ?? ""));
  if (eventsRequired && !userAuth)
    throw new Error("COTAL config: COTAL_EVENTS_REQUIRED is valid only for a user-mode registration launch");
  if (eventsRequired) {
    const principal = userSet === 4
      ? { owner: userVars.owner!, actor: userVars.actor! }
      : { owner: DEV_OWNER, actor: credsId ?? declaredId ?? "" };
    if (!principal.actor)
      throw new Error("COTAL config: this space requires events, but the session has no stable principal to derive its event channel");
    const channel = eventChannel(principal);
    if (!channelInAllow(resolvedAllowPub, channel))
      throw new Error(
        `COTAL config: space "${env.COTAL_SPACE?.trim() || link?.space || "demo"}" requires events, but this session's grant does not cover its event channel "${channel}". ` +
          `Widen the whole user-auth actor row with \`cotal actor grant ${principal.actor} --owner ${principal.owner} --scope <current-scope> --allow-subscribe <current-read> --allow-publish '<current-post>,${channel}' --role <current-role> --label <current-label>\`; actor grant replaces the whole row, so preserve every current field.`,
      );
  }
  return {
    space: env.COTAL_SPACE?.trim() || link?.space || "demo",
    id: credsId ?? declaredId,
    lifecycleUid,
    backfillFloor,
    acceptedToken,
    managerInstanceId,
    creds: boundedCreds ? async () => readFileSync(credsPath!, "utf8") : initialCreds,
    userAuth,
    name,
    role: env.COTAL_ROLE?.trim() || def?.role || undefined,
    description: def?.description,
    tags: def?.tags,
    meta: def?.meta,
    capabilities: splitList(env.COTAL_CAPABILITIES).length ? splitList(env.COTAL_CAPABILITIES) : def?.capabilities,
    model: env.COTAL_MODEL?.trim() || undefined,
    variant: env.COTAL_VARIANT?.trim() || undefined,
    servers: material?.servers || env.COTAL_SERVERS?.trim() || link?.servers || DEFAULT_SERVER,
    subscribe: resolvedSubscribe,
    allowSubscribe: resolvedAllowSub,
    // Post ACL is default-DENY: only what's explicitly declared (env > agent-file). The broker
    // enforces it under auth; in open mode posting is unrestricted regardless.
    allowPublish: resolvedAllowPub,
    eventsRequired,
    quiet: resolvedQuiet,
    muted: resolvedMuted,
    kind: (env.COTAL_KIND?.trim() as EndpointKind) || def?.kind || "agent",
    token: material?.token || env.COTAL_TOKEN?.trim() || link?.token,
    user: link?.user,
    pass: link?.pass,
    tls: env.COTAL_TLS?.trim() === "1" || link?.tls || false,
    feedbackKey: env.COTAL_FEEDBACK_KEY?.trim() || undefined,
    feedbackUrl: env.COTAL_FEEDBACK_URL?.trim() || undefined,
  };
}

/** Beta-feedback guidance folded into connector instructions. */
export function feedbackLine(config: AgentConfig): string {
  const dest = config.feedbackKey
    ? ""
    : `Without a feedback key it goes to the public cotal.ai intake and needs a contact email — ` +
      `the tool will tell you to ask the user for one if it can't find it. `;
  return (
    `Use cotal_feedback with origin="human" when the user asks you to ` +
    `send feedback or gives you feedback to pass along. If you independently hit a major Cotal ` +
    `issue — for example repeated Cotal tool failures, inability to connect, lost/incorrect mesh ` +
    `messages, or a workflow-blocking bug — send cotal_feedback yourself with origin="agent". ` +
    `Do not send minor noise or secrets; include diagnostics only when they help debug the Cotal issue. ` +
    dest
  );
}
