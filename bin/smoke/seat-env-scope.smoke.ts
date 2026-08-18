/**
 * Seat-environment scope smoke — the cell for Cotal #396 / #424.
 *
 * WHAT WENT WRONG. Every connector used to build the seat's environment with `COTAL_CREDS`,
 * `COTAL_SERVERS` and `COTAL_CONTROL_TOKEN` in it. A process environment is inherited transitively,
 * so the seat handed all three to every build, linter, test suite and third-party CLI it ever
 * shelled out to. Reproduced live on a sandbox mesh before the fix: an ordinary `node` process run
 * by a seat's shell tool inherited the set, read the creds file, and opened an authenticated broker
 * connection AS THE SEAT, having done no credential handling of any kind.
 *
 * WHAT THIS ASSERTS, and why both halves are here. An absence assertion on its own passes on a
 * completely broken seat: a connector that exports nothing would sail through "no credential in the
 * environment" while being unable to connect to anything. So the cell asserts the absence AND the
 * working path, and it asserts the absence in a REAL descendant process rather than in a map the
 * suite built for itself.
 *
 *   A1  no production connector puts connection material in the seat environment
 *   A2  a real grandchild of a seat process inherits none of it
 *   A3  the seat's own launch still resolves its identity: servers, creds and the control token
 *       round-trip through the material file
 *   A4  a material file readable beyond its owner is refused, not read
 *
 * A2 is the one that could not have been faked by reading the same object the assertion was written
 * against: the seat is a real `node` process started with the connector's env, and the observer is a
 * real child of THAT, so what it reports is what the operating system actually inherited.
 *
 * WHAT THIS SUITE DOES NOT PROVE, stated here rather than left for a reader to discover:
 *
 *  - A2's seat is a bare `node` process, NOT a real pi session, so it never runs the connector's
 *    own scrub. A2 therefore proves that the VALUES are not inherited. It says nothing about whether
 *    a connector that drops the material POINTER actually drops it; that happens inside a live
 *    harness and is evidenced by a live spawn, not here.
 *  - A3 skips the control token for hermes, because that connector mints its control endpoint inside
 *    its own launcher and `buildLaunch` returns none to skip. Hermes' control path, including its
 *    PYTHON lifecycle hooks, is covered by `pnpm smoke:hermes-hooks-control` instead. That gap is
 *    not theoretical: it is exactly where a real defect lived until a reviewer read the Python.
 *
 * Run: `pnpm smoke:seat-env-scope`
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LAUNCH_MATERIAL_ENV, readLaunchMaterial, registry, type Connector, type LaunchOpts } from "@cotal-ai/core";
import { configFromEnv, controlFromEnv, scrubLaunchMaterial } from "@cotal-ai/connector-core";
import "@cotal-ai/connector-claude-code";
import "@cotal-ai/connector-opencode";
import "@cotal-ai/connector-codex";
import "@cotal-ai/connector-hermes";
import "@cotal-ai/pi";

/** The variables that carry material a descendant has no business holding. `COTAL_CONTROL_SOCKET` is
 *  deliberately NOT here: it is a path, the socket refuses an unauthenticated frame, and the
 *  short-lived hook processes need it. The failure was never that a descendant learned a path. */
const FORBIDDEN = [
  "COTAL_CREDS",
  "COTAL_SERVERS",
  "COTAL_TOKEN",
  "COTAL_CONTROL_TOKEN",
  "COTAL_OWNER",
  "COTAL_ACTOR",
  "COTAL_SENTINEL_CREDS",
  "COTAL_BEARER_CMD",
] as const;

const SERVERS = "nats://127.0.0.1:14999"; // never dialled by this suite; it is a config input, not traffic
const work = mkdtempSync(join(tmpdir(), "cotal-seat-env-scope-"));
const credsPath = join(work, "agent.creds");
writeFileSync(credsPath, "-----BEGIN NATS USER JWT-----\nnot-a-real-credential\n------END NATS USER JWT------\n");

const opts: LaunchOpts = {
  space: "scope",
  name: "seat-1",
  role: "worker",
  id: "AGENTIDPLACEHOLDER",
  lifecycleUid: "lc-0000000000",
  creds: credsPath,
  servers: SERVERS,
  subscribe: ["general"],
  allowSubscribe: ["general"],
  allowPublish: ["general"],
  workspaceRoot: work,
} as LaunchOpts;

/** Every connector a manager can put a human-facing seat on. Named rather than swept out of the
 *  registry: a sweep silently shrinks to zero if the imports above ever stop registering, and a
 *  zero-length loop is a green suite that checked nothing. */
const CONNECTORS = ["claude", "opencode", "codex", "hermes", "pi"] as const;

console.log(`• broker: ${SERVERS} (suite constant; this suite opens no connection to it)`);

