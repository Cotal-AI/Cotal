/**
 * `cotal spawn -f` classification — the pure decision layer over a running mesh's live state (the
 * channel registry, the roster, the broker-sourced membership feed) plus any prior ledger for this
 * manifest. It never mutates: it produces the plan that drives `--dry-run`, the apply grouping, and
 * the SECURITY warnings. Creation-only by construction — a pre-existing unmanaged channel/agent is
 * classified, never adopted or patched.
 */
import { subjectMatches, type ChannelConfig, type ChannelRegistryFile, type MembershipSnapshot, type Presence } from "@cotal-ai/core";
import type { ResolvedChannel } from "./model.js";
import type { PreparedAgent } from "./prepare.js";
import type { MeshLedger } from "./ledger.js";
import { hashAgent } from "./apply.js";

// ---- channels ---------------------------------------------------------------------------------

export interface ChannelPlan {
  /** Brand-new registry keys this run will create + seed + ledger-own. */
  create: ResolvedChannel[];
  /** Keys that already exist and are NOT owned by this run — left untouched (no card mutation); the
   *  manifest-desired card is shown against the live one. */
  existsUnmanaged: Array<{ channel: ResolvedChannel; live: ChannelConfig }>;
  /** Keys this run already owns (prior ledger) — ours to additively re-seed. */
  owned: ResolvedChannel[];
}

/** Classify each declared channel against the live registry + this run's owned keys. Only brand-new
 *  keys are creatable/ownable; a key present but unowned is `exists-unmanaged` (never adopted). */
export function classifyChannels(declared: ResolvedChannel[], live: ChannelRegistryFile, ownedKeys: Set<string>): ChannelPlan {
  const create: ResolvedChannel[] = [];
  const existsUnmanaged: Array<{ channel: ResolvedChannel; live: ChannelConfig }> = [];
  const owned: ResolvedChannel[] = [];
  for (const ch of declared) {
    const liveCfg = live.channels?.[ch.name];
    if (!liveCfg) create.push(ch);
    else if (ownedKeys.has(ch.name)) owned.push(ch);
    else existsUnmanaged.push({ channel: ch, live: liveCfg });
  }
  return { create, existsUnmanaged, owned };
}

// ---- agents -----------------------------------------------------------------------------------

export type AgentDisposition = "will-create" | "already-owned" | "stale";

export interface PriorAgent {
  requested: string;
  name: string;
  id: string;
  hash: string;
}

export interface AgentPlanEntry {
  agent: PreparedAgent;
  /** Resolved hash of the declared agent (drift key). */
  hash: string;
  disposition: AgentDisposition;
  /** The prior ledger entry, for `already-owned` / `stale`. */
  prior?: PriorAgent;
  /** Whether the prior spawned agent is currently present on the mesh (stale wording). */
  running?: boolean;
}

export interface AgentPlan {
  entries: AgentPlanEntry[];
  willCreate: AgentPlanEntry[];
  alreadyOwned: AgentPlanEntry[];
  stale: AgentPlanEntry[];
}

/** Classify declared agents against any prior ledger (matched by manifest key) + the live roster:
 *  not previously created → `will-create`; previously created + same resolved hash → `already-owned`
 *  (no-op); previously created + hash changed → `stale` (restart required). */
export function classifyAgents(agents: PreparedAgent[], roster: Presence[], prior?: MeshLedger): AgentPlan {
  const present = new Set(roster.filter((p) => p.status !== "offline").map((p) => p.card.name));
  const priorByKey = new Map((prior?.created.agents ?? []).map((a) => [a.requested, a]));
  const entries: AgentPlanEntry[] = agents.map((agent) => {
    const hash = hashAgent(agent);
    const p = priorByKey.get(agent.name); // PreparedAgent.name is the manifest `agents:` key
    if (!p) return { agent, hash, disposition: "will-create" };
    const running = present.has(p.name);
    return { agent, hash, disposition: p.hash === hash ? "already-owned" : "stale", prior: p, running };
  });
  return {
    entries,
    willCreate: entries.filter((e) => e.disposition === "will-create"),
    alreadyOwned: entries.filter((e) => e.disposition === "already-owned"),
    stale: entries.filter((e) => e.disposition === "stale"),
  };
}

// ---- unmanaged actors (SECURITY) --------------------------------------------------------------

export interface UnmanagedActor {
  id: string;
  name?: string;
  /** How the access was observed: a durable membership record, or a live (CONNZ) subscription. */
  via: "durable" | "live";
}

export interface ChannelExposure {
  channel: string;
  actors: UnmanagedActor[];
}

export interface UnmanagedReport {
  /** Per declared channel: unmanaged actors observed with read access to it (a SECURITY conflict). */
  perChannel: ChannelExposure[];
  /** True when the broker-sourced membership feed was readable (the per-channel signal is meaningful).
   *  When false, the report is presence-only — an explicit LOWER BOUND, not "no unmanaged access." */
  feedAvailable: boolean;
  /** Feed freshness (epoch ms) when available. */
  asOf?: number;
  /** Present peers not owned by this run — mesh-level context (not necessarily on a declared channel). */
  presentUnowned: Array<{ id: string; name: string; role?: string }>;
}

/** Observe unmanaged actors with read access to a manifest-declared channel — an isolation conflict
 *  on a shared mesh. v1 is an explicit LOWER BOUND: it uses the roster (presence) + the broker
 *  membership feed (durable members + CONNZ live subscriptions); when the feed is absent it falls back
 *  to presence only and says so. `owned` is this run's agents (ids + spawned names) to exclude. */
export function detectUnmanagedActors(
  declared: string[],
  snapshot: MembershipSnapshot | null,
  roster: Presence[],
  owned: { ids: Set<string>; names: Set<string> },
): UnmanagedReport {
  const presentUnowned = roster
    .filter((p) => p.status !== "offline" && !owned.ids.has(p.card.id) && !owned.names.has(p.card.name))
    .map((p) => ({ id: p.card.id, name: p.card.name, role: p.card.role }));
  const nameOf = new Map(roster.map((p) => [p.card.id, p.card.name]));
  const perChannel: ChannelExposure[] = [];
  if (snapshot) {
    for (const channel of declared) {
      const actors: UnmanagedActor[] = [];
      for (const m of snapshot.members) {
        if (owned.ids.has(m.id)) continue;
        const durable = m.durable.includes(channel);
        const live = !durable && m.live.some((pat) => subjectMatches(pat, channel)); // channel-token wildcards (`team.>`)
        if (durable || live) actors.push({ id: m.id, name: nameOf.get(m.id), via: durable ? "durable" : "live" });
      }
      if (actors.length) perChannel.push({ channel, actors });
    }
  }
  return { perChannel, feedAvailable: Boolean(snapshot?.asOf), asOf: snapshot?.asOf, presentUnowned };
}
