/** `cotal up --serve artifacts` through the real CLI (A1, E9). The shipped path, not a harness that
 * calls the bootstrap directly: the launcher passes `--serve` to the daemon it starts, registers the
 * endpoint from the root's signer once the daemon answers, and reports success only after the daemon
 * proves it bound. The decision is recorded on the mesh entry, so a relaunch without the flag keeps
 * serving: a bare `cotal up` after the daemon was killed starts a new one with `--serve artifacts` and
 * binds it again at a later epoch. On a prepared root the controller-owned stack takes the same flag:
 * its delivery member's saved definition carries it, and up returns only after the endpoint bound.
 *
 * Also refused before anything starts: an unknown endpoint name, `--serve` with `--open`, and `--serve`
 * with `-f`.
 *
 * Uses a private home and root on an allocated loopback port, starts no agents (`--no-manager`), and
 * retains the sandbox and logs. Needs nats-server on PATH. Run: pnpm smoke:up-serve:live */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ARTIFACTS_ENDPOINT, CotalEndpoint, mintCreds, newIdentity } from "@cotal-ai/core";
import { canonicalLocalProcessPath, DELIVERY_PIDFILE, findMesh, getSpaceAuth, parsePid, readProcessCommand, workspaceSecretStore } from "@cotal-ai/workspace";
import { assertSmokeSandboxDown, emitSentinel, freePort, recordSmokeSandbox } from "@cotal-ai/smoke-kit";
import { foregroundCliProbe } from "./_foreground-cli-probe.js";

const EXPECTED = 12;
const wt = resolve(import.meta.dirname, "../../..");
const cliEntry = join(wt, "bin/cotal.ts");
const tsx = import.meta.resolve("tsx");
const base = realpathSync(mkdtempSync(join(tmpdir(), "cotal-up-serve-")));
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(COTAL_|CLAUDE_|ANTHROPIC_|OPENAI_|JCODE_)/i.test(k)));
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
let passed = 0;
const check = (name: string, ok: unknown, detail?: unknown) => {
  assert.ok(ok, `${name}${detail === undefined ? "" : `\n${typeof detail === "string" ? detail : JSON.stringify(detail, null, 2)}`}`);
  passed++;
  console.log(`  ✓ ${name}`);
};

const home = join(base, "home"), mesh = join(base, "mesh");
for (const p of [home, mesh, join(mesh, ".cotal"), join(home, "xdg"), join(home, "runtime"), join(home, "machine")]) mkdirSync(p, { recursive: true, mode: 0o700 });
const sandbox = recordSmokeSandbox({ root: mesh, cotalHome: join(home, "machine"), xdgConfigHome: join(home, "xdg") });
const port = await freePort();
assert.notEqual(port, 4222);
const space = "up-serve";
const server = `nats://127.0.0.1:${port}`;
const env = { ...cleanEnv, HOME: home, COTAL_HOME: join(home, "machine"), XDG_CONFIG_HOME: join(home, "xdg"), XDG_RUNTIME_DIR: join(home, "runtime"), XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache"), XDG_STATE_HOME: join(home, "state"), COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1" };
// The registry this process reads (`findMesh`) is the sandbox's, not the caller's.
process.env.COTAL_HOME = env.COTAL_HOME;
const logs: Record<string, { code: number | null; out: string; err: string }> = {};
const cli = async (name: string, args: string[], ms = 120_000) => (logs[name] = await foregroundCliProbe(cliEntry, tsx, mesh, env, args, ms));
const daemonPid = () => parsePid(readFileSync(canonicalLocalProcessPath(DELIVERY_PIDFILE, { root: mesh, space }), "utf8"));
const daemonArgv = (pid: number) => { const c = readProcessCommand(pid); return c.kind === "command" ? c.command : `(${c.kind})`; };

