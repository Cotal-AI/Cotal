import assert from "node:assert/strict";
import { Kvm } from "@nats-io/kv";
import { PermissionViolationError } from "@nats-io/transport-node";
import { epAuthBucket, mintCreds, newIdentity, setupSpaceStreams } from "@cotal-ai/core";
import { emitSentinel } from "@cotal-ai/smoke-kit";
import { authorityWriterGrants, environmentManagerAdmissionWriterGrants, remoteManagerIssuerGrants, openAuthorityClient, type AuthorityClient } from "../src/authority-client.js";
import { startHostedAuthFixture } from "./_hosted-auth-fixture.js";

let passed = 0;
function check(name: string, value: unknown) { assert.ok(value, name); passed++; console.log(`PASS ${name}`); }
const fixture = await startHostedAuthFixture("consent-acl", 1);
const account = fixture.accounts[0]!;
const clients: AuthorityClient[] = [];
try {
  await setupSpaceStreams({ servers: fixture.servers, space: account.space, creds: await mintCreds(account.auth, newIdentity(), "provisioner") });
  const open = async (label: string, grants: typeof authorityWriterGrants) => {
    const client = await openAuthorityClient({ server: fixture.servers, space: account.space,
      dataAccount: { pub: account.accountPublicKey, signingSeed: account.auth.account.signingSeed! }, label,
      grants: id => grants(account.space, id), log: () => {} });
    clients.push(client); return client;
  };
  const writer = await open("consent-acl-writer", authorityWriterGrants);
  const kv = await new Kvm(writer.nc).open(epAuthBucket(account.space));
  const bytes = new TextEncoder().encode("consent-acl-control");
  const revision = await kv.put("consent.writer", bytes, { previousSeq: 0 });
  check("auth-writer consent publish receives a real broker persistence acknowledgement", revision > 0);
  check("auth-writer consent bytes are durably readable", (await kv.get("consent.writer"))?.string() === "consent-acl-control");
  for (const [label, grants] of [["environment-admission-writer", environmentManagerAdmissionWriterGrants], ["remote-manager-issuer", remoteManagerIssuerGrants]] as const) {
    const client = await open(`consent-acl-${label}`, grants);
    const key = `consent.${label}`;
    const subject = `$KV.${epAuthBucket(account.space)}.${key}`;
    let denied: unknown;
    try { await client.nc.request(subject, bytes, { timeout: 2_000 }); }
    catch (error) { denied = error instanceof PermissionViolationError ? error : (error as Error).cause; }
    check(`${label} receives native publish permission denial on the consent subject`,
      denied instanceof PermissionViolationError && denied.operation === "publish" && denied.subject === subject);
    check(`${label} cannot create a consent KV row`, await kv.get(key) === null);
  }
  console.log(`tool-result-consent-acl: ${passed} passed, 0 failed`);
  emitSentinel({ passed, failed: 0 });
} finally {
  await Promise.all(clients.map(client => client.close()));
  await fixture.close();
}
