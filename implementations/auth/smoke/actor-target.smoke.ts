/**
 * `cotal actor list` answers what `cotal auth grants` answers for the same space, because both
 * resolve their target and check the space's user-auth ledger the same way. With no space to
 * resolve, both refuse with TARGET_NOT_FOUND and the next step, `actor list` prints no report for an
 * assumed `main`, and bare `cotal auth` points to `cotal space` instead of printing an unfilled
 * `--space`. On a space whose root holds no user-auth ledger, both refuse UNSUPPORTED instead of
 * listing no rows. On a registered static or open space, list, grant and revoke refuse UNSUPPORTED
 * under both spellings and say that actor grants need a user-auth space, grant and revoke before
 * they ask for a subject or the ACL flags; nothing is written. Every `service-endpoint` subcommand
 * refuses UNSUPPORTED there too, saying the space has no service endpoint host, and records no
 * request; a root without the user-auth service says it does not hold it. A
 * user-auth space lists its row under both spellings, with its role, label and parent in the table
 * and in `--json`, which `actor list` takes as `auth grants` does. With `--sub`, both list only the rows
 * of the owner that IdP subject derives to, titled with the subject and that owner, and an empty
 * `--sub` is a value refusal. `actor label` changes only an interactive row's label and keeps its
 * lifecycle and grant time; it refuses a missing row, a managed agent's row, and a static space. Bare
 * `cotal auth` fills its Next lines
 * with the named or resolved space. `auth retire` refuses UNSUPPORTED there too, and its help and
 * refusal name the lever that works, rotating the space identity. Broker-free; the mesh registry and
 * the prepared spaces are private to this run.
 *
 * Run: pnpm smoke:actor-target
 */