/** Ask the running daemon what it serves, on a scoped evictor credential minted from the root's signer. */
async function serveState(root = mesh, sp = space, srv = server): Promise<{ bound?: boolean; state?: { epoch: number; instanceId: string } }> {
  const auth = (await getSpaceAuth(workspaceSecretStore(root), sp))!;
  const id = newIdentity();
  const ep = new CotalEndpoint({ space: sp, servers: srv, creds: await mintCreds(auth, id, "endpoint-evictor", { expiresInSeconds: 120 }),
    card: { id: id.id, name: "up-serve-probe", kind: "endpoint" }, channels: [], consume: false, watchChannels: false, watchPresence: false, registerPresence: false });
  ep.on("error", () => {});
  try {
    await ep.start();
    const r = await ep.requestDeliveryAdmin("serveState", { endpoint: ARTIFACTS_ENDPOINT }, 10_000);
    return r.ok ? r.data as { bound?: boolean; state?: { epoch: number; instanceId: string } } : {};
  } finally { await ep.stop().catch(() => {}); }
}

console.log(`up-serve retained evidence: ${base}`);
const ctlRoot = join(base, "controller"), ctlSpace = "up-serve-ctl";
mkdirSync(ctlRoot, { recursive: true, mode: 0o700 });
const ctlSandbox = recordSmokeSandbox({ root: ctlRoot, cotalHome: join(home, "machine"), xdgConfigHome: join(home, "xdg") });
const ctlPort = await freePort();
const ctlServer = `nats://127.0.0.1:${ctlPort}`;
let started = false, ctlStarted = false;
try {
  // ---- refused before anything starts ----
  const unknown = await cli("unknown", ["up", "--server", server, "--space", space, "--no-manager", "--serve", "nothing"], 30_000);
  check("an unknown endpoint name is refused, naming the ones the daemon serves, and nothing starts",
    unknown.code !== 0 && /--serve nothing: the delivery daemon serves only artifacts/.test(unknown.err) && findMesh(space) === undefined, unknown.err);
  const open = await cli("open", ["up", "--server", server, "--space", space, "--no-manager", "--open", "--serve", "artifacts"], 30_000);
  check("--serve with --open is refused, since an open mesh runs no delivery daemon",
    open.code !== 0 && /open mesh \(--open\) runs none/.test(open.err) && findMesh(space) === undefined, open.err);
  writeFileSync(join(mesh, "cotal.yaml"), "space: up-serve\n", { mode: 0o600 });
  const manifest = await cli("manifest", ["up", "-f", "cotal.yaml", "--serve", "artifacts"], 30_000);
  check("--serve with -f is refused, since a manifest launch does not take it",
    manifest.code !== 0 && /--serve cannot be combined with --file/.test(manifest.err) && findMesh(space) === undefined, manifest.err);

  // ---- the shipped start: daemon launched with --serve, endpoint registered and bound ----
  const up = await cli("up", ["up", "--detach", "--server", server, "--space", space, "--no-manager", "--serve", "artifacts"], 180_000);
  started = true;
  check("cotal up --serve artifacts succeeds and says the daemon bound it", up.code === 0 && /artifacts: registered, bound by the delivery daemon at epoch \d+, ready/.test(up.err), up.err);
  const first = await serveState();
  check("the daemon reports artifacts bound", first.bound === true && typeof first.state?.epoch === "number", first);
  const pid1 = daemonPid()!;
  check("the daemon process was launched with --serve artifacts", /--serve artifacts/.test(daemonArgv(pid1)), daemonArgv(pid1));
  check("the mesh record keeps the decision", JSON.stringify(findMesh(space)?.serve) === JSON.stringify(["artifacts"]), findMesh(space));

  // ---- a relaunch without the flag keeps serving ----
  process.kill(pid1, "SIGKILL");
  for (let i = 0; i < 100 && alive(pid1); i++) await wait(50);
  const again = await cli("refresh", ["up", "--detach", "--server", server, "--space", space, "--no-manager"], 180_000);
  const pid2 = daemonPid()!;
  check("a bare cotal up after the daemon died starts a new one with --serve artifacts, from the record",
    again.code === 0 && pid2 !== pid1 && alive(pid2) && /--serve artifacts/.test(daemonArgv(pid2)), { err: again.err, argv: daemonArgv(pid2) });
  const second = await serveState();
  check("the new daemon re-registers artifacts as a takeover and binds it at a later epoch",
    second.bound === true && second.state!.epoch > first.state!.epoch && second.state!.instanceId === first.state!.instanceId, { first, second });
  check("the record still keeps the decision after the bare up", JSON.stringify(findMesh(space)?.serve) === JSON.stringify(["artifacts"]), findMesh(space));
  assertSmokeSandboxDown(sandbox, ["down", "--yes"], { cwd: mesh, env });
  logs.downLegacy = await foregroundCliProbe(cliEntry, tsx, mesh, env, ["down", "--yes"], 60_000);
  started = false;

  // ---- the controller-owned route: a prepared root starts as exact controller members ----
  const prepared = await foregroundCliProbe(cliEntry, tsx, ctlRoot, env, ["space", "create", ctlSpace, "--root", ctlRoot], 60_000);
  logs.prepared = prepared;
  assert.equal(prepared.code, 0, prepared.err);
  const ctlUp = logs.ctlUp = await foregroundCliProbe(cliEntry, tsx, ctlRoot, env, ["up", "--detach", "--no-manager", "--server", ctlServer, "--space", ctlSpace, "--serve", "artifacts"], 180_000);
  ctlStarted = true;
  const ctlState = await serveState(ctlRoot, ctlSpace, ctlServer);
  check("on a controller-owned root, cotal up --serve artifacts starts the delivery member serving it, bound before up returns",
    ctlUp.code === 0 && existsSync(join(ctlRoot, ".cotal", "stack-controller.json")) && ctlState.bound === true, { err: ctlUp.err, ctlState });
  const deliveryDefinition = await foregroundCliProbe(cliEntry, tsx, ctlRoot, env, ["service", "show", "stack-delivery", "--space", ctlSpace, "--json"], 30_000);
  const ctlPid = parsePid(readFileSync(canonicalLocalProcessPath(DELIVERY_PIDFILE, { root: ctlRoot, space: ctlSpace }), "utf8"));
  // `service show` reports options by count, never by value; the running member's argv is the evidence.
  check("the delivery member's saved definition carries the decision, and its process runs with --serve artifacts",
    deliveryDefinition.code === 0 && /"optionCount":4/.test(deliveryDefinition.out) && ctlPid !== undefined && /__service-delivery .*--serve artifacts/.test(daemonArgv(ctlPid)),
    { show: deliveryDefinition.out.slice(0, 800), argv: ctlPid === undefined ? "(no pid)" : daemonArgv(ctlPid) });
} finally {
  try {
    if (started) {
      assertSmokeSandboxDown(sandbox, ["down", "--yes"], { cwd: mesh, env });
      logs.down = await foregroundCliProbe(cliEntry, tsx, mesh, env, ["down", "--yes"], 60_000);
    }
    if (ctlStarted) {
      assertSmokeSandboxDown(ctlSandbox, ["down", "--yes"], { cwd: ctlRoot, env });
      logs.ctlDown = await foregroundCliProbe(cliEntry, tsx, ctlRoot, env, ["down", "--yes"], 60_000);
    }
  } finally {
    for (const [name, log] of Object.entries(logs)) writeFileSync(join(base, `${name}.json`), JSON.stringify(log), { mode: 0o600 });
  }
}
if (passed !== EXPECTED) throw new Error(`expected ${EXPECTED} cells, ran ${passed}`);
console.log(`up-serve: ${passed} passed, 0 failed`);
emitSentinel({ cells: passed, passed, failed: 0 });
