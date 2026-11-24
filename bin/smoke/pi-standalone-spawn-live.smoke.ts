import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { assertSmokeSandboxDown, createSuite, freePort, recordSmokeSandbox } from "@cotal-ai/smoke-kit";
import { clean, nodePty, repoRoot, wait } from "../../implementations/cli/smoke/_console-pty.js";

const { check, finish } = createSuite();
const scratch = mkdtempSync(join(tmpdir(), "cotal-pi-"));
const cwd = join(scratch, "project");
const HOME = join(scratch, "home");
const XDG_CONFIG_HOME = join(scratch, "config");
const XDG_RUNTIME_DIR = join(scratch, "runtime");
const COTAL_HOME = join(scratch, "cotal");
const extensionDir = join(HOME, ".pi", "agent", "extensions");
const projectExtensions = join(cwd, ".pi", "extensions");
for (const dir of [join(cwd, ".cotal"), join(cwd, ".git"), HOME, XDG_CONFIG_HOME, XDG_RUNTIME_DIR, COTAL_HOME, extensionDir, projectExtensions]) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}
writeFileSync(join(extensionDir, "..", "settings.json"), '{"defaultProjectTrust":"always"}');
writeFileSync(join(extensionDir, "..", "models.json"), JSON.stringify({
  providers: { smoke: {
    baseUrl: "http://127.0.0.1:1", api: "openai-completions", apiKey: "${COTAL_NAME}",
    models: [{ id: "identity-backed-model" }],
  } },
}));
writeFileSync(join(cwd, ".cotal", "config.json"), '{"spawn":{"env":["PI_OFFLINE"]}}\n');
const pi = join(repoRoot, "extensions", "pi");
const cli = join(repoRoot, "bin", "dist", "cotal.js");
const env = {
  HOME, USERPROFILE: HOME, XDG_CONFIG_HOME, XDG_RUNTIME_DIR, COTAL_HOME,
  PATH: [join(pi, "node_modules", ".bin"), process.env.PATH ?? ""].join(delimiter),
  TMPDIR: scratch, TERM: "xterm-256color", PI_OFFLINE: "1", COTAL_ALLOW_CHECKOUT_SEED: "1",
  COTAL_SKIP_ASSIST: "1", COTAL_NO_UPDATE_CHECK: "1", COTAL_TELEMETRY: "off", DO_NOT_TRACK: "1",
};
const anchor = recordSmokeSandbox({ root: cwd, cotalHome: COTAL_HOME, xdgConfigHome: XDG_CONFIG_HOME });

function cotal(...args: string[]) {
  const options = { cwd, env, encoding: "utf8" as const, timeout: 120_000 };
  assertSmokeSandboxDown(anchor, args, options);
  const r = spawnSync(process.execPath, [cli, ...args], options);
  if (r.error) throw r.error;
  return { status: r.status, output: clean(r.stdout + r.stderr) };
}

function requireCotal(...args: string[]): string {
  const { status, output } = cotal(...args);
  assert.equal(status, 0, `${args[0]} exited ${status}:\n${output}`);
  return output;
}

const marker = join(scratch, "unrelated.log");
const projectMarker = join(scratch, "project-extension.log");
writeFileSync(join(projectExtensions, "cotal.js"), `
import { appendFileSync } from "node:fs";
export default function (pi) {
  pi.on("session_start", ({ reason }) => appendFileSync(${JSON.stringify(projectMarker)}, reason + "\\n"));
}
`);
writeFileSync(join(extensionDir, "unrelated.ts"), `
import { appendFileSync } from "node:fs";
import { basename } from "node:path";
export default function (pi) {
  const nameAtLoad = process.env.COTAL_NAME;
  const agentFileAtLoad = process.env.COTAL_AGENT_FILE;
  let nameAtTrust: string | undefined;
  pi.on("project_trust", () => {
    nameAtTrust = process.env.COTAL_NAME;
    return { trusted: "undecided" };
  });
  pi.on("session_start", ({ reason }, ctx) => {
    const owners = pi.getAllTools().filter(({ name }) => name === "cotal_orientation")
      .map(({ sourceInfo }) => basename(sourceInfo.path));
    appendFileSync(${JSON.stringify(marker)}, JSON.stringify({
      reason, nameAtLoad, nameAtTrust, sameAgentFile: Boolean(agentFileAtLoad) && agentFileAtLoad === process.env.COTAL_AGENT_FILE,
      nameAtStart: process.env.COTAL_NAME, model: ctx.model?.id, owners, preloadInEnv: Boolean(process.env.NODE_OPTIONS),
    }) + "\\n");
  });
}
`);
const sessions = () => existsSync(marker) ? readFileSync(marker, "utf8").trimEnd().split("\n") : [];
const idleLine = (who: string, name: string) => who.split("\n").find((line) => line.includes(`${name}/default`) && /\bidle\b/.test(line));

