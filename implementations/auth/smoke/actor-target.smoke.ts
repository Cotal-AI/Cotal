/**
 * `cotal actor list` answers what `cotal auth grants` answers for the same space, because both
 * resolve their target and check the space's user-auth ledger the same way. With no space to
 * resolve, both refuse with TARGET_NOT_FOUND and `actor list` prints no report for an assumed
 * `main`. On a space whose root holds no user-auth ledger, both refuse UNSUPPORTED instead of
 * listing no rows. A user-auth space lists its row under both spellings. Broker-free; the mesh
 * registry and the prepared spaces are private to this run.
 *
 * Run: pnpm smoke:actor-target
 */
import { strict as nodeAssert } from "node:assert";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registry, type Command, type ParsedArgs } from "@cotal-ai/core";
import { countedAssert, emitSentinel } from "@cotal-ai/smoke-kit";
import { exitCode, findCotalRoot, isCommandFailure, recordPreparedSpace, userAuthStateDir, workspaceSecretStore, type CommandFailure } from "@cotal-ai/workspace";
import { deriveOwnerForIdpSubject, ensureOwnerSecret, ensurePinnedIdp, grantActor } from "../src/index.js";

const counted = countedAssert(nodeAssert);
const assert: typeof nodeAssert = counted.assert;
const cells = counted.cells;

const startCwd = process.cwd();
const priorHome = process.env.COTAL_HOME;
const base = realpathSync(mkdtempSync(join(tmpdir(), "cotal-actor-target-")));
process.env.COTAL_HOME = join(base, "home");

function command(name: string): Command {
  const found = registry.all<Command>("command").find((c) => c.name === name);
  if (!found) throw new Error(`the ${name} command is not registered`);
  return found;
}
const actorCommand = command("actor");
const authCommand = command("auth");

/** Validate and run one command in `cwd`, as the CLI does after parsing. Returns the failure it
 *  threw and what it wrote to stdout. */
async function run(cmd: Command, cwd: string, values: ParsedArgs["values"], positionals: string[]): Promise<{ failure?: CommandFailure; out: string }> {
  const out: string[] = [];
  const log = console.log;
  const write = process.stdout.write.bind(process.stdout);
  console.log = (...a: unknown[]) => { out.push(`${a.join(" ")}\n`); };
  process.stdout.write = ((chunk: string | Uint8Array) => (out.push(String(chunk)), true)) as typeof process.stdout.write;
  process.chdir(cwd);
  try {
    const args = { values, positionals, raw: [] };
    cmd.validate?.(args);
    await cmd.run(args);
    return { out: out.join("") };
  } catch (error) {
    if (!isCommandFailure(error)) throw error;
    return { failure: error, out: out.join("") };
  } finally {
    console.log = log;
    process.stdout.write = write;
    process.chdir(startCwd);
    process.exitCode = 0;
  }
}

/** The outcome, code and sentence of a refusal, for comparing the two spellings. */
const refusal = (failure?: CommandFailure) => [failure?.outcome, failure?.code, failure?.message];

try {
  // 1. No space anywhere: both spellings refuse alike, and actor list reports no assumed `main`.
  {
    const bare = join(base, "bare");
    mkdirSync(bare);
    assert.equal(findCotalRoot(bare), bare, "fixture: no .cotal directory above the temp dir");
    const actor = await run(actorCommand, bare, {}, ["list"]);
    const auth = await run(authCommand, bare, {}, ["grants"]);
    assert.equal(actor.failure?.code, "TARGET_NOT_FOUND", `actor list with no space refuses: ${actor.failure?.message ?? actor.out}`);
    assert.equal(exitCode(actor.failure!.outcome, actor.failure!.code), 2, "actor list with no space exits 2");
    assert.deepEqual(refusal(actor.failure), refusal(auth.failure), "actor list and auth grants refuse alike with no space");
    assert.equal(actor.out, "", "actor list prints no report for an assumed space");
  }

  // 2. A space whose root holds no user-auth ledger: both refuse UNSUPPORTED, never "no rows".
  {
    const root = join(base, "static");
    mkdirSync(join(root, ".cotal"), { recursive: true, mode: 0o700 });
    recordPreparedSpace({ space: "static-space", root, ts: new Date().toISOString() });
    const actor = await run(actorCommand, root, { space: "static-space" }, ["list"]);
    const auth = await run(authCommand, root, { space: "static-space" }, ["grants"]);
    assert.equal(actor.failure?.code, "UNSUPPORTED", `actor list without a ledger refuses: ${actor.failure?.message ?? actor.out}`);
    assert.equal(exitCode(actor.failure!.outcome, actor.failure!.code), 2, "actor list without a ledger exits 2");
    assert.deepEqual(refusal(actor.failure), refusal(auth.failure), "actor list and auth grants refuse alike without a ledger");
    assert.doesNotMatch(actor.out, /No rows/, "no empty authoritative list is printed");
  }

  // 3. Control: a user-auth space lists its row under both spellings.
  {
    const space = "user-space";
    const root = join(base, "user");
    mkdirSync(join(root, ".cotal"), { recursive: true, mode: 0o700 });
    recordPreparedSpace({ space, root, ts: new Date().toISOString() });
    const dir = userAuthStateDir(root, space);
    const issuer = "http://127.0.0.1:9";
    const secret = await ensureOwnerSecret(workspaceSecretStore(root), space);
    ensurePinnedIdp(dir, `${issuer}/api/auth`);
    const owner = deriveOwnerForIdpSubject(secret, issuer, "target-human");
    grantActor(dir, { owner, actor: "cli", scope: ["spawn"], allowSubscribe: [">"], allowPublish: [">"] });
    const actor = await run(actorCommand, root, { space }, ["list"]);
    const auth = await run(authCommand, root, { space, json: true }, ["grants"]);
    assert.equal(actor.failure, undefined, `actor list on a user-auth space succeeds: ${actor.failure?.message}`);
    assert.ok(actor.out.replace(/\x1b\[[0-9;]*m/g, "").replace(/\s+/g, "").includes(`${owner}.cli`), `actor list shows the granted row: ${actor.out}`);
    const envelope = JSON.parse(auth.out) as { result: { items: { owner: string; actor: string }[] } };
    assert.deepEqual(envelope.result.items.map((item) => `${item.owner}.${item.actor}`), [`${owner}.cli`], "auth grants lists the same row");
  }
} finally {
  process.chdir(startCwd);
  if (priorHome === undefined) delete process.env.COTAL_HOME;
  else process.env.COTAL_HOME = priorHome;
  rmSync(base, { recursive: true, force: true });
}

console.log("actor-target smoke: OK - actor list and auth grants resolve and refuse alike: no space is TARGET_NOT_FOUND with no assumed main, a root without the user-auth ledger is UNSUPPORTED, and a user-auth space lists the same row");
emitSentinel({ passed: cells(), failed: 0 });
