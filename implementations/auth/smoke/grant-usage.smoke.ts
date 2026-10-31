/**
 * Grant usage is checked before any authority is read, under both spellings, `cotal actor
 * grant|revoke` and `cotal auth grant|revoke`; only a space registered as static or open refuses
 * first, which `smoke:actor-target` covers. A grant missing its `--sub`/`--owner` and its
 * ACL flags refuses once with USAGE_INVALID (exit 1) and names every missing input, never exit 5,
 * and that holds with no space to resolve. An input that is not valid is named with its field and
 * reason, and `--scope` takes only the known capability names. With complete flags on a space whose
 * root holds no user-auth ledger, the capability refusal (UNSUPPORTED, exit 2) comes only after usage
 * passed.
 * `auth handle inspect` on a NATS credential file says it is not a handle, names `whoami --creds`
 * and echoes none of it, and `auth retire` names the lifecycle UID format and where to find one.
 * Broker-free; the mesh registry and the prepared spaces are private to this run.
 *
 * Run: pnpm smoke:grant-usage
 */
import { strict as nodeAssert } from "node:assert";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registry, type Command, type ParsedArgs } from "@cotal-ai/core";
import { countedAssert, emitSentinel } from "@cotal-ai/smoke-kit";
import { exitCode, findCotalRoot, isCommandFailure, recordPreparedSpace, type CommandFailure } from "@cotal-ai/workspace";
import "../src/index.js";

const counted = countedAssert(nodeAssert);
const assert: typeof nodeAssert = counted.assert;
const cells = counted.cells;

const startCwd = process.cwd();
const priorHome = process.env.COTAL_HOME;
const base = realpathSync(mkdtempSync(join(tmpdir(), "cotal-grant-usage-")));
process.env.COTAL_HOME = join(base, "home");
const bare = join(base, "bare");
mkdirSync(bare);
const staticRoot = join(base, "static");
mkdirSync(join(staticRoot, ".cotal"), { recursive: true, mode: 0o700 });
recordPreparedSpace({ space: "static-space", root: staticRoot, ts: new Date().toISOString() });

function command(name: string): Command {
  const found = registry.all<Command>("command").find((c) => c.name === name);
  if (!found) throw new Error(`the ${name} command is not registered`);
  return found;
}
const actorCommand = command("actor");
const authCommand = command("auth");

/** The failure one step throws in `cwd`: `validate` alone (the CLI's parse step), or `run` alone
 *  (an in-process caller that skipped validation). */
async function failureOf(step: "validate" | "run", cmd: Command, cwd: string, values: ParsedArgs["values"], positionals: string[]): Promise<CommandFailure> {
  process.chdir(cwd);
  try {
    const args = { values, positionals, raw: [] };
    if (step === "validate") cmd.validate?.(args);
    else await cmd.run(args);
  } catch (error) {
    if (isCommandFailure(error)) return error;
    throw error;
  } finally {
    process.chdir(startCwd);
    process.exitCode = 0;
  }
  throw new Error(`${cmd.name} ${positionals.join(" ")}: ${step} did not refuse`);
}

/** A usage refusal: USAGE_INVALID, exit 1. */
function assertUsage(failure: CommandFailure, name: string): void {
  assert.equal(failure.outcome, "refused", `${name}: outcome`);
  assert.equal(failure.code, "USAGE_INVALID", `${name}: code (${failure.message})`);
  assert.equal(exitCode(failure.outcome, failure.code), 1, `${name}: exit code`);
}

