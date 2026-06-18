import { userInfo } from "node:os";
import { readFileSync } from "node:fs";
import { DEFAULT_SERVER, loadAgentFile, parseJoinLink, type AgentDef, type EndpointKind } from "@cotal-ai/core";

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
  /** Channels this agent subscribes to (read). May include wildcard subtrees (`team.>`). */
  channels: string[];
  /** Channels this agent may post to (write). Falls back to `channels` when unset, matching
   *  the agent-file convention and the minted publish ACL. */
  publish: string[];
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
  /** When set (`COTAL_MCP_BRIDGE=1`), surface the `cotal_tools` / `cotal_tool` tools so this
   *  agent can discover and call external MCP tools shared on the mesh by an mcp-bridge peer. */
  mcpBridge?: boolean;
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
  const channels = splitList(env.COTAL_CHANNELS);
  const resolvedChannels = channels.length ? channels : (def?.channels ?? link?.channels ?? ["general"]);
  const publish = splitList(env.COTAL_PUBLISH);
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
    channels: resolvedChannels,
    publish: publish.length ? publish : (def?.publish ?? resolvedChannels),
    kind: (env.COTAL_KIND?.trim() as EndpointKind) || def?.kind || "agent",
    token: env.COTAL_TOKEN?.trim() || link?.token,
    user: link?.user,
    pass: link?.pass,
    tls: env.COTAL_TLS?.trim() === "1" || link?.tls || false,
    feedbackKey: env.COTAL_FEEDBACK_KEY?.trim() || undefined,
    feedbackUrl: env.COTAL_FEEDBACK_URL?.trim() || undefined,
    mcpBridge: env.COTAL_MCP_BRIDGE?.trim() === "1",
  };
}

/** One sentence telling the agent its channel lanes — what it reads and where it may post —
 *  so it knows its scope up front instead of discovering it from inbound tags and send errors.
 *  Folded into each connector's MCP `instructions`. Publish outside the lane is rejected by the
 *  broker (auth mode), so state it plainly. */
export function laneLine(config: AgentConfig): string {
  const fmt = (cs: string[]) => cs.map((c) => `#${c}`).join(", ");
  const subs = config.channels;
  const pubs = config.publish.length ? config.publish : config.channels;
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
