/**
 * `cotal actor grant` and `revoke` retire the actor's interactive lifecycle before their ledger
 * transaction. When the actor row changes or disappears while that retirement runs, the lifecycle
 * is already retired and the command writes nothing, so the result is partial (exit 4) and names
 * the retired lifecycle under `changed`, never unknown. Only a retirement the service reports for
 * this call counts: when it answers `retired: false` (the lifecycle never started) or that the
 * lifecycle was already retired, the same race is a plain conflict (exit 2), and a 200 without a
 * readable result is unknown (exit 3). A stub auth service answers the retirement and changes the
 * ledger while it does. Broker-free.
 *
 * Run: pnpm smoke:actor-retire-partial
 */
import { strict as nodeAssert } from "node:assert";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registry, type Command } from "@cotal-ai/core";
import { countedAssert, emitSentinel } from "@cotal-ai/smoke-kit";
import { exitCode, isCommandFailure, recordPreparedSpace, userAuthStateDir, workspaceSecretStore, type CommandFailure } from "@cotal-ai/workspace";
import { deriveOwnerForIdpSubject, ensureOwnerSecret, ensurePinnedIdp, findInteractiveActor, grantActor, revokeActor, saveAuthServiceInfo, type ActorRow } from "../src/index.js";
import { INTERACTIVE_RETIRE_PATH } from "../src/service.js";

const counted = countedAssert(nodeAssert);
const assert: typeof nodeAssert = counted.assert;
const cells = counted.cells;

const startCwd = process.cwd();
const priorHome = process.env.COTAL_HOME;
const root = mkdtempSync(join(tmpdir(), "cotal-actor-partial-"));
mkdirSync(join(root, ".cotal"), { mode: 0o700 });
process.env.COTAL_HOME = join(root, "home");
// `actor` resolves its root from the working directory.
process.chdir(root);

const space = "partial";
// `actor --space` resolves a named space as `auth` does: this one is prepared at `root`, not started.
recordPreparedSpace({ space, root, ts: new Date().toISOString() });
const ACTOR = "cli";
const dir = userAuthStateDir(root, space);
const issuer = "http://127.0.0.1:9";
const secret = await ensureOwnerSecret(workspaceSecretStore(root), space);
ensurePinnedIdp(dir, `${issuer}/api/auth`);
const owner = deriveOwnerForIdpSubject(secret, issuer, "partial-human");
const row = (): Omit<ActorRow, "grantedAt"> => ({ owner, actor: ACTOR, scope: ["spawn"], allowSubscribe: [">"], allowPublish: [">"] });

