/**
 * The Hermes model catalog (src/models.ts, plugin/cotal/models.py): the Manager's model selector
 * reads the models of the provider Hermes resolves from the environment a launch receives, with
 * the `spawn.env` names the Manager passes in.
 *
 * uv is a stand-in that runs the real catalog script under python with a stand-in `hermes_cli`,
 * since Hermes is not installed in CI. The stand-in resolves a provider from the environment as
 * Hermes does and records what the read received. The connector, the script and the environment
 * it builds are the connector's own.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { createSuite, skipSuite } from "@cotal-ai/smoke-kit";
import { hermesConnector } from "../src/extension.js";
import { listHermesModels } from "../src/models.js";

if (process.platform === "win32") skipSuite("the Hermes connector is Unix-only");

const { check, finish } = createSuite();

const python = ["python3", "python"].find((bin) => spawnSync(bin, ["-c", ""], { stdio: "ignore" }).status === 0);
if (!python) throw new Error("python is not on PATH, so the catalog script cannot run");
const pkgDir = fileURLToPath(new URL("..", import.meta.url));
const script = join(pkgDir, "plugin", "cotal", "models.py");

const root = mkdtempSync(join(tmpdir(), "cotal-hermes-models-smoke-"));
const record = join(root, "record.json");
const fetched = join(root, "fetched.json");
const uvArgs = join(root, "uv-args");
const pidFile = join(root, "pid");
mkdirSync(join(root, "py", "hermes_cli"), { recursive: true });
writeFileSync(join(root, "py", "hermes_cli", "__init__.py"), "");
writeFileSync(join(root, "py", "hermes_cli", "runtime_provider.py"), `
import json, os, sys

def resolve_runtime_provider(**kw):
    home = os.environ.get("HERMES_HOME", "")
    with open(${JSON.stringify(record)}, "w") as fh:
        json.dump({"env": sorted(os.environ), "home": home, "homeExists": os.path.isdir(home), "safePath": sys.flags.safe_path}, fh)
    provider = os.environ.get("HERMES_INFERENCE_PROVIDER")
    if provider == "custom":
        return {"provider": "custom", "base_url": os.environ.get("CUSTOM_BASE_URL"), "api_key": "", "api_mode": "chat_completions"}
    if provider:
        return {"provider": provider}
    if os.environ.get("OPENROUTER_API_KEY"):
        return {"provider": "openrouter"}
    raise RuntimeError("No inference provider configured.")
`);
writeFileSync(join(root, "py", "hermes_cli", "models.py"), `
import json, os, time

def fetch_api_models(api_key, base_url, timeout=5.0, api_mode=None):
    with open(${JSON.stringify(fetched)}, "w") as fh:
        json.dump({"baseUrl": base_url, "apiMode": api_mode}, fh)
    if "dead" in base_url:
        return None
    if "hang" in base_url:
        with open(${JSON.stringify(pidFile)}, "w") as fh:
            fh.write(str(os.getpid()))
        time.sleep(60)
    return ["local-a", "local-b"]

def provider_model_ids(provider):
    if provider == "explode":
        raise RuntimeError("catalog broke")
    if provider == "silent":
        os._exit(0)
    return [provider + "/one", "", provider + "/two"]
`);
// Not exec: python runs as uv's child, as under the real uv, so a kill must reach the whole group.
const uv = join(root, "uv");
writeFileSync(uv, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(uvArgs)}\nshift 5\nPYTHONPATH=${JSON.stringify(join(root, "py"))} ${python} "$@"\n`, { mode: 0o755 });

const SPAWN_ENV = ["HERMES_INFERENCE_PROVIDER", "CUSTOM_BASE_URL"];
// The run's own provider choice would decide the cells that expect none.
for (const k of [...SPAWN_ENV, "OPENROUTER_API_KEY", "COTAL_HERMES_ADOPT_HOME"]) delete process.env[k];
type Recorded = { env: string[]; home: string; homeExists: boolean; safePath: boolean };
const recorded = (): Recorded => JSON.parse(readFileSync(record, "utf8")) as Recorded;
const read = (env: Record<string, string>, opts: { envAllow?: string[]; uv?: string } = {}) => {
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  return listHermesModels({ resolvedBinaries: { uv: opts.uv ?? uv }, ...(opts.envAllow ? { envAllow: opts.envAllow } : {}) })
    .finally(() => { for (const k of Object.keys(env)) delete process.env[k]; });
};
const refusal = (p: Promise<unknown>): Promise<string> => p.then(() => "", (e: Error) => e.message);

check("the connector declares a model catalog", hermesConnector.listModels === listHermesModels);

const custom = { HERMES_INFERENCE_PROVIDER: "custom", CUSTOM_BASE_URL: "http://127.0.0.1:1/v1", UNRELATED_SECRET_TOKEN: "s3cret" };
const listed = await read(custom, { envAllow: SPAWN_ENV });
check("the read runs the catalog script under the project's Hermes through uv",
  isDeepStrictEqual(readFileSync(uvArgs, "utf8").trim().split("\n"), ["run", "--project", pkgDir, "--quiet", "python", "-P", script]));
check("and keeps the plugin directory off sys.path", recorded().safePath === true);
check("a custom endpoint that spawn.env names lists that endpoint's models",
  isDeepStrictEqual(listed.models, [{ id: "local-a" }, { id: "local-b" }]) && listed.unavailable === undefined, listed);
check("the catalog names the provider Hermes resolved", /\bcustom provider\b/.test(listed.source ?? ""), listed.source);
check("Hermes reads the base URL spawn.env passes", JSON.parse(readFileSync(fetched, "utf8")).baseUrl === custom.CUSTOM_BASE_URL);
const first = recorded();
check("an operator secret no launch receives does not reach the read", !first.env.includes("UNRELATED_SECRET_TOKEN"), first.env);
check("the read runs on an empty profile of its own, removed afterwards",
  first.homeExists && first.home.startsWith(tmpdir()) && !existsSync(first.home), first);

const unnamed = await read(custom);
check("without spawn.env, the launch's names do not reach the read, so Hermes resolves no provider",
  unnamed.models.length === 0 && /no model provider/.test(unnamed.unavailable ?? "") && /No inference provider configured/.test(unnamed.unavailable ?? ""), unnamed);

const keyed = await read({ OPENROUTER_API_KEY: "sk-or-test" });
check("a provider key a launch forwards reaches the read", recorded().env.includes("OPENROUTER_API_KEY"));
check("a named provider lists Hermes's catalog for it, without blank ids",
  isDeepStrictEqual(keyed.models, [{ id: "openrouter/one" }, { id: "openrouter/two" }]) && /openrouter provider/.test(keyed.source ?? ""), keyed);

const adopted = join(root, "adopted-home");
mkdirSync(adopted);
await read({ COTAL_HERMES_ADOPT_HOME: adopted, HERMES_INFERENCE_PROVIDER: "openrouter" }, { envAllow: SPAWN_ENV });
check("with COTAL_HERMES_ADOPT_HOME the read uses the operator's profile and leaves it", recorded().home === adopted && existsSync(adopted));

const dead = await read({ HERMES_INFERENCE_PROVIDER: "custom", CUSTOM_BASE_URL: "http://127.0.0.1:1/dead" }, { envAllow: SPAWN_ENV });
check("an endpoint whose model list Hermes cannot read is reported unavailable",
  dead.models.length === 0 && /could not read the model list/.test(dead.unavailable ?? ""), dead);

const broke = await refusal(read({ HERMES_INFERENCE_PROVIDER: "explode" }, { envAllow: SPAWN_ENV }));
check("a read that fails throws with the script's last error line", /exit 1/.test(broke) && /catalog broke/.test(broke), broke);
const silent = await refusal(read({ HERMES_INFERENCE_PROVIDER: "silent" }, { envAllow: SPAWN_ENV }));
check("a read that prints no catalog throws", /printed no catalog/.test(silent), silent);
const missing = await refusal(read({}, { uv: join(root, "no-uv") }));
check("a uv that cannot run throws", /could not run Hermes through uv/.test(missing), missing);

const started = Date.now();
const hung = await refusal(read({ HERMES_INFERENCE_PROVIDER: "custom", CUSTOM_BASE_URL: "http://127.0.0.1:1/hang" }, { envAllow: SPAWN_ENV }));
check("a read that hangs throws at its bound", /within 10s/.test(hung) && Date.now() - started < 15_000, hung);
const hungPid = Number(readFileSync(pidFile, "utf8"));
await new Promise((r) => setTimeout(r, 200));
let alive = true;
try {
  process.kill(hungPid, 0);
} catch {
  alive = false;
}
check("and uv's python child does not outlive it", hungPid > 0 && !alive, hungPid);

rmSync(root, { recursive: true, force: true });
finish();
