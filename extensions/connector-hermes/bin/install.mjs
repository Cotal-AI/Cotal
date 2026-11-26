#!/usr/bin/env node
/**
 * `npx @cotal-ai/connector-hermes <install|uninstall>`
 *
 * Wires the Cotal plugin into an existing Hermes so its gateway can join a Cotal mesh, and
 * reverses it cleanly. The plugin (incl. the bundled `_sidecar/standalone.cjs`) lands in
 * `<HERMES_HOME>/plugins/cotal`, gets enabled, and your mesh config is written to
 * `<HERMES_HOME>/.env`.
 *
 * It figures out WHERE Hermes lives on its own:
 *   - `hermes` on PATH                  → host mode (also covers running this INSIDE the container)
 *   - else a running Hermes container   → docker mode (copy in + `docker exec … plugins enable`)
 *   - else `--target-home <path>`       → files-only mode (place files, print the manual steps)
 * Override the guess with `--docker <container>`, `--target-home <path>`, or `--profile <name>`.
 *
 * Interactive in a TTY; non-interactive with `--yes` (or no TTY), taking mesh config from
 * `--link/--space/--name/--server` flags or the matching `COTAL_*` env vars. A non-interactive
 * run never mutates an auto-detected container — pass `--docker <name>` to be explicit.
 *
 * House rule: no fallbacks. If we can't find a place to install, we fail loudly and write nothing.
 */
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const PKG_ROOT = fileURLToPath(new URL("..", import.meta.url));
const PLUGIN_SRC = join(PKG_ROOT, "plugin", "cotal");
const SIDECAR = join(PLUGIN_SRC, "_sidecar", "standalone.cjs");

const DEFAULTS = { space: "demo", name: "my-hermes", server: "nats://127.0.0.1:4222" };
const DOCKER_SERVER = "nats://host.docker.internal:4222";
const CONTAINER_HOME = "/opt/data"; // HERMES_HOME inside the official image
const ENV_KEYS = ["COTAL_LINK", "COTAL_SPACE", "COTAL_NAME", "COTAL_SERVERS"];

const die = (msg) => {
  process.stderr.write(`✗ ${msg}\n`);
  process.exit(1);
};
const info = (msg) => process.stdout.write(`${msg}\n`);
const warn = (msg) => process.stdout.write(`! ${msg}\n`);

function usage() {
  info("usage: npx @cotal-ai/connector-hermes <install|uninstall> [options]");
  info("  targeting:  --docker <container> | --target-home <path> | --profile <name>");
  info("  mesh:       --link <url> | --space <s> --name <n> --server <url>");
  info("  other:      --yes (non-interactive)   --keep-env (uninstall: leave COTAL_* in .env)");
}

// ---- arg parsing ------------------------------------------------------------
function parseFlags(argv) {
  const f = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--yes" || a === "-y") f.yes = true;
    else if (a.startsWith("--")) {
      const [k, inline] = a.slice(2).split("=");
      f[k] = inline ?? (argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true);
    }
  }
  return f;
}

// ---- small prompts ----------------------------------------------------------
async function confirm(question, defaultYes) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const a = (await rl.question(question)).trim().toLowerCase();
    if (!a) return defaultYes;
    return a === "y" || a === "yes";
  } finally {
    rl.close();
  }
}

async function pickContainer(containers) {
  info("Multiple Hermes containers are running:");
  containers.forEach((c, i) => info(`  ${i + 1}) ${c.name}  (${c.image})`));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const idx = Number((await rl.question(`pick [1-${containers.length}]: `)).trim()) - 1;
    if (!(idx >= 0 && idx < containers.length)) die("invalid selection");
    return containers[idx].name;
  } finally {
    rl.close();
  }
}

// ---- mesh config gathering --------------------------------------------------
async function promptConfig(defaults) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    info("\nCotal mesh — paste a join link (cotal://token@host/space), or press Enter to set it manually:");
    const link = (await rl.question("  link: ")).trim();
    if (link) {
      const name = (await rl.question(`  name [${defaults.name}]: `)).trim() || defaults.name;
      return { COTAL_LINK: link, COTAL_NAME: name };
    }
    const space = (await rl.question(`  space  [${defaults.space}]: `)).trim() || defaults.space;
    const name = (await rl.question(`  name   [${defaults.name}]: `)).trim() || defaults.name;
    const server = (await rl.question(`  server [${defaults.server}]: `)).trim() || defaults.server;
    return { COTAL_SPACE: space, COTAL_NAME: name, COTAL_SERVERS: server };
  } finally {
    rl.close();
  }
}

