import { userInfo } from "node:os";
import { readFileSync } from "node:fs";
import { DEFAULT_SERVER, assertValidChannel, channelInAllow, loadAgentFile, parseJoinLink, type AgentDef, type EndpointKind } from "@cotal-ai/core";

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
  kind: EndpointKind;
  token?: string;
  user?: string;
  pass?: string;
  tls: boolean;
  /** Optional beta-feedback key — routes feedback to the keyed intake at {@link FEEDBACK_URL};
   *  without it, feedback goes to the public {@link PUBLIC_FEEDBACK_URL}. */
  feedbackKey?: string;
  /** Optional intake URL override (`COTAL_FEEDBACK_URL`) for self-hosted intakes. */
  feedbackUrl?: string;
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
  const credsPath = env.COTAL_CREDS?.trim();
  return {
    space: env.COTAL_SPACE?.trim() || link?.space || "demo",
    id: env.COTAL_ID?.trim() || undefined,
    creds: credsPath ? readFileSync(credsPath, "utf8") : undefined,
    name,
    role: env.COTAL_ROLE?.trim() || def?.role || undefined,
    description: def?.description,
    tags: def?.tags,
    servers: env.COTAL_SERVERS?.trim() || link?.servers || DEFAULT_SERVER,
    subscribe: resolvedSubscribe,
    allowSubscribe: resolvedAllowSub,
    // Post ACL is default-DENY: only what's explicitly declared (env > agent-file). The broker
    // enforces it under auth; in open mode posting is unrestricted regardless (see laneLine).
    allowPublish: resolvedAllowPub,
    kind: (env.COTAL_KIND?.trim() as EndpointKind) || def?.kind || "agent",
    token: env.COTAL_TOKEN?.trim() || link?.token,
    user: link?.user,
    pass: link?.pass,
    tls: env.COTAL_TLS?.trim() === "1" || link?.tls || false,
    feedbackKey: env.COTAL_FEEDBACK_KEY?.trim() || undefined,
    feedbackUrl: env.COTAL_FEEDBACK_URL?.trim() || undefined,
  };
}

/** One sentence telling the agent its channel lanes — what it reads and where it may post —
 *  so it knows its scope up front instead of discovering it from inbound tags and send errors.
 *  Folded into each connector's MCP `instructions`. It must match the broker truth: under auth the
 *  post ACL is default-deny, so an undeclared agent genuinely cannot post (state it plainly rather
 *  than promise a lane the broker will reject). In open mode there is no cred, so posting is
 *  unrestricted regardless of the (display-only) post ACL. */
export function laneLine(config: AgentConfig): string {
  const fmt = (cs: string[]) => cs.map((c) => `#${c}`).join(", ");
  const subs = config.subscribe;
  // Open mode (no creds) ⇒ nothing is enforced; the agent reads and posts to its channels freely.
  if (!config.creds) return `You read and may post to ${fmt(subs)}. `;
  const pubs = config.allowPublish;
  if (!pubs.length) return `You read ${fmt(subs)}; you may not post to any channel (no publish channels granted). `;
  const same = subs.length === pubs.length && subs.every((c) => pubs.includes(c));
  return same
    ? `You read and may post to ${fmt(subs)}. `
    : `You read ${fmt(subs)}; you may post only to ${fmt(pubs)} (posts to other channels are rejected). `;
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