try {
  assert.equal(findCotalRoot(bare), bare, "fixture: no .cotal directory above the temp dir");

  // 1. actor grant with no target and no ACL flags: one usage refusal naming every missing input,
  //    from the parse step and from run alone, before the unresolvable target is read.
  for (const step of ["validate", "run"] as const) {
    const failure = await failureOf(step, actorCommand, bare, {}, ["grant", "alice"]);
    assertUsage(failure, `actor grant, ${step}`);
    assert.match(failure.message, /--scope, --allow-subscribe, --allow-publish left off/, `actor grant, ${step}: names the ACL flags`);
    assert.match(failure.message, /no --sub <IdP subject>.* or --owner/, `actor grant, ${step}: names the authority target`);
    assert.match(failure.remedy ?? "", /cotal actor grant <actor>/, `actor grant, ${step}: remedy shows the actor forms`);
  }

  // 2. auth grant: the same single refusal, with its own spelling in the remedy.
  {
    const failure = await failureOf("validate", authCommand, bare, {}, ["grant", "alice"]);
    assertUsage(failure, "auth grant");
    assert.match(failure.message, /--scope, --allow-subscribe, --allow-publish left off/, "auth grant: names the ACL flags");
    assert.match(failure.message, /no --sub <IdP subject>.* or --owner/, "auth grant: names the authority target in the same refusal");
    assert.match(failure.remedy ?? "", /cotal auth grant <actor>/, "auth grant: remedy shows the auth forms");
  }

  // 3. revoke with no target, and a grant naming both targets: usage refusals.
  {
    const revoke = await failureOf("validate", actorCommand, bare, {}, ["revoke", "alice"]);
    assertUsage(revoke, "actor revoke");
    assert.match(revoke.message, /no --sub <IdP subject>.* or --owner/, "actor revoke: names the authority target");
    const both = await failureOf("validate", actorCommand, bare, { sub: "someone", owner: "u_someone", full: true }, ["grant", "alice"]);
    assertUsage(both, "actor grant with --sub and --owner");
    assert.match(both.message, /both --sub and --owner/, "actor grant with --sub and --owner: says to choose one");
    const bareActor = await failureOf("validate", actorCommand, bare, {}, []);
    assertUsage(bareActor, "bare actor");
    assert.match(bareActor.message, /use actor list, actor grant <actor>, actor label <actor> <label>, or actor revoke <actor>/, "bare actor: names the verbs");
  }

  // 4. Complete flags on a space with no user-auth ledger: usage passes, then the capability
  //    refusal, UNSUPPORTED (exit 2), under both spellings.
  for (const cmd of [actorCommand, authCommand]) {
    const values = { space: "static-space", sub: "someone", full: true };
    process.chdir(staticRoot);
    try { cmd.validate?.({ values, positionals: ["grant", "alice"], raw: [] }); }
    finally { process.chdir(startCwd); }
    const failure = await failureOf("run", cmd, staticRoot, values, ["grant", "alice"]);
    assert.equal(failure.code, "UNSUPPORTED", `${cmd.name} grant with full flags: the capability refusal (${failure.message})`);
    assert.equal(exitCode(failure.outcome, failure.code), 2, `${cmd.name} grant with full flags: exit code`);
  }

  // 4b. An input that is not valid is named with its field and reason, every one in one refusal,
  //     and --scope takes only the capability names the ledger is checked for.
  {
    const scopes = await failureOf("validate", authCommand, bare, { sub: "someone", scope: "spwan,admn", "allow-subscribe": ">", "allow-publish": ">" }, ["grant", "alice"]);
    assertUsage(scopes, "auth grant with unknown capabilities");
    assert.match(scopes.message, /--scope: unknown capabilities "spwan", "admn"; the capabilities are admin, run, spawn, supervise and role:<role>/, "unknown capabilities: names each one and the valid set");
    assert.match(scopes.message, /no grant was changed$/, "unknown capabilities: nothing was written");
    const one = await failureOf("validate", actorCommand, bare, { sub: "someone", scope: "fliegen", "allow-subscribe": "", "allow-publish": "" }, ["grant", "alice"]);
    assert.match(one.message, /--scope: an unknown capability "fliegen"/, "one unknown capability is named alone");
    const role = await failureOf("validate", actorCommand, bare, { sub: "someone", scope: "role:a b", "allow-subscribe": "", "allow-publish": "" }, ["grant", "alice"]);
    assert.match(role.message, /--scope: an unknown capability "role:a b"/, "a role capability with an invalid role is refused");
    const fields = await failureOf("validate", authCommand, bare, { sub: "someone", full: true, role: "r r", parent: "nodot", "allow-subscribe": "a b" }, ["grant", "bad.actor"]);
    assertUsage(fields, "auth grant with several invalid fields");
    for (const field of ["the actor: invalid owner/actor token \"bad\.actor\"", "--role: invalid role \"r r\"", "--parent: \"nodot\" is not <owner>\.<actor>", "--allow-subscribe: invalid channel \"a b\""])
      assert.match(fields.message, new RegExp(field), `several invalid fields: names ${field.split(":")[0]}`);
    const owner = await failureOf("validate", actorCommand, bare, { owner: "notatoken" }, ["revoke", "alice"]);
    assertUsage(owner, "actor revoke with an invalid --owner");
    assert.match(owner.message, /--owner: invalid derived owner token "notatoken"/, "revoke: names --owner");
    // Every known capability passes, so the grant reaches its capability refusal on this space.
    const known = { space: "static-space", sub: "someone", scope: "admin,run,spawn,supervise,role:reviewer", "allow-subscribe": ">", "allow-publish": "" };
    process.chdir(staticRoot);
    try { authCommand.validate?.({ values: known, positionals: ["grant", "alice"], raw: [] }); }
    finally { process.chdir(startCwd); }
  }

  // 5. handle inspect says a NATS credential file is not a handle, and what a handle is.
  {
    const creds = join(bare, "agent.creds");
    writeFileSync(creds, "-----BEGIN NATS USER JWT-----\neyJhbGciOiJlZDI1NTE5LW5rZXkifQ.e30.c2ln\n------END NATS USER JWT------\n", { mode: 0o600 });
    const handle = await failureOf("run", authCommand, bare, {}, ["handle", "inspect", creds]);
    assert.equal(handle.code, "SCHEMA_INVALID", `auth handle inspect on a credential file: code (${handle.message})`);
    assert.match(handle.message, /^this is a NATS credential file, not a capability handle, which is a signed JSON grant/, "auth handle inspect: says what the file is");
    assert.match(handle.remedy ?? "", /cotal whoami --creds <file>/, "auth handle inspect: says which command reads a credential file");
    assert.doesNotMatch(`${handle.message} ${handle.remedy}`, /eyJhbGci/, "auth handle inspect: the credential is not echoed");
    const text = join(bare, "notes.txt");
    writeFileSync(text, "not json\n", { mode: 0o600 });
    const other = await failureOf("run", authCommand, bare, {}, ["handle", "inspect", text]);
    assert.equal(other.code, "SCHEMA_INVALID", `auth handle inspect on a text file: code (${other.message})`);
    assert.match(other.message, /^this file is not a capability handle: a handle is a signed JSON grant/, "auth handle inspect on a text file: says what a handle is");
    // A path that names nothing is named, in its own folder or in one that does not exist.
    for (const missing of [join(bare, "missing.json"), join(bare, "no-such-folder", "missing.json")]) {
      const absent = await failureOf("run", authCommand, bare, {}, ["handle", "inspect", missing]);
      assert.equal(absent.code, "TARGET_NOT_FOUND", `auth handle inspect on a missing file: code (${absent.message})`);
      assert.equal(absent.message, `the handle file ${missing} does not exist; nothing was read`, "auth handle inspect on a missing file: names the path");
      assert.deepEqual(absent.target, { path: missing }, "auth handle inspect on a missing file: its target is the path");
    }
  }

  // 6. retire names the lifecycle UID format and where to find one.
  {
    const retire = await failureOf("validate", authCommand, bare, {}, ["retire", "x"]);
    assertUsage(retire, "auth retire x");
    assert.match(retire.message, /26 to 32 lowercase letters and digits/, "auth retire: names the UID format");
    assert.equal(retire.remedy, "`cotal ps --wide` shows each seat's lifecycle uid", "auth retire: says where a UID is shown");
  }
} finally {
  process.chdir(startCwd);
  if (priorHome === undefined) delete process.env.COTAL_HOME;
  else process.env.COTAL_HOME = priorHome;
  rmSync(base, { recursive: true, force: true });
}

console.log("grant-usage smoke: OK - actor and auth grant usage refuse with exit 1 before any target or authority is read and name every missing input; complete flags then meet the capability refusal; handle inspect says a credential file is not a handle, and retire names the UID format");
emitSentinel({ passed: cells(), failed: 0 });
