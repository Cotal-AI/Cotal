import { setTimeout as sleep } from "node:timers/promises";

/** OpenCode's own `opencode models` polls its plugin list this often before it reads the models. */
const PLUGIN_POLL_MS = 25;

/**
 * Reads an OpenCode 2.x server's model list once the server's plugins have loaded, and returns the
 * reply's `data`. Until then `GET /api/model` answers 200 with an empty or partial list (measured on
 * 2.4.1: nothing, then one provider's models, then every model at the moment `GET /api/plugin` first
 * lists anything). OpenCode's own `opencode models` waits the same way. The plugin list includes
 * OpenCode's built-in plugins, so it fills on every install. Throws when either route answers
 * anything but a 200 list, or when the wait outlasts `timeoutMs`.
 */
export async function readSettledModels(serverUrl: string, authorization: string, timeoutMs: number): Promise<unknown[]> {
  const signal = AbortSignal.timeout(timeoutMs);
  const list = async (path: string): Promise<unknown[]> => {
    const response = await fetch(`${serverUrl}${path}`, { headers: { authorization }, signal });
    if (!response.ok) throw new Error(`GET ${path} answered HTTP ${response.status}`);
    let reply: unknown;
    try {
      reply = await response.json();
    } catch {
      // The parser quotes its input in its message, and a model list carries provider keys.
      throw new Error(`GET ${path} answered something other than JSON`);
    }
    const data = (reply as { data?: unknown } | null)?.data;
    if (!Array.isArray(data)) throw new Error(`GET ${path} answered no list`);
    return data;
  };
  let loaded = false;
  try {
    while ((await list("/api/plugin")).length === 0) await sleep(PLUGIN_POLL_MS, undefined, { signal });
    loaded = true;
    return await list("/api/model");
  } catch (error) {
    if (!signal.aborted) throw error;
    const within = `within ${timeoutMs / 1000} s`;
    throw new Error(loaded ? `GET /api/model did not answer ${within}` : `OpenCode's plugins did not finish loading ${within}`);
  }
}
