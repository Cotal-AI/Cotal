/**
 * LIVE: an explicit `cotal up --space` refresh selects that same space's registry entry when one
 * broker has records for more than one space. Registry filenames are sorted, so the other record can
 * otherwise be considered first and make a valid same-root refresh look foreign.
 *
 * The fixture drives the shipped binary against its own isolated broker with a supported
 * multi-space account root. It runs both filename orders, then verifies that an absent requested
 * space and a record rooted elsewhere still refuse.
 * Run: pnpm smoke:up-refresh-identity:live
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
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
const EXPECTED_CHECKS = 20;
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

try {
  await orderedRefresh("alpha-root", "omega-tenant", ["alpha-root", "omega-tenant"]);
  await orderedRefresh("omega-root", "alpha-tenant", ["alpha-tenant", "omega-root"]);
  await foreignRootRefusal();
  if (passed !== EXPECTED_CHECKS)
    throw new Error(`FAIL: expected ${EXPECTED_CHECKS} checks, ran ${passed}`);
  console.log(`\nUP REFRESH IDENTITY LIVE SMOKE OK ✅ (${passed} checks passed)`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
