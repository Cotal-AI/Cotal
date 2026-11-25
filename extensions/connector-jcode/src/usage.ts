/**
 * What a Jcode seat answers to `usage` on its `agent` endpoint (SPEC 13.22): the context Jcode's last
 * provider call used, against the context budget Jcode reported with it. Jcode reports no cost.
 */
import type { AgentUsage } from "@cotal-ai/connector-core";

/** The fields of Jcode's `token_usage` event this reads, for its session's last provider call.
 *  `cache_creation_input` and `effective_budget` come from Jcode 1.x and the SDK types neither. */
export interface JcodeTokenUsage {
  readonly input: number;
  readonly cache_read_input?: number;
  readonly cache_creation_input?: number;
  readonly effective_budget?: number;
}

const count = (value: unknown): number | undefined => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined);

/** The usage fields of a `token_usage` event, or undefined when it carries none Jcode documents. */
export function readTokenUsage(event: Record<string, unknown>): JcodeTokenUsage | undefined {
  const input = count(event.input);
  if (input === undefined) return undefined;
  const cacheRead = count(event.cache_read_input), cacheCreation = count(event.cache_creation_input), budget = count(event.effective_budget);
  return {
    input,
    ...(cacheRead !== undefined ? { cache_read_input: cacheRead } : {}),
    ...(cacheCreation !== undefined ? { cache_creation_input: cacheCreation } : {}),
    ...(budget ? { effective_budget: budget } : {}),
  };
}

/** The tokens in context after one call, read as Jcode reads them for its own context meter
 *  (jcode-compaction-core `effective_context_tokens_from_usage`). OpenAI counts cache reads and
 *  writes inside `input`; Anthropic reports them apart, so they are added back. */
function contextTokens(provider: string, usage: JcodeTokenUsage): number {
  const read = usage.cache_read_input ?? 0, creation = usage.cache_creation_input ?? 0;
  const name = provider.toLowerCase();
  if (name.includes("openai") || name.includes("codex")) return usage.input;
  const split = name.includes("anthropic") || name.includes("claude") || creation > 0 || read > usage.input;
  return split ? usage.input + read + creation : usage.input;
}

/** The context in use against Jcode's budget. Before Jcode has reported a budget, as a Jcode that
 *  predates `effective_budget` never does, the context is left out. */
export function jcodeUsage(provider: string | undefined, usage: JcodeTokenUsage | undefined): AgentUsage {
  if (!usage?.effective_budget) return {};
  return { context: { used: contextTokens(provider ?? "", usage), size: usage.effective_budget } };
}
