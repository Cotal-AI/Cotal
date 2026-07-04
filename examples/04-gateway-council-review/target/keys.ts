/**
 * Per-user BYO provider keys for agentgw.
 *
 * Users can bring their own OpenAI/Anthropic keys instead of billing through
 * the gateway's shared keys. Stored in the user_provider_keys table (see
 * keys.sql), read here with a short cache to avoid a DB hit per request.
 */

export type ProviderKeys = { openaiKey?: string; anthropicKey?: string };

// Stand-in for the user_provider_keys table. Same columns, keys held as given.
const store = new Map<string, ProviderKeys>();

// 60s TTL cache so a chatty client does not hit the store on every /llm call.
const cache = new Map<string, { value: ProviderKeys; at: number }>();
const TTL_MS = 60_000;

export function putKeys(userId: string, keys: ProviderKeys): void {
  store.set(userId, keys);
  cache.delete(userId);
}

export function getKeys(userId: string): ProviderKeys {
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const value = store.get(userId) ?? {};
  cache.set(userId, { value, at: Date.now() });
  return value;
}

export function keyFor(userId: string, provider: "openai" | "anthropic"): string | undefined {
  const k = getKeys(userId);
  return provider === "openai" ? k.openaiKey : k.anthropicKey;
}
