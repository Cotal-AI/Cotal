/**
 * The `cotal_orientation` card — a structured, versioned self/context snapshot an agent reads to
 * orient: who it is, what it may read/post, what it can do, and what's around it.
 *
 * Built from the SAME {@link AgentConfig} (+ the gated tool list the connector exposes) that gates the
 * tools, so it can never drift from what's actually enforced. Connector-local introspection — an agent
 * reading its own minted grants — NOT a wire/SPEC capability handshake.
 *
 * The typed {@link Orientation} object is the source of truth; {@link renderOrientation} is one view of
 * it (the text the model reads). A future MCP resource can JSON-stringify the object directly.
 */
import type { AttentionMode, PresenceStatus } from "@cotal-ai/core";
import type { MeshAgent } from "./agent.js";
import type { AgentConfig } from "./config.js";
import { DOCS_VERSION } from "./docs.js";

/** One-line connector bootstrap that points a joining agent at `cotal_orientation`. Folded into each
 *  connector's system prompt / MCP instructions so every agent — Claude Code, OpenCode, Hermes — is
 *  told to orient first, from a single source of truth. */
export const ORIENTATION_BOOTSTRAP =
  "Start with cotal_orientation — it shows your identity, the channels you can read and post to, " +
  "your capabilities, the tools available to you, and who's present.";

/** Mesh-first steer, folded in alongside {@link ORIENTATION_BOOTSTRAP} for every connector. Keeps
 *  multi-agent work on the mesh instead of inside the harness's own hidden subagents, so it stays
 *  visible to the user and addressable by peers. Unconditional (a read-only agent still delegates via
 *  DM/anycast rather than a private subagent); the spawn-specific detail lives on the cotal_spawn tool. */
export const MESH_FIRST_STEER =
  "Keep multi-agent work on the mesh. Before reaching for your harness's own subagents, Task tool, or " +
  "any built-in parallel-agent feature, do it through Cotal instead: spawn or delegate to a real peer " +
  "(cotal_spawn if you have it, otherwise cotal_dm or cotal_anycast to reach one) so the work stays " +
  "visible to the user and addressable by peers rather than hidden inside a private subagent.";

/** A tool the agent can actually call (already gated), as it appears in the card. */
export interface OrientationTool {
  name: string;
  title: string;
}

export interface Orientation {
  /** Schema version — bump on a breaking shape change so future renderers/resources can adapt. */
  v: 1;
  /** Snapshot stamp. The live fields below (peers / status / attention / unread) are as of this time;
   *  the identity/access/capabilities/tools fields are static for the session. */
  generatedAt: number;
  identity: { name: string; role?: string; space: string; id: string; cotalVersion: string };
  access: {
    /** auth mode → these grants are broker-enforced; open mode → advisory (host-trusted) only. */
    authMode: boolean;
    /** Active read set — channels you currently receive. */
    read: string[];
    /** Read ACL — channels you MAY join (equals `read` when no creds). */
    readAcl: string[];
    /** Post ACL — channels you may broadcast to. Empty ⇒ read-only (default-deny). */
    post: string[];
  };
  /** Control-plane capabilities (e.g. `spawn`). Empty ⇒ none beyond the defaults granted to all. */
  capabilities: string[];
  /** The tools available to you, grouped so the surface reads small: `core` is the everyday loop. */
  tools: { core: OrientationTool[]; more: OrientationTool[] };
  peers: {
    present: number;
    summary: string;
    /**
     * The distinct roles present, with how many peers hold each.
     *
     * Here as DATA rather than as advice, because that is the difference between a card that
     * describes the space and one that lets an agent find something in it. An agent that needs a
     * service peer — a board, an indexer, a gateway — has to learn two things: that one is running
     * at all, and how to address it. The summary above answers neither past its first eight
     * entries, and a name written into a brief answers the second one only until the peer is
     * respawned under a different name.
     *
     * Peers with no role are counted in `present` and absent here: a peer that declares no role is
     * not addressable by one, and inventing a bucket for them would list something nobody can ask
     * for. Sorted by role name so the same space renders the same card twice running.
     */
    roles: { role: string; count: number }[];
  };
  status: PresenceStatus;
  attention: AttentionMode;
  unread: { total: number };
  /** A factual map from intent → tool. Not a prescribed sequence. */
  actions: { read: string; replyChannel: string; replyPrivate: string; askRole: string };
}

/** The everyday loop (the `core` group); every other tool falls into `more`. Keep in sync with the
 *  reply/loop tools an agent reaches for each turn. An unknown/new tool defaults to `more`. */
const CORE_TOOLS = new Set([
  "cotal_inbox",
  "cotal_send",
  "cotal_dm",
  "cotal_anycast",
  "cotal_roster",
  "cotal_status",
]);

/** Assemble the card. `visibleTools` is the already-gated tool list the connector exposes (pass the
 *  result of `cotalToolSpecs(config)` mapped to name/title) — the orientation tool itself is dropped.
 *  Pure: `generatedAt` is supplied by the caller so it's testable and deterministic. */
