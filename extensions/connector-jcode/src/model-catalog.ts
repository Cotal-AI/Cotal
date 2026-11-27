import { execFile } from "node:child_process";
import type { ModelCatalog, ModelCatalogOpts, ModelInfo } from "@cotal-ai/core";
import { launchEnv } from "@cotal-ai/connector-core";
import { bareModelId } from "./route-identity.js";
import { JcodeConnectorError } from "./startup-diagnostics.js";

const MODEL_LIST_ARGS = ["model", "list", "--json", "--no-update"];
const MODEL_LIST_TIMEOUT_MS = 30_000;

/** What `jcode model list --json` prints: the ids `-m` takes, and each provider route that can carry one. */
interface JcodeModelList {
  provider: string;
  models: string[];
  routes: { model: string; provider: string; available: boolean }[];
}

function isJcodeModelList(value: unknown): value is JcodeModelList {
  const list = value as Partial<JcodeModelList> | null;
  return typeof list?.provider === "string" &&
    Array.isArray(list.models) && list.models.every((id) => typeof id === "string" && id.length > 0) &&
    Array.isArray(list.routes) && list.routes.every((route) =>
      typeof route?.model === "string" && typeof route.provider === "string" && typeof route.available === "boolean");
}

/** A model is listed when jcode reports an available route for it, and is attributed to the provider
 *  of those routes: the one jcode selected when it has one, else the only one. jcode reports no
 *  per-model reasoning efforts, so no model carries variants. */
function catalogModels(stdout: string): ModelInfo[] {
  let list: unknown;
  try {
    list = JSON.parse(stdout);
  } catch {
    throw new Error("jcode model list --json did not print JSON");
  }
  if (!isJcodeModelList(list)) throw new Error("jcode model list --json printed an unexpected shape");
  const { provider: selected, models, routes } = list;
  return models.flatMap((id) => {
    const providers = new Set(routes.filter((route) => route.model === id && route.available).map((route) => route.provider));
    if (!providers.size) return [];
    const provider = providers.has(selected) ? selected : providers.size === 1 ? [...providers][0] : undefined;
    return [{ id, ...(provider ? { provider } : {}) }];
  });
}

/** Ask the jcode a seat would run which models it can use, in the environment a seat's host gets. */
export function listJcodeModels(opts: ModelCatalogOpts = {}): Promise<ModelCatalog> {
  return readJcodeModels(opts.resolvedBinaries?.jcode ?? "jcode", launchEnv({ envAllow: opts.envAllow }));
}

function readJcodeModels(bin: string, env: NodeJS.ProcessEnv): Promise<ModelCatalog> {
  return new Promise((fulfill, reject) => {
    const child = execFile(
      bin,
      MODEL_LIST_ARGS,
      { encoding: "utf8", env, timeout: MODEL_LIST_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          // jcode prints its error last, after any prompt it left unanswered on the same line.
          const last = stderr.trim().split("\n").at(-1) ?? "";
          const timedOut = error.killed && error.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
          const reason = timedOut
            ? `no answer within ${MODEL_LIST_TIMEOUT_MS / 1000} seconds`
            : last.slice(Math.max(0, last.indexOf("Error: "))).trim() || error.message;
          return reject(new Error(`jcode model list failed: ${reason}`));
        }
        try {
          fulfill({ source: "jcode model list --json", models: catalogModels(stdout) });
        } catch (parseError) {
          reject(parseError);
        }
      },
    );
    // Without a login, jcode asks for one on stdin. Ending stdin answers it with a skip, so jcode
    // exits and names `jcode login` instead of waiting out the timeout.
    child.stdin?.end();
  });
}

/** An exact catalog ID takes precedence. Only a listed suffix is evidence for a prefix remedy. */
export async function checkJcodeLaunchModel(bin: string, model: string, env: NodeJS.ProcessEnv): Promise<void> {
  const spec = bareModelId(model);
  if (spec.ok) return;
  // Jcode's session selector still decides whether it can run the exact ID when listing fails.
  const catalog = await readJcodeModels(bin, env).catch(() => undefined);
  if (!catalog || catalog.models.some(({ id }) => id === model)) return;
  if (catalog.models.some(({ id }) => id === spec.bare)) {
    const override = /^[A-Za-z0-9][A-Za-z0-9._/:-]{0,255}$/.test(spec.bare) ? ` Retry with \`--model ${spec.bare}\`.` : "";
    throw new JcodeConnectorError("model_prefix_rejected", `Select the provider in Jcode's configuration and use the model ID from the catalog.${override}`);
  }
}
