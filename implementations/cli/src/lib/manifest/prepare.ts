/**
 * Prepare stage — resolve each agent's effective launch identity + ACLs by merging its persona
 * (read from disk) with the manifest. Pure: it takes already-loaded {@link AgentDef}s so it stays
 * unit-testable; the fs/live I/O lives in {@link ./preflight.js}.
 *
 * Behavior fields (model/role/description/body) are persona-default + manifest-override. Access is
 * governed by {@link PersonaPermissions}: under `reject` the manifest is the sole source; under
 * `include` a persona's own grants are inherited **only for channels the manifest does not declare**
 * (one authority per channel), concrete-only (wildcards rejected), and surfaced loudly.
 */
import { isConcreteChannel, type AgentDef } from "@cotal-ai/core";
import type { AgentPolicy, ResolvedAgent } from "./model.js";
import type { ManifestIssue } from "./errors.js";

/** Persona grants that fall outside the manifest's channels (unmanaged credential scopes) + the
 *  capabilities inherited from the persona — the data the loud dry-run section renders. */
export interface InheritedScopes {
  subscribe: string[];
  allowSubscribe: string[];
  allowPublish: string[];
  capabilities: string[];
}

/** A non-fatal diagnostic to surface in dry-run / topology view. `loud` = call it out prominently
 *  (e.g. an agent with capabilities but no channel access). */
export interface AgentWarning {
  agent: string;
  message: string;
  loud?: boolean;
}

/** The fully resolved launch form for one agent — what the spawn path needs. */
export interface PreparedAgent {
  name: string;
  agentType: string;
  /** Persona file path (or undefined for an inline agent). */
  persona?: string;
  /** Effective values (manifest override ?? persona default). */
  model?: string;
  role?: string;
  description?: string;
  /** Effective persona body (manifest `instructions` REPLACES the file body; sole body for inline). */
  body?: string;
  /** Effective merged capabilities. */
  capabilities: string[];
  capabilitySource: "manifest" | "persona" | "none";
  /** Effective merged per-channel ACLs (manifest + persona-undeclared under `include`). */
  policy: AgentPolicy;
  /** Persona grants outside manifest channels + inherited caps (empty under `reject`/inline). */
  inherited: InheritedScopes;
}

export interface PreparedResult {
  prepared: PreparedAgent;
  issues: ManifestIssue[];
  warnings: AgentWarning[];
}

/** Merge one resolved agent with its (optional) loaded persona, given the set of channel names the
 *  manifest declares. Returns the launch form plus any errors/warnings. */
export function prepareAgent(agent: ResolvedAgent, persona: AgentDef | undefined, declared: Set<string>): PreparedResult {
  const issues: ManifestIssue[] = [];
  const warnings: AgentWarning[] = [];
  const at: (string | number)[] = ["agents", agent.name];

  // Behavior: persona default, manifest override wins. Inline `instructions` REPLACE the body.
  const model = agent.model ?? persona?.model;
  const role = agent.role ?? persona?.role;
  const description = agent.description ?? persona?.description;
  const body = agent.instructions ?? persona?.persona;

  // Capabilities: manifest wins; else inherited from the persona only under `include`.
  let capabilities: string[] = [];
  let capabilitySource: PreparedAgent["capabilitySource"] = "none";
  if (agent.capabilities?.length) {
    capabilities = [...agent.capabilities];
    capabilitySource = "manifest";
  } else if (agent.personaPermissions === "include" && persona?.capabilities?.length) {
    capabilities = [...persona.capabilities];
    capabilitySource = "persona";
  }

  // Access. Start from the manifest-inverted policy (all its channels are declared by construction).
  const policy: AgentPolicy = {
    subscribe: [...agent.policy.subscribe],
    allowSubscribe: [...agent.policy.allowSubscribe],
    allowPublish: [...agent.policy.allowPublish],
  };
  const inherited: InheritedScopes = { subscribe: [], allowSubscribe: [], allowPublish: [], capabilities: [] };

  if (agent.personaPermissions === "include" && persona) {
    const personaAllowSub = persona.allowSubscribe ?? persona.subscribe ?? [];
    // Reject persona WILDCARD grants in v1 (they'd re-introduce wildcards via the persona file and
    // break the per-channel partition).
    for (const [field, list] of [["subscribe", persona.subscribe], ["allowSubscribe", personaAllowSub], ["allowPublish", persona.allowPublish]] as const)
      for (const ch of list ?? [])
        if (!isConcreteChannel(ch))
          issues.push({ message: `persona ${field} "${ch}" is a wildcard — not supported in v1 (declare concrete channels)`, path: at });

    // Persona grants apply ONLY to channels the manifest does not declare (manifest owns its own).
    const undeclared = (list: string[] | undefined) => (list ?? []).filter((c) => isConcreteChannel(c) && !declared.has(c));
    inherited.subscribe = undeclared(persona.subscribe);
    inherited.allowSubscribe = undeclared(personaAllowSub);
    inherited.allowPublish = undeclared(persona.allowPublish);
    inherited.capabilities = capabilitySource === "persona" ? capabilities : [];

    policy.subscribe = dedupe([...policy.subscribe, ...inherited.subscribe]);
    policy.allowSubscribe = dedupe([...policy.allowSubscribe, ...inherited.allowSubscribe]);
    policy.allowPublish = dedupe([...policy.allowPublish, ...inherited.allowPublish]);
  }

  // Defensive: the merged read set must stay within the merged read ACL.
  const missing = policy.subscribe.filter((c) => !policy.allowSubscribe.includes(c));
  if (missing.length)
    issues.push({ message: `merged subscribe [${missing.join(", ")}] not within allowSubscribe`, path: at });

  // Warn on an agent the manifest declares but never grants channel access — likely a typo, but
  // valid (a DM/control-only peer). Loud when it nonetheless carries capabilities.
  const noAccess = !policy.subscribe.length && !policy.allowSubscribe.length && !policy.allowPublish.length;
  if (noAccess)
    warnings.push({
      agent: agent.name,
      loud: capabilities.length > 0,
      message: capabilities.length
        ? `declared with capabilities [${capabilities.join(", ")}] but NO channel access (DM/control-only — a powerful non-channel grant)`
        : `declared but has no channel access from the manifest (DM/control-only unless a persona under \`include\` grants scopes)`,
    });

  return {
    prepared: {
      name: agent.name,
      agentType: agent.agentType,
      persona: agent.persona,
      model,
      role,
      description,
      body,
      capabilities,
      capabilitySource,
      policy,
      inherited,
    },
    issues,
    warnings,
  };
}

function dedupe<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}
