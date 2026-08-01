/**
 * SHIPPED-PATH smoke — `cotal spawn --agent codex` end to end through the pieces a customer
 * actually runs, none of which any other codex smoke touches:
 *
 *   the built binary (`bin/dist/cotal.js`)
 *     → first-run auto-seed into an empty `XDG_CONFIG_HOME`
 *       → the connector resolved from `<config>/cotal/extensions`, NOT this worktree's `src/`
 *         → its registered `codex` Connector building a launch
 *           → the shipped `dist/host.js` under plain node
 *             → a `codex` found on PATH
 *               → a real mesh join, a real turn, a real ack.
 *
 * Every other codex smoke imports `src/` (or runs `dist/host.js` directly), so all of them pass
 * while the shipped path is broken. That gap is not hypothetical: the connector was seeded but
 * unreachable through `--agent codex` until the seed reconciler was fixed, and a stale INSTALLED
 * copy shadowing current source is the single most repeated way a working change looks broken.
 * The env allow-list makes this the only place the PATH lookup is exercised for real, too:
 * `COTAL_CODEX_BIN` is not forwarded to the child, so the fake has to be a `codex` on PATH.
 *
 * Deliberately NOT `:live`-gated despite spinning a broker — the delivery path a customer hits is
 * gate-worthy. Kills only the PIDs it starts (never pkill), and sandboxes HOME, XDG_CONFIG_HOME,
 * and COTAL_HOME so the operator's real codex auth and mesh registry are untouched.
 *
 * Run: pnpm smoke:codex-installed
 */
import { strict as assert } from "node:assert";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CotalEndpoint, isReachable } from "@cotal-ai/core";

if (process.platform === "win32") {
  // Managed Codex agents are POSIX-only by design (the isolated CODEX_HOME symlinks the
  // operator's auth.json — docs/connect-codex.md). Same stated limitation as the other codex smokes.
  console.log("SKIP codex installed-path smoke — managed Codex agents are POSIX-only (symlinked auth.json)");
  process.exit(0);
}

