/**
 * LIVE: an explicit `cotal up --space` refresh selects that same space's registry entry when one
 * broker has records for more than one space. Registry filenames are sorted, so the other record can
 * otherwise be considered first and make a valid same-root refresh look foreign.
 *
 * The fixture drives the shipped binary against its own isolated broker with a supported
 * multi-space account root. It runs both filename orders, then verifies that an absent requested
 * space and a record rooted elsewhere still refuse.
 *
 * Also carries the #1697 `--host` shape refusals (broker-free, first section): a URL typed into
 * `--host` used to be bracketed into `nats://[nats://…]:4222` and either misfired as an unrelated
 * registry refusal or died as a raw `Invalid URL` on the `--server` mismatch parse. A URL, and a
 * `host:port` spelling, are refused by name pointing at `--server`, and a correct bare host still
 * reaches the registry's own refusal.
 * Run: pnpm smoke:up-refresh-identity:live
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { assertEphemeralBroker, scrubAmbientBrokerEnv } from "../../../packages/core/smoke/_ephemeral-only.js";
import { pickFreePort } from "../../../packages/core/smoke/_free-port.js";
import { assertScratchHeld, makeScratch } from "../../../bin/smoke/_scratch.js";
import { assertSmokeSandboxDown, recordSmokeSandbox, type SmokeSandboxAnchor } from "@cotal-ai/smoke-kit";

scrubAmbientBrokerEnv();
const scratch = makeScratch("cotal-up-refresh-identity-");
const TSX = join(import.meta.dirname, "..", "..", "..", "node_modules", ".bin", "tsx");
const CLI = join(import.meta.dirname, "..", "..", "..", "bin", "cotal.ts");
const rootEnv = { ...process.env };
for (const key of Object.keys(rootEnv)) if (key.startsWith("COTAL_")) delete rootEnv[key];

let passed = 0;
const EXPECTED_CHECKS = 29 + 13 + 5 + 13; // storeRecordRepair + preFieldWarning + foregroundCrashKeepsRecord
const check = (name: string, ok: boolean, detail?: unknown): void => {
  if (!ok) throw new Error(`FAIL: ${name}${detail === undefined ? "" : `\n${JSON.stringify(detail, null, 2)}`}`);
  passed++;
  console.log(`  ✓ ${name}`);
};

type Fixture = {
  home: string;
  root: string;
  server: string;
  env: NodeJS.ProcessEnv;
  sandbox: SmokeSandboxAnchor;
};

async function makeFixture(label: string): Promise<Fixture> {
  const home = mkdtempSync(join(scratch, `${label}-home-`));
  const root = mkdtempSync(join(scratch, `${label}-root-`));
  const xdg = join(home, "xdg");
  const sandbox = recordSmokeSandbox({ root, cotalHome: home, xdgConfigHome: xdg });
  assertScratchHeld(root, `${label} refresh fixture`);
  const server = `nats://127.0.0.1:${await pickFreePort()}`;
  assertEphemeralBroker(server);
  process.env.HOME = home;
  process.env.COTAL_HOME = home;
  process.env.XDG_CONFIG_HOME = xdg;
  return {
    home,
    root,
    server,
    env: { ...rootEnv, HOME: home, COTAL_HOME: home, XDG_CONFIG_HOME: xdg, COTAL_SKIP_CONNECTOR_SEED: "1" },
    sandbox,
  };
}

function cotal(fixture: Fixture, args: string[]) {
  const options = { cwd: fixture.root, env: fixture.env, encoding: "utf8" as const, timeout: 120_000 };
  assertSmokeSandboxDown(fixture.sandbox, args, options);
  return spawnSync(TSX, [CLI, ...args], options);
}

async function stop(fixture: Fixture): Promise<boolean> {
  const down = cotal(fixture, ["down", "manager", "nats"]);
  const stopped = down.status === 0 && !down.error && !down.signal;
  check("the isolated mesh stops cleanly", stopped, {
    status: down.status,
    signal: down.signal,
    error: down.error?.message,
    output: `${down.stdout}${down.stderr}`.slice(-1000),
  });
  return stopped;
}

async function orderedRefresh(rootSpace: string, tenantSpace: string, expectedOrder: string[]): Promise<void> {
  const fixture = await makeFixture(rootSpace);
  process.env.COTAL_HOME = fixture.home;
  process.env.XDG_CONFIG_HOME = fixture.env.XDG_CONFIG_HOME;
  const { createBrokerAuth, createSpaceAccountAuth } = await import("@cotal-ai/core");
  const { authDir, findMesh, loadMeshes, recordMesh, removeMesh, saveBrokerAuth, saveSpaceAccountAuth, spaceAccountPath } = await import("@cotal-ai/workspace");
  const broker = await createBrokerAuth(`refresh-${rootSpace}`);
  saveBrokerAuth(authDir(fixture.root), broker);
  saveSpaceAccountAuth(authDir(fixture.root), await createSpaceAccountAuth(broker, rootSpace));
  saveSpaceAccountAuth(authDir(fixture.root), await createSpaceAccountAuth(broker, tenantSpace));
  const removeTenantAccount = () => rmSync(spaceAccountPath(authDir(fixture.root), tenantSpace), { force: true });
  let started = false;
  try {
    const first = cotal(fixture, ["up", "--detach", "--open", "--server", fixture.server, "--space", rootSpace]);
    started = first.status === 0;
    check(`fixture mesh ${rootSpace} starts`, started, `${first.stdout}${first.stderr}`);
    if (!started) return;

    const rootEntry = findMesh(rootSpace);
    check("the started mesh is recorded under its requested root and server", rootEntry?.root === fixture.root && rootEntry.server === fixture.server, rootEntry);
    const tenantEntry = { space: tenantSpace, server: fixture.server, root: fixture.root, mode: "open" as const, ts: new Date(0).toISOString() };
    recordMesh(tenantEntry);
    const sameServer = loadMeshes().filter((entry) => entry.server === fixture.server);
    check(`fixture registry order is ${expectedOrder.join(", ")}`, sameServer.map((entry) => entry.space).join(",") === expectedOrder.join(","), sameServer);

    const refresh = cotal(fixture, ["up", "--detach", "--open", "--server", fixture.server, "--space", rootSpace]);
    const refreshOutput = `${refresh.stdout}${refresh.stderr}`;
    check(`explicit refresh selects ${rootSpace} even with same-server records`, refresh.status === 0 && new RegExp(`mesh "${rootSpace}" already running`).test(refreshOutput), refreshOutput);
    check("the unrelated same-server record remains unchanged by the refresh", JSON.stringify(findMesh(tenantSpace)) === JSON.stringify(tenantEntry), findMesh(tenantSpace));

    const absent = cotal(fixture, ["up", "--detach", "--open", "--server", fixture.server, "--space", "absent-space"]);
    check("an absent explicit space refuses rather than selecting a same-server record", absent.status !== 0 && !/already running/.test(`${absent.stdout}${absent.stderr}`), `${absent.stdout}${absent.stderr}`);
    check("the absent-space refusal leaves both existing records in place", [rootSpace, tenantSpace].every((space) => findMesh(space) !== undefined), loadMeshes());

    removeMesh(tenantSpace);
    removeTenantAccount();
    started = !(await stop(fixture));
  } finally {
    if (started) {
      try { removeMesh(tenantSpace); } catch { /* fixture cleanup keeps the primary failure */ }
      removeTenantAccount();
      await stop(fixture);
    }
    rmSync(fixture.home, { recursive: true, force: true });
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

