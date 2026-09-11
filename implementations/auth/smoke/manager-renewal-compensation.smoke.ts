/**
 * Hosted manager renewal compensation over the shipped authority plane and real auth KV.
 * Run: pnpm smoke:manager-renewal-compensation   (needs nats-server on PATH)
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kvm } from "@nats-io/kv";
import { jetstreamManager } from "@nats-io/jetstream";
import {
  createEndpointStreams,
  createSpaceAuth,
  credsFromJwt,
  ensureAuthorityStores,
  epAuthBucket,
  epcredRowKey,
  isReachable,
  mintLifecycleUid,
  newIdentity,
  parseLedgerRow,
  remoteManagerActors,
  serverConfig,
  serveIssuanceGateKv,
  type EpGateState,
  type EpIssuanceGate,
  type EpServeLedgerRow,
  type RemoteManagerAuthorityRequest,
} from "@cotal-ai/core";
import { killAndAwaitExit, SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { openAuthAuthorityPlane } from "../src/service.js";
import { openAuthorityClient } from "../src/authority-client.js";
import { remoteManagerRegistrationProof } from "../src/authority-client.js";
import { ManagerRenewalCompensation } from "../src/renewal-compensation.js";
import { managerClusterArtifacts } from "../../manager/src/manager-service-contract.js";
import { registerRemoteManagerAuthority } from "../../manager/src/remote-register.js";
import { pickFreePort } from "../../../packages/core/smoke/_free-port.js";

const port = await pickFreePort();
const server = `nats://127.0.0.1:${port}`;
const space = `renew-clean-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dataAccount = { pub: auth.account.pub, signingSeed: auth.account.signingSeed };
const tmp = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const dir = join(tmp, "state");
mkdirSync(dir, { recursive: true });
writeFileSync(join(tmp, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port, storeDir: join(tmp, "js") }));
const broker = spawn("nats-server", ["-c", join(tmp, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(broker, tmp);
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const quiet = () => {};
let assertionCount = 0;
const expectedAssertions = 5 + 5 + 5 + (2 * 4) + 3 + 3 + (4 * 6) + 3 + 2 + 6 + 1;
const measured = {
  equal: (actual: unknown, expected: unknown, name: string): void => { assertionCount++; assert.equal(actual, expected, name); console.log(`  PASS: ${name}`); },
  match: (actual: string, expected: RegExp, name: string): void => { assertionCount++; assert.match(actual, expected, name); console.log(`  PASS: ${name}`); },
  ok: (actual: unknown, name: string): void => { assertionCount++; assert.ok(actual, name); console.log(`  PASS: ${name}`); },
};
const wallClockNow = Date.now.bind(Date);
let issuanceClockMs = Math.floor(wallClockNow() / 1000) * 1000;
const atIssuanceClock = async <T>(run: () => Promise<T>): Promise<T> => {
  const before = Date.now;
  Date.now = () => issuanceClockMs;
  try { return await run(); }
  finally { Date.now = before; }
};

const owner = "u_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const instanceId = mintLifecycleUid();
const managerLifecycleUid = mintLifecycleUid();
const identities = {
  supervisor: newIdentity(),
  executor: newIdentity(),
  serve: newIdentity(),
  goalWriter: newIdentity(),
  sessionLedger: newIdentity(),
};
const publicIdentities = Object.fromEntries(Object.entries(identities).map(([key, value]) => [key, { id: value.id }])) as RemoteManagerAuthorityRequest["identities"];
const base = {
  v: 1 as const,
  kind: "manager-service-authority" as const,
  space,
  actor: "cli",
  instanceId,
  managerLifecycleUid,
  identities: publicIdentities,
};
const request = (operation: RemoteManagerAuthorityRequest["operation"], registrationProof?: string, contractArtifacts?: unknown[]): RemoteManagerAuthorityRequest => ({
  ...base,
  operation,
  requestId: `${operation}${mintLifecycleUid()}`,
  ...(registrationProof ? { registrationProof } : {}),
  ...(contractArtifacts ? { contractArtifacts } : {}),
});

let wide: Awaited<ReturnType<typeof openAuthorityClient>> | undefined;
let plane: Awaited<ReturnType<typeof openAuthAuthorityPlane>> | undefined;
let primaryError: unknown;
try {
  for (let attempt = 0; attempt < 50 && !(await isReachable(server)); attempt++) await wait(100);
  measured.equal(await isReachable(server), true, "fixture: nats-server starts");
  wide = await openAuthorityClient({ server, space, dataAccount, label: `renew-clean-fixture:${space}`, grants: (id) => ({ publish: [">"], subscribe: [`_INBOX_${id}.>`] }), log: quiet });
  const kvm = new Kvm(wide.nc);
  await ensureAuthorityStores(await jetstreamManager(wide.nc), kvm, space);
  await createEndpointStreams(await jetstreamManager(wide.nc), kvm, space);
  plane = await openAuthAuthorityPlane({ server, space, dir, dataAccount, log: quiet });

  const prepare = request("prepare");
  const prepared = await plane.issueManagerServiceAuthority({ owner, scope: ["supervise"], request: prepare });
  await registerRemoteManagerAuthority({
    space,
    server,
    owner,
    instanceId,
    serveActor: remoteManagerActors(instanceId).serve,
    prepareCreds: credsFromJwt(prepared.credentials.executor!.jwt, identities.executor),
    tlsRequired: false,
  });
  const artifacts = managerClusterArtifacts();
  const activateTemplate = request("activate", `sha256:${"0".repeat(64)}`, [artifacts.document, artifacts.manifest]);
  const activationProof = remoteManagerRegistrationProof(owner, activateTemplate);
  const activated = await atIssuanceClock(() => plane!.issueManagerServiceAuthority({ owner, scope: ["supervise"], request: { ...activateTemplate, registrationProof: activationProof } }));
  const proof = activated.nextRegistrationProof!;
  measured.match(proof, /^sha256:[0-9a-f]{64}$/, "activation: returns a current registration proof");

  const authKv = await kvm.open(epAuthBucket(space));
  const actors = remoteManagerActors(instanceId);
  const roleByHolder = new Map([
    [`${owner}.${actors.serve}`, "serve"],
    [`${owner}.${actors.goalWriter}`, "goalWriter"],
    [`${owner}.${actors.sessionLedger}`, "sessionLedger"],
  ] as const);
  const family = async () => {
    const rows: Array<{ key: string; role: string; state: "active" | "revoked" }> = [];
    const keys = await authKv.keys();
    for await (const key of keys) {
      if (!key.startsWith(`epcred.manager.${instanceId}.`)) continue;
      const entry = await authKv.get(key);
      if (entry?.operation === "PUT") {
        const row = parseLedgerRow(entry.value, key);
        rows.push({ key, role: roleByHolder.get(row.holderPrincipal as never) ?? "unknown", state: row.state });
      }
    }
    return rows.sort((a, b) => a.role.localeCompare(b.role) || a.state.localeCompare(b.state) || a.key.localeCompare(b.key));
  };
  const initialFamily = await family();
  measured.equal(initialFamily.length, 3, "activation: creates the complete serve/goal/session endpoint family");
  measured.equal(initialFamily.every((row) => row.state === "active"), true, "activation: the prior complete family starts active");
  measured.equal([...new Set(initialFamily.map((row) => row.role))].sort().join(","), "goalWriter,serve,sessionLedger", "activation: classifies all three endpoint rows by role");
  const initialByRole = new Map(initialFamily.map((row) => [row.role, row]));
  const delta = async <T>(run: () => Promise<T>) => {
    const before = await family();
    let error: Error | undefined;
    try { await run(); } catch (value) { error = value as Error; }
    const after = await family();
    return { before, after, error, fresh: after.filter((row) => !before.some((old) => old.key === row.key)) };
  };

  // Activation and this renewal are deliberately minted at the exact same epoch second. The
  // endpoint-serve JWT is byte-identical, so its digest names the already-active serve row. This is
  // the collision that compensation must classify as reuse rather than ownership: the failed request
  // creates no ledger row and must never revoke any member of the prior complete family.
  await plane.close();
  plane = await openAuthAuthorityPlane({
    server, space, dir, dataAccount, log: quiet,
    probeRenewalFault: (at) => { if (at === "after-serve-finalize") throw new Error("owner fault at after-serve-finalize"); },
  });
  const sameClock = await delta(() => atIssuanceClock(() => plane!.issueManagerServiceAuthority({
    owner, scope: ["supervise"], request: request("renew", proof),
  })));
  measured.match(sameClock.error?.message ?? "", /after-serve-finalize/, "same-clock: renewal reaches the fault after reusing serve");
  measured.equal(sameClock.fresh.length, 0, "same-clock: after-serve failure creates no new ledger row");
  measured.equal(sameClock.after.length, initialFamily.length, "same-clock: compensation retains exactly the prior complete family");
  measured.equal(sameClock.after.find((row) => row.key === initialByRole.get("serve")?.key)?.state, "active", "same-clock: compensation leaves the exact reused serve row active");
  measured.equal(initialFamily.every((old) => sameClock.after.some((row) => row.key === old.key && row.role === old.role && row.state === "active")), true, "same-clock: compensation preserves every role in the prior complete generation");

  const sameClockActivationTemplate = request("activate", `sha256:${"0".repeat(64)}`, [artifacts.document, artifacts.manifest]);
  const sameClockActivation = await delta(() => atIssuanceClock(() => plane!.issueManagerServiceAuthority({
    owner, scope: ["supervise"], request: {
      ...sameClockActivationTemplate,
      registrationProof: remoteManagerRegistrationProof(owner, sameClockActivationTemplate),
    },
  })));
  measured.match(sameClockActivation.error?.message ?? "", /after-serve-finalize/, "same-clock activation: the manager wrapper reaches its issuance fault");
  measured.equal(sameClockActivation.fresh.length, 0, "same-clock activation: reuse creates no new ledger row");
  measured.equal(sameClockActivation.after.length, initialFamily.length, "same-clock activation: rollback retains exactly the prior complete family");
  measured.equal(sameClockActivation.after.find((row) => row.key === initialByRole.get("serve")?.key)?.state, "active", "same-clock activation: rollback leaves the reused serve row active");
  measured.equal(initialFamily.every((old) => sameClockActivation.after.some((row) => row.key === old.key && row.role === old.role && row.state === "active")), true, "same-clock activation: rollback preserves every prior role");

  // The public plane above proves the real source reach. These two focused cells drive the shipped
  // compensation wrapper against the same real auth KV while controlling only the collaborator's
  // gate CAS result. A CAS loser must conserve a byte-identical reused row, while still revoking a row
  // that this request atomically created. No copy of either ownership implementation appears here.
  const wrapperCasLoss = async (expectedOwnership: "created" | "reused") => {
    const focusedInstanceId = mintLifecycleUid();
    const realGate = serveIssuanceGateKv(authKv, space, { endpoint: "manager", instanceId: focusedInstanceId });
    const observed: EpGateState = {
      space, endpoint: "manager", lifecycleUid: focusedInstanceId,
      principal: `${owner}.${actors.serve}`, state: "open", generation: 0, processEpoch: 0,
      registrationRevision: 0, nameAuthorityRevision: 0, revision: 1,
    };
    const row: EpServeLedgerRow = {
      credentialId: `sha256-${randomUUID().replaceAll("-", "")}`,
      credentialKey: identities.serve.id,
      holderPrincipal: observed.principal,
      endpoint: observed.endpoint,
      lifecycleUid: observed.lifecycleUid,
      sourceChain: ["root"], state: "active", exp: Math.floor(issuanceClockMs / 1000) + 86_400,
      generation: observed.generation, processEpoch: observed.processEpoch,
      registrationRevision: observed.registrationRevision, nameAuthorityRevision: observed.nameAuthorityRevision,
    };
    if (expectedOwnership === "reused") await realGate.stage(row);
    let underlyingRevokes = 0;
    let reportedOwnership: "created" | "reused" | undefined;
    const controlledGate: EpIssuanceGate & { stageOwned: (row: EpServeLedgerRow) => Promise<"created" | "reused"> } = {
      observe: () => observed,
      stage: (candidate: EpServeLedgerRow) => realGate.stage(candidate),
      stageOwned: async (candidate: EpServeLedgerRow) => {
        reportedOwnership = await realGate.stageOwned(candidate);
        return reportedOwnership;
      },
      commit: () => false,
      revoke: async (candidate: EpServeLedgerRow) => { underlyingRevokes++; await realGate.revoke(candidate); },
    };
    const compensation = new ManagerRenewalCompensation(authKv, controlledGate, focusedInstanceId, `renew${mintLifecycleUid()}`);
    await compensation.begin();
    const wrapped = compensation.wrap("serve");
    await wrapped.stage(row);
    measured.equal(reportedOwnership, expectedOwnership, `wrapper ${expectedOwnership}: stage records the real gate's atomic row ownership`);
    measured.equal(await wrapped.commit(observed.revision), false, `wrapper ${expectedOwnership}: controlled gate commit loses its CAS`);
    await wrapped.revoke(row);
    measured.equal(underlyingRevokes, expectedOwnership === "created" ? 1 : 0, `wrapper ${expectedOwnership}: lost-CAS revoke ownership is conserved`);
    const rowKey = epcredRowKey(row.endpoint, row.lifecycleUid, row.credentialId);
    const stored = await authKv.get(rowKey);
    measured.equal(stored?.operation === "PUT" ? parseLedgerRow(stored.value, rowKey).state : "missing", expectedOwnership === "created" ? "revoked" : "active", `wrapper ${expectedOwnership}: real auth KV retains the required terminal row state`);
  };
  await wrapperCasLoss("reused");
  await wrapperCasLoss("created");

  // Explicit revocation preserves the shared gate's published contract after an idempotent restage.
  // Request-owned rollback belongs in the manager wrapper above, rather than suppressing a caller's
  // explicit revoke of an existing ledger row.
  const directInstanceId = mintLifecycleUid();
  const directGate = serveIssuanceGateKv(authKv, space, { endpoint: "manager", instanceId: directInstanceId });
  const directRow: EpServeLedgerRow = {
    credentialId: `sha256-${randomUUID().replaceAll("-", "")}`,
    credentialKey: identities.serve.id,
    holderPrincipal: `${owner}.${actors.serve}`,
    endpoint: "manager", lifecycleUid: directInstanceId, sourceChain: ["root"], state: "active",
    exp: Math.floor(issuanceClockMs / 1000) + 86_400,
    generation: 0, processEpoch: 0, registrationRevision: 0, nameAuthorityRevision: 0,
  };
  const directKey = epcredRowKey(directRow.endpoint, directRow.lifecycleUid, directRow.credentialId);
  const directState = async () => {
    const stored = await authKv.get(directKey);
    return stored?.operation === "PUT" ? parseLedgerRow(stored.value, directKey).state : "missing";
  };
  await directGate.stage(directRow);
  measured.equal(await directState(), "active", "real gate: ordinary stage creates an active row");
  await directGate.stage(directRow);
  await directGate.revoke(directRow);
  measured.equal(await directState(), "revoked", "real gate: explicit revoke remains effective after an identical restage");
  await serveIssuanceGateKv(authKv, space, { endpoint: "manager", instanceId: directInstanceId }).revoke(directRow);
  measured.equal(await directState(), "revoked", "real gate: repeated explicit revoke is idempotent");

  // A collaborator that reports an atomic create but loses the staged row is corruption, not the
  // ordinary prepared-before-create crash window. The durable intent lives in the real auth KV. Its
  // created ownership must keep cleanup pending and must not manufacture a revoke against absence.
  const missingInstanceId = mintLifecycleUid();
  const missingObserved: EpGateState = {
    space, endpoint: "manager", lifecycleUid: missingInstanceId,
    principal: `${owner}.${actors.serve}`, state: "open", generation: 0, processEpoch: 0,
    registrationRevision: 0, nameAuthorityRevision: 0, revision: 1,
  };
  const missingRow: EpServeLedgerRow = {
    credentialId: `sha256-${randomUUID().replaceAll("-", "")}`,
    credentialKey: identities.serve.id,
    holderPrincipal: missingObserved.principal,
    endpoint: missingObserved.endpoint,
    lifecycleUid: missingObserved.lifecycleUid,
    sourceChain: ["root"], state: "active", exp: Math.floor(issuanceClockMs / 1000) + 86_400,
    generation: missingObserved.generation, processEpoch: missingObserved.processEpoch,
    registrationRevision: missingObserved.registrationRevision, nameAuthorityRevision: missingObserved.nameAuthorityRevision,
  };
  let missingRevokes = 0;
  const missingGate: EpIssuanceGate & { stageOwned: (row: EpServeLedgerRow) => Promise<"created"> } = {
    observe: () => missingObserved,
    stage: () => {},
    stageOwned: async () => "created",
    commit: () => false,
    revoke: () => { missingRevokes++; },
  };
  const missingCompensation = new ManagerRenewalCompensation(authKv, missingGate, missingInstanceId, `renew${mintLifecycleUid()}`);
  await missingCompensation.begin();
  await missingCompensation.wrap("serve").stage(missingRow);
  let missingError: Error | undefined;
  try { await missingCompensation.compensate(new Error("owner fault with created prepared row absent")); }
  catch (error) { missingError = error as Error; }
  measured.match(missingError?.message ?? "", /ALSO renewal compensation revoke failed for 1 role \(serve\)/, "missing created row: cleanup remains explicit debt");
  measured.equal(missingRevokes, 0, "missing created row: cleanup never calls revoke against an absent row");
  measured.equal(await authKv.get(epcredRowKey(missingRow.endpoint, missingRow.lifecycleUid, missingRow.credentialId)), null, "missing created row: collaborator did not silently create test evidence");

  const faultCases = [
    ["after-serve-finalize", ["serve"]],
    ["after-goal-finalize", ["goalWriter", "serve"]],
    ["after-session-finalize", ["goalWriter", "serve", "sessionLedger"]],
    ["before-response", ["goalWriter", "serve", "sessionLedger"]],
  ] as const;
  for (const [point, expectedRoles] of faultCases) {
    // Each remaining cell is a truly fresh generation, not an accidental same-second digest reuse.
    issuanceClockMs += 1_000;
    await plane.close();
    plane = await openAuthAuthorityPlane({
      server, space, dir, dataAccount, log: quiet,
      probeRenewalFault: (at) => { if (at === point) throw new Error(`owner fault at ${point}`); },
    });
    const renewal = request("renew", proof);
    const out = await delta(() => atIssuanceClock(() => plane!.issueManagerServiceAuthority({ owner, scope: ["supervise"], request: renewal })));
    measured.match(out.error?.message ?? "", new RegExp(point), `${point}: fault is attributed by name`);
    measured.equal(out.fresh.length, expectedRoles.length, `${point}: retains exactly its finalized rows`);
    measured.equal(out.fresh.map((row) => row.role).sort().join(","), [...expectedRoles].sort().join(","), `${point}: retains only its finalized roles`);
    measured.equal(out.fresh.every((row) => row.state === "revoked"), true, `${point}: every owned row is retained revoked`);
    measured.ok(out.before.every((old) => out.after.some((row) => row.key === old.key && row.state === old.state)), `${point}: does not change any older row`);
    measured.equal(out.after.filter((row) => initialFamily.some((initial) => initial.key === row.key)).every((row) => row.state === "active"), true, `${point}: preserves the pre-existing active generation`);
  }

  issuanceClockMs += 1_000;
  await plane.close();
  let failIssue = true;
  let revokeFailures = 2;
  plane = await openAuthAuthorityPlane({
    server, space, dir, dataAccount, log: quiet,
    probeRenewalFault: (at, role) => {
      if (at === "after-session-finalize" && failIssue) { failIssue = false; throw new Error("owner fault after session finalize"); }
      if (at === "revoke" && role === "goalWriter" && revokeFailures > 0) { revokeFailures--; throw new Error("owner revoke fault"); }
    },
  });
  const failedRenewal = request("renew", proof);
  const failed = await delta(() => atIssuanceClock(() => plane!.issueManagerServiceAuthority({ owner, scope: ["supervise"], request: failedRenewal })));
  measured.match(failed.error?.message ?? "", /ALSO renewal compensation revoke failed for 1 role \(goalWriter\)/, "cleanup debt: primary error names the one failed role");
  measured.equal(failed.fresh.length, 3, "cleanup debt: failed issuance owns one complete three-row attempted family");
  measured.equal(failed.fresh.filter((row) => row.state === "revoked").length, 2, "cleanup debt: all non-failing revokes are attempted");

  await plane.close();
  plane = await openAuthAuthorityPlane({
    server, space, dir, dataAccount, log: quiet,
    probeRenewalFault: (at, role) => {
      if (at === "revoke" && role === "goalWriter" && revokeFailures > 0) { revokeFailures--; throw new Error("owner revoke fault after reopen"); }
    },
  });
  const blockedRequest = request("renew", proof);
  const blocked = await delta(() => atIssuanceClock(() => plane!.issueManagerServiceAuthority({ owner, scope: ["supervise"], request: blockedRequest })));
  measured.match(blocked.error?.message ?? "", /prior manager renewal has unresolved cleanup debt/, "cleanup debt: survives a real authority plane close and reopen");
  measured.equal(blocked.fresh.length, 0, "cleanup debt: blocks every new row before minting");

  await plane.close();
  plane = await openAuthAuthorityPlane({ server, space, dir, dataAccount, log: quiet });
  issuanceClockMs += 1_000;
  const retryRequest = request("renew", proof);
  const retried = await delta(() => atIssuanceClock(() => plane!.issueManagerServiceAuthority({ owner, scope: ["supervise"], request: retryRequest })));
  measured.equal(retried.error, undefined, retried.error?.message ?? "cleanup recovery: retry succeeds");
  measured.equal(retried.fresh.length, 3, "cleanup recovery: successful retry creates one three-row endpoint generation");
  measured.equal(retried.fresh.map((row) => row.role).sort().join(","), "goalWriter,serve,sessionLedger", "cleanup recovery: retry restores the complete role family");
  measured.equal(retried.fresh.every((row) => row.state === "active"), true, "cleanup recovery: replacement family is active");
  measured.equal((await family()).filter((row) => failed.fresh.some((failedRow) => failedRow.key === row.key)).every((row) => row.state === "revoked"), true, "cleanup recovery: reconciles the same failed rows before minting");
  measured.equal(initialFamily.every((old) => (retried.after.find((row) => row.key === old.key)?.state === "active")), true, "cleanup recovery: leaves the old complete generation unchanged");

  await plane.close();
  plane = undefined;
  measured.equal((await family()).length > 0, true, "teardown: final normal plane close retains the ledger family");
  assert.equal(assertionCount, expectedAssertions, `assertion census: expected ${expectedAssertions}, measured ${assertionCount}`);
} catch (error) {
  primaryError = error;
} finally {
  let cleanupError: unknown;
  try { await plane?.close(); } catch (error) { cleanupError ??= error; }
  try { await wide?.close(); } catch (error) { cleanupError ??= error; }
  await killAndAwaitExit(broker);
  try { rmSync(tmp, { recursive: true, force: true }); } catch (error) { cleanupError ??= error; }
  releaseBroker();
  primaryError ??= cleanupError;
}
console.log(`manager-renewal-compensation: ${primaryError === undefined ? "passed" : "failed"} (${assertionCount}/${expectedAssertions} assertions)`);
if (primaryError !== undefined) throw primaryError;
