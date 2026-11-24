/**
 * The commands and skills an OpenCode seat started in a directory would run, read before any seat
 * exists. OpenCode lists them only at a running server, so this reads them from a private
 * `opencode serve` in the directory (private-serve.ts). It loads the operator's OpenCode configuration
 * as a seat's server does, without the Cotal plugin, and creates no session. A 2.x server loads a
 * directory's lists on the first request for them and emits each list's `loaded` event once it has
 * (command-routes.ts), so both lists are read once loaded. A 1.x server is read in
 * command-catalog1.ts.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CommandCatalog, CommandListOpts } from "@cotal-ai/core";
import { openCode1CommandCatalog } from "./command-catalog1.js";
import { COMMAND_ROUTES, LISTS_LOAD_MS, readCommandLists } from "./command-routes.js";
import { opencodeLine } from "./opencode-line.js";
import { readPrivateServe, type ServeRead } from "./private-serve.js";

/** Opens the server's event stream. `loaded` resolves once it carried every list's `loaded` event. */
async function listsLoaded(url: string, auth: string, signal: AbortSignal): Promise<{ loaded: Promise<void> }> {
  const res = await fetch(`${url}/api/event`, { headers: { authorization: auth }, signal });
  if (!res.ok || !res.body) throw new Error(`opencode serve answered /api/event with HTTP ${res.status}`);
  const waiting = new Set(Object.values(COMMAND_ROUTES).map((r) => r.loaded));
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  const loaded = (async () => {
    let buf = "";
    while (waiting.size > 0) {
      const { value, done } = await reader.read();
      if (done) throw new Error("opencode serve closed its event stream before it loaded the lists");
      buf += value;
      for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        try {
          waiting.delete((JSON.parse(line.slice(5)) as { type?: string }).type ?? "");
        } catch { /* a line that is not an event names no list */ }
      }
    }
  })();
  loaded.catch(() => {});
  return { loaded };
}

async function readLoadedLists({ url, auth, signal }: ServeRead): Promise<CommandCatalog> {
  const get = async (path: string): Promise<unknown> => {
    const res = await fetch(`${url}${path}`, { headers: { authorization: auth }, signal });
    if (!res.ok) throw new Error(`opencode serve answered ${path} with HTTP ${res.status}`);
    return res.json();
  };
  const { loaded } = await listsLoaded(url, auth, signal);
  await readCommandLists(get); // the first request for a list starts its load
  let late: NodeJS.Timeout | undefined;
  await Promise.race([loaded, new Promise((resolve) => { late = setTimeout(resolve, LISTS_LOAD_MS); })]).finally(() => clearTimeout(late));
  return { supported: true, commands: await readCommandLists(get) };
}

/** `env` is the environment a seat's OpenCode gets, so the list comes from the same configuration. */
export async function openCodeCommandCatalog(opts: CommandListOpts, env: Record<string, string>): Promise<CommandCatalog> {
  const bin = process.env.COTAL_OPENCODE_BIN?.trim() || opts.resolvedBinaries?.opencode || "opencode";
  const { stdout } = await promisify(execFile)(bin, ["--version"], { env, timeout: 5_000 });
  const version = stdout.trim();
  if (opencodeLine(version, bin) === 1) return openCode1CommandCatalog({ bin, cwd: opts.cwd, env });
  return readPrivateServe({ bin, cwd: opts.cwd, env, port: "0" }, readLoadedLists);
}
