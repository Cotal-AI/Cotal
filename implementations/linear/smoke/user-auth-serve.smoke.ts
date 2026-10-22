/**
 * The pure half of serving on a per-user-auth mesh, with no broker, authority or account: the
 * registration this build submits, the persisted request identities, and the serve grant derived
 * from a registration snapshot. The connected path (register, activate, the callout connection,
 * ready and renew) needs a hosted auth service and is not exercised here.
 *
 * Run: pnpm --filter @cotal-ai/linear test   (needs `pnpm build` of core and workspace first)
 */
import { contractDigest, createSpaceAuth, DEV_OWNER, mintLifecycleUid, parseServiceAuthorityRequest, type ServiceRegistrationSnapshot, type ServiceRegistrationWitness } from "@cotal-ai/core";
import { LINEAR_COMMANDS, linearClusterArtifacts, linearContractArtifactValues } from "../src/contract.js";
import { linearUserAuthRegistration, linearUserAuthServeGrant, parseLinearUserAuthKeys } from "../src/user-auth-serve.js";

let pass = 0, fail = 0;
const check = (n: string, c: boolean, x?: unknown): void => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ FAIL: ${n}`, x ?? ""); } };
const refuses = (f: () => unknown): boolean => { try { f(); return false; } catch { return true; } };
const refusesAsync = async (f: () => Promise<unknown>): Promise<boolean> => { try { await f(); return false; } catch { return true; } };

const space = "lnr", endpoint = "com.example.linear", instanceId = mintLifecycleUid();
const accountPublicKey = (await createSpaceAuth(space)).account.pub;
const artifacts = linearClusterArtifacts();

// ---- registration ----
const registration = linearUserAuthRegistration();
const schemas = linearContractArtifactValues().map((v) => contractDigest(v));
check("the registration names this build's closure and carries its manifest, root document and command schema closures",
  registration.clusterDigests.length === 1 && registration.clusterDigests[0] === artifacts.closureDigest
  && registration.contractArtifacts.length === 2 + schemas.length && contractDigest(registration.contractArtifacts[0]) === artifacts.closureDigest
  && contractDigest(registration.contractArtifacts[1]) === artifacts.rootDigest
  && registration.contractArtifacts.slice(2).every((v, i) => contractDigest(v) === schemas[i]), registration.contractArtifacts.length);
const declared = new Set(artifacts.document.commands.flatMap((c) => [c.inputDigest, c.outputDigest]));
check("every command's input and output schema closure manifest is in the registration", [...declared].every((d) => schemas.includes(d)), [...declared]);
check("the same build submits byte-identical registrations, so a replay keeps its request body",
  JSON.stringify(linearUserAuthRegistration()) === JSON.stringify(registration));

// ---- persisted request identities ----
const keys = { v: 1, kind: "linear-user-auth-serve", space, accountPublicKey, endpoint, instanceId, register: "0".repeat(32) };
const served = { ...keys, serving: { witnessDigest: `sha256:${"a".repeat(64)}`, activate: "1".repeat(32), renew: "2".repeat(32), ready: "3".repeat(32) } };
check("a registered-only identity record parses unchanged", JSON.stringify(parseLinearUserAuthKeys(JSON.parse(JSON.stringify(keys)))) === JSON.stringify(keys));
check("a serving identity record parses unchanged", JSON.stringify(parseLinearUserAuthKeys(JSON.parse(JSON.stringify(served)))) === JSON.stringify(served));
check("an identity record with an unknown field is refused", refuses(() => parseLinearUserAuthKeys({ ...keys, extra: 1 })));
check("an identity record with a malformed request id is refused", refuses(() => parseLinearUserAuthKeys({ ...served, serving: { ...served.serving, renew: "xyz" } })));

// ---- the register request the runner sends ----
const register = { v: 1, kind: "service-endpoint-authority", requestId: keys.register, space, accountPublicKey, endpoint, instanceId,
  operation: "register", registration, expected: { state: "unregistered" } };
check("the register request the runner builds passes the authority's request grammar",
  !refuses(() => parseServiceAuthorityRequest(register)));

// ---- the serve grant from a registration snapshot ----
const owner = DEV_OWNER;
const witness = { accountPublicKey, space, endpoint, instanceId, principal: { owner, actor: "cli", lifecycleUid: mintLifecycleUid() }, rootCredentialId: "r",
  approvalDigest: `sha256:${"c".repeat(64)}`, processEpoch: 3, registrationRevision: 17, nameAuthorityRevision: 5, registrationRequestId: keys.register, registrationProof: "p" } as ServiceRegistrationWitness;
const snapshot = (clusterDigests: string[]): ServiceRegistrationSnapshot => ({
  spec: { value: { endpoint, owner, clusterDigests, protocol: { v: 1 } }, revision: 17 }, name: { authorized: true, revision: 5 }, processEpoch: 3,
  contractArtifacts: [artifacts.manifest, artifacts.document],
});
const grant = await linearUserAuthServeGrant(space, witness, snapshot([artifacts.closureDigest]));
check("the derived grant binds the witness's endpoint, instance, epoch, owner and revisions",
  grant.space === space && grant.endpoint === endpoint && grant.instanceId === instanceId && grant.epoch === 3 && grant.owner === owner
  && grant.registrationRevision === 17 && grant.nameAuthorityRevision === 5, grant);
check("the derived grant serves exactly the Linear commands, as ephemeral commands with the linear.mcp capability",
  JSON.stringify(grant.commands) === JSON.stringify([...LINEAR_COMMANDS].sort())
  && grant.commands.every((c) => grant.surface[c]?.class === "ephemeral" && grant.surface[c]?.capability === "linear.mcp"), grant.commands);
check("a snapshot registering another closure derives no grant",
  await refusesAsync(() => linearUserAuthServeGrant(space, witness, snapshot([`sha256:${"d".repeat(64)}`]))));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