const REPO = fileURLToPath(new URL("../../..", import.meta.url));
const CLI = join(REPO, "bin", "dist", "cotal.js");
if (!existsSync(CLI)) {
  console.error(`✗ ${CLI} missing — build first: pnpm --filter cotal-ai... build`);
  process.exit(1);
}
// The seeded payload is what an install copies in. If the build did not stage it, the smoke would
// silently prove nothing (the auto-seed would simply find no codex), so assert it up front.
const SEEDED = join(REPO, "bin", "seeded-connectors", "codex", "dist", "index.js");
if (!existsSync(SEEDED)) {
  console.error(`✗ ${SEEDED} missing — build first: pnpm --filter cotal-ai... build`);
  process.exit(1);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function freePort(): Promise<number> {
  const srv = createServer();
  srv.listen(0, "127.0.0.1");
  await once(srv, "listening");
  const port = (srv.address() as { port: number }).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

const PORT = await freePort();
const servers = `nats://127.0.0.1:${PORT}`;
const space = `cxinst${process.pid}`;
const PEER = "cxinstalled";
let pass = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, `${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

const dir = mkdtempSync(join(tmpdir(), "cotal-cxinst-"));
const HOME = join(dir, "home");
const CONFIG = join(dir, "config"); // XDG_CONFIG_HOME — empty, so the first command auto-seeds
const COTAL_HOME = join(dir, "cotalhome");
const ROOT = join(dir, "project"); // the spawn's cwd / workspace root
const SHIM = join(dir, "shim"); // prepended to PATH; holds the fake `codex`
for (const d of [HOME, CONFIG, COTAL_HOME, ROOT, SHIM, join(HOME, ".codex")]) mkdirSync(d, { recursive: true });

// The launch symlinks the operator's `~/.codex/auth.json` into the per-agent CODEX_HOME and fails
// loud without it. HOME is sandboxed, so plant one: this must be the smoke's own file and never
// the real developer's credential.
writeFileSync(join(HOME, ".codex", "auth.json"), JSON.stringify({ tokens: { access_token: "fake-smoke-token" } }));

// The fake `codex app-server`, reachable the ONLY way the child can find it: by name on PATH. The
// log path is baked into the shim because FAKE_CODEX_LOG is not on the launch env allow-list —
// which is exactly the constraint that makes this an honest test of the shipped launch.
const FAKE = fileURLToPath(new URL("./fake-codex.mjs", import.meta.url));
const LOG = join(dir, "fake.log.jsonl");
const CODEX = join(SHIM, "codex");
writeFileSync(CODEX, `#!/bin/sh\nFAKE_CODEX_LOG="${LOG}" exec "${process.execPath}" "${FAKE}" "$@"\n`);
chmodSync(CODEX, 0o755);

interface LogEntry {
  ev: string;
  argv?: string[];
  method?: string;
  params?: Record<string, unknown>;
}
const logEntries = (): LogEntry[] =>
  existsSync(LOG)
    ? readFileSync(LOG, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as LogEntry)
    : [];
const turnStarts = (): string[] =>
  logEntries()
    .filter((e) => e.ev === "recv" && e.method === "turn/start")
    .map((e) => ((e.params?.input as { text?: string }[] | undefined) ?? []).map((i) => i.text ?? "").join("\n"));

async function waitFor<T>(name: string, get: () => T | undefined, timeoutMs = 45_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = get();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${name}`);
    await sleep(200);
  }
}

// Scrub ambient COTAL_* (this smoke may itself run inside a mesh session) so every command below
// takes its identity and target only from its own arguments and these sandboxed dirs.
const cleanEnv: NodeJS.ProcessEnv = { ...process.env };
for (const k of Object.keys(cleanEnv)) if (k.startsWith("COTAL_")) delete cleanEnv[k];
const cliEnv: NodeJS.ProcessEnv = {
  ...cleanEnv,
  HOME,
  XDG_CONFIG_HOME: CONFIG,
  COTAL_HOME,
  PATH: `${SHIM}:${cleanEnv.PATH ?? ""}`,
  COTAL_CODEX_TUI: "0", // headless: deterministic text, and no TUI to own this process's stdout
};

/** Is anything listening on `port`? The check that the broker really died, rather than trusting an
 *  exit code from a command that may have refused the request. */
const portOpen = (port: number): Promise<boolean> =>
  new Promise((res) => {
    const s = createConnection({ host: "127.0.0.1", port }, () => {
      s.destroy();
      res(true);
    });
    s.on("error", () => res(false));
    s.setTimeout(400, () => {
      s.destroy();
      res(false);
    });
  });

let cli: ChildProcess | undefined;
let meshUp = false;

/** Does the spawn's process GROUP still have members? `kill(-pgid, 0)` is the only way to ask,
 *  since the agent's real work happens in grandchildren this smoke never gets handles to. */
const groupAlive = (pgid: number): boolean => {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Stop the foreground spawn and everything it started. Signalling the CLI alone is not enough: it
 *  launches the connector's host as a child, which launches `codex` in turn, and neither dies with
 *  it — the host just logs "mesh unreachable, retrying" forever once this smoke's broker is gone,
 *  leaving two node processes per run on the machine. `cotal down` cannot reap them either, because
 *  a foreground spawn is not the manager's. So the spawn gets its own process group and the whole
 *  group is signalled. */
const stopCli = async (): Promise<void> => {
  const pgid = cli?.pid;
  if (!pgid) return;
  try {
    process.kill(-pgid, "SIGTERM");
  } catch {
    return; // already gone
  }
  for (let i = 0; i < 20 && groupAlive(pgid); i++) await sleep(200);
  if (groupAlive(pgid)) {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {
      /* raced with its own exit */
    }
    await sleep(300);
  }
};

/** Bare `cotal down` from the project root — the whole-stack form, which is what `up` created here.
 *  Runs at most once; later calls report the first result so the finally-block net is a no-op after
 *  a successful teardown. */
let tornDown: { status: number; stdout: string; stderr: string } | undefined;
async function teardown(): Promise<{ status: number; stdout: string; stderr: string }> {
  if (tornDown) return tornDown;
  if (!meshUp) return (tornDown = { status: 0, stdout: "", stderr: "" });
  const r = spawnSync("node", [CLI, "down"], { cwd: ROOT, env: cliEnv, encoding: "utf8" });
  tornDown = { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  for (let i = 0; i < 40 && (await portOpen(PORT)); i++) await sleep(250);
  return tornDown;
}
const operator = new CotalEndpoint({
  space,
  servers,
  card: { name: "operator", kind: "agent", id: "operator" },
  channels: ["general"],
});
operator.on("error", () => {});
let online = false;
operator.on("presence", (e: { type: string; presence: { card: { id: string; name: string } } }) => {
  const c = e.presence.card;
  if ((c.id === PEER || c.name === PEER) && e.type !== "offline") online = true;
});

let cliStderr = "";
try {
  // A real mesh, brought up the way an operator does it. `spawn` resolves its target through the
  // machine's mesh registry, so a bare broker on a port is not a mesh it will launch into — and
  // this is the first command run against the empty config, so it is also what triggers the
  // auto-seed. Open mode (`auth: false`) so this smoke's own operator endpoint can watch presence
  // without minting creds; the connector resolution under test is the same either way.
  const manifest = join(ROOT, "mesh.yaml");
  writeFileSync(
    manifest,
    `apiVersion: cotal/v1\nkind: Mesh\nspace: ${space}\nagent: codex\nbroker: { servers: "${servers}", auth: false }\nchannels:\n  general: { description: Open coordination. }\n`,
  );
  // A named spawn resolves a persona from the workspace catalog, so the agent file is part of the
  // path under test. Its `model:`/`variant:` are also what the roster (and the dashboard's
  // `model · variant` badge) must end up carrying.
  mkdirSync(join(ROOT, ".cotal", "agents"), { recursive: true });
  writeFileSync(
    join(ROOT, ".cotal", "agents", `${PEER}.md`),
    `---\nname: ${PEER}\nrole: tester\nmodel: fake-model\nvariant: high\n---\n\nA smoke peer. Do nothing on your own.\n`,
  );
  const up = spawnSync("node", [CLI, "up", "-f", manifest, "--server", servers], {
    cwd: ROOT,
    env: cliEnv,
    encoding: "utf8",
  });
  if (up.status !== 0) throw new Error(`cotal up failed (${up.status})\n${up.stdout}\n${up.stderr}`);
  meshUp = true;
  check(
    "the empty config auto-seeded the codex connector on first use",
    existsSync(join(CONFIG, "cotal", "extensions", "node_modules", "@cotal-ai", "connector-codex")),
  );

  for (let i = 0; i < 60; i++) {
    if (await isReachable(servers)) break;
    await sleep(200);
  }
  await operator.start();

  // The real command, with nothing pointed at this worktree: the connector must come from the
  // config dir the binary seeded for itself. Foreground, not `-d` — the same resolution path with
  // one less moving part (no manager relay) between the CLI and the connector.
  cli = spawn("node", [CLI, "spawn", PEER, "--agent", "codex", "--server", servers, "--space", space], {
    cwd: ROOT,
    env: cliEnv,
    stdio: ["ignore", "pipe", "pipe"],
    // Its own process group, so teardown can reap the host and the codex child it starts (see
    // stopCli). Without this the agent outlives the smoke.
    detached: true,
  });
  cli.stderr?.on("data", (b: Buffer) => (cliStderr += b.toString()));
  cli.stdout?.on("data", (b: Buffer) => (cliStderr += b.toString()));

  // (1) The whole chain, proven by the one thing that cannot happen without all of it: the agent
  // is on the mesh. A missing/stale installed connector, an unresolvable `codex`, or a host bundle
  // that will not load under plain node each stop here instead.
  await waitFor(`${PEER} to join the mesh`, () => (online ? true : undefined));
  check("a seeded-then-installed connector serves `spawn --agent codex` all the way to a mesh join", online);

  // (2) It really launched the SHIPPED bundle against a real `codex` off PATH.
  const argv = await waitFor("the child codex to be launched", () => logEntries().find((e) => e.ev === "argv")?.argv);
  check("the launch resolved `codex` by name on PATH (no test-only bin override)", Array.isArray(argv), argv);
  check("the shipped launch carries the autonomy defaults", (argv ?? []).join(" ").includes('approval_policy="never"'), argv);
  check(
    "the shipped launch carries the network-enabled workspace sandbox",
    (argv ?? []).join(" ").includes("sandbox_workspace_write={network_access=true}"),
    argv,
  );

  // (3) Delivery works through it, not just startup: a DM drives a real turn and is acked (a
  // second turn must not re-carry the first one's text).
  // What the dashboard reads: the harness badge plus `model · variant`, carried on presence meta
  // and sourced here from the agent file. The whole chain (agent file → launch env → host config →
  // presence) only exists on this path, so this is where it can actually be proven.
  const card = await waitFor("the peer in the operator's roster", () => {
    const c = operator.getRoster().find((p) => p.card.name === PEER)?.card;
    return c?.meta?.model ? c : undefined;
  });
  check("presence carries harness + model + reasoning effort for the dashboard", card.meta?.connector === "codex" && card.meta?.model === "fake-model" && card.meta?.variant === "high", card.meta);
  const id = card.id;
  await operator.unicast(id, "installed-path-one");
  const t1 = await waitFor("a turn carrying the DM", () => turnStarts().find((t) => t.includes("installed-path-one")));
  check("a DM to the spawned agent drives a real codex turn", t1 !== undefined);
  await sleep(600);
  await operator.unicast(id, "installed-path-two");
  const t2 = await waitFor("a second turn", () => turnStarts().find((t) => t.includes("installed-path-two")));
  check("the first batch was acked on completion, not redelivered", !t2.includes("installed-path-one"), t2);

  // (4) It cleans up after itself. This runs in the gate, so a teardown that quietly fails leaks a
  // broker and a manager per run, on every developer machine and every CI job — which is exactly
  // what the first version of this smoke did, by calling `down --space <name>`: that form is only
  // for target-addressed components and throws for a whole-stack stop, and the error was discarded.
  await operator.stop().catch(() => {});
  const agentPgid = cli.pid;
  await stopCli();
  check("the spawned agent and the codex child it started are both reaped", agentPgid !== undefined && !groupAlive(agentPgid));
  const torn = await teardown();
  check("`cotal down` reports success", torn.status === 0, `${torn.stdout}\n${torn.stderr}`);
  check("the broker this smoke started is really gone (nothing leaked into the gate)", !(await portOpen(PORT)));

  console.log(`\nCODEX INSTALLED-PATH SMOKE PASSED ✅  (${pass} checks)`);
} catch (e) {
  console.error(`\n✗ codex installed-path smoke failed: ${(e as Error).message}`);
  if (cliStderr.trim()) console.error(`--- cotal spawn output ---\n${cliStderr}`);
  process.exitCode = 1;
} finally {
  await operator.stop().catch(() => {});
  await stopCli();
  // Idempotent: a no-op when the success path already tore down, and the safety net when the run
  // threw before reaching it. Never pkill — the operator's own broker on :4222 must survive.
  await teardown();
  rmSync(dir, { recursive: true, force: true });
}
