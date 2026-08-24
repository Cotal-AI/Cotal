/**
 * Registered remote user-auth manager repro — a real `cotal supervise` process with the exact
 * participant shape: a manual `mode: "user"` registry entry produced by the same writer used by
 * `meshes add --from`, but no local `cotal up` marker. The manager must not require the host-only
 * marker from a participant.
 *
 * Stock 0.29.2 is intentionally RED: startup exits with the false reconciliation advice to run
 * `cotal down` then `cotal up`. PR-A flips this to the honest host-required refusal: a registered
 * participant may foreground-spawn, while detached/managed agents require the host.
 *
 * The fixture has a scratch COTAL_HOME and workspace root. It never reads or writes a real mesh.
 * Requires nats-server on PATH.
 *
 * Run: pnpm smoke:supervise-registered-user
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createSpaceAuth } from "@cotal-ai/core";
import { hasUserAuthState, userAuthStateDir } from "@cotal-ai/workspace";
import { persistRemoteUserEntry } from "../../cli/src/commands/meshes-add.js";
import { bootBroker } from "./_boot-broker.js";

const repo = resolve(import.meta.dirname, "..", "..", "..");
const cli = join(repo, "bin", "cotal.ts");
const tsx = join(repo, "node_modules", ".bin", "tsx");
const home = mkdtempSync(join(tmpdir(), "cotal-supervise-registered-home-"));
const workspaceRoot = mkdtempSync(join(tmpdir(), "cotal-supervise-registered-root-"));
const space = `registered-user-${Math.random().toString(36).slice(2, 10)}`;
const previousHome = process.env.COTAL_HOME;

let pass = 0;
let fail = 0;
const check = (name: string, condition: boolean, extra?: unknown): void => {
  if (condition) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ FAIL: ${name}`, extra ?? "");
  }
};

// Do not let an ambient COTAL connection identity turn this subprocess into a test of another
// mesh. PATH/XDG stay inherited so the local source tree and the caller's isolated config work.
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("COTAL_")) env[key] = value;
  }
  env.COTAL_HOME = home;
  env.COTAL_SKIP_CONNECTOR_SEED = "1";
  env.XDG_CONFIG_HOME = join(home, "xdg");
  return env;
}

/** The actual tsx CLI surface (not a built dist copy) with an explicit cwd and scratch registry. */
function supervise(args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(tsx, [cli, "supervise", ...args], {
    cwd: workspaceRoot,
    env: childEnv(),
    encoding: "utf8",
    timeout: 15_000,
  });
}

let broker: Awaited<ReturnType<typeof bootBroker>> | undefined;
try {
  process.env.COTAL_HOME = home;
  mkdirSync(join(workspaceRoot, ".cotal"), { recursive: true });
  broker = await bootBroker(await createSpaceAuth(space));

  // This is deliberately the production remote-entry writer: it lands a sentinel under the
  // participant root and records `manual/user/remote`, but writes none of the local-host provider
  // pin files (`idp.json` / `callout.json`) that make the host marker true.
  persistRemoteUserEntry(
    space,
    broker.servers,
    workspaceRoot,
    {
      space,
      server: broker.servers,
      tlsRequired: false,
      userAuth: {
        provider: "cotal",
        idp: { url: "https://idp.example.test", issuer: "https://idp.example.test", audience: "cotal" },
        endpoints: { url: "https://exchange.example.test" },
      },
      sentinelCreds: "-----BEGIN NATS USER JWT-----\nfixture\n------END NATS USER JWT------\n\n*****\nfixture\n*****\n",
    },
    false,
    false,
  );

  const stateDir = userAuthStateDir(workspaceRoot, space);
  check("remote registration wrote participant state only", existsSync(stateDir));
  check("registered participant has no local cotal-up user-auth marker", hasUserAuthState(workspaceRoot, space) === false);

  // This is the real public entry point. The short cap converts a regression that accidentally
  // starts a forever-running manager into a bounded red; the stock defect exits immediately.
  const result = supervise(["--space", space, "--server", broker.servers]);
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  console.log(`  raw supervise rc: ${result.status === null ? "null" : result.status}`);
  check("stock registered-not-hosting supervise refuses", result.status !== 0 && result.signal !== "SIGTERM", {
    status: result.status,
    signal: result.signal,
    output: output.slice(-1200),
  });
  check(
    "registered participant without login/authority refuses before manager start, never false down/up advice",
    /remote supervision .* was refused/i.test(output) &&
      /not logged in/i.test(output) &&
      /Foreground `cotal spawn` remains available/i.test(output) &&
      /detached\/managed agents require a live host-approved manager-service authority/i.test(output) &&
      !/`cotal down` and re-`cotal up`/.test(output),
    output.slice(-1200),
  );

  // Explicit server may only repeat the registry broker; a supervisor must not borrow remote
  // metadata from one mesh then dial another. This is a pre-network refusal, so the fake endpoint
  // need not answer.
  const mismatched = supervise(["--space", space, "--server", "nats://127.0.0.1:1"]);
  const mismatchOutput = `${mismatched.stdout ?? ""}${mismatched.stderr ?? ""}`;
  console.log(`  raw mismatch rc: ${mismatched.status === null ? "null" : mismatched.status}`);
  check(
    "explicit --server mismatch is named before remote-host refusal or dial",
    mismatched.status !== 0 && /does not match registered space/.test(mismatchOutput) && /refuses to use a different broker/.test(mismatchOutput),
    mismatchOutput.slice(-1200),
  );

  // No marker and no entry is neither a hosting failure nor a remote authority failure. It gets
  // the agreed two-path copy and does not mention a destructive down/up lifecycle.
  const absent = `${space}-absent`;
  const neither = supervise(["--space", absent, "--server", broker.servers]);
  const neitherOutput = `${neither.stdout ?? ""}${neither.stderr ?? ""}`;
  console.log(`  raw neither-path rc: ${neither.status === null ? "null" : neither.status}`);
  check(
    "neither hosting nor registered gets the exact host-or-join recovery",
    neither.status !== 0 &&
      neitherOutput.includes(`neither hosting '${absent}' (no cotal up root here) nor registered to it (no meshes entry)`) &&
      neitherOutput.includes("`cotal up` to host, or `cotal meshes add` to join"),
    neitherOutput.slice(-1200),
  );
} finally {
  await broker?.stop().catch(() => {});
  rmSync(home, { recursive: true, force: true });
  rmSync(workspaceRoot, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.COTAL_HOME;
  else process.env.COTAL_HOME = previousHome;
}

console.log(`\nSUPERVISE REGISTERED USER REPRO ${fail === 0 ? "RED OBSERVED ✅" : "FAILED"} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
