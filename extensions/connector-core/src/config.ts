import { userInfo } from "node:os";
import { readFileSync } from "node:fs";
import { DEFAULT_SERVER, assertValidChannel, channelInAllow, isConcreteChannel, loadAgentFile, parseJoinLink, type AgentDef, type ChannelMode, type EndpointKind } from "@cotal-ai/core";

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
  /** Minted creds file content (auth mode); the endpoint authenticates with it. */
  creds?: string;
  name: string;
  role?: string;
  description?: string;
  tags?: string[];
  /** Display-only metadata from unmodelled agent-file frontmatter keys (for example `theme`).
   *  Connector-owned keys such as `connector` and `model` are overlaid later and cannot be spoofed here. */
  meta?: Record<string, string>;
  /** Control-plane capabilities this session declares (from the agent file's `capabilities:`); today
   *  only `spawn`. Used to gate the manager-op tools (cotal_spawn / cotal_persona) so the advertised
   *  surface matches what the agent can actually invoke. The cred layer is the real boundary (auth
   *  mode); open mode mints no creds, so the gate is permissive there. Same file the manager minted
   *  creds from, so the tool gate mirrors the wire grant exactly. */
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
  /** Model the host runs this agent on (e.g. `claude-opus-4`), from the agent file's `model:` or
   *  `COTAL_MODEL`. Rides {@link AgentCard.meta}.model as display-only discovery metadata; omitted
   *  when the operator didn't pin one (the harness default isn't knowable from here). */
  model?: string;
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

function splitList(v: string | undefined): string[] {
  if (!v) return [];
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** True iff the env carries a Cotal identity — i.e. this is a launcher-spawned
 *  session, not an operator's plain `claude`. `COTAL_LINK` / `COTAL_AGENT_FILE`
 *  count: setting either is itself the explicit opt-in. The connector stays
 *  inert otherwise. */
export function hasIdentity(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.COTAL_NAME?.trim() || env.COTAL_LINK?.trim() || env.COTAL_AGENT_FILE?.trim());
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
  const resolvedSubscribe = subscribe.length ? subscribe : (def?.subscribe ?? link?.channels ?? ["general"]);
  const allowSub = splitList(env.COTAL_ALLOW_SUBSCRIBE);
  const resolvedAllowSub = allowSub.length ? allowSub : (def?.allowSubscribe ?? resolvedSubscribe);
  // Fail loud on an inconsistent env override (the agent-file loader already checks the file): the
  // active read set must be within the read ACL, or the agent would subscribe to what it can't read.
  for (const ch of resolvedSubscribe)
    if (!channelInAllow(resolvedAllowSub, ch))
      throw new Error(`COTAL config: subscribe channel "${ch}" is not within allowSubscribe [${resolvedAllowSub.join(", ")}]`);
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
  const credsPath = env.COTAL_CREDS?.trim();
  return {
    space: env.COTAL_SPACE?.trim() || link?.space || "demo",
    id: env.COTAL_ID?.trim() || undefined,
    creds: credsPath ? readFileSync(credsPath, "utf8") : undefined,
    name,
    role: env.COTAL_ROLE?.trim() || def?.role || undefined,
    description: def?.description,
    tags: def?.tags,
    meta: def?.meta,
    capabilities: splitList(env.COTAL_CAPABILITIES).length ? splitList(env.COTAL_CAPABILITIES) : def?.capabilities,
    model: env.COTAL_MODEL?.trim() || def?.model || undefined,
    servers: env.COTAL_SERVERS?.trim() || link?.servers || DEFAULT_SERVER,
    subscribe: resolvedSubscribe,
    allowSubscribe: resolvedAllowSub,
    // Post ACL is default-DENY: only what's explicitly declared (env > agent-file). The broker
    // enforces it under auth; in open mode posting is unrestricted regardless.
    allowPublish: resolvedAllowPub,
    quiet: resolvedQuiet,
    muted: resolvedMuted,
    kind: (env.COTAL_KIND?.trim() as EndpointKind) || def?.kind || "agent",
    token: env.COTAL_TOKEN?.trim() || link?.token,
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
