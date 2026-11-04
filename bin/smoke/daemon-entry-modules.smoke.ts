/**
 * A daemon entry loads its own command's modules, not the whole CLI.
 *
 * `bin/run.ts` declares each daemon entry to the registry as a provider: the surfaces its command
 * and its run need. The built binary runs every entry with a module hook that logs each module the
 * process loads, and an option the entry does not take, so the run ends at the command's own usage
 * refusal before any effect. That refusal names the entry, which proves the command was resolved.
 * The log must then hold the entry's own surface and no module of the CLI's command surface, the
 * other daemons' surfaces or the docs. `version` is the positive control: it loads the whole CLI,
 * so the hook sees the modules the entries do not load, and every entry loads fewer.
 *
 * The root reads the command word as the dispatcher does. A service the controller starts with
 * colour off has `--no-color` before its entry word and still loads only its own surfaces, and a
 * daemon word after any other flag is not the command word, so that run loads the whole CLI.
 *
 * Requires the binary built (`pnpm --filter cotal-ai... build`); `pnpm smoke:daemon-entry-modules`
 * builds first.
 *
 * Run: pnpm smoke:daemon-entry-modules
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createSuite } from "@cotal-ai/smoke-kit";

const BIN = join(import.meta.dirname, "..", "dist", "cotal.js");
if (!existsSync(BIN)) {
  console.error(`✗ ${BIN} missing - build first: pnpm --filter cotal-ai... build`);
  process.exit(1);
}
const { check, finish } = createSuite();
const dir = mkdtempSync(join(tmpdir(), "cotal-daemon-entry-modules-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
writeFileSync(join(dir, "hooks.mjs"), `import { appendFileSync } from "node:fs";\nexport async function load(url, context, next) { appendFileSync(process.env.ENTRY_MODULE_LOG, url + "\\n"); return next(url, context); }\n`);
writeFileSync(join(dir, "register.mjs"), `import { register } from "node:module";\nregister(${JSON.stringify(pathToFileURL(join(dir, "hooks.mjs")).href)});\n`);
// A seat's COTAL_* would point the run at a live mesh, so none reaches the child.
const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("COTAL_")));

let runs = 0;
/** The modules `cotal <words> --not-an-option` loads, and how it ended. */
function loads(...words: string[]): { status: number | null; stderr: string; loaded: string[] } {
  const run = join(dir, String(runs++));
  for (const sub of ["root", "home", "config"]) mkdirSync(join(run, sub), { recursive: true });
  const log = join(run, "loaded.txt");
  const r = spawnSync(process.execPath, ["--import", pathToFileURL(join(dir, "register.mjs")).href, BIN, ...words, "--not-an-option"], {
    cwd: join(run, "root"), encoding: "utf8", timeout: 120_000,
    env: { ...env, COTAL_HOME: join(run, "home"), XDG_CONFIG_HOME: join(run, "config"), COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1", ENTRY_MODULE_LOG: log },
  });
  return { status: r.status, stderr: r.stderr ?? "", loaded: existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [] };
}
const has = (loaded: readonly string[], tail: string) => loaded.some((url) => url.endsWith(tail));

// Modules only the whole CLI loads: the base command surface and its commands, the other daemon
// surfaces, the workflow-run operator surface's commands and the docs command.
const CLI_SURFACE = ["/cli/dist/index.js", "/cli/dist/commands/up.js", "/cli/dist/commands/spawn.js", "/cli/dist/lib/service-presets.js", "/bin/dist/docs.js", "/bin/dist/daemon/command.js"];
const SURFACES = { manager: "/manager/dist/index.js", delivery: "/delivery/dist/index.js", auth: "/auth/dist/index.js", runtime: "/runtime/dist/index.js", unit: "/cli/dist/service-unit.js" };
type Surface = keyof typeof SURFACES;
// Each entry, and the surfaces it loads: its own, the auth provider's, and for the manager the
// workflow run host's.
const ENTRIES: [string, Surface[]][] = [
  ["supervise", ["manager", "auth", "runtime"]], ["__daemon-manager", ["manager", "auth", "runtime"]], ["__service-manager", ["manager", "auth", "runtime"]],
  ["deliver", ["delivery", "auth"]], ["__daemon-deliver", ["delivery", "auth"]], ["__service-delivery", ["delivery", "auth"]],
  ["feedback-intake", ["delivery", "auth"]], ["__service-feedback-intake", ["delivery", "auth"]],
  ["auth-service", ["auth"]], ["__daemon-auth-service", ["auth"]], ["__service-auth", ["auth"]],
  ["__service-unit", ["unit"]],
];

const whole = loads("version");
check("control: the whole CLI's modules are in the log of a command it runs",
  whole.loaded.length > 0 && CLI_SURFACE.every((tail) => has(whole.loaded, tail)) && Object.values(SURFACES).filter((tail) => tail !== SURFACES.unit).every((tail) => has(whole.loaded, tail)),
  { loaded: whole.loaded.length, missing: CLI_SURFACE.filter((tail) => !has(whole.loaded, tail)) });

for (const [word, own] of ENTRIES) {
  const r = loads(word);
  check(`${word} resolves its own command: the refusal is its usage`, r.status !== 0 && r.stderr.includes("Unknown option '--not-an-option'") && r.stderr.includes(`cotal ${word}`), { status: r.status, stderr: r.stderr.slice(0, 300) });
  const absent = (Object.keys(SURFACES) as Surface[]).filter((name) => !own.includes(name)).map((name) => SURFACES[name]);
  check(`${word} loads ${own.join(", ")} and no other surface`,
    own.every((name) => has(r.loaded, SURFACES[name])) && ![...CLI_SURFACE, ...absent].some((tail) => has(r.loaded, tail)),
    { loaded: r.loaded.length, missing: own.filter((name) => !has(r.loaded, SURFACES[name])), extra: [...CLI_SURFACE, ...absent].filter((tail) => has(r.loaded, tail)) });
  check(`${word} loads fewer modules than the whole CLI (${r.loaded.length} of ${whole.loaded.length})`, r.loaded.length > 0 && r.loaded.length < whole.loaded.length, { loaded: r.loaded.length, whole: whole.loaded.length });
}

const noColor = loads("--no-color", "__service-manager");
check("--no-color before __service-manager: the refusal is its usage, and it loads manager, auth, runtime and no other surface",
  noColor.stderr.includes("Unknown option '--not-an-option'") && noColor.stderr.includes("cotal __service-manager") && ["manager", "auth", "runtime"].every((name) => has(noColor.loaded, SURFACES[name as Surface])) && ![...CLI_SURFACE, SURFACES.delivery, SURFACES.unit].some((tail) => has(noColor.loaded, tail)),
  { status: noColor.status, stderr: noColor.stderr.slice(0, 300), loaded: noColor.loaded.length });
const afterValueFlag = loads("--space", "__daemon-deliver");
check("a daemon word after --space is not the command word: that run loads the whole CLI",
  afterValueFlag.status !== 0 && CLI_SURFACE.every((tail) => has(afterValueFlag.loaded, tail)),
  { status: afterValueFlag.status, stderr: afterValueFlag.stderr.slice(0, 300), missing: CLI_SURFACE.filter((tail) => !has(afterValueFlag.loaded, tail)) });

finish();