async function spawnPi(name: string, reload: boolean, path = env.PATH) {
  const start = sessions().length;
  const terminal = nodePty([cli, "spawn", "--harness", "pi", "--name", name], { cwd, env: { ...env, PATH: path } });
  let stdout = "";
  let exitCode: number | undefined;
  const exited = new Promise<number>((resolve) => terminal.onExit(({ exitCode: code }) => { exitCode = code; resolve(code); }));
  terminal.onData((data) => {
    stdout += data;
    if (data.includes("\x1b[6n")) terminal.write("\x1b[1;1R");
  });
  let idle: string | undefined;
  let reloadSent = false;
  let quitAt = 0;
  try {
    const deadline = Date.now() + 45_000;
    while (exitCode === undefined && Date.now() < deadline) {
      if (!idle) idle = idleLine(requireCotal("who", "--all"), name);
      const started = sessions().length - start;
      if (idle && started > 0) {
        if (reload && !reloadSent) {
          terminal.write("/reload\r");
          reloadSent = true;
        } else if ((!reload || started >= 2) && Date.now() >= quitAt) {
          terminal.write("\x04");
          quitAt = Date.now() + 2_000;
        }
      }
      await wait(350);
    }
    return { exitCode, output: clean(stdout), idle, sessions: sessions().slice(start) };
  } finally {
    if (exitCode === undefined) {
      terminal.kill();
      await exited;
    }
  }
}

async function checkSpawn(name: string, label: string, reload = false) {
  const report = await spawnPi(name, reload);
  const after = requireCotal("who", "--all");
  check(`${label}: joins without duplicate tools and exits normally`, report.exitCode === 0 &&
    !!report.idle && !/Failed to load extension|conflicts with/.test(report.output), report);
  check(`${label}: goes offline on Ctrl-D`, after.split("\n").some((line) => line.includes(`${name}/default`) && /\boffline\b/.test(line)), after);
  const expected = (reload ? ["startup", "reload"] : ["startup"]).map((reason) => JSON.stringify({
    reason, nameAtLoad: name, nameAtTrust: reason === "startup" ? name : undefined, sameAgentFile: true,
    nameAtStart: name, model: "identity-backed-model", owners: ["spawn-entry.js"], preloadInEnv: false,
  }));
  check(`${label}: startup model interpolation and unrelated factories see the launch identity`,
    JSON.stringify(report.sessions) === JSON.stringify(expected), report.sessions);
}

async function checkReleaseBinary(directory: string): Promise<void> {
  const release = spawnSync(join(directory, "pi"), ["--version"], { cwd, env, encoding: "utf8", timeout: 10_000 });
  assert.equal(release.status, 0, release.stderr);
  assert.equal(release.stdout.trim(), "0.79.10");
  const name = "pi-release";
  const report = await spawnPi(name, false, [directory, env.PATH].join(delimiter));
  check("the Pi release binary refuses with the supported-host diagnostic", report.exitCode === 1 &&
    report.output.includes("cannot isolate standalone extension discovery; use the supported npm-installed Pi host") &&
    !/registerHooks.*(?:undefined|not a function)/.test(report.output), report);
  check("an unsupported Pi host does not join the mesh", !requireCotal("who", "--all").includes(`${name}/default`));
}

console.log(`Cotal CLI: ${requireCotal("--version").split("\n")[0]}`);
const version = spawnSync("pi", ["--version"], { cwd, env, encoding: "utf8" });
assert.equal(version.status, 0, version.stderr);
assert.equal(version.stdout.trim(), "0.79.10");
console.log(`Pi CLI: ${version.stdout.trim()}`);
requireCotal("ext", "seed");
const server = `nats://127.0.0.1:${await freePort()}`;
const started = cotal("up", "--open", "--no-manager", "--server", server, "--store-dir", join(scratch, "store"));
assert.equal(started.status, 0, started.output);
try {
  if (process.env.COTAL_SMOKE_PI_RELEASE_DIR) await checkReleaseBinary(process.env.COTAL_SMOKE_PI_RELEASE_DIR);
  await checkSpawn("pi-control", "without a standalone copy");
  const source = process.env.COTAL_SMOKE_PI_COPY ?? join(pi, "dist", "standalone.js");
  const current = join(pi, "dist", "standalone.js");
  const copies = [
    { path: join(extensionDir, "cotal.js"), source },
    { path: join(projectExtensions, "copied.ts"), source },
    { path: join(extensionDir, "legacy-bom.js"), source, bom: true },
    { path: join(projectExtensions, "marked-bom.js"), source: current, bom: true },
  ];
  const bytesFor = (copy: typeof copies[number]): Buffer => {
    const bytes = readFileSync(copy.source);
    return copy.bom ? Buffer.concat([Buffer.from("\uFEFF"), bytes]) : bytes;
  };
  for (const copy of copies) writeFileSync(copy.path, bytesFor(copy));
  await checkSpawn("pi-copy", "with user and project standalone copies", true);
  check("the installed standalone copies were left intact", copies.every((copy) => existsSync(copy.path) && readFileSync(copy.path).equals(bytesFor(copy))));
  check("trusted project discovery keeps unrelated extensions named cotal.js", existsSync(projectMarker) &&
    readFileSync(projectMarker, "utf8") === "startup\nstartup\nreload\n");
} finally {
  const down = cotal("down", "--yes");
  check("down stops the owned broker", down.status === 0, down.output);
}
finish();
