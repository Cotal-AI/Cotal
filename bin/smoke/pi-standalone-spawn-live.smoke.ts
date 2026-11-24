import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { assertSmokeSandboxDown, createSuite, freePort, recordSmokeSandbox } from "@cotal-ai/smoke-kit";
import { clean, nodePty, repoRoot, wait } from "../../implementations/cli/smoke/_console-pty.js";

const { check, finish } = createSuite();
const scratch = mkdtempSync(join(tmpdir(), "cotal-pi-spawn-"));
const cwd = join(scratch, "project");
const home = join(scratch, "home");
const config = join(scratch, "config");
const cotalHome = join(scratch, "cotal");
const runtime = join(scratch, "runtime");
const globalPi = join(home, ".pi", "agent");
const userExtensions = join(globalPi, "extensions");
const projectExtensions = join(cwd, ".pi", "extensions");
const otherPackage = join(scratch, "other-package");
const cotalPackage = join(scratch, "cotal-package");
const anchor = recordSmokeSandbox({ root: cwd, cotalHome, xdgConfigHome: config });
for (const dir of [join(cwd, ".git"), runtime, userExtensions, projectExtensions, otherPackage, cotalPackage]) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

const pi = join(repoRoot, "extensions", "pi");
const piBin = process.env.COTAL_SMOKE_PI_BIN_DIR ?? join(pi, "node_modules", ".bin");
const piVersion = process.env.COTAL_SMOKE_PI_VERSION ?? "0.79.10";
const cli = join(repoRoot, "bin", "dist", "cotal.js");
const env = {
  HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: config, XDG_RUNTIME_DIR: runtime, COTAL_HOME: cotalHome,
  PATH: [piBin, process.env.PATH ?? ""].join(delimiter),
  TMPDIR: scratch, TERM: "xterm-256color", COTAL_ALLOW_CHECKOUT_SEED: "1", COTAL_SKIP_ASSIST: "1",
  COTAL_NO_UPDATE_CHECK: "1", DO_NOT_TRACK: "1",
};

