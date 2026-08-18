/**
 * Seat-environment scope smoke - the cell for Cotal #396 / #424.
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
 *   A5  dropping the pointer unlinks the file, and the half that is left refuses instead of working
 *   A6  a material file that says nothing is refused on READ, and a valid one still reads
 *   A7  a material file plus a direct carrier (COTAL_LINK here) is refused, never ranked silently
 *   A8  half a control pair throws in both directions, from the one place the pair is resolved
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
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

// A2 - a REAL grandchild of a REAL seat process inherits none of it.
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
  `A2: a real grandchild of a seat inherited ${inherited.join(", ")} - the material is still ambient`,
);
console.log("✓ A2: a real grandchild of a real seat process inherited none of the connection material");

for (const name of CONNECTORS) {
  assert.ok(registry.has("connector", name), `connector "${name}" is registered`);
  const connector = registry.resolve<Connector>("connector", name);
  const spec = connector.buildLaunch(opts);
  const env = spec.env ?? {};

  // A1 - no production connector puts connection material in the seat environment.
  for (const key of FORBIDDEN)
    assert.equal(
      env[key],
      undefined,
      `A1: the ${name} connector exports ${key} into the seat environment, which every descendant of the seat inherits`,
    );

  // A3 - and it still hands the session everything it needs, through the material file.
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

// A4 - a material file other local users can read is refused, not read. Without this the carrier
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

// A6 - a material file that says nothing is refused on READ, not just on write.
//
// The write-side refusal was the only one for a while, and it is in the wrong place to stand alone:
// the reader is handed a path by an environment variable, and a file that is empty, truncated or
// shaped wrong reaches it without ever passing through the writer. `{}` used to parse cleanly into a
// material with every field undefined, after which configFromEnv filled in its defaults - so a launch
// that REFERENCED material and got nothing usable resolved to the default broker with no credential.
// Open mode, silently, on a launch that asked for the opposite.
{
  const dir = mkdtempSync(join(tmpdir(), "cotal-material-shape-"));
  const write = (name: string, body: string): string => {
    const p = join(dir, name);
    writeFileSync(p, body, { mode: 0o600 });
    chmodSync(p, 0o600);
    return p;
  };
  assert.throws(
    () => readLaunchMaterial(write("empty.json", "{}")),
    /carries nothing this reader recognises/,
    "A6: an empty material object was read as a valid launch instead of refused",
  );
  assert.throws(
    () => readLaunchMaterial(write("unknown.json", JSON.stringify({ somethingElse: 1 }))),
    /carries nothing this reader recognises/,
    "A6: a material with no recognised field was accepted",
  );
  assert.throws(
    () => readLaunchMaterial(write("badservers.json", JSON.stringify({ servers: "" }))),
    /servers that is not a non-empty string/,
    "A6: an empty broker URL was accepted",
  );
  assert.throws(
    () => readLaunchMaterial(write("baduser.json", JSON.stringify({ userAuth: { owner: "o", actor: "a", sentinelCredsPath: "s", bearerCmd: [] } }))),
    /bearerCmd that is not a non-empty array/,
    "A6: a user-mode identity with no bearer command was accepted",
  );
  // And the working path still reads, or the four refusals above would be satisfied by a reader that
  // refuses everything.
  const ok = readLaunchMaterial(write("ok.json", JSON.stringify({ servers: SERVERS, creds: credsPath })));
  assert.equal(ok.servers, SERVERS, "A6: a valid material file no longer reads");
}
console.log("✓ A6: a material file that says nothing is refused on read, and a valid one still reads");

// A5 - dropping the pointer makes the control token unreachable, so every reader has to run first,
// and the file it pointed at is GONE rather than merely unreferenced.
//
// This is here because the ordering it describes was got WRONG, and the suite did not catch it: the
// pi extension scrubbed the pointer immediately after parsing its config and then asked for the
// control token, which was by then gone. Every pi launch refused, loudly and correctly, and it took
// a live spawn to see it. The property is pinned here so the hazard is a named, tested fact rather
// than a comment somebody has to remember, and the contract keeps failing loud when it is violated.
//
// IT RUNS AFTER A4 ON PURPOSE. The scrub now unlinks, so this leg destroys the pi launch's material
// file; A4 needs that file on disk to chmod it. Ordering is the whole dependency, and stating it
// here is cheaper than a future reader rediscovering it as a confusing A4 failure.
{
  const env = { ...piSpec.env } as NodeJS.ProcessEnv;
  const file = env[LAUNCH_MATERIAL_ENV] as string;
  assert.ok(controlFromEnv(env)?.token, "A5: the control token is reachable before the pointer is dropped");
  scrubLaunchMaterial(env);
  assert.equal(env[LAUNCH_MATERIAL_ENV], undefined, "A5: the pointer itself is gone");
  assert.equal(existsSync(file), false, "A5: the material file survived the scrub that was supposed to unlink it");
  // Not `undefined`: the socket path is still in this env, so what remains is a BROKEN control
  // endpoint rather than an absent one, and the contract is that a half pair is refused out loud.
  assert.throws(
    () => controlFromEnv(env),
    /no control token could be resolved/,
    "A5: a scrubbed env with a socket path still resolved a control endpoint instead of refusing",
  );
}
console.log("✓ A5: the pointer is dropped, the file is unlinked, and what is left refuses instead of half-working");

// A7 - the two-carrier refusal covers every direct carrier, COTAL_LINK included.
//
// A join link is connection material in one string: server, auth and space. Left off the refusal
// list it did not conflict loudly, it lost quietly to material precedence, which is the same silent
// answer to "who is this session" that the creds pair is refused for.
{
  const env = { ...piSpec.env, COTAL_LINK: "cotal://example.invalid/space" } as NodeJS.ProcessEnv;
  assert.throws(
    () => configFromEnv(env),
    /carries connection material BOTH as COTAL_LAUNCH_MATERIAL and as COTAL_LINK/,
    "A7: a launch carrying both a material file and a join link resolved by precedence instead of refusing",
  );
}
console.log("✓ A7: a material file plus a direct carrier (COTAL_LINK) is refused, not silently ranked");

// A8 - half a control pair throws in BOTH directions, from the one place the pair is resolved.
//
// It used to return undefined and leave the policy to each caller, and the callers did not agree.
// A session that believes it configured a control plane and silently has none is the shape of defect
// this whole change exists to remove, so the refusal lives where the pair is built.
{
  assert.throws(
    () => controlFromEnv({ COTAL_CONTROL_SOCKET: "/tmp/cotal-nonexistent.sock" } as NodeJS.ProcessEnv),
    /COTAL_CONTROL_SOCKET is set but no control token could be resolved/,
    "A8: a socket with no resolvable token was reported as no control plane rather than a broken one",
  );
  assert.throws(
    () => controlFromEnv({ COTAL_CONTROL_TOKEN: "orphan-token" } as NodeJS.ProcessEnv),
    /COTAL_CONTROL_SOCKET is unset/,
    "A8: a control token with no socket was accepted as a normal launch",
  );
  assert.equal(controlFromEnv({} as NodeJS.ProcessEnv), undefined, "A8: a launch with no control plane at all still reads as none");
}
console.log("✓ A8: half a control pair is refused in both directions; no control plane at all is still fine");

console.log("\nseat-env-scope: PASS");
