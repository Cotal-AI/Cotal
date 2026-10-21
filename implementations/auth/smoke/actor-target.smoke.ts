/**
 * `cotal actor list` answers what `cotal auth grants` answers for the same space, because both
 * resolve their target and check the space's user-auth ledger the same way. With no space to
 * resolve, both refuse with TARGET_NOT_FOUND and the next step, `actor list` prints no report for an
 * assumed `main`, and bare `cotal auth` points to `cotal space` instead of printing an unfilled
 * `--space`. On a space whose root holds no user-auth ledger, both refuse UNSUPPORTED instead of
 * listing no rows. On a registered static or open space, list, grant and revoke refuse UNSUPPORTED
 * under both spellings and say that actor grants need a user-auth space; nothing is written. A
 * user-auth space lists its row under both spellings, and bare `cotal auth` fills its Next lines
 * with the named or resolved space. Broker-free; the mesh registry and the prepared spaces are
 * private to this run.
 *
 * Run: pnpm smoke:actor-target
 */
import { strict as nodeAssert } from "node:assert";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSpaceAuth, registry, type Command, type ParsedArgs } from "@cotal-ai/core";
import { countedAssert, emitSentinel } from "@cotal-ai/smoke-kit";
import { authDir, exitCode, findCotalRoot, hasUserAuthState, isCommandFailure, recordMesh, recordPreparedSpace, saveSpaceAuth, userAuthStateDir, workspaceSecretStore, type CommandFailure } from "@cotal-ai/workspace";
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

/** The outcome, code, sentence and remedy of a refusal, for comparing the two spellings. */
const refusal = (failure?: CommandFailure) => [failure?.outcome, failure?.code, failure?.message, failure?.remedy];

/** The text of a report with styling removed and whitespace collapsed. */
const flat = (out: string) => out.replace(/\x1b\[[0-9;]*m/g, "").replace(/\s+/g, " ");

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
    assert.equal(actor.failure?.remedy, "run `cotal up` in a project", "with no space the refusal names the next step");
    const bareAuth = await run(authCommand, bare, { plain: true }, []);
    assert.equal(bareAuth.failure, undefined, `bare auth with no space succeeds: ${bareAuth.failure?.message}`);
    assert.ok(flat(bareAuth.out).includes("cotal space See registered spaces and choose one"), `bare auth with no space points to cotal space: ${bareAuth.out}`);
    assert.doesNotMatch(bareAuth.out, /<space>|--space/, "bare auth with no space prints no unfilled --space");
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
    assert.match(actor.failure?.remedy ?? "", /host this space's user-auth ledger; a space started without `--user-auth` has none$/, "a space with no mode yet points to the root that holds its ledger");
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

  // 4. A registered static space has no user-auth ledger anywhere: list, grant and revoke refuse
  //    UNSUPPORTED under both spellings, say that grants need a user-auth space, and write nothing.
  //    Bare auth fills its Next lines with the named space, or with the one its root resolves.
  {
    const space = "static-reg";
    const root = join(base, "static-reg");
    mkdirSync(authDir(root), { recursive: true, mode: 0o700 });
    saveSpaceAuth(authDir(root), await createSpaceAuth(space));
    recordMesh({ space, server: "nats://127.0.0.1:4999", root, mode: "auth", ts: new Date().toISOString() });
    const cases = [
      { verb: "list", auth: "grants", values: { space }, unwritten: "an empty grant list was not inferred" },
      { verb: "grant", auth: "grant", values: { space, sub: "someone", full: true }, unwritten: "no inert grant was written" },
      { verb: "revoke", auth: "revoke", values: { space, sub: "someone" }, unwritten: "nothing was revoked" },
    ] as const;
    for (const c of cases) {
      const positionals = c.verb === "list" ? [] : ["alice"];
      const actor = await run(actorCommand, root, c.values, [c.verb, ...positionals]);
      const auth = await run(authCommand, root, c.values, [c.auth, ...positionals]);
      assert.equal(actor.failure?.code, "UNSUPPORTED", `actor ${c.verb} on a static space refuses: ${actor.failure?.message ?? actor.out}`);
      assert.equal(exitCode(actor.failure!.outcome, actor.failure!.code), 2, `actor ${c.verb} on a static space exits 2`);
      assert.equal(actor.failure?.message, `space "${space}" is a static-credential space and has no user-auth ledger; ${c.unwritten}`, `actor ${c.verb} on a static space says why and what was not done`);
      assert.equal(actor.failure?.remedy, "actor grants apply only to a space started with `cotal up --user-auth`", `actor ${c.verb} on a static space: remedy`);
      assert.deepEqual(refusal(actor.failure), refusal(auth.failure), `actor ${c.verb} and auth ${c.auth} refuse alike on a static space`);
    }
    assert.equal(hasUserAuthState(root, space, { readOnly: true }), false, "no user-auth state was written on the static space");
    const named = flat((await run(authCommand, base, { space, plain: true }, [])).out);
    assert.ok(named.includes(`cotal whoami --space ${space}`) && named.includes(`cotal auth grants --space ${space}`), `bare auth --space fills its Next lines: ${named}`);
    const resolved = flat((await run(authCommand, root, { plain: true }, [])).out);
    assert.ok(resolved.includes(`cotal auth grants --space ${space}`), `bare auth in a space's root fills its Next lines with that space: ${resolved}`);
    assert.doesNotMatch(resolved, /<space>/, "bare auth prints no unfilled placeholder");
  }

  // 5. A registered open space refuses a grant the same way, naming it open.
  {
    const space = "open-reg";
    const root = join(base, "open-reg");
    mkdirSync(join(root, ".cotal"), { recursive: true, mode: 0o700 });
    recordMesh({ space, server: "nats://127.0.0.1:4998", root, mode: "open", ts: new Date().toISOString() });
    const actor = await run(actorCommand, root, { space, sub: "someone", full: true }, ["grant", "alice"]);
    assert.equal(actor.failure?.code, "UNSUPPORTED", `actor grant on an open space refuses: ${actor.failure?.message ?? actor.out}`);
    assert.equal(actor.failure?.message, `space "${space}" is an open space and has no user-auth ledger; no inert grant was written`, "actor grant on an open space says why");
    assert.equal(actor.failure?.remedy, "actor grants apply only to a space started with `cotal up --user-auth`", "actor grant on an open space: remedy");
  }
} finally {
  process.chdir(startCwd);
  if (priorHome === undefined) delete process.env.COTAL_HOME;
  else process.env.COTAL_HOME = priorHome;
  rmSync(base, { recursive: true, force: true });
}

console.log("actor-target smoke: OK - actor list and auth grants resolve and refuse alike: no space is TARGET_NOT_FOUND with a next step and no assumed main, a root without the user-auth ledger is UNSUPPORTED, a static or open space says grants need a user-auth space, a user-auth space lists the same row, and bare auth names a real space or cotal space");
emitSentinel({ passed: cells(), failed: 0 });