export function buildOrientation(
  agent: MeshAgent,
  config: AgentConfig,
  visibleTools: OrientationTool[],
  generatedAt: number,
): Orientation {
  const core: OrientationTool[] = [];
  const more: OrientationTool[] = [];
  for (const t of visibleTools) {
    if (t.name === "cotal_orientation") continue; // don't list the orientation tool in its own card
    (CORE_TOOLS.has(t.name) ? core : more).push(t);
  }

  const peers = agent.roster().filter((p) => p.card.id !== agent.id);
  const shown = peers
    .slice(0, 8)
    .map((p) => `${p.card.role ? `${p.card.name}/${p.card.role}` : p.card.name} (${p.status})`);
  const summary = peers.length
    ? shown.join(", ") + (peers.length > shown.length ? `, +${peers.length - shown.length} more` : "")
    : "no other peers present";

  // Counted over ALL peers, not the eight the summary shows: the point of this field is to answer
  // "is there one of these here" for a space too big to list, which is exactly the space where the
  // summary has already truncated.
  const byRole = new Map<string, number>();
  for (const p of peers) {
    const role = p.card.role;
    if (role) byRole.set(role, (byRole.get(role) ?? 0) + 1);
  }
  const roles = [...byRole]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([role, count]) => ({ role, count }));

  return {
    v: 1,
    generatedAt,
    identity: { name: config.name, role: config.role, space: config.space, id: agent.id, cotalVersion: DOCS_VERSION },
    access: {
      authMode: !!config.creds,
      read: config.subscribe,
      readAcl: config.allowSubscribe,
      post: config.allowPublish,
    },
    capabilities: config.capabilities ?? [],
    tools: { core, more },
    peers: { present: peers.length, summary, roles },
    status: agent.status,
    attention: agent.attention,
    unread: { total: agent.inboxCount() },
    actions: {
      read: "cotal_inbox",
      replyChannel: "cotal_send",
      replyPrivate: "cotal_dm",
      askRole: "cotal_anycast",
    },
  };
}

/** Render the card as compact, glanceable text — the view the model reads. */
export function renderOrientation(o: Orientation): string {
  const fmt = (cs: string[]) => (cs.length ? cs.map((c) => `#${c}`).join(", ") : "—");
  const who = o.identity.role ? `${o.identity.name}/${o.identity.role}` : o.identity.name;
  const aclDiffers =
    o.access.readAcl.length !== o.access.read.length ||
    o.access.readAcl.some((c) => !o.access.read.includes(c));

  const lines: string[] = [
    `You are ${who} in space "${o.identity.space}" (id ${o.identity.id.slice(0, 8)}…).`,
    `Cotal v${o.identity.cotalVersion} — call cotal_docs for the version-exact spec, schema, and guides. ` +
      "Consult it before answering about Cotal or writing code against it; don't rely on training memory.",
    "",
    `Access — ${o.access.authMode ? "auth mode (grants are broker-enforced)" : "open mode (grants advisory, host-trusted)"}:`,
    `  • read: ${fmt(o.access.read)}`,
  ];
  if (aclDiffers) lines.push(`  • may join (read ACL): ${fmt(o.access.readAcl)}`);
  lines.push(
    `  • post: ${o.access.post.length ? fmt(o.access.post) : "— (read-only; no post channels)"}`,
    `  • capabilities: ${o.capabilities.length ? o.capabilities.join(", ") : "none beyond defaults"}`,
    "",
    `Tools — core loop: ${o.tools.core.map((t) => t.name).join(", ") || "—"}`,
    `Tools — more: ${o.tools.more.map((t) => t.name).join(", ") || "—"}`,
    "",
    `Right now (snapshot @ ${new Date(o.generatedAt).toISOString()}):`,
    `  • status: ${o.status} · attention: ${o.attention}`,
    `  • peers present: ${o.peers.present} — ${o.peers.summary}`,
  );
  // Only when there is a role to address. With none, the rule below is a sentence about nothing.
  if (o.peers.roles.length) {
    lines.push(
      `  • roles present: ${o.peers.roles.map((r) => `${r.role} (${r.count})`).join(", ")}`,
      "    A peer that provides a service is found by its ROLE, not by a name someone wrote in a brief: " +
        "pick the role here, take that peer's name from cotal_roster, and message it directly. Names are " +
        "reassigned when a peer is respawned; a role is what the peer is. No role you need means it is not " +
        "running in this space, and several holders mean you must choose rather than assume.",
    );
  }
  lines.push(
    `  • unread: ${o.unread.total}`,
    "",
    `Act → read: ${o.actions.read} · reply on a channel: ${o.actions.replyChannel} · ` +
      `private: ${o.actions.replyPrivate} · ask a role: ${o.actions.askRole}`,
  );
  return lines.join("\n");
}
