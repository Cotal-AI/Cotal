/**
 * Grant usage is checked before any target or authority is read, under both spellings, `cotal
 * actor grant|revoke` and `cotal auth grant|revoke`. A grant missing its `--sub`/`--owner` and its
 * ACL flags refuses once with USAGE_INVALID (exit 1) and names every missing input, never exit 5,
 * and that holds with no space to resolve. With complete flags on a space whose root holds no
 * user-auth ledger, the capability refusal (UNSUPPORTED, exit 2) comes only after usage passed.
 * Broker-free; the mesh registry and the prepared spaces are private to this run.
 *
 * Run: pnpm smoke:grant-usage
 */
import { strict as nodeAssert } from "node:assert";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
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
    assert.match(bareActor.message, /use actor list, actor grant <actor>, or actor revoke <actor>/, "bare actor: names the verbs");
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
} finally {
  process.chdir(startCwd);
  if (priorHome === undefined) delete process.env.COTAL_HOME;
  else process.env.COTAL_HOME = priorHome;
  rmSync(base, { recursive: true, force: true });
}

console.log("grant-usage smoke: OK - actor and auth grant usage refuse with exit 1 before any target or authority is read and name every missing input; complete flags then meet the capability refusal");
emitSentinel({ passed: cells(), failed: 0 });