function cotal(...args: string[]): string {
  const options = { cwd, env, encoding: "utf8" as const, timeout: args[0] === "who" ? 10_000 : 120_000 };
  assertSmokeSandboxDown(anchor, args, options);
  const result = spawnSync(process.execPath, [cli, ...args], options);
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${args[0]} exited ${result.status}:\n${result.stdout}${result.stderr}`);
  return clean(result.stdout);
}

const marker = join(scratch, "hooks.jsonl");
function fixture(label: string): string {
  return `import { appendFileSync } from "node:fs";
export default function (pi) {
  const nameAtLoad = process.env.COTAL_NAME;
  let nameAtTrust;
  pi.on("project_trust", () => {
    nameAtTrust = process.env.COTAL_NAME;
    return { trusted: "undecided" };
  });
  pi.on("session_start", ({ reason }, ctx) => {
    const tools = pi.getAllTools().filter((tool) => tool.name === "cotal_orientation");
    appendFileSync(${JSON.stringify(marker)}, JSON.stringify({ label: ${JSON.stringify(label)}, reason,
      nameAtLoad, nameAtTrust, model: ctx.model?.id, owners: tools.map((tool) => tool.sourceInfo.path.split(/[/\\\\]/).at(-1)),
      preloadLeaked: process.env.NODE_OPTIONS !== undefined }) + "\\n");
  });
}`;
}

function configurePackages(packages: string[]): void {
  writeFileSync(join(globalPi, "settings.json"), JSON.stringify({ defaultProjectTrust: "always", packages }));
}

configurePackages([otherPackage]);
writeFileSync(join(globalPi, "models.json"), JSON.stringify({ providers: { fixture: {
  baseUrl: "http://127.0.0.1:1", api: "openai-completions", apiKey: "${COTAL_NAME}", models: [{ id: "fixture-model" }],
} } }));
writeFileSync(join(userExtensions, "other.js"), fixture("user"));
writeFileSync(join(projectExtensions, "cotal.js"), fixture("project"));
writeFileSync(join(otherPackage, "package.json"), '{"main":"unused.js"}');
writeFileSync(join(otherPackage, "index.js"), fixture("package"));
// Jiti prefers this directory's index to the entry Node's require.resolve would pick.
const bundle = readFileSync(join(pi, "dist", "standalone.js"));
writeFileSync(join(otherPackage, "unused.js"), bundle);
const labels = ["package", "project", "user"];
const starts = () => existsSync(marker) ? readFileSync(marker, "utf8").trimEnd().split("\n") : [];
const rosterState = (who: string, name: string, state: string) => who.split("\n").some((line) =>
  line.includes(`${name}/default`) && line.split(/\s+/).includes(state));

async function spawnPi(name: string, reload: boolean) {
  const before = starts().length;
  const terminal = nodePty([cli, "spawn", "--harness", "pi", "--name", name], { cwd, env });
  let output = "";
  let exit: number | undefined;
  const exited = new Promise<number>((resolve) => terminal.onExit(({ exitCode }) => { exit = exitCode; resolve(exitCode); }));
  terminal.onData((data) => {
    output += data;
    if (data.includes("\x1b[6n")) terminal.write("\x1b[1;1R");
  });
  let idle = false;
  let reloading = false;
  let quitAt = 0;
  try {
    const deadline = Date.now() + 40_000;
    while (exit === undefined && Date.now() < deadline) {
      if (!idle) idle = rosterState(cotal("who", "--all"), name, "idle");
      const count = starts().length - before;
      if (idle && count >= labels.length) {
        if (reload && !reloading) {
          terminal.write("/reload\r");
          reloading = true;
        } else if ((!reload || count >= 2 * labels.length) && Date.now() >= quitAt) {
          terminal.write("\x04");
          quitAt = Date.now() + 2_000;
        }
      }
      await wait(300);
    }
    return { exit, output: clean(output), idle, hooks: starts().slice(before) };
  } finally {
    if (exit === undefined) {
      terminal.kill();
      await exited;
    }
  }
}

async function checkSpawn(name: string, reload = false): Promise<void> {
  const result = await spawnPi(name, reload);
  check(`${name} joins idle and exits normally without duplicate diagnostics`,
    result.idle && result.exit === 0 && !/Failed to load extension|conflicts with/.test(result.output), result);
  check(`${name} goes offline on Ctrl-D`, rosterState(cotal("who", "--all"), name, "offline"));
  const expected = (reload ? ["startup", "reload"] : ["startup"]).flatMap((reason) =>
    labels.map((label) => JSON.stringify({ label, reason, nameAtLoad: name,
      nameAtTrust: reason === "startup" && label !== "project" ? name : undefined, model: "fixture-model",
      owners: ["spawn-entry.js"], preloadLeaked: false })));
  check(`${name} keeps launch identity and unrelated Pi hooks, with one bundled Cotal tool source`,
    JSON.stringify(result.hooks.sort()) === JSON.stringify(expected.sort()), result.hooks);
}

const version = spawnSync("pi", ["--version"], { cwd, env, encoding: "utf8", timeout: 10_000 });
if (version.error) throw version.error;
assert.equal(version.status, 0, version.stderr);
assert.equal(version.stdout.trim(), piVersion);
cotal("ext", "seed");
try {
  cotal("up", "--open", "--no-manager", "--server", `nats://127.0.0.1:${await freePort()}`, "--store-dir", join(scratch, "store"));
  await checkSpawn("pi-control");
  configurePackages([otherPackage, cotalPackage]);
  const legacy = readFileSync(new URL("./fixtures/pi-standalone-legacy.js", import.meta.url));
  const releasedCopy = process.env.COTAL_SMOKE_PI_LEGACY_COPY;
  const copies = [
    { path: join(userExtensions, "cotal.js"), content: bundle },
    { path: join(projectExtensions, "copied.ts"), content: Buffer.concat([Buffer.from("\uFEFF"), bundle]) },
    { path: join(userExtensions, "vendor copy.ts"), content: bundle },
    // Pi imports the ASCII-space path for both spellings.
    { path: join(userExtensions, "vendor\u00a0copy.ts"), content: Buffer.from(fixture("unreachable-alias")) },
    { path: join(userExtensions, "legacy.js"), content: legacy },
    { path: join(cotalPackage, "index.js"), content: bundle },
    ...(releasedCopy ? [{ path: join(userExtensions, "released.js"), content: readFileSync(releasedCopy) }] : []),
  ];
  for (const { path, content } of copies) writeFileSync(path, content);
  await checkSpawn("pi-copy", true);
  check("discovered standalone copies are not modified", copies.every(({ path, content }) => readFileSync(path).equals(content)));
} finally {
  cotal("down", "--yes");
}
finish();
