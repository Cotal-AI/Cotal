import assert from "node:assert/strict";
import { createServer, Server } from "node:net";
import { Kvm } from "@nats-io/kv";
import { epAuthBucket, mintCreds, mintLifecycleUid, newIdentity, setupSpaceStreams } from "@cotal-ai/core";
import { emitSentinel } from "@cotal-ai/smoke-kit";
import { authorityBarrierGrants, openAuthorityClient } from "../src/authority-client.js";
import { startAuthService } from "../src/index.js";
import { parsePlaneClaimRow, PLANE_CLAIM_KEY } from "../src/plane-claim.js";
import { startHostedAuthFixture } from "./_hosted-auth-fixture.js";

// Occupied listener: the real hosted start fails after opening its plane. A changed fixture claim
// makes release refuse; the start must keep its bind error and report the release refusal too.
const fx = await startHostedAuthFixture("start-close", 2);
const listen = Server.prototype.listen;
const error = console.error;
let verifier: Awaited<ReturnType<typeof openAuthorityClient>> | undefined;
let busy: Server | undefined;
let count = 0;
const ok = (condition: boolean, name: string) => { assert.ok(condition, name); count++; console.log(`PASS ${name}`); };
try {
  for (const [i, account] of fx.accounts.entries()) {
    const { space, auth, store, stateDir, accountPublicKey } = account;
    const lost = i === 1;
    const name = lost ? "lost claim" : "released claim";
    await setupSpaceStreams({ servers: fx.servers, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
    verifier = await openAuthorityClient({ server: fx.servers, space,
      dataAccount: { pub: auth.account.pub, signingSeed: auth.account.signingSeed! },
      label: "start-close-probe", grants: id => authorityBarrierGrants(space, id), log: () => {} });
    const kv = await new Kvm(verifier.nc).open(epAuthBucket(space));
    busy = createServer();
    await new Promise<void>((resolve, reject) => { busy!.once("error", reject); busy!.listen(0, "127.0.0.1", resolve); });
    const address = busy.address();
    assert.ok(address && typeof address !== "string");
    const port = address.port;
    const lines: string[] = [];
    const replacement = mintLifecycleUid();
    let reached = 0;
    let held = false;
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
    Server.prototype.listen = function (this: Server, ...args: unknown[]) {
      const first = args[0];
      const target = first && typeof first === "object" ? (first as { port?: unknown }).port : first;
      if (Number(target) !== port) return Reflect.apply(listen, this, args);
      reached++;
      Server.prototype.listen = listen;
      void (async () => {
        const entry = await kv.get(PLANE_CLAIM_KEY);
        const row = entry && parsePlaneClaimRow(entry.value);
        held = row?.state === "held";
        if (lost) {
          assert.ok(entry && row?.state === "held");
          await kv.update(PLANE_CLAIM_KEY, new TextEncoder().encode(JSON.stringify({ ...row, claimId: replacement })), entry.revision);
        }
        Reflect.apply(listen, this, args);
      })().catch(e => this.emit("error", e));
      return this;
    } as typeof listen;
    let failure: unknown;
    try {
      await startAuthService({ context: { accountPublicKey, lifecycleUid: `start-close-${i}` },
        space, servers: fx.servers, store, storeIdentity: store.identity, stateDir, port });
    } catch (e) { failure = e; }
    finally { Server.prototype.listen = listen; console.error = error; }
    const entry = await kv.get(PLANE_CLAIM_KEY);
    const row = entry && parsePlaneClaimRow(entry.value);
    ok(reached === 1 && held, `${name}: occupied bind follows the real plane claim`);
    ok(failure instanceof Error && (failure as NodeJS.ErrnoException).code === "EADDRINUSE", `${name}: original bind error is preserved`);
    ok(lines.some(line => line.includes(`plane-claim: space "${space}" held`)), `${name}: claim acquisition is logged`);
    ok(lost ? row?.state === "held" && row.claimId === replacement : row?.state === "released", `${name}: release preserves claim ownership`);
    ok(lines.some(line => line.includes(lost ? `plane-claim: NOT releasing space "${space}"` : `plane-claim: released space "${space}"`)), `${name}: release result is logged`);
    await verifier.close(); verifier = undefined;
    await new Promise<void>(resolve => busy!.close(() => resolve())); busy = undefined;
  }
  console.log(`hosted auth failed-start close: ${count} assertions passed`);
  emitSentinel({ passed: count, failed: 0 });
} finally {
  Server.prototype.listen = listen; console.error = error;
  await verifier?.close();
  if (busy?.listening) await new Promise<void>(resolve => busy!.close(() => resolve()));
  await fx.close();
}
