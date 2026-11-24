import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
writeFileSync(join(extensionDir, "unrelated.js"), `
import { appendFileSync } from "node:fs";
import { basename } from "node:path";
export default function (pi) {
  const nameAtLoad = process.env.COTAL_NAME;
  const agentFileAtLoad = process.env.COTAL_AGENT_FILE;
  let nameAtTrust;
  pi.on("project_trust", () => { nameAtTrust = process.env.COTAL_NAME; });
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

async function spawnPi(name: string, reload: boolean) {
  const start = sessions().length;
  const terminal = nodePty([cli, "spawn", "--harness", "pi", "--name", name], { cwd, env });
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
  await checkSpawn("pi-control", "without a standalone copy");
  const source = process.env.COTAL_SMOKE_PI_COPY ?? join(pi, "dist", "standalone.js");
  const copies = [
    { path: join(extensionDir, "cotal.js"), source },
    { path: join(projectExtensions, "renamed-mesh.js"), source: join(pi, "dist", "standalone.js") },
  ];
  for (const copy of copies) copyFileSync(copy.source, copy.path);
  await checkSpawn("pi-copy", "with user and project standalone copies", true);
  check("the installed standalone copies were left intact", copies.every(({ path, source }) => existsSync(path) && readFileSync(path).equals(readFileSync(source))));
  check("trusted project discovery keeps unrelated extensions named cotal.js", existsSync(projectMarker) &&
    readFileSync(projectMarker, "utf8") === "startup\nstartup\nreload\n");
} finally {
  const down = cotal("down", "--yes");
  check("down stops the owned broker", down.status === 0, down.output);
}
finish();
