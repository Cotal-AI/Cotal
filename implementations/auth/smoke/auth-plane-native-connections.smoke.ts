/** Native authority-plane connection custody, including failed construction after client acquisition. */
import assert from "node:assert/strict";
import { decode, encodeAccount, encodeUser, type Account } from "@nats-io/jwt";
import { fromPublic, fromSeed } from "@nats-io/nkeys";
import { connect, credsAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import { credsFromJwt, mintAccountCensusCreds, mintCreds, newIdentity, observeAccountCensusWithCreds, pushAccountClaim, setupSpaceStreams, wakeAccountClaim } from "@cotal-ai/core";
import { createSuite } from "@cotal-ai/smoke-kit";
import { openAuthAuthorityPlane, type AuthAuthorityPlaneHandle } from "../dist/index.js";
import { startHostedAuthFixture } from "./_hosted-auth-fixture.js";

const { check, finish, passed, failed } = createSuite();
const fx = await startHostedAuthFixture("authority-native", 3, { fullResolver: true, keepFiles: process.argv.includes("--keep-fixture") });
const handles: AuthAuthorityPlaneHandle[] = [], clients: NatsConnection[] = [];
const bytes = (value: string) => new TextEncoder().encode(value);
try {
  for (const a of fx.accounts) await setupSpaceStreams({ servers: fx.servers, space: a.space, creds: await mintCreds(a.auth, newIdentity(), "provisioner") });
  const options = (index: number) => {
    const a = fx.accounts[index]!;
    return { server: fx.servers, space: a.space, dir: a.stateDir, identityRoot: a.stateDir, identityStore: a.store,
      dataAccount: { pub: a.accountPublicKey, signingSeed: a.auth.account.signingSeed }, log: () => {} };
  };
  const a = await openAuthAuthorityPlane(options(0)); handles.push(a);
  const b = await openAuthAuthorityPlane(options(1)); handles.push(b);
  const serverId = a.nativeConnections()[0]!.serverId;
  const census = async (index: number) => {
    const account = fx.accounts[index]!;
    const result = await observeAccountCensusWithCreds({ servers: fx.servers, observerCreds: await mintAccountCensusCreds(account.auth, newIdentity()),
      accountId: account.accountPublicKey, expectedServerId: serverId });
    assert.equal(result.state, "complete");
    if (result.state !== "complete") throw new Error("native account census is incomplete");
    return result.connections;
  };
  const matches = async (index: number, plane: AuthAuthorityPlaneHandle) => {
    const owned = plane.nativeConnections(), native = await census(index);
    return owned.length > 0 && owned.length === native.length && owned.every(row => row.serverId === serverId && native.some(conn => conn.cid === row.cid));
  };
  check("first standalone plane exposes every current native data connection", await matches(0, a));
  check("second account has its own independently matching connection inventory", await matches(1, b));
  check("native metadata contains no credential or connection object", a.nativeConnections().every(row => Object.keys(row).sort().join(",") === "cid,label,serverId"));
  const first = a.nativeConnections()[0]!, actualCid = first.cid; first.cid = -1; first.label = "changed-copy";
  check("a caller cannot mutate the plane's custody through returned metadata", a.nativeConnections()[0]!.cid === actualCid && a.nativeConnections()[0]!.label !== "changed-copy");
  const bBefore = b.nativeConnections();
  check("the two account handles never share a native connection ID", a.nativeConnections().every(row => !bBefore.some(other => other.cid === row.cid)));
  await a.close();
  const terminal = await a.closed;
  check("successful close resolves only with ended tracked clients and no native bindings", terminal.connections.length > 0 && terminal.connections.every(row => row.ended) && a.nativeConnections().length === 0);
  check("the first account's real broker census is empty after close", (await census(0)).length === 0);
  check("closing one plane leaves the other account's clients unchanged", await matches(1, b) && JSON.stringify(b.nativeConnections()) === JSON.stringify(bBefore));

  // A real account connection limit interrupts the third construction. Native census observes
  // acquired clients during the attempt; removing the limit is the same-account positive control.
  const limited = fx.accounts[2]!, sysId = newIdentity(), sysSigner = fromSeed(bytes(limited.auth.sys.signingSeed!));
  let systemJwt: string;
  try { systemJwt = await encodeUser("owned-authority-limit", fromPublic(sysId.id), fromPublic(limited.auth.sys.pub), {
    pub: { allow: [`$SYS.REQ.ACCOUNT.${limited.accountPublicKey}.CLAIMS.UPDATE`] }, sub: { allow: [`_INBOX_${sysId.id}.>`] },
  }, { signer: sysSigner, exp: Math.floor(Date.now() / 1000) + 120 }); } finally { sysSigner.clear(); }
  const system = await connect({ servers: fx.servers, authenticator: credsAuthenticator(bytes(credsFromJwt(systemJwt, sysId))), inboxPrefix: `_INBOX_${sysId.id}`, reconnect: false });
  clients.push(system);
  const previousSecond = Math.floor(Date.now() / 1000);
  while (Math.floor(Date.now() / 1000) <= previousSecond) await new Promise(resolve => setTimeout(resolve, 20));
  const original = decode<Account>(limited.auth.account.jwt), operator = fromSeed(bytes(limited.auth.operator.seed));
  let capped: string;
  try { capped = await encodeAccount(original.name, fromPublic(limited.accountPublicKey), { ...original.nats, limits: { ...original.nats.limits, conn: 2 } }, { signer: operator }); }
  finally { operator.clear(); }
  await pushAccountClaim(system, { accountJwt: capped, expectedServerIds: [serverId], maxWaitMs: 3_000 });
  let sampling = true, mostConnections = 0;
  const sampled = (async () => { while (sampling) mostConnections = Math.max(mostConnections, (await census(2)).length); })();
  try { await assert.rejects(openAuthAuthorityPlane(options(2)), /connection|maximum|limit|timeout/i); }
  finally { sampling = false; await sampled; }
  check("late construction failure releases clients observed by the real broker", mostConnections > 0 && (await census(2)).length === 0);
  await pushAccountClaim(system, { accountJwt: await wakeAccountClaim(limited.auth, limited.auth.account.jwt, Math.floor(Date.now() / 1000)), expectedServerIds: [serverId], maxWaitMs: 3_000 });
  const recovered = await openAuthAuthorityPlane(options(2)); handles.push(recovered);
  check("the same account opens and matches native census once its limit is removed", await matches(2, recovered));
  check("failed construction in another account leaves the healthy plane intact", await matches(1, b) && JSON.stringify(b.nativeConnections()) === JSON.stringify(bBefore));
} catch (error) { check(`harness: ${error instanceof Error ? error.stack : String(error)}`, false); }
finally {
  for (const handle of handles.reverse()) {
    try { await handle.close(); } catch (error) { check(`plane cleanup: ${String(error)}`, false); }
  }
  for (const client of clients.reverse()) await client.close();
  await fx.close();
  if (passed() + failed() !== 11) check(`cell count: ran ${passed() + failed()}, expected 11`, false);
  finish();
}
process.exit(process.exitCode ?? 0);
