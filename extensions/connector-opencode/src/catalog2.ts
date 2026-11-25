import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { ModelCatalog, ModelInfo } from "@cotal-ai/core";

/**
 * The 2.x catalog read runs a private `opencode serve --stdio`, OpenCode's parent-managed server:
 * it prints its URL as JSON, takes its password from `OPENCODE_SERVER_PASSWORD` and exits when its
 * stdin closes, so a catalog read never starts OpenCode's background service. Its own process
 * group lets a stop take down whatever it started.
 */
const SERVE_ARGS = ["serve", "--stdio", "--hostname", "127.0.0.1", "--port", "0"];
const CATALOG_SOURCE = "opencode serve --stdio: GET /api/model";
/** One bound on the whole read: the server's start, the plugins' settling and the model read. */
const CATALOG_TIMEOUT_MS = 10_000;
/** OpenCode's own wait for its plugins (`opencode models` and its ACP catalog, 2.4.1) polls this often. */
const PLUGIN_POLL_MS = 25;

/** Maps the `GET /api/model` reply (`{ location, data: Model.Info[] }`, the same shape since 2.0.0)
 *  to `provider/model` ids, the form `--model` accepts. Only ids, names and variant names are read:
 *  a model's `settings` and `headers` carry provider credentials. */
function parseModels2(stdout: string): ModelInfo[] {
  let reply: unknown;
  try {
    reply = JSON.parse(stdout);
  } catch {
    // JSON.parse quotes the input in its message, and this input can hold provider keys.
    throw new Error("the reply is not JSON");
  }
  const data = (reply as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) throw new Error("the reply has no model list");
  return data.map((raw: unknown, i) => {
    const { id, providerID, name, variants } = (raw ?? {}) as Record<string, unknown>;
    if (typeof id !== "string" || !id || typeof providerID !== "string" || !providerID)
      throw new Error(`model ${i} has no id or providerID`);
    if (!Array.isArray(variants)) throw new Error(`model ${providerID}/${id} has no variant list`);
    const variantNames = variants.map((v: unknown) => {
      const variant = (v as { id?: unknown } | null)?.id;
      if (typeof variant !== "string" || !variant) throw new Error(`model ${providerID}/${id} has a variant without an id`);
      return { name: variant };
    });
    return {
      id: `${providerID}/${id}`,
      provider: providerID,
      ...(typeof name === "string" ? { name } : {}),
      ...(variantNames.length ? { variants: variantNames } : {}),
    };
  });
}

/** Every 2.x install serves this list, so a read that does not produce one fails: the manager then
 *  reports the catalog unreadable, never as an install without a catalog. */
export function listOpenCode2Models(bin: string, env: NodeJS.ProcessEnv): Promise<ModelCatalog> {
  const password = randomBytes(32).toString("base64url");
  // The password rides the environment only, never argv, where any local user could read it.
  const child = spawn(bin, SERVE_ARGS, { env: { ...env, OPENCODE_SERVER_PASSWORD: password }, detached: process.platform !== "win32" });
  const stage = { waitingFor: "the server to start" };
  const deadline = AbortSignal.timeout(CATALOG_TIMEOUT_MS);
  return readCatalog(child, password, deadline, stage).then(
    (models): ModelCatalog => ({ source: CATALOG_SOURCE, models }),
    (e: Error) => {
      const why = deadline.aborted ? `no answer within ${CATALOG_TIMEOUT_MS / 1000} seconds, waiting for ${stage.waitingFor}` : e.message;
      throw new Error(`OpenCode 2.x did not list its models (${CATALOG_SOURCE}: ${why}); pass --model provider/model`);
    },
  ).finally(() => stop(child));
}

/**
 * The model list once OpenCode's plugins settled. A location loads on its first request, and until
 * its plugin list fills, its model list is empty or partial (measured on 2.0.24 and 2.4.1; OpenCode
 * documents that the list "may precede initial plugin settlement"), so the read waits for the plugin
 * list as OpenCode's own `opencode models` does.
 */
async function readCatalog(child: ChildProcess, password: string, signal: AbortSignal, stage: { waitingFor: string }): Promise<ModelInfo[]> {
  const url = await serverUrl(child, signal);
  const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
  const get = async (path: string): Promise<string> => {
    const response = await fetch(`${url}${path}`, { headers: { authorization }, signal });
    if (!response.ok) throw new Error(`GET ${path} answered HTTP ${response.status}`);
    return response.text();
  };
  stage.waitingFor = "OpenCode's plugins to settle";
  while (!pluginsListed(await get("/api/plugin"))) await sleep(PLUGIN_POLL_MS, undefined, { signal });
  stage.waitingFor = "GET /api/model";
  const models = parseModels2(await get("/api/model"));
  if (models.length === 0) throw new Error("GET /api/model listed no models once OpenCode's plugins settled");
  return models;
}

function pluginsListed(body: string): boolean {
  let data: unknown;
  try {
    data = (JSON.parse(body) as { data?: unknown } | null)?.data;
  } catch {}
  if (!Array.isArray(data)) throw new Error("GET /api/plugin answered no plugin list");
  return data.length > 0;
}

/** The URL the server prints as its first stdout line, or its stderr when it exits first. */
function serverUrl(child: ChildProcess, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = "";
    let err = "";
    child.stderr?.on("data", (d: Buffer) => (err += d));
    child.stdout?.on("data", (d: Buffer) => {
      out += d;
      const end = out.indexOf("\n");
      if (end < 0) return;
      let url: unknown;
      try {
        url = (JSON.parse(out.slice(0, end)) as { url?: unknown } | null)?.url;
      } catch {}
      if (typeof url === "string") resolve(url);
      else reject(new Error("opencode serve --stdio printed no server URL"));
    });
    child.on("error", reject);
    child.on("close", (code, sig) => reject(new Error(err.trim().replace(/\s+/g, " ") || `opencode serve exited (${sig ?? code}) before it listened`)));
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

/** Closes the server's stdin, its stop signal, and kills its process group, which takes down
 *  anything it started too. Windows has no process group to kill, so there the server alone is. */
function stop(child: ChildProcess): void {
  // Writing to a server that already exited fails with EPIPE, and the close is all this pipe is for.
  child.stdin?.on("error", () => {});
  child.stdin?.end();
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    child.kill("SIGKILL");
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
  }
}
