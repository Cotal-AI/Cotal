import { DEFAULT_CONNECTOR } from "./official-connectors.js";

export const DEFAULT_AGENT_ENV = "COTAL_DEFAULT_AGENT";
export const DEFAULT_PERSONA_ENV = "COTAL_DEFAULT_PERSONA";

/** The operator-level default connector/agent harness, when set. */
export function defaultAgentOverride(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[DEFAULT_AGENT_ENV]?.trim() || undefined;
}

/** Resolve the default connector/agent harness with the product fallback for this launch path. */
export function defaultAgentType(fallback: string, env: NodeJS.ProcessEnv = process.env): string {
  return defaultAgentOverride(env) ?? fallback;
}

/** The harness a spawn runs (#869), resolved here once so the foreground and detached launch paths
 *  cannot drift: an explicit `--agent`, then the persona's `agent:` pin, then a detached caller's
 *  default, then this process's `COTAL_DEFAULT_AGENT`, then {@link DEFAULT_CONNECTOR}. Both
 *  environment values are defaults, so neither beats a pin. */
export function resolveAgentType(choice: { flag?: string; pin?: string; callerDefault?: string }): string {
  return choice.flag ?? choice.pin ?? choice.callerDefault ?? defaultAgentType(DEFAULT_CONNECTOR);
}

/** The operator-level default persona ref (catalog name or path), when set. */
export function defaultPersonaOverride(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[DEFAULT_PERSONA_ENV]?.trim() || undefined;
}

/** Resolve the default persona ref with the product fallback. */
export function defaultPersonaRef(fallback = "default", env: NodeJS.ProcessEnv = process.env): string {
  return defaultPersonaOverride(env) ?? fallback;
}