import { strict as nodeAssert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSpaceAuth, mintLifecycleUid, registry, type Command, type ParsedArgs } from "@cotal-ai/core";
import { countedAssert, emitSentinel } from "@cotal-ai/smoke-kit";
import { authDir, exitCode, findCotalRoot, hasUserAuthState, isCommandFailure, recordMesh, recordPreparedSpace, saveSpaceAuth, userAuthStateDir, workspaceSecretStore, type CommandFailure } from "@cotal-ai/workspace";
import { deriveOwnerForIdpSubject, ensureOwnerSecret, ensurePinnedIdp, findInteractiveActor, findManagedActor, grantActor, grantManagedActor, newActorToken } from "../src/index.js";

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
const serviceEndpointCommand = command("service-endpoint");
/** Every `service-endpoint` subcommand, with a subject and the flags its usage needs. */
const SERVICE_ENDPOINT_RUNS = [
  [["approve", "p1"], {}], [["refuse", "p1"], {}], [["proposal", "p1"], {}], [["operation", "o1"], {}], [["name", "e1"], {}],
  [["name-bind", "e1"], { owner: "u_aaaaaaaaaaaaaaaaaaaaaaaaaa", claim: "c1" }],
] as const;

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
    const endpoint = await run(serviceEndpointCommand, root, { space: "static-space" }, ["proposal", "p1"]);
    assert.equal(endpoint.failure?.code, "UNSUPPORTED", `service-endpoint without the user-auth service refuses: ${endpoint.failure?.message ?? endpoint.out}`);
    assert.equal(endpoint.failure?.message, "this root does not hold the space's user-auth service; nothing was sent", "service-endpoint says this root holds no user-auth service");
    assert.equal(endpoint.failure?.remedy, "run it on the root that started the space with `cotal up --user-auth --service-endpoints`; a space started without `--user-auth` has no service endpoint host", "service-endpoint names the root that hosts the service");
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

    // A re-grant replaces the whole row, so both lists show every field it must spell again, and
    // the actor spelling takes --json as the auth one does.
    grantActor(dir, { owner, actor: "rev", scope: ["spawn"], allowSubscribe: ["general"], allowPublish: ["general"], role: "reviewer", label: "Code reviewer", parent: `${owner}.cli` });
    for (const [name, cmd, verb] of [["actor list", actorCommand, "list"], ["auth grants", authCommand, "grants"]] as const) {
      const plain = flat((await run(cmd, root, { space }, [verb])).out);
      assert.ok(plain.includes("May post Role Label Parent"), `${name} names the role, label and parent columns: ${plain}`);
      assert.ok(plain.includes(`${owner}.rev interactive spawn general general reviewer Code reviewer ${owner}.cli`), `${name} shows the row's role, label and parent: ${plain}`);
      assert.ok(plain.includes(`${owner}.cli interactive spawn > > none none none`), `${name} shows none for a row with no role, label or parent: ${plain}`);
    }
    const actorJson = await run(actorCommand, root, { space, json: true }, ["list"]);
    const authJson = await run(authCommand, root, { space, json: true }, ["grants"]);
    assert.equal(actorJson.failure, undefined, `actor list --json succeeds: ${actorJson.failure?.message}`);
    const actorItems = (JSON.parse(actorJson.out) as { command: string; result: { items: { actor: string; role: string | null; label: string | null; parent: string | null }[] } });
    assert.equal(actorItems.command, "actor", "actor list --json is the actor command's envelope");
    assert.deepEqual(actorItems.result.items.map(({ actor, role, label, parent }) => ({ actor, role, label, parent })), [
      { actor: "cli", role: null, label: null, parent: null },
      { actor: "rev", role: "reviewer", label: "Code reviewer", parent: `${owner}.cli` },
    ], "actor list --json carries each row's role, label and parent");
    assert.deepEqual(actorItems.result, (JSON.parse(authJson.out) as { result: unknown }).result, "actor list --json and auth grants --json list the same rows");

    // `--sub` lists one IdP subject's rows. The ledger keeps no subject, so the subject derives to its
    // owner as a grant does, and another owner's row is left out.
    const otherOwner = deriveOwnerForIdpSubject(secret, issuer, "other-human");
    grantActor(dir, { owner: otherOwner, actor: "cli", scope: ["spawn"], allowSubscribe: [">"], allowPublish: [">"] });
    for (const [name, cmd, verb] of [["actor list", actorCommand, "list"], ["auth grants", authCommand, "grants"]] as const) {
      const plain = flat((await run(cmd, root, { space, sub: "target-human" }, [verb])).out);
      assert.ok(plain.includes(`Rows for target-human (owner ${owner})`), `${name} --sub is titled with the subject and its owner: ${plain}`);
      assert.ok(plain.includes(`${owner}.cli`) && plain.includes(`${owner}.rev`) && !plain.includes(otherOwner), `${name} --sub lists only that subject's rows: ${plain}`);
    }
    type SubjectEnvelope = { target: unknown; result: { subject?: string; owner?: string; items: { owner: string; actor: string }[] } };
    const bySubject = JSON.parse((await run(actorCommand, root, { space, sub: "target-human", json: true }, ["list"])).out) as SubjectEnvelope;
    const bySubjectAuth = JSON.parse((await run(authCommand, root, { space, sub: "target-human", json: true }, ["grants"])).out) as SubjectEnvelope;
    assert.deepEqual(bySubject.target, { space, owner }, "actor list --sub --json names the owner in its target");
    assert.deepEqual([bySubject.result.subject, bySubject.result.owner], ["target-human", owner], "actor list --sub --json carries the subject and its owner");
    assert.deepEqual(bySubject.result.items.map((item) => `${item.owner}.${item.actor}`), [`${owner}.cli`, `${owner}.rev`], "actor list --sub --json lists only that subject's rows");
    assert.deepEqual(bySubject.result, bySubjectAuth.result, "actor list --sub and auth grants --sub list the same rows");
    const everyRow = JSON.parse((await run(actorCommand, root, { space, json: true }, ["list"])).out) as SubjectEnvelope;
    assert.ok(everyRow.result.items.some((item) => item.owner === otherOwner) && everyRow.result.subject === undefined, "control: without --sub every owner's rows are listed");
    const nobody = flat((await run(actorCommand, root, { space, sub: "nobody-human" }, ["list"])).out);
    assert.ok(nobody.includes(`Rows for nobody-human (owner ${deriveOwnerForIdpSubject(secret, issuer, "nobody-human")})`) && nobody.includes("No rows for this owner"), `a subject with no rows lists none: ${nobody}`);
    const empty = await run(actorCommand, root, { space, sub: "" }, ["list"]);
    assert.deepEqual([empty.failure?.code, empty.failure?.selfContained, empty.out], ["USAGE_INVALID", true, ""], "an empty --sub is a value refusal that lists nothing");

    // `actor label` changes only the label. The lifecycle, the grant time and every grant field stay,
    // so a bearer issued under the row keeps working.
    const beforeLabel = findInteractiveActor(dir, owner, "rev")!;
    const relabel = await run(actorCommand, root, { space, owner, json: true }, ["label", "rev", "Lead reviewer"]);
    assert.equal(relabel.failure, undefined, `actor label succeeds: ${relabel.failure?.message}`);
    assert.deepEqual(findInteractiveActor(dir, owner, "rev"), { ...beforeLabel, label: "Lead reviewer" }, "actor label changes only the label, keeping the lifecycle and grant time");
    const labelled = JSON.parse(relabel.out) as { target: unknown; result: { kind: string; grant: { label: string | null }; previousLabel: string | null } };
    assert.deepEqual([labelled.target, labelled.result.kind, labelled.result.grant.label, labelled.result.previousLabel], [{ space, owner, actor: "rev" }, "actor-label", "Lead reviewer", "Code reviewer"], "the label receipt names the row, its new label and the earlier one");
    const bySubLabel = flat((await run(actorCommand, root, { space, sub: "target-human" }, ["label", "cli", "Target laptop"])).out);
    assert.ok(bySubLabel.includes("Actor label stored") && bySubLabel.includes("Earlier label: none") && bySubLabel.includes("Lifecycle: kept"), `actor label --sub finds the row as a grant does: ${bySubLabel}`);
    assert.equal(findInteractiveActor(dir, owner, "cli")?.label, "Target laptop", "actor label --sub wrote the label");
    const absent = await run(actorCommand, root, { space, owner }, ["label", "nobody", "x"]);
    assert.equal(absent.failure?.code, "TARGET_NOT_FOUND", `actor label of an actor with no row refuses TARGET_NOT_FOUND: ${absent.failure?.message}`);
    grantManagedActor(dir, { custody: { kind: "foreground" }, owner, actor: "worker", scope: [], parent: `${owner}.cli`, allowSubscribe: ["general"], allowPublish: ["general"], tokenHash: newActorToken().tokenHash, lifecycleUid: mintLifecycleUid() });
    const managed = await run(actorCommand, root, { space, owner }, ["label", "worker", "x"]);
    assert.equal(managed.failure?.code, "UNSUPPORTED", `actor label of a managed agent refuses UNSUPPORTED: ${managed.failure?.message}`);
    assert.equal(findManagedActor(dir, owner, "worker")?.label, undefined, "a managed agent's row is not relabelled");
    for (const [words, values, why] of [
      [["label", "rev"], { space, owner }, "no label"],
      [["label", "rev", ""], { space, owner }, "an empty label"],
      [["label", "rev", "a", "b"], { space, owner }, "two labels"],
      [["label", "rev", "x"], { space }, "no --sub or --owner"],
      [["label", "rev", "x"], { space, owner, role: "lead" }, "a grant field"],
    ] as const) {
      const refused = await run(actorCommand, root, values, [...words]);
      assert.equal(refused.failure?.code, "USAGE_INVALID", `actor label with ${why} is a usage refusal: ${refused.failure?.message}`);
    }
    assert.equal(findInteractiveActor(dir, owner, "rev")?.label, "Lead reviewer", "a refused label writes nothing");
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
    // Grant and revoke refuse there before they ask for a subject or the ACL flags, which could not
    // make them apply.
    for (const verb of ["grant", "revoke"] as const) {
      const actor = await run(actorCommand, root, { space }, [verb, "alice"]);
      const auth = await run(authCommand, root, { space }, [verb, "alice"]);
      assert.equal(actor.failure?.code, "UNSUPPORTED", `actor ${verb} with no --sub on a static space refuses UNSUPPORTED before asking for one: ${actor.failure?.message ?? actor.out}`);
      assert.deepEqual(refusal(actor.failure), refusal(auth.failure), `actor ${verb} and auth ${verb} with no --sub refuse alike on a static space`);
    }
    // service-endpoint is the auth service's too: every subcommand refuses the same way, a binding
    // before it records a request, and nothing names a re-registration.
    for (const [positionals, values] of SERVICE_ENDPOINT_RUNS) {
      const endpoint = await run(serviceEndpointCommand, root, { space, ...values }, [...positionals]);
      assert.equal(endpoint.failure?.code, "UNSUPPORTED", `service-endpoint ${positionals[0]} on a static space refuses: ${endpoint.failure?.message ?? endpoint.out}`);
      assert.equal(exitCode(endpoint.failure!.outcome, endpoint.failure!.code), 2, `service-endpoint ${positionals[0]} on a static space exits 2`);
      assert.equal(endpoint.failure?.message, `space "${space}" is a static-credential space and has no service endpoint host; nothing was sent`, `service-endpoint ${positionals[0]} on a static space says why`);
      assert.equal(endpoint.failure?.remedy, "service endpoints are hosted by the auth service of a space started with `cotal up --user-auth --service-endpoints`", `service-endpoint ${positionals[0]} on a static space: remedy`);
    }
    assert.equal(existsSync(join(userAuthStateDir(root, space), "service-endpoint-requests")), false, "service-endpoint name-bind on a static space records no request");
    const staticLabel = await run(actorCommand, root, { space, sub: "someone" }, ["label", "alice", "x"]);
    assert.equal(staticLabel.failure?.message, `space "${space}" is a static-credential space and has no user-auth ledger; no label was written`, "actor label on a static space refuses UNSUPPORTED and says nothing was written");
    assert.equal(hasUserAuthState(root, space, { readOnly: true }), false, "no user-auth state was written on the static space");
    const named = flat((await run(authCommand, base, { space, plain: true }, [])).out);
    assert.ok(named.includes(`cotal whoami --space ${space}`) && named.includes(`cotal auth grants --space ${space}`), `bare auth --space fills its Next lines: ${named}`);
    const resolved = flat((await run(authCommand, root, { plain: true }, [])).out);
    assert.ok(resolved.includes(`cotal auth grants --space ${space}`), `bare auth in a space's root fills its Next lines with that space: ${resolved}`);
    assert.doesNotMatch(resolved, /<space>/, "bare auth prints no unfilled placeholder");
    // auth retire never sends a request from this CLI. Its help and refusal say so, and both name the
    // levers that work: revoke-credential for one credential, and rotating the space identity for all.
    const retire = await run(authCommand, root, { space }, ["retire", mintLifecycleUid()]);
    assert.equal(retire.failure?.code, "UNSUPPORTED", `auth retire refuses: ${retire.failure?.message ?? retire.out}`);
    assert.equal(exitCode(retire.failure!.outcome, retire.failure!.code), 2, "auth retire exits 2");
    assert.match(retire.failure?.message ?? "", /^this CLI cannot retire a lifecycle: .*no request was sent$/, "auth retire says what it cannot do");
    assert.ok(retire.failure?.remedy?.startsWith("to stop one minted credential and keep the space's store: cotal down, then cotal auth revoke-credential <its creds file or public key> --yes, then cotal up."), `auth retire names revoke-credential first: ${retire.failure?.remedy}`);
    assert.ok(retire.failure?.remedy?.includes(`To stop every credential the space issued, rotate its identity: cotal down, then cotal reset space ${space}`), `and identity rotation as the wider step: ${retire.failure?.remedy}`);
    assert.ok(retire.failure?.remedy?.includes("That reset also removes the space's store, with its workflow runs and their journals, channel history") && retire.failure.remedy.includes(`cotal reset space ${space} --dry-run`), `auth retire's next step says the reset removes the store and names its dry run: ${retire.failure?.remedy}`);
    const retireHelp = authCommand.subcommands?.find((sub) => sub.name === "retire")?.summary ?? "";
    assert.ok(retireHelp.startsWith("not available from this CLI") && retireHelp.includes("revoke-credential") && retireHelp.includes("reset space"), `help says retire is not available here and names both levers: ${retireHelp}`);
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
    const bare = await run(actorCommand, root, { space }, ["grant", "alice"]);
    assert.equal(bare.failure?.message, `space "${space}" is an open space and has no user-auth ledger; no inert grant was written`, `actor grant with no --sub or ACL flags on an open space refuses the same way: ${bare.failure?.message ?? bare.out}`);
    const endpoint = await run(serviceEndpointCommand, root, { space }, ["proposal", "p1"]);
    assert.equal(endpoint.failure?.message, `space "${space}" is an open space and has no service endpoint host; nothing was sent`, `service-endpoint on an open space says why: ${endpoint.failure?.message ?? endpoint.out}`);
  }
} finally {
  process.chdir(startCwd);
  if (priorHome === undefined) delete process.env.COTAL_HOME;
  else process.env.COTAL_HOME = priorHome;
  rmSync(base, { recursive: true, force: true });
}

console.log("actor-target smoke: OK - actor list and auth grants resolve and refuse alike: no space is TARGET_NOT_FOUND with a next step and no assumed main, a root without the user-auth ledger is UNSUPPORTED, a static or open space says grants need a user-auth space, a user-auth space lists the same row, and bare auth names a real space or cotal space");
emitSentinel({ passed: cells(), failed: 0 });
