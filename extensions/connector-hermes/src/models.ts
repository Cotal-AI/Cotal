/**
 * The models a Hermes seat can run, for the Manager's selector (`listModels`).
 *
 * Hermes picks its provider from the launch's environment, often through a `spawn.env` name such as
 * `HERMES_INFERENCE_PROVIDER` or `CUSTOM_BASE_URL`. So the read builds the environment a launch
 * builds and runs plugin/cotal/models.py under the project-pinned Hermes, which asks Hermes which
 * provider that is and lists its models. One bounded run per read, with no cache. A managed seat's
 * profile reads nothing from `~/.hermes`, so the read runs on an empty profile of its own, and on
 * the operator's profile when `COTAL_HERMES_ADOPT_HOME` names one. Each model's variants are the
 * reasoning efforts that Hermes takes, which a managed profile sets as `agent.reasoning_effort`.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchEnv, MODEL_PROVIDER_KEYS } from "@cotal-ai/connector-core";
import type { ModelCatalog, ModelCatalogOpts } from "@cotal-ai/core";
import { hermesUvCommand } from "./binary.js";

/** The provider keys a Hermes launch forwards, and so the catalog read too. */
export const HERMES_PROVIDER_KEYS: readonly string[] = [
  ...MODEL_PROVIDER_KEYS,
  "OPENCODE_GO_API_KEY", "OPENCODE_ZEN_API_KEY", "XAI_API_KEY", "GEMINI_API_KEY",
  "NOVITA_API_KEY", "DEEPSEEK_API_KEY", "GLM_API_KEY", "ZAI_API_KEY", "Z_AI_API_KEY",
  "KIMI_API_KEY", "KIMI_CODING_API_KEY", "KIMI_CN_API_KEY", "MINIMAX_API_KEY",
  "MINIMAX_CN_API_KEY", "DASHSCOPE_API_KEY", "ALIBABA_CODING_PLAN_API_KEY",
  "STEPFUN_API_KEY", "ARCEEAI_API_KEY", "GMI_API_KEY", "NVIDIA_API_KEY", "KILOCODE_API_KEY",
  "XIAOMI_API_KEY", "TOKENHUB_API_KEY", "OLLAMA_API_KEY", "AZURE_FOUNDRY_API_KEY",
];

const PKG_DIR = fileURLToPath(new URL("..", import.meta.url));
const MODELS_SCRIPT = join(PKG_DIR, "plugin", "cotal", "models.py");
// `-P` keeps the plugin directory off sys.path: its tools.py would shadow Hermes' own `tools`.
const SCRIPT_ARGS = ["run", "--project", PKG_DIR, "--quiet", "python", "-P", MODELS_SCRIPT];
/** How long one read may take, as Codex's app-server read is bounded. */
const READ_MS = 10_000;

/** Run the catalog script and resolve with its last line of output. The whole process group is
 *  killed at the bound, so uv's Python child does not outlive the read. */
function runScript(uv: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(uv, SCRIPT_ARGS, { env, stdio: ["ignore", "pipe", "pipe"], detached: true, windowsHide: true });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (out += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (err += d));
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        // already gone
      }
      reject(new Error(`Hermes did not list its models within ${READ_MS / 1000}s; the first read after the connector is installed may also build its Python environment`));
    }, READ_MS);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`could not run Hermes through uv to list its models: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out.trim().split("\n").at(-1) ?? "");
      else reject(new Error(`the Hermes model read failed (exit ${code}): ${err.trim().split("\n").at(-1) ?? ""}`));
    });
  });
}

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

/** The reasoning efforts the project-pinned Hermes takes, read as the launcher reads its version:
 *  with no bound, since the first launch after an install may build the Python environment. */
export function hermesEfforts(opts: {
  env?: NodeJS.ProcessEnv;
  execFileImpl?: (file: string, args: readonly string[], options: { encoding: "utf8"; env: NodeJS.ProcessEnv }) => string;
} = {}): string[] {
  const env = opts.env ?? process.env;
  const exec = opts.execFileImpl ?? ((file, args, options) => execFileSync(file, args, { ...options, windowsHide: true }));
  let line: string;
  try {
    line = exec(hermesUvCommand(env), [...SCRIPT_ARGS, "efforts"], { encoding: "utf8", env }).trim().split("\n").at(-1) ?? "";
  } catch (e) {
    throw new Error(`could not read the reasoning efforts Hermes takes through uv: ${(e as Error).message}`);
  }
  let efforts: unknown;
  try {
    efforts = JSON.parse(line);
  } catch {
    efforts = undefined;
  }
  if (!isStrings(efforts) || !efforts.length) throw new Error(`Hermes printed no list of reasoning efforts: ${JSON.stringify(line.slice(0, 200))}`);
  return efforts;
}

export async function listHermesModels(opts: ModelCatalogOpts = {}): Promise<ModelCatalog> {
  const adopted = process.env.COTAL_HERMES_ADOPT_HOME?.trim();
  const home = adopted || mkdtempSync(join(tmpdir(), "cotal-hermes-models-"));
  try {
    const env = { ...launchEnv({ providerKeys: HERMES_PROVIDER_KEYS, envAllow: opts.envAllow }), HERMES_HOME: home };
    const line = await runScript(opts.resolvedBinaries?.uv ?? "uv", env);
    let read: { provider?: string; models?: unknown; efforts?: unknown; unavailable?: string };
    try {
      read = JSON.parse(line) as typeof read;
    } catch {
      throw new Error(`the Hermes model read printed no catalog: ${JSON.stringify(line.slice(0, 200))}`);
    }
    if (typeof read.unavailable === "string") return { models: [], unavailable: read.unavailable };
    if (!isStrings(read.models)) throw new Error("the Hermes model read printed a catalog without a list of model ids");
    if (!isStrings(read.efforts) || !read.efforts.length) throw new Error("the Hermes model read printed a catalog without the reasoning efforts Hermes takes");
    // An adopted profile keeps the effort its own config.yaml sets, so a launch there takes no variant.
    const variants = adopted ? undefined : read.efforts.map((name) => ({ name }));
    return {
      source: `the ${read.provider} provider Hermes resolves from the launch environment`,
      models: read.models.map((id) => ({ id, ...(variants ? { variants } : {}) })),
    };
  } finally {
    if (!adopted) rmSync(home, { recursive: true, force: true });
  }
}