// A2 — a REAL grandchild of a REAL seat process inherits none of it.
//
// The seat is started with the pi connector's env (any of them would do; pi is the one whose whole
// session runs in the seat process, so it is the tightest case). The seat spawns a child with no env
// argument at all, which is exactly what a coding agent's shell tool does, and that child reports
// what the operating system gave it.
const piSpec = registry.resolve<Connector>("connector", "pi").buildLaunch(opts);
const observer = `const found = Object.keys(process.env).filter((k) => ${JSON.stringify([...FORBIDDEN])}.includes(k)); console.log("GRANDCHILD " + JSON.stringify(found));`;
const seat = `require("node:child_process").execFileSync(process.execPath, ["-e", ${JSON.stringify(observer)}], { stdio: "inherit" });`;
const run = spawnSync(process.execPath, ["-e", seat], { env: piSpec.env, encoding: "utf8" });
assert.equal(run.status, 0, `A2: the seat process could not run a child (${run.stderr})`);
const line = run.stdout.split("\n").find((l) => l.startsWith("GRANDCHILD "));
assert.ok(line, `A2: the grandchild produced no report (stdout: ${JSON.stringify(run.stdout)})`);
const inherited = JSON.parse(line.slice("GRANDCHILD ".length)) as string[];
assert.deepEqual(
  inherited,
  [],
  `A2: a real grandchild of a seat inherited ${inherited.join(", ")} — the material is still ambient`,
);
console.log("✓ A2: a real grandchild of a real seat process inherited none of the connection material");

for (const name of CONNECTORS) {
  assert.ok(registry.has("connector", name), `connector "${name}" is registered`);
  const connector = registry.resolve<Connector>("connector", name);
  const spec = connector.buildLaunch(opts);
  const env = spec.env ?? {};

  // A1 — no production connector puts connection material in the seat environment.
  for (const key of FORBIDDEN)
    assert.equal(
      env[key],
      undefined,
      `A1: the ${name} connector exports ${key} into the seat environment, which every descendant of the seat inherits`,
    );

  // A3 — and it still hands the session everything it needs, through the material file.
  const materialPath = env[LAUNCH_MATERIAL_ENV];
  assert.ok(materialPath, `A3: the ${name} connector wrote no launch material, so the session has no way to reach the broker`);
  const material = readLaunchMaterial(materialPath);
  assert.equal(material.servers, SERVERS, `A3: ${name} lost the broker URL`);
  assert.equal(material.creds, credsPath, `A3: ${name} lost the creds path`);
  const config = configFromEnv(env);
  assert.equal(config.servers, SERVERS, `A3: ${name} session parses a different broker than the launch named`);
  assert.equal(config.creds, readFileSync(credsPath, "utf8"), `A3: ${name} session cannot read its credential`);
  assert.equal(config.name, "seat-1", `A3: ${name} session lost its identity`);
  // The control token round-trips to the exact value buildLaunch handed the manager. The hermes
  // connector mints its control endpoint inside its own launcher, so its buildLaunch has none.
  if (spec.control) {
    assert.equal(
      controlFromEnv(env)?.token,
      spec.control.token,
      `A3: the ${name} session cannot recover the control token the manager holds, so its control plane is dead`,
    );
    assert.equal(controlFromEnv(env)?.path, spec.control.path, `A3: ${name} control socket path mismatch`);
  }
  console.log(`✓ ${name}: no material in the seat env; identity + control recovered from the material file`);
}

// A5 — dropping the pointer makes the control token unreachable, so every reader has to run first.
//
// This is here because the ordering it describes was got WRONG, and the suite did not catch it: the
// pi extension scrubbed the pointer immediately after parsing its config and then asked for the
// control token, which was by then gone. Every pi launch refused, loudly and correctly, and it took
// a live spawn to see it. The property is pinned here so the hazard is a named, tested fact rather
// than a comment somebody has to remember, and the contract keeps failing loud when it is violated.
{
  const env = { ...piSpec.env } as NodeJS.ProcessEnv;
  assert.ok(controlFromEnv(env)?.token, "A5: the control token is reachable before the pointer is dropped");
  scrubLaunchMaterial(env);
  assert.equal(controlFromEnv(env), undefined, "A5: the control token is unreachable after the pointer is dropped");
  assert.equal(env[LAUNCH_MATERIAL_ENV], undefined, "A5: the pointer itself is gone");
}
console.log("✓ A5: the launch material is unreachable once the pointer is dropped, so readers must run first");

// A4 — a material file other local users can read is refused, not read. Without this the carrier
// could be quietly weaker than the environment it replaced, and nothing would say so.
if (process.platform !== "win32") {
  const loose = piSpec.env?.[LAUNCH_MATERIAL_ENV] as string;
  chmodSync(loose, 0o644);
  assert.throws(
    () => readLaunchMaterial(loose),
    /readable beyond its owner/,
    "A4: a world-readable material file was read instead of refused",
  );
  chmodSync(loose, 0o600);
  console.log("✓ A4: a material file readable beyond its owner is refused");
} else {
  console.log("• A4 skipped: POSIX mode bits only (win32 privacy is the ACL hardenPrivate sets at write)");
}

console.log("\nseat-env-scope: PASS");