async function foreignRootRefusal(): Promise<void> {
  const fixture = await makeFixture("foreign");
  process.env.COTAL_HOME = fixture.home;
  process.env.XDG_CONFIG_HOME = fixture.env.XDG_CONFIG_HOME;
  const foreignRoot = mkdtempSync(join(scratch, "foreign-record-root-"));
  const { findMesh, recordMesh, removeMesh } = await import("@cotal-ai/workspace");
  const localSpace = "local-space";
  const foreignSpace = "foreign-space";
  let started = false;
  try {
    const first = cotal(fixture, ["up", "--detach", "--open", "--server", fixture.server, "--space", localSpace]);
    started = first.status === 0;
    check("foreign-root fixture mesh starts", started, `${first.stdout}${first.stderr}`);
    if (!started) return;

    const foreignEntry = { space: foreignSpace, server: fixture.server, root: foreignRoot, mode: "open" as const, ts: new Date(0).toISOString() };
    recordMesh(foreignEntry);
    const refresh = cotal(fixture, ["up", "--detach", "--server", fixture.server, "--space", foreignSpace]);
    check("an explicit record rooted elsewhere refuses", refresh.status !== 0 && !/already running/.test(`${refresh.stdout}${refresh.stderr}`), `${refresh.stdout}${refresh.stderr}`);
    check("the foreign-root refusal does not rewrite that record", JSON.stringify(findMesh(foreignSpace)) === JSON.stringify(foreignEntry), findMesh(foreignSpace));

    removeMesh(foreignSpace);
    started = !(await stop(fixture));
  } finally {
    if (started) {
      try { removeMesh(foreignSpace); } catch { /* fixture cleanup keeps the primary failure */ }
      await stop(fixture);
    }
    rmSync(fixture.home, { recursive: true, force: true });
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(foreignRoot, { recursive: true, force: true });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** #2218/#1014 gap 3 — a repair `up` on a same-root record whose broker died reopens the store
 *  the record names, refuses a disagreeing explicit `--store-dir`, and a pre-field record (no
 *  `storeDir`) warns instead of refusing. Each cell kills the live broker with SIGKILL (a crash,
 *  not a `down`) so the record is the M3 "stays recorded" kind, then drives a repair `up` through
 *  the shipped binary. */
async function storeRecordRepair(): Promise<void> {
  const fixture = await makeFixture("store-repair");
  process.env.COTAL_HOME = fixture.home;
  process.env.XDG_CONFIG_HOME = fixture.env.XDG_CONFIG_HOME;
  const { findMesh } = await import("@cotal-ai/workspace");
  const space = "store-repair";
  const storeA = join(fixture.root, "store-a");
  const other = join(fixture.root, "other");
  let started = false;
  try {
    const up1 = cotal(fixture, ["up", "--detach", "--open", "--server", fixture.server, "--space", space, "--store-dir", storeA]);
    started = up1.status === 0;
    check("(1) a fresh --store-dir start succeeds", started, `${up1.stdout}${up1.stderr}`);
    if (!started) return;
    check("(1) the record carries the resolved --store-dir", findMesh(space)?.storeDir === resolve(storeA), findMesh(space));

    let railsUp = false;
    for (let i = 0; i < 6 && !railsUp; i++) {
      const set = cotal(fixture, ["channels", "set", "probe", "--desc", "p", "--server", fixture.server, "--space", space]);
      if (set.status === 0) railsUp = true;
      else await sleep(5_000);
    }
    check("(2) the manager answers channels set within the poll budget", railsUp);

    const pidPath = join(fixture.root, ".cotal", "nats.pid");
    const pid = Number(readFileSync(pidPath, "utf8").trim());
    process.kill(pid, "SIGKILL");
    let unreachable = false;
    for (let i = 0; i < 20 && !unreachable; i++) {
      const st = cotal(fixture, ["status", "--server", fixture.server, "--space", space]);
      if (/unreachable/.test(`${st.stdout}${st.stderr}`)) unreachable = true;
      else await sleep(1_000);
    }
    check("(3) status observes the killed broker unreachable within the poll budget", unreachable);

    const repair = cotal(fixture, ["up", "--detach", "--open", "--server", fixture.server, "--space", space]);
    check("(4) the bare repair exits 0", repair.status === 0, `${repair.stdout}${repair.stderr}`);
    check("(4) the repair output names reopening the recorded store", /reopening the recorded store/.test(`${repair.stdout}${repair.stderr}`), `${repair.stdout}${repair.stderr}`);
    const log = readFileSync(join(fixture.root, ".cotal", "nats.log"), "utf8");
    const lastStoreLine = log.split("\n").filter((l) => l.includes("Store Directory:")).pop() ?? "";
    check("(4) the log's last Store Directory: line names store-a/jetstream", lastStoreLine.includes(join("store-a", "jetstream")), lastStoreLine);
    const list = cotal(fixture, ["channels", "list", "--server", fixture.server, "--space", space]);
    check("(4) channels list still shows the pre-crash channel", /#probe/.test(`${list.stdout}${list.stderr}`), `${list.stdout}${list.stderr}`);

    const pid2 = Number(readFileSync(pidPath, "utf8").trim());
    process.kill(pid2, "SIGKILL");
    await sleep(1_000);
    const refused = cotal(fixture, ["up", "--detach", "--open", "--server", fixture.server, "--space", space, "--store-dir", other]);
    check("(5) a disagreeing --store-dir repair refuses", refused.status !== 0, `${refused.stdout}${refused.stderr}`);
    check("(5) the refusal names store-a and --store-dir", `${refused.stdout}${refused.stderr}`.includes("store-a") && `${refused.stdout}${refused.stderr}`.includes("--store-dir"), `${refused.stdout}${refused.stderr}`);
    let pidStillDead = true;
    try {
      const nowPid = readFileSync(pidPath, "utf8").trim();
      if (nowPid !== "" && Number(nowPid) !== pid2) pidStillDead = false;
    } catch { /* absent is fine */ }
    check("(5) no new broker started (pidfile still names the dead pid or is absent)", pidStillDead);
    check("(5) the record's storeDir is unchanged", findMesh(space)?.storeDir === resolve(storeA), findMesh(space));

    const same = cotal(fixture, ["up", "--detach", "--open", "--server", fixture.server, "--space", space, "--store-dir", storeA]);
    check("(6) repairing with the SAME --store-dir starts", same.status === 0, `${same.stdout}${same.stderr}`);

    started = !(await stop(fixture));
  } finally {
    if (started) await stop(fixture);
    rmSync(fixture.home, { recursive: true, force: true });
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

/** A pre-field record (`storeDir` absent, written before the field existed) warns rather than
 *  refuses on repair, and opens the root's default store. */
async function preFieldWarning(): Promise<void> {
  const fixture = await makeFixture("pre-field");
  process.env.COTAL_HOME = fixture.home;
  process.env.XDG_CONFIG_HOME = fixture.env.XDG_CONFIG_HOME;
  const { findMesh, recordMesh } = await import("@cotal-ai/workspace");
  const space = "pre-field";
  // A custom --store-dir keeps the root's DEFAULT store virgin, so the pre-field repair below is
  // exercising the real gap: the record loses its storeDir field (simulating a record written
  // before the field existed) while the broker actually used a non-default store the whole time.
  const preFieldStore = join(fixture.root, "pre-field-store");
  let started = false;
  try {
    const up1 = cotal(fixture, ["up", "--detach", "--open", "--server", fixture.server, "--space", space, "--store-dir", preFieldStore]);
    started = up1.status === 0;
    check("pre-field fixture starts", started, `${up1.stdout}${up1.stderr}`);
    if (!started) return;

    const pidPath = join(fixture.root, ".cotal", "nats.pid");
    const pid = Number(readFileSync(pidPath, "utf8").trim());
    process.kill(pid, "SIGKILL");
    await sleep(1_000);

    const held = findMesh(space);
    if (!held) throw new Error("FAIL: pre-field record missing before rewrite");
    const { storeDir: _drop, ...withoutStoreDir } = held;
    recordMesh(withoutStoreDir);

    const repair = cotal(fixture, ["up", "--detach", "--open", "--server", fixture.server, "--space", space]);
    check("a pre-field repair exits 0", repair.status === 0, `${repair.stdout}${repair.stderr}`);
    check("...and warns it was recorded before the store directory was kept", /recorded before the store directory was kept/.test(`${repair.stdout}${repair.stderr}`), `${repair.stdout}${repair.stderr}`);
    check("...naming .cotal/nats.log", `${repair.stdout}${repair.stderr}`.includes(join(".cotal", "nats.log")), `${repair.stdout}${repair.stderr}`);
    const log = readFileSync(join(fixture.root, ".cotal", "nats.log"), "utf8");
    const lastStoreLine = log.split("\n").filter((l) => l.includes("Store Directory:")).pop() ?? "";
    check("...and the log's last Store Directory: line names the default store", lastStoreLine.includes(join(".cotal", "nats", "jetstream")), lastStoreLine);

    started = !(await stop(fixture));
  } finally {
    if (started) await stop(fixture);
    rmSync(fixture.home, { recursive: true, force: true });
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

/** #2218 M3 — a foreground `up` whose broker exits unexpectedly (killed, not stopped) keeps the
 *  mesh record and exits non-zero; the control is the same foreground `up` ended with SIGINT
 *  (the intended stop), which exits 0 and drops the record. */
async function foregroundCrashKeepsRecord(): Promise<void> {
  const fixture = await makeFixture("fg-crash");
  process.env.COTAL_HOME = fixture.home;
  process.env.XDG_CONFIG_HOME = fixture.env.XDG_CONFIG_HOME;
  const { findMesh } = await import("@cotal-ai/workspace");
  const space = "fg-crash";
  const child = spawn(TSX, [CLI, "up", "--open", "--server", fixture.server, "--space", space], { cwd: fixture.root, env: fixture.env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (c) => { stdout += c; });
  child.stderr?.on("data", (c) => { stderr += c; });
  try {
    let railsUp = false;
    for (let i = 0; i < 60 && !railsUp; i++) {
      const set = cotal(fixture, ["channels", "set", "probe", "--desc", "p", "--server", fixture.server, "--space", space]);
      if (set.status === 0) railsUp = true;
      else await sleep(1_000);
    }
    check("the foreground fixture answers channels set within the poll budget", railsUp);

    const pidPath = join(fixture.root, ".cotal", "nats.pid");
    const pid = Number(readFileSync(pidPath, "utf8").trim());
    process.kill(pid, "SIGKILL");
    const exitCode = await new Promise<number | null>((res) => {
      const timer = setTimeout(() => res(null), 20_000); // a mutation that drops the exit call must not hang the suite
      child.once("exit", (code) => { clearTimeout(timer); res(code); });
    });
    check("the record survives the crash", findMesh(space) !== undefined, findMesh(space));
    check("a killed broker makes the foreground `up` exit 1, the crash arm's code, not Node's unsettled-await 13", exitCode === 1, { exitCode, stdout, stderr });
    check("...stderr names 'exited unexpectedly'", /exited unexpectedly/.test(stderr), stderr);
    check("...and 'stays recorded'", /stays recorded/.test(stderr), stderr);
    check("...and the repair command naming this space", stderr.includes(`cotal up --server ${fixture.server} --space ${space}`), stderr);
    const meshes = cotal(fixture, ["meshes"]);
    check("`cotal meshes` tags the crashed mesh offline", new RegExp(`${space}[^\n]*offline`).test(`${meshes.stdout}`), meshes.stdout);

    // Not the shared `stop()` helper: a crashed broker leaves no pidfile of its own for `down` to
    // find, so `cotal down` here reports "Nothing running" and exits non-zero even though its
    // registry sweep (which runs unconditionally on a bare down, ahead of that exit) still clears
    // the crash-kept record — the real, documented effect this cell checks.
    cotal(fixture, ["down", "manager", "nats"]);
    check("`stop` (down) also removes the kept record", findMesh(space) === undefined, findMesh(space));
  } finally {
    if (child.exitCode === null) { try { child.kill("SIGKILL"); } catch { /* already gone */ } }
  }

  // CONTROL: the same foreground `up`, ended with SIGINT (the intended stop) instead of SIGKILL,
  // exits 0 and drops the record — proving the crash branch above is the ONLY one that keeps it.
  const control = spawn(TSX, [CLI, "up", "--open", "--server", fixture.server, "--space", space], { cwd: fixture.root, env: fixture.env, stdio: ["ignore", "pipe", "pipe"] });
  try {
    let railsUp = false;
    for (let i = 0; i < 60 && !railsUp; i++) {
      const set = cotal(fixture, ["channels", "set", "probe", "--desc", "p", "--server", fixture.server, "--space", space]);
      if (set.status === 0) railsUp = true;
      else await sleep(1_000);
    }
    check("(control) the second foreground fixture answers channels set within the poll budget", railsUp);
    control.kill("SIGINT");
    const controlExit = await new Promise<number | null>((res) => control.once("exit", (code) => res(code)));
    check("(control) SIGINT (intended stop) exits 0", controlExit === 0, controlExit);
    check("(control) SIGINT drops the record", findMesh(space) === undefined, findMesh(space));
  } finally {
    if (control.exitCode === null) { try { control.kill("SIGKILL"); } catch { /* already gone */ } }
    rmSync(fixture.home, { recursive: true, force: true });
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

/** #1697 — `--host` takes a bind HOST, not a URL and not a host:port. Both refusals used to be
 *  reachable only past the IPv6 bracketing: a URL was wrapped into `nats://[nats://…]:4222`, which
 *  nothing validated — with no `--server` the garbage string reached the registry comparison and
 *  misfired as an unrelated refusal, and with one the mismatch parse threw a raw `Invalid URL`
 *  instead of printing its own diagnostic. These cells run against the shipped binary with NO
 *  broker: both refusals happen before one is launched, so the section is cheap and deterministic.
 *  A correct bare host is the control: it passes the shape guard and reaches the registry's own
 *  (correct, for this fixture) manual-record refusal — proving the guard refuses only the shapes it
 *  names and lets the ordinary path run. */
async function hostShapeRefusals(): Promise<void> {
  const fixture = await makeFixture("host-shape");
  // A manual record for the space, exactly like an operator's `cotal meshes add`: the state whose
  // MISFIRE the URL spelling used to produce (the garbage derived server disagreed with the record,
  // and the operator was told to de-register a live mesh for a reason unrelated to what they typed).
  // The record's root is a FOREIGN directory on purpose: rooted at the invocation's own cwd the
  // claim would look like a same-root refresh and `up` would boot a broker (this section otherwise
  // starts none); foreign + manual is the refusal state the fixture exists to hold.
  const recordRoot = mkdtempSync(join(scratch, "host-shape-record-root-"));
  const { recordMesh, removeMesh } = await import("@cotal-ai/workspace");
  const entry = { space: "host-shape", server: "nats://127.0.0.1:4222", root: recordRoot, mode: "open" as const, origin: "manual" as const, ts: new Date(0).toISOString() };
  recordMesh(entry);
  const out = (r: { stdout: string; stderr: string }) => `${r.stdout}${r.stderr}`;
  try {
    // The URL, no --server: refused BY NAME at the flag, never bracketed into a server string.
    const urlOnly = cotal(fixture, ["up", "--space", "host-shape", "--host", "nats://127.0.0.1:4222"]);
    check("a URL passed to --host is refused", urlOnly.status !== 0, out(urlOnly));
    check("...naming --host and pointing at --server", /--host nats:\/\/127\.0\.0\.1:4222 looks like a URL/.test(out(urlOnly)) && /--server/.test(out(urlOnly)), out(urlOnly));
    check("...not as a raw parse error", !/Invalid URL/.test(out(urlOnly)), out(urlOnly));
    check("...and not as the manual-record registry refusal it used to misfire as", !/registered by hand/.test(out(urlOnly)), out(urlOnly));

    // The same URL WITH a --server: the shape refusal still wins, and the mismatch path prints its
    // own diagnostic rather than throwing `TypeError: Invalid URL` out of the comparison.
    const urlWithServer = cotal(fixture, ["up", "--space", "host-shape", "--host", "nats://127.0.0.1:4222", "--server", "nats://127.0.0.1:4222"]);
    check("a URL passed to --host is refused even alongside --server", urlWithServer.status !== 0 && /looks like a URL/.test(out(urlWithServer)), out(urlWithServer));
    check("...never a raw Invalid URL from the mismatch parse", !/Invalid URL/.test(out(urlWithServer)), out(urlWithServer));

    // host:port: a port belongs to --server; refused as a malformed bind host, not bracketed into a
    // server that silently binds the wrong address.
    const hostPort = cotal(fixture, ["up", "--space", "host-shape", "--host", "127.0.0.1:4222"]);
    check("a host:port spelling is refused as a bind host", hostPort.status !== 0 && /is not a valid bind host/.test(out(hostPort)) && /the port comes from --server/.test(out(hostPort)), out(hostPort));

    // The real mismatch diagnostic still prints for valid hosts that disagree (and exits, not throws).
    const mismatch = cotal(fixture, ["up", "--space", "host-shape", "--host", "10.0.0.9", "--server", "nats://127.0.0.1:4222"]);
    check("a --host/--server address mismatch still prints its own diagnostic", mismatch.status !== 0 && /name different addresses/.test(out(mismatch)), out(mismatch));

    // CONTROL: a correct bare host passes the shape guard and reaches the registry's own refusal
    // (correct for this fixture: the space IS manually registered). The guard must not widen.
    const bare = cotal(fixture, ["up", "--space", "host-shape", "--host", "127.0.0.1"]);
    check("a correct bare host still reaches the registry refusal (control)", bare.status !== 0 && /registered by hand/.test(out(bare)), out(bare));
  } finally {
    try { removeMesh("host-shape"); } catch { /* fixture cleanup keeps the primary failure */ }
    rmSync(fixture.home, { recursive: true, force: true });
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(recordRoot, { recursive: true, force: true });
  }
}

try {
  await hostShapeRefusals();
  await orderedRefresh("alpha-root", "omega-tenant", ["alpha-root", "omega-tenant"]);
  await orderedRefresh("omega-root", "alpha-tenant", ["alpha-tenant", "omega-root"]);
  await foreignRootRefusal();
  await storeRecordRepair();
  await preFieldWarning();
  await foregroundCrashKeepsRecord();
  if (passed !== EXPECTED_CHECKS)
    throw new Error(`FAIL: expected ${EXPECTED_CHECKS} checks, ran ${passed}`);
  console.log(`\nUP REFRESH IDENTITY LIVE SMOKE OK ✅ (${passed} checks passed)`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