function configFromFlags(flags, defaults) {
  const link = flags.link || process.env.COTAL_LINK;
  if (link) return { COTAL_LINK: link, COTAL_NAME: flags.name || process.env.COTAL_NAME || defaults.name };
  const space = flags.space || process.env.COTAL_SPACE;
  const server = flags.server || process.env.COTAL_SERVERS;
  if (!space && !server) return {}; // nothing supplied → skip .env, print manual next steps
  return {
    COTAL_SPACE: space || defaults.space,
    COTAL_NAME: flags.name || process.env.COTAL_NAME || defaults.name,
    COTAL_SERVERS: server || defaults.server,
  };
}

// On macOS/Windows a container can't reach the host over 127.0.0.1 — rewrite to host.docker.internal.
// On Linux the right answer depends on the container's network mode, so we only warn.
function dockerizeServer(meshEnv) {
  const isLoop = (s) => /(^|@|\/\/)(127\.0\.0\.1|localhost)(:|\/|$)/.test(s || "");
  for (const k of ["COTAL_SERVERS", "COTAL_LINK"]) {
    if (!meshEnv[k] || !isLoop(meshEnv[k])) continue;
    if (process.platform === "linux") {
      warn(`${k} points at loopback. From a Linux container, reach the host via \`--network host\` (keep 127.0.0.1) or add \`host.docker.internal:host-gateway\`. Leaving as-is.`);
    } else {
      const before = meshEnv[k];
      meshEnv[k] = before.replace(/127\.0\.0\.1|localhost/g, "host.docker.internal");
      warn(`Rewrote ${k}: ${before} → ${meshEnv[k]} (so the container can reach your host).`);
    }
  }
}

