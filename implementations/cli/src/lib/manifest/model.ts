/**
 * The resolved manifest model — the typed output of the pure pipeline (parse → schema →
 * normalize/invert → semantic), with channel-centric membership inverted into per-agent ACLs.
 * Preflight (persona reads + the `include` merge) and the plan/apply stages consume this.
 */
import type { ChannelDefaults, DeliveryClass } from "@cotal-ai/core";

export type PersonaPermissions = "reject" | "include";

/** A channel after normalization: `allowSubscribe` defaulted to `subscribe`, dedup'd. The
 *  registry-card fields (description/instructions/replay…) seed the channel registry verbatim. */
export interface ResolvedChannel {
  name: string;
  description?: string;
  instructions?: string;
  /** Active read set (boot subscription). */
  subscribe: string[];
  /** Read ACL — may read/join. Defaults to {@link subscribe}; always a superset of it. */
  allowSubscribe: string[];
  /** Post ACL (default-deny: empty ⇒ nobody posts). */
  allowPublish: string[];
  replay?: boolean;
  replayWindow?: string;
  deliveryClass?: DeliveryClass;
}

/** Per-agent ACLs inverted from the channel membership lists — the manifest-declared access only
 *  (a persona's own grants, under `include`, are merged on top in preflight). 1:1 with AgentDef. */
export interface AgentPolicy {
  subscribe: string[];
  allowSubscribe: string[];
  allowPublish: string[];
}

/** A resolved agent: its identity/behavior source (a persona file or fully inline) plus the
 *  manifest-declared policy. Behavior fields here are the manifest's overrides; the persona
 *  default is filled in during preflight (which reads the file). */
export interface ResolvedAgent {
  /** The `agents:` key — also the requested spawn name in v1. */
  name: string;
  /** Connector type to spawn with (agent-entry `agent:` ?? top-level `agent:`). */
  agentType: string;
  /** Resolved persona path (absolute), or undefined for an inline agent. */
  persona?: string;
  /** Manifest override of the persona's model (or the inline model). */
  model?: string;
  role?: string;
  /** Manifest card blurb (override / inline). */
  description?: string;
  /** Manifest persona body (REPLACES the file body when set; the sole body for inline). */
  instructions?: string;
  /** Manifest capabilities — win over the persona's when present. */
  capabilities?: string[];
  /** Effective policy for THIS agent: per-agent override ?? top-level ?? "reject". */
  personaPermissions: PersonaPermissions;
  /** ACLs inverted from the channels this agent appears in (pre persona-merge). */
  policy: AgentPolicy;
}

/** The fully resolved, validated manifest — channel-centric on disk, per-agent here. */
export interface ResolvedManifest {
  space: string;
  broker?: { servers?: string; host?: string; auth?: boolean };
  runtime?: "pty" | "tmux" | "cmux";
  personaPermissions: PersonaPermissions;
  defaults?: ChannelDefaults;
  agents: ResolvedAgent[];
  channels: ResolvedChannel[];
  /** Absolute path the manifest was loaded from — anchors relative persona refs + error output. */
  sourcePath: string;
}
