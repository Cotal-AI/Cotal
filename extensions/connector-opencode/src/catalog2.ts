import { execFile } from "node:child_process";
import type { ModelCatalog, ModelInfo } from "@cotal-ai/core";

/** The 2.x catalog read. `--standalone` makes the CLI start a private `opencode serve` for this one
 *  request and stop it on exit, so a catalog read never starts OpenCode's background service. */
const OPENCODE2_CATALOG_ARGS = ["api", "--standalone", "GET", "/api/model"];
const OPENCODE2_CATALOG_TIMEOUT_MS = 6_000;

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

export function listOpenCode2Models(bin: string, env: NodeJS.ProcessEnv): Promise<ModelCatalog> {
  const source = `opencode ${OPENCODE2_CATALOG_ARGS.join(" ")}`;
  const unavailable = (why: string): ModelCatalog => ({
    models: [],
    unavailable: `OpenCode 2.x did not list its models (${source}: ${why}); pass --model provider/model`,
  });
  return new Promise((settle) => {
    const child = execFile(
      bin,
      OPENCODE2_CATALOG_ARGS,
      { encoding: "utf8", env, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        clearTimeout(timer);
        if (err) return settle(unavailable((stderr.trim() || err.message).replace(/\s+/g, " ")));
        try {
          settle({ source, models: parseModels2(stdout) });
        } catch (e) {
          settle(unavailable((e as Error).message));
        }
      },
    );
    child.stdin?.end();
    // execFile calls back only once every pipe closes, which a killed CLI's children can delay.
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      settle(unavailable(`no answer within ${OPENCODE2_CATALOG_TIMEOUT_MS / 1000} seconds`));
    }, OPENCODE2_CATALOG_TIMEOUT_MS);
  });
}