// ---- .env editing (idempotent, pure) ----------------------------------------
const envKey = (l) => l.replace(/^#\s*/, "").split("=")[0].trim();

function applyEnv(content, set) {
  // Link mode and manual mode are mutually exclusive; comment out the other mode's keys so a
  // re-run never leaves a stale COTAL_SPACE overriding a new COTAL_LINK.
  const drop = set.COTAL_LINK ? ["COTAL_SPACE", "COTAL_SERVERS"] : ["COTAL_LINK"];
  const lines = content ? content.split("\n") : [];
  for (const [k, v] of Object.entries(set)) {
    const line = `${k}=${v}`;
    const i = lines.findIndex((l) => envKey(l) === k);
    if (i >= 0) lines[i] = line;
    else lines.push(line);
  }
  for (let i = 0; i < lines.length; i++) {
    if (drop.includes(envKey(lines[i])) && !lines[i].trimStart().startsWith("#")) lines[i] = `# ${lines[i]}`;
  }
  return lines.join("\n").replace(/\n*$/, "\n");
}

function stripEnv(content, keys) {
  if (!content) return content;
  return content
    .split("\n")
    .filter((l) => !keys.includes(envKey(l)))
    .join("\n")
    .replace(/\n*$/, "\n");
}

function writeEnvFile(file, set) {
  mkdirSync(dirname(file), { recursive: true });
  const cur = existsSync(file) ? readFileSync(file, "utf8") : "";
  writeFileSync(file, applyEnv(cur, set));
}

function stripEnvFile(file, keys) {
  if (!existsSync(file)) return false;
  const cur = readFileSync(file, "utf8");
  const next = stripEnv(cur, keys);
  if (next === cur) return false;
  writeFileSync(file, next);
  return true;
}

// ---- mesh reachability ------------------------------------------------------
function hostPort(server) {
  try {
    const u = new URL(server.replace(/^(cotals?|nats):\/\//, "http://"));
    // host.docker.internal is the container's name for the host; probe it as loopback from here.
    const host = u.hostname === "host.docker.internal" ? "127.0.0.1" : u.hostname;
    return { host, port: Number(u.port || 4222) };
  } catch {
    return undefined;
  }
}

function reachable(server) {
  const hp = hostPort(server);
  if (!hp) return Promise.resolve(false);
  return new Promise((res) => {
    const s = createConnection({ host: hp.host, port: hp.port });
    const done = (ok) => {
      try {
        s.destroy();
      } catch {
        /* ignore */
      }
      res(ok);
    };
    s.setTimeout(2000);
    s.once("connect", () => done(true));
    s.once("timeout", () => done(false));
    s.once("error", () => done(false));
  });
}

async function reachabilityInfo(meshEnv) {
  const server = meshEnv.COTAL_SERVERS || meshEnv.COTAL_LINK;
  if (!server) return;
  const ok = await reachable(server);
  const hp = hostPort(server);
  info(ok ? "✓ Mesh reachable" : `! Mesh not reachable at ${hp?.host}:${hp?.port} — start it (e.g. \`nats-server -js\`) before \`hermes gateway run\``);
}

// ---- host / docker discovery ------------------------------------------------
function hermesVersion() {
  try {
    return execFileSync("hermes", ["--version"], { encoding: "utf8", windowsHide: true }).trim();
  } catch {
    return undefined;
  }
}

function dockerAvailable() {
  try {
    execFileSync("docker", ["version", "--format", "{{.Server.Version}}"], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

// Running containers whose image looks like Hermes AND that actually have a `hermes` binary.
function findHermesContainers() {
  let out;
  try {
    out = execFileSync("docker", ["ps", "--format", "{{.ID}}\t{{.Image}}\t{{.Names}}"], { encoding: "utf8", windowsHide: true });
  } catch {
    return [];
  }
  const rows = out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [id, image, name] = l.split("\t");
      return { id, image, name };
    })
    .filter((r) => /hermes/i.test(r.image));
  return rows.filter((r) => {
    try {
      execFileSync("docker", ["exec", r.name, "hermes", "--version"], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
      return true;
    } catch {
      return false;
    }
  });
}

// Host path bind-mounted at /opt/data (so files placed there appear in the container), or null
// for a volume / no mount (then we copy in with `docker cp`).
function bindSource(container) {
  try {
    const out = execFileSync("docker", ["inspect", container, "--format", "{{json .Mounts}}"], { encoding: "utf8", windowsHide: true });
    const m = JSON.parse(out).find((x) => x.Destination === CONTAINER_HOME);
    return m && m.Type === "bind" ? m.Source : null;
  } catch {
    return null;
  }
}

// ---- target resolution ------------------------------------------------------
function resolveHome(flags) {
  if (flags.profile) return join(homedir(), ".hermes", "profiles", flags.profile);
  return process.env.HERMES_HOME?.trim() || join(homedir(), ".hermes");
}

function resolveTarget(flags) {
  if (flags["target-home"]) return { mode: "files", home: flags["target-home"] };
  if (flags.docker) return { mode: "docker", container: flags.docker, explicit: true };
  const version = hermesVersion();
  if (version) return { mode: "host", home: resolveHome(flags), profile: flags.profile, version };
  if (dockerAvailable()) {
    const cs = findHermesContainers();
    if (cs.length === 1) return { mode: "docker", container: cs[0].name, detected: cs[0] };
    if (cs.length > 1) return { mode: "docker-multi", containers: cs };
  }
  return { mode: "none" };
}

const targetDesc = (t) =>
  t.mode === "docker" ? `container '${t.container}'` : t.mode === "host" ? `${t.home}` : t.home;

// Resolve auto-detected/ambiguous docker targets into a concrete one (or exit).
async function settleTarget(target, interactive, verb) {
  if (target.mode === "none") {
    die(
      `No Hermes found to ${verb}.\n` +
        "  • Host install? Put `hermes` on PATH first:\n" +
        "      curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash\n" +
        "  • Running in Docker? pass --docker <container> (or run this inside it: `docker exec -it <c> npx @cotal-ai/connector-hermes " +
        verb +
        "`)\n" +
        "  • Just place/remove files for a runtime elsewhere? pass --target-home <path>",
    );
  }
  if (target.mode === "docker-multi") {
    if (!interactive) die("Multiple Hermes containers found — pass --docker <container>.");
    return { mode: "docker", container: await pickContainer(target.containers) };
  }
  if (target.mode === "docker" && target.detected) {
    // Auto-detected, not explicitly named: confirm in a TTY, never mutate silently otherwise.
    if (!interactive)
      die(`Detected container '${target.container}'. Re-run with --docker ${target.container} to confirm (a non-interactive run won't mutate an auto-detected container).`);
    if (!(await confirm(`Found Hermes container '${target.container}' (${target.detected.image}) — ${verb} Cotal ${verb === "install" ? "into" : "from"} it? [Y/n] `, true)))
      die("aborted");
  }
  return target;
}

// ---- plugin file placement --------------------------------------------------
function copyPluginTo(dest) {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(PLUGIN_SRC, dest, {
    recursive: true,
    filter: (src) => !src.includes(`${sep}__pycache__`) && !src.endsWith(".pyc"),
  });
}

function dockerCopyPlugin(container) {
  const stage = mkdtempSync(join(tmpdir(), "cotal-plugin-"));
  try {
    copyPluginTo(join(stage, "cotal"));
    execFileSync("docker", ["exec", container, "mkdir", "-p", `${CONTAINER_HOME}/plugins`], { stdio: "inherit", windowsHide: true });
    execFileSync("docker", ["cp", join(stage, "cotal"), `${container}:${CONTAINER_HOME}/plugins/cotal`], { stdio: "inherit", windowsHide: true });
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

function dockerReadFile(container, path) {
  try {
    return execFileSync("docker", ["exec", container, "sh", "-c", `cat ${path} 2>/dev/null || true`], { encoding: "utf8", windowsHide: true });
  } catch {
    return "";
  }
}

function dockerWriteFile(container, path, content) {
  execFileSync("docker", ["exec", "-i", container, "sh", "-c", `mkdir -p "$(dirname ${path})" && cat > ${path}`], { input: content, windowsHide: true });
}

// ---- running hermes (host or in-container) ----------------------------------
function runHermes(target, hermesArgs) {
  if (target.mode === "host")
    execFileSync("hermes", [...(target.profile ? ["-p", target.profile] : []), ...hermesArgs], { stdio: "inherit", windowsHide: true });
  else if (target.mode === "docker")
    execFileSync("docker", ["exec", target.container, "hermes", ...hermesArgs], { stdio: "inherit", windowsHide: true });
  else throw new Error("runHermes is not available in files-only mode");
}

function printRestart(target) {
  if (target.mode === "docker") {
    info("Restart the gateway:");
    info(`  docker restart ${target.container}`);
  } else if (target.mode === "host") {
    info("Restart the gateway to load it:");
    info("  hermes gateway restart      # supervised service (launchd/systemd)");
    info("  # or restart your foreground `hermes gateway run`");
  } else {
    info("Where Hermes runs, enable + restart it:");
    info("  hermes plugins enable cotal && hermes gateway restart");
  }
}

// ---- install ----------------------------------------------------------------
async function install(flags) {
  if (!existsSync(SIDECAR))
    die(
      `bundled sidecar missing at ${SIDECAR}\n` +
        "  (running from source? build it first: pnpm --filter @cotal-ai/connector-hermes build)",
    );

  const interactive = Boolean(process.stdin.isTTY) && !flags.yes;
  let target = await settleTarget(resolveTarget(flags), interactive, "install");

  if (target.mode === "host") info(`✓ Hermes detected — ${target.version.split("·")[0].trim()}`);
  else if (target.mode === "docker") info(`✓ Targeting Hermes container '${target.container}'`);
  else info(`• Files-only install into ${target.home} (no hermes binary will be invoked)`);

  // Gather mesh config (docker defaults the server to host.docker.internal).
  const defaults = target.mode === "docker" ? { ...DEFAULTS, server: DOCKER_SERVER } : DEFAULTS;
  const meshEnv = interactive ? await promptConfig(defaults) : configFromFlags(flags, defaults);
  if (target.mode === "docker") dockerizeServer(meshEnv);
  const hasEnv = Object.keys(meshEnv).length > 0;

  // Place .env + plugin files, per mode.
  if (target.mode === "docker") {
    const bind = bindSource(target.container);
    if (bind) {
      if (hasEnv) writeEnvFile(join(bind, ".env"), meshEnv);
      copyPluginTo(join(bind, "plugins", "cotal"));
    } else {
      if (hasEnv) dockerWriteFile(target.container, `${CONTAINER_HOME}/.env`, applyEnv(dockerReadFile(target.container, `${CONTAINER_HOME}/.env`), meshEnv));
      dockerCopyPlugin(target.container);
    }
    if (hasEnv) info(`✓ Wrote ${Object.keys(meshEnv).join(", ")} to ${target.container}:${CONTAINER_HOME}/.env`);
    // The sidecar needs Node inside the container; the official image ships it, but verify.
    try {
      execFileSync("docker", ["exec", target.container, "node", "--version"], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    } catch {
      warn(`No \`node\` in container '${target.container}' — the Cotal sidecar can't start. Use the official nousresearch/hermes-agent image (it bundles Node 22).`);
    }
  } else {
    const envFile = join(target.home, ".env");
    if (hasEnv) {
      writeEnvFile(envFile, meshEnv);
      info(`✓ Wrote ${Object.keys(meshEnv).join(", ")} to ${envFile}`);
    }
    copyPluginTo(join(target.home, "plugins", "cotal"));
  }

  if (hasEnv) await reachabilityInfo(meshEnv);

  // Enable (host/docker only — files-only has no binary to call).
  if (target.mode === "files") {
    info("\n✓ Cotal plugin files placed.");
    info("Can't enable without a hermes binary. Next, where Hermes runs:");
    info("  hermes plugins enable cotal");
    printRestart(target);
    return;
  }
  try {
    runHermes(target, ["plugins", "enable", "cotal"]);
  } catch {
    die("copied the plugin but `plugins enable cotal` failed.\n  Enable it manually: `hermes plugins enable cotal`.");
  }

  info("\n✓ Cotal plugin installed + enabled.\n");
  if (!hasEnv) info("Set your mesh in .env (COTAL_LINK, or COTAL_SPACE/COTAL_NAME/COTAL_SERVERS), then:");
  printRestart(target);
}

// ---- uninstall --------------------------------------------------------------
async function uninstall(flags) {
  const interactive = Boolean(process.stdin.isTTY) && !flags.yes;
  const target = await settleTarget(resolveTarget(flags), interactive, "uninstall");

  if (interactive && !(await confirm(`Remove Cotal from ${targetDesc(target)} and disable it? [y/N] `, false))) die("aborted");

  // Disable (idempotent — cotal not being enabled is fine), then delete the files.
  if (target.mode === "docker") {
    try {
      runHermes(target, ["plugins", "disable", "cotal"]);
    } catch {
      /* not enabled */
    }
    try {
      execFileSync("docker", ["exec", target.container, "rm", "-rf", `${CONTAINER_HOME}/plugins/cotal`], { stdio: "inherit", windowsHide: true });
    } catch {
      /* already gone */
    }
    info(`✓ Removed ${CONTAINER_HOME}/plugins/cotal in '${target.container}'`);
  } else {
    if (target.mode === "host") {
      try {
        runHermes(target, ["plugins", "disable", "cotal"]);
      } catch {
        /* not enabled */
      }
    }
    const dir = join(target.home, "plugins", "cotal");
    const had = existsSync(dir);
    rmSync(dir, { recursive: true, force: true });
    info(had ? `✓ Removed ${dir}` : `• No plugin dir at ${dir}`);
    if (target.mode === "files") info("Where Hermes runs, also disable it: hermes plugins disable cotal");
  }

  // Clean only the COTAL_* keys we manage, leaving the rest of .env untouched.
  if (!flags["keep-env"]) {
    if (target.mode === "docker") {
      const bind = bindSource(target.container);
      if (bind) {
        if (stripEnvFile(join(bind, ".env"), ENV_KEYS)) info(`✓ Cleaned COTAL_* from ${join(bind, ".env")}`);
      } else {
        const cur = dockerReadFile(target.container, `${CONTAINER_HOME}/.env`);
        const next = stripEnv(cur, ENV_KEYS);
        if (cur && next !== cur) {
          dockerWriteFile(target.container, `${CONTAINER_HOME}/.env`, next);
          info(`✓ Cleaned COTAL_* from ${target.container}:${CONTAINER_HOME}/.env`);
        }
      }
    } else if (stripEnvFile(join(target.home, ".env"), ENV_KEYS)) {
      info(`✓ Cleaned COTAL_* from ${join(target.home, ".env")}`);
    }
  }

  info("\n✓ Cotal uninstalled.\n");
  printRestart(target);
}

// ---- main -------------------------------------------------------------------
const args = process.argv.slice(2);
const cmd = args[0];
if (cmd !== "install" && cmd !== "uninstall") {
  usage();
  process.exit(cmd ? 1 : 0);
}
const flags = parseFlags(args.slice(1));
if (cmd === "install") await install(flags);
else await uninstall(flags);