// The stub retirement endpoint records each lifecycle it is asked to retire and runs the armed race
// once. It answers that it retired the lifecycle unless a cell armed another answer for one call.
const retired: string[] = [];
let race: (() => void) | undefined;
let answer: ((lifecycleUid: string) => unknown) | undefined;
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
  req.on("end", () => {
    res.setHeader("content-type", "application/json");
    if (req.method !== "POST" || req.url !== INTERACTIVE_RETIRE_PATH) { res.statusCode = 404; res.end("{}"); return; }
    const lifecycleUid = String((JSON.parse(body) as { lifecycleUid?: unknown }).lifecycleUid);
    retired.push(lifecycleUid);
    const armed = race;
    race = undefined;
    armed?.();
    const reply = answer ?? ((uid: string) => ({ retired: true, lifecycleUid: uid }));
    answer = undefined;
    res.end(JSON.stringify(reply(lifecycleUid)));
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
saveAuthServiceInfo(dir, { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, pid: process.pid, cap: "smoke-cap" });

const actorCommand = registry.all<Command>("command").find((command) => command.name === "actor");
if (!actorCommand) throw new Error("the actor command is not registered");
async function actor(sub: "grant" | "revoke"): Promise<unknown> {
  try {
    await actorCommand!.run({ values: { space, owner, ...(sub === "grant" ? { full: true } : {}) }, positionals: [sub, ACTOR], raw: [] });
    return undefined;
  } catch (error) {
    return error;
  }
}

/** The failure a guard after retirement must produce: partial, exit 4, naming what was retired. */
function assertPartial(error: unknown, predecessor: ActorRow, unwritten: RegExp, name: string): void {
  assert.ok(isCommandFailure(error), `${name}: expected a CommandFailure, got ${String(error)}`);
  const failure = error as CommandFailure;
  assert.equal(failure.outcome, "partial", `${name}: outcome`);
  assert.equal(failure.code, "OPERATION_PARTIAL", `${name}: code`);
  assert.equal(exitCode(failure.outcome, failure.code), 4, `${name}: exit code`);
  assert.ok(failure.message.includes(`its lifecycle ${predecessor.lifecycleUid} was retired`), `${name}: the message names the retired lifecycle: ${failure.message}`);
  assert.match(failure.message, unwritten, `${name}: the message says what was not written`);
  assert.deepEqual(failure.changed, [{ kind: "actor-lifecycle-retired", owner, actor: ACTOR, lifecycleUid: predecessor.lifecycleUid }], `${name}: changed names the retired lifecycle`);
  assert.match(failure.remedy ?? "", /re-read `cotal actor list`/, `${name}: remedy`);
}

/** The failure the same guard must produce when this call retired nothing: a conflict, exit 2. */
function assertConflict(error: unknown, unwritten: RegExp, name: string): void {
  assert.ok(isCommandFailure(error), `${name}: expected a CommandFailure, got ${String(error)}`);
  const failure = error as CommandFailure;
  assert.equal(failure.outcome, "refused", `${name}: outcome`);
  assert.equal(failure.code, "CONFLICT", `${name}: code`);
  assert.equal(exitCode(failure.outcome, failure.code), 2, `${name}: exit code`);
  assert.doesNotMatch(failure.message, /was retired/, `${name}: the message claims no retirement: ${failure.message}`);
  assert.match(failure.message, unwritten, `${name}: the message says what was not written`);
  assert.equal(failure.changed, undefined, `${name}: nothing is listed under changed`);
}

try {
  // 1. Control: an undisturbed re-grant retires the predecessor and writes a successor.
  {
    const first = grantActor(dir, row());
    retired.length = 0;
    assert.equal(await actor("grant"), undefined, "an undisturbed re-grant succeeds");
    assert.deepEqual(retired, [first.lifecycleUid], "the re-grant retired the predecessor lifecycle");
    const successor = findInteractiveActor(dir, owner, ACTOR);
    assert.ok(successor?.lifecycleUid && successor.lifecycleUid !== first.lifecycleUid, "the successor row carries a new lifecycle");
  }

  // 2. Re-grant: another grant lands while the predecessor retires.
  {
    const first = grantActor(dir, row());
    let racer: ActorRow | undefined;
    race = () => { racer = grantActor(dir, row()); };
    retired.length = 0;
    const error = await actor("grant");
    assertPartial(error, first, /the successor grant was not written and nothing was overwritten$/, "a re-grant whose row changed");
    assert.deepEqual(retired, [first.lifecycleUid], "only the predecessor was retired");
    assert.equal(findInteractiveActor(dir, owner, ACTOR)?.lifecycleUid, racer?.lifecycleUid, "the racing grant's row is left as it was");
  }

  // 3. Revoke: another grant lands while the lifecycle retires.
  {
    const first = grantActor(dir, row());
    let racer: ActorRow | undefined;
    race = () => { racer = grantActor(dir, row()); };
    retired.length = 0;
    const error = await actor("revoke");
    assertPartial(error, first, /the changed row was not deleted$/, "a revoke whose row changed");
    assert.equal(findInteractiveActor(dir, owner, ACTOR)?.lifecycleUid, racer?.lifecycleUid, "the changed row is not deleted");
  }

  // 4. Revoke: the row is removed while the lifecycle retires.
  {
    const first = grantActor(dir, row());
    race = () => { revokeActor(dir, owner, ACTOR); };
    retired.length = 0;
    const error = await actor("revoke");
    assertPartial(error, first, /was removed or replaced since it was read; nothing was deleted$/, "a revoke whose row was removed");
    assert.equal(findInteractiveActor(dir, owner, ACTOR), undefined, "the row stays absent");
  }

  // 5. Re-grant: the service answers 200 with `retired: false` (the lifecycle never started) while
  //    another grant lands. This call retired nothing, so the guard is a conflict.
  {
    const first = grantActor(dir, row());
    let racer: ActorRow | undefined;
    answer = (uid) => ({ retired: false, lifecycleUid: uid, notStarted: true });
    race = () => { racer = grantActor(dir, row()); };
    retired.length = 0;
    const error = await actor("grant");
    assertConflict(error, /the successor grant was not written and nothing was overwritten$/, "a re-grant whose lifecycle never started");
    assert.deepEqual(retired, [first.lifecycleUid], "only the predecessor was asked to retire");
    assert.equal(findInteractiveActor(dir, owner, ACTOR)?.lifecycleUid, racer?.lifecycleUid, "the racing grant's row is left as it was");
  }

  // 6. Re-grant: `retired: false` with no race. A lifecycle that never started does not block the successor.
  {
    const first = grantActor(dir, row());
    answer = (uid) => ({ retired: false, lifecycleUid: uid, notStarted: true });
    assert.equal(await actor("grant"), undefined, "a re-grant whose lifecycle never started succeeds");
    const successor = findInteractiveActor(dir, owner, ACTOR);
    assert.ok(successor?.lifecycleUid && successor.lifecycleUid !== first.lifecycleUid, "the successor row carries a new lifecycle");
  }

  // 7. Revoke: the service reports the lifecycle was already retired while the row changes. This
  //    call retired nothing, so the guard is a conflict.
  {
    grantActor(dir, row());
    let racer: ActorRow | undefined;
    answer = (uid) => ({ retired: true, lifecycleUid: uid, alreadyRetired: true });
    race = () => { racer = grantActor(dir, row()); };
    const error = await actor("revoke");
    assertConflict(error, /the changed row was not deleted$/, "a revoke whose lifecycle was already retired");
    assert.equal(findInteractiveActor(dir, owner, ACTOR)?.lifecycleUid, racer?.lifecycleUid, "the changed row is not deleted");
  }

  // 8. Re-grant: a 200 without a readable result leaves the retirement unconfirmed, so the result
  //    is unknown (exit 3) and the successor is not written.
  {
    const first = grantActor(dir, row());
    answer = () => ({});
    const error = await actor("grant");
    assert.ok(isCommandFailure(error), `an unreadable retirement result: expected a CommandFailure, got ${String(error)}`);
    const failure = error as CommandFailure;
    assert.equal(failure.outcome, "unknown", "an unreadable retirement result: outcome");
    assert.equal(failure.code, "OPERATION_UNKNOWN", "an unreadable retirement result: code");
    assert.equal(exitCode(failure.outcome, failure.code), 3, "an unreadable retirement result: exit code");
    assert.equal(findInteractiveActor(dir, owner, ACTOR)?.lifecycleUid, first.lifecycleUid, "the predecessor row is left as it was");
  }
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  process.chdir(startCwd);
  if (priorHome === undefined) delete process.env.COTAL_HOME;
  else process.env.COTAL_HOME = priorHome;
  rmSync(root, { recursive: true, force: true });
}

console.log("actor-retire-partial smoke: OK - a re-grant or revoke whose actor row changes or disappears during lifecycle retirement ends partial (exit 4), names the retired lifecycle and writes nothing; when the service retired nothing the same race is a conflict (exit 2), and an unreadable retirement result is unknown (exit 3)");
emitSentinel({ passed: cells(), failed: 0 });
