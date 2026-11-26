/**
 * LIVE e2e for `cotal up -f <manifest>` — the orchestration the hermetic manifest smoke can't reach:
 * a REAL fresh broker on an isolated port, channels seeded from the manifest, exactly ONE manager
 * (carrying the launch spec — a second manager would race the singleton lease), the
 * refuse-on-reachable guard, and `cotal down` teardown + transient-run cleanup.
 *
 * Open-mode manifest (no auth) so the registry is readable without minting creds. Channels-only
 * (agents: {}) so no real connector boots. Sandboxes COTAL_HOME + a temp project root; tears down via
 * `cotal down` and a port check — never pkill, so a co-running broker on :4222 is untouched.
 * Needs `nats-server` on PATH. Run: pnpm smoke:up-manifest:live
 */
import { spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, statSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { canonicalLocalProcessPath, MANAGER_PIDFILE } from "@cotal-ai/workspace";
import { assertSmokeSandboxDown, freePort, recordSmokeSandbox } from "@cotal-ai/smoke-kit";

// Ephemeral free ports + a per-run space: repeated or concurrent runs never collide on a fixed port
// nor contaminate each other's `supervise` scan (the old fixed 14311 / "upf-live" flaked locally).
const PORT = await freePort();
const DECOY_PORT = await freePort(); // the manifest declares this; --server overrides it to PORT
const SERVER = `nats://127.0.0.1:${PORT}`;
const SPACE = `upf-live-${process.pid}`;
const WT = resolve(import.meta.dirname, "..", "..", "..");
const CLI = join(WT, "bin", "cotal.ts");
const TSX = join(WT, "node_modules", ".bin", "tsx");

const home = mkdtempSync(join(tmpdir(), "cotal-upf-home-"));
const root = mkdtempSync(join(tmpdir(), "cotal-upf-root-"));
mkdirSync(join(root, ".cotal"), { mode: 0o700 });
const configDir = join(home, "xdg");
const sandbox = recordSmokeSandbox({ root, cotalHome: home, xdgConfigHome: configDir });
const env = { ...process.env, COTAL_HOME: home, XDG_CONFIG_HOME: configDir, COTAL_SKIP_CONNECTOR_SEED: "1", DO_NOT_TRACK: "1" };

let pass = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) throw new Error(`FAIL: ${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};
const cli = (...args: string[]) => {
  const options = { cwd: root, env, encoding: "utf8" as const };
  assertSmokeSandboxDown(sandbox, args, options);
  return spawnSync(TSX, [CLI, ...args], options);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const portOpen = (port: number) =>
  new Promise<boolean>((res) => {
    const s = createConnection({ host: "127.0.0.1", port }, () => { s.destroy(); res(true); });
    s.on("error", () => res(false));
    s.setTimeout(400, () => { s.destroy(); res(false); });
  });

function down(): void {
  cli("down", "--yes");
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
/** Command lines of every live manager daemon (`__daemon-manager`) for OUR space (never other meshes' managers). */
const supervisors = () =>
  spawnSync("ps", ["ax", "-o", "command="], { encoding: "utf8" })
    .stdout.split("\n")
    .filter((l) => l.includes(" __daemon-manager ") && l.includes(`--space ${SPACE}`));

const manifestDir = join(root, "manifests");
mkdirSync(manifestDir);
const manifest = join(manifestDir, "mesh.yaml");
const logFile = join(manifestDir, "broker.log");
const rotation = ["--logfile-size-limit", "1048576", "--logfile-max-num", "3"];
writeFileSync(
  manifest,
  `apiVersion: cotal/v1
kind: Mesh
space: ${SPACE}
agent: claude
broker: { servers: "nats://127.0.0.1:${DECOY_PORT}", auth: false, logFile: "./broker.log" }
channels:
  general: { description: Open coordination. }
  decisions: { description: The durable record. }
`,
);

let mgrPid = NaN;
try {
  const agents = join(manifestDir, "agents.yaml");
  writeFileSync(agents, `${readFileSync(manifest, "utf8")}agents:\n  planner: { instructions: Plan. }\n  builder: { instructions: Build. }\n`);
  const refused = cli("up", "-f", agents, "--dry-run", "--no-manager", "--server", SERVER);
  ok("an agent manifest with --no-manager refuses as usage and names the next step",
    refused.status === 1 && refused.stdout === "" && /Outcome:\s+refused/.test(refused.stderr) && /Code:\s+USAGE_INVALID/.test(refused.stderr)
    && refused.stderr.includes("declares 2 agent(s)") && refused.stderr.includes("Next") && refused.stderr.includes("drop --no-manager"), refused);

  const preview = cli("up", "-f", manifest, "--server", SERVER, "--dry-run", ...rotation);
  ok("text preview shows the manifest-relative log path and both CLI rotation bounds", preview.status === 0
    && preview.stdout.includes(`Broker log file: ${JSON.stringify(logFile)}`)
    && preview.stdout.includes("Broker log rotation size limit: 1048576 bytes")
    && preview.stdout.includes("Maximum broker log files: 3"), preview);

  for (const args of [["-f", manifest, agents], [manifest, agents]]) {
    const extra = cli("topology", "view", ...args);
    ok("topology refuses multiple manifest paths without printing a graph", extra.status === 1
      && extra.stdout === "" && extra.stderr.includes("exactly one manifest path"), extra);
  }
  for (const args of [["-f", manifest], [manifest]]) {
    const graph = cli("topology", "view", ...args);
    ok("topology renders the graph with one manifest path", graph.status === 0 && graph.stdout.includes("#general"), graph);
  }
  for (const args of [["--dry-run"], []]) {
    const consent = cli("up", "-f", manifest, "--server", SERVER, "--accept-stale-checkpoint", ...args);
    ok("a fresh manifest start refuses stale checkpoint consent", consent.status === 1 && consent.stdout === ""
      && /Code:\s+USAGE_INVALID/.test(consent.stderr) && consent.stderr.includes("--accept-stale-checkpoint cannot be combined with --file/-f")
      && consent.stderr.includes("resume a preserved stack"), consent);
  }

  const seedWarning = "--channels is not used with -f. Set channels and defaults in the manifest.";
  const warnedOnce = (stderr: string) => stderr.split(/\r?\n/).filter((line) => line.startsWith("! ") && line.includes("--channels")).join("\n") === `! ${seedWarning}`;
  writeFileSync(join(root, "seed.json"), JSON.stringify({ channels: { "from-seed": { deliveryClass: "live" } } }));
  writeFileSync(join(root, "malformed-seed.json"), "not JSON");
  for (const seed of ["seed.json", "missing-seed.json", "malformed-seed.json"]) {
    const seedPreview = cli("up", "-f", "manifests/mesh.yaml", "--channels", seed, "--server", SERVER, "--dry-run", ...rotation);
    ok(`preview ignores ${seed} and prints the unchanged manifest plan with one warning`, seedPreview.status === 0
      && seedPreview.stdout === preview.stdout && warnedOnce(seedPreview.stderr), seedPreview);
  }
  const seedJsonArgs = ["up", "--file", manifest, "--channels", "missing-seed.json", "--json"];
  for (const dryRun of [true, false]) {
    const seedJson = cli(...seedJsonArgs, ...(dryRun ? ["--dry-run"] : []));
    const envelope = JSON.parse(seedJson.stdout);
    ok(`the JSON ${dryRun ? "preview" : "live format refusal"} carries the ignored seed warning only in its warnings field`,
      (dryRun ? seedJson.status === 0 && envelope.result?.dryRun === true : seedJson.status === 2 && envelope.error?.code === "UNSUPPORTED")
      && envelope.warnings?.length === 1 && envelope.warnings[0].code === "MANIFEST_CHANNEL_SEED_IGNORED"
      && envelope.warnings[0].message === seedWarning && seedJson.stderr === "", seedJson);
  }

  const unavailableArgs = ["up", "-f", manifest, "--server", SERVER, "--runtime", "example-uninstalled-runtime"];
  const unavailablePreview = cli(...unavailableArgs, "--dry-run");
  const unavailableApply = cli(...unavailableArgs);
  ok("an unavailable runtime refuses preview and apply with the same dependency diagnosis",
    unavailablePreview.status === 2 && unavailableApply.status === 2 && unavailablePreview.stdout === ""
    && unavailablePreview.stderr === unavailableApply.stderr && /Code:\s+DEPENDENCY_UNAVAILABLE/.test(unavailablePreview.stderr)
    && unavailablePreview.stderr.includes('unknown runtime "example-uninstalled-runtime"'), { unavailablePreview, unavailableApply });
  const brokerOnly = join(manifestDir, "broker-only.yaml");
  writeFileSync(brokerOnly, `${readFileSync(manifest, "utf8")}runtime: example-uninstalled-runtime\n`);
  const brokerPreview = cli("up", "-f", brokerOnly, "--server", SERVER, "--dry-run", "--no-manager");
  ok("a broker-only preview does not require the declared manager runtime", brokerPreview.status === 0
    && brokerPreview.stdout.includes("no manager will start on this host (--no-manager)"), brokerPreview);
  ok("the refusals and preview started nothing and created no records or log", !await portOpen(PORT) && !await portOpen(DECOY_PORT) && readdirSync(join(root, ".cotal")).length === 0 && !existsSync(logFile));

  const noLog = join(manifestDir, "no-log.yaml");
  writeFileSync(noLog, readFileSync(manifest, "utf8").replace(', logFile: "./broker.log"', ""));
  const missing = cli("up", "-f", noLog, "--server", SERVER, "--dry-run", ...rotation);
  ok("manifest rotation still refuses when neither source names a log path", missing.status === 1
    && missing.stdout === "" && missing.stderr.includes("require --log-file or broker.logFile"), missing);
  const boundsOnly = join(manifestDir, "rotation.yaml");
  writeFileSync(boundsOnly, readFileSync(manifest, "utf8").replace(', logFile: "./broker.log"', ", logfileSizeLimit: 1048576, logfileMaxNum: 3"));
  const withPath = cli("up", "-f", boundsOnly, "--server", SERVER, "--dry-run", "--log-file", "./nats.log");
  ok("manifest rotation uses the CLI log path relative to the invoking directory", withPath.status === 0
    && withPath.stdout.includes(`Broker log file: ${JSON.stringify(join(root, "nats.log"))}`)
    && withPath.stdout.includes("Broker log rotation size limit: 1048576 bytes")
    && withPath.stdout.includes("Maximum broker log files: 3") && !existsSync(join(root, "nats.log")), withPath);
  const withoutPath = cli("up", "-f", boundsOnly, "--server", SERVER, "--dry-run");
  ok("rotation bounds in the manifest still require a log path", withoutPath.status === 1
    && withoutPath.stdout === "" && withoutPath.stderr.includes("require broker.logFile"), withoutPath);

  // 1) fresh up -f with a --server OVERRIDE (the manifest declares the decoy port; the flag wins).
  const up = cli("up", "-f", manifest, "--channels", "malformed-seed.json", "--server", SERVER, "--logfile-size-limit", "1048576");
  ok("up -f starts with an ignored malformed seed and warns once", up.status === 0 && up.stdout.includes(`mesh "${SPACE}" up`) && warnedOnce(up.stderr), up.stdout + up.stderr);
  ok("up -f reports seeded channels", /seeded 2 channel/.test(up.stdout), up.stdout);
  const brokerConfig = readFileSync(join(root, ".cotal/server-open.conf"), "utf8");
  ok("live manifest start renders the CLI rotation limit and writes the log beside the manifest", existsSync(logFile)
    && brokerConfig.includes(`log_file: ${JSON.stringify(logFile)}`) && brokerConfig.includes("logfile_size_limit: 1048576"), brokerConfig);
  // Regression guard (checked BEFORE any settle sleep, while a lease-race loser would still be
  // alive): the launch rides THE one control-plane manager — two supervises here means the plain
  // manager and the launch manager are racing the singleton lease, so the agents' boot is a coin flip.
  ok("exactly ONE supervise was started for the space", supervisors().length === 1, supervisors());
  await sleep(1500);
  ok("broker bound the --server OVERRIDE port (not the manifest's)", await portOpen(PORT));
  ok("manifest's declared port was NOT used (override won)", !(await portOpen(DECOY_PORT)));
  mgrPid = Number(readFileSync(canonicalLocalProcessPath(MANAGER_PIDFILE, { root, space: SPACE }), "utf8").trim());
  ok("the recorded manager is alive (not a lease-race loser)", Number.isFinite(mgrPid) && alive(mgrPid), mgrPid);
  const mgrCmd = spawnSync("ps", ["-p", String(mgrPid), "-o", "command="], { encoding: "utf8" }).stdout;
  ok("the recorded manager carries the launch spec", /--launch\b/.test(mgrCmd), mgrCmd);

  // 2) channels were really seeded into the registry (open mode → readable without creds).
  const { readChannelRegistry } = await import("@cotal-ai/core");
  const reg = await readChannelRegistry({ servers: SERVER, space: SPACE });
  ok("#general seeded with its description", reg.channels?.general?.description === "Open coordination.", reg.channels);
  ok("only manifest channels were seeded in the live registry", Boolean(reg.channels?.decisions) && reg.channels?.["from-seed"] === undefined, reg.channels);

  // 3) the launch spec was written 0600 under .cotal/run.
  const runDir = join(root, ".cotal", "run");
  const specs = existsSync(runDir) ? readdirSync(runDir).filter((f) => f.endsWith(".json")) : [];
  ok("a launch spec was written", specs.length === 1, specs);
  ok("launch spec is 0600", (statSync(join(runDir, specs[0])).mode & 0o777) === 0o600);

  // 4) up -f again, this folder's mesh still running → refuse (never re-seed as fresh, never adopt
  //    the broker), naming the mesh as running and the routes that change it.
  const again = cli("up", "-f", manifest, "--server", SERVER);
  ok("up -f refuses when this folder's mesh is already running", new RegExp(`mesh "${SPACE}" is already running at .* from this folder`).test(again.stderr) && again.status === 1, { status: again.status, stderr: again.stderr });
  ok("...and names down before retrying instead of deploying the same manifest", again.stderr.includes("stop it with `cotal down`, then retry your original command") && !again.stderr.includes("cotal team deploy"), again.stderr);

  // 5) down tears the mesh down + clears the run dir — including the manager (nothing orphaned).
  //    `cotal down` now awaits real exit; keep a backstop poll keyed on the EXACT manager pid
  //    (precise — a name scan can be contaminated by an unrelated run) in case of a slow CI reap.
  down();
  let torn = false;
  for (let i = 0; i < 60 && !torn; i++) {
    torn = !alive(mgrPid) && !(await portOpen(PORT));
    if (!torn) await sleep(500);
  }
  ok("broker + manager are gone after down (no orphaned manager)", torn, { mgrAlive: alive(mgrPid), portOpen: await portOpen(PORT), supervisors: supervisors() });
  ok("transient run dir cleaned by down", !existsSync(runDir));

  console.log(`\nUP-MANIFEST LIVE SMOKE OK ✅ (${pass} checks)`);
} finally {
  down();
  // Belt-and-suspenders: if down somehow didn't reap the manager, don't leave an orphan behind.
  if (Number.isFinite(mgrPid) && alive(mgrPid)) { try { process.kill(mgrPid, "SIGKILL"); } catch { /* already gone */ } }
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
}
