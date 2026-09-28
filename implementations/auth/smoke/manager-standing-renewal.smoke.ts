/**
 * Standing manager renewal through the auth plane's real issuer (a live nats-server, a real
 * registered manager instance): the plane re-derives the serve grant from the registered service
 * spec and content store, binds the held nkeys and process epoch, and keeps run renewal unavailable.
 *
 * Run: tsx implementations/auth/smoke/manager-standing-renewal.smoke.ts (needs nats-server on PATH)
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeJwt } from "jose";
import {
  createSpaceAuth, isReachable, mintCreds, mintLifecycleUid, newIdentity, remoteManagerActors, serverConfig, setupSpaceStreams,
  type Identity, type RemoteManagerAuthorityRequest,
} from "@cotal-ai/core";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { openAuthAuthorityPlane } from "../src/index.js";
import { remoteManagerCurrentRegistrationProof } from "../src/retained-manager-validation.js";
import { registerRemoteManagerAuthority } from "../../manager/src/remote-register.js";
import { pickFreePort } from "../../../packages/core/smoke/_free-port.js";

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};
const refusal = async (p: Promise<unknown>): Promise<string> => {
  try { await p; return "issued"; } catch (e) { return `${(e as { code?: string }).code ?? "?"}: ${(e as Error).message}`; }
};

const space = `srenew${mintLifecycleUid().slice(0, 8).toLowerCase()}`;
const auth = await createSpaceAuth(space);
const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const tmp = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const dir = join(tmp, "state");
mkdirSync(dir, { recursive: true });
writeFileSync(join(tmp, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(tmp, "js") }));
const srv = spawn("nats-server", ["-c", join(tmp, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, tmp);

const names = ["supervisor", "executor", "serve", "goalWriter", "sessionLedger"] as const;
type Name = (typeof names)[number];
const owner = `u_${"e".repeat(26)}`;
const instanceId = mintLifecycleUid();
const managerLifecycleUid = mintLifecycleUid();
const actors = remoteManagerActors(instanceId);
const held = Object.fromEntries(names.map((n) => [n, newIdentity()])) as Record<Name, Identity>;
const dataAccount = { pub: auth.account.pub, signingSeed: auth.account.signingSeed };
let plane: Awaited<ReturnType<typeof openAuthAuthorityPlane>> | undefined;
try {
  await awaitBrokerReady(() => isReachable(SERVERS), { servers: SERVERS, attempts: 50, delayMs: 100 });
  await setupSpaceStreams({ servers: SERVERS, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  plane = await openAuthAuthorityPlane({ server: SERVERS, space, dir, dataAccount, log: () => {} });
  const prepareCreds = await mintCreds(auth, held.executor, "remote-manager", {
    principal: { owner, actor: actors.executor }, remoteManager: { instanceId, owner, actor: actors.executor },
  });
  const registered = await registerRemoteManagerAuthority({
    space, server: SERVERS, owner, instanceId, serveActor: actors.serve, prepareCreds, tlsRequired: false, evict: async () => true,
  });
  const request = (over: Partial<RemoteManagerAuthorityRequest> = {}, proofEpoch = registered.processEpoch): RemoteManagerAuthorityRequest => {
    const base = {
      v: 1 as const, kind: "manager-service-authority" as const, operation: "renewStandingBundle" as const,
      space, actor: "cli", instanceId, managerLifecycleUid, requestId: `req${mintLifecycleUid()}`,
      accountPublicKey: dataAccount.pub, processEpoch: registered.processEpoch,
      identities: Object.fromEntries(names.map((n) => [n, { id: held[n].id }])) as RemoteManagerAuthorityRequest["identities"],
      ...over,
    };
    return {
      ...base,
      registrationProof: remoteManagerCurrentRegistrationProof(dataAccount.signingSeed, owner, base, {
        registrationRevision: registered.registrationRevision, processEpoch: proofEpoch,
      }),
    } as RemoteManagerAuthorityRequest;
  };

  console.log("standing renewal through the plane issuer");
  const material = await plane.issueManagerServiceAuthority({ owner, scope: ["supervise"], request: request() });
  const issued = Object.keys(material.credentials).sort();
  check("standing renewal issues exactly the five standing duties", issued.join(",") === [...names].sort().join(","), issued);
  for (const n of names) {
    const claims = decodeJwt(material.credentials[n]!.jwt) as { sub?: string; nats?: { issuer_account?: string } };
    check(`${n} is signed for the held nkey under the data account`, claims.sub === held[n].id && claims.nats?.issuer_account === dataAccount.pub,
      { sub: claims.sub, account: claims.nats?.issuer_account });
  }
  const serve = decodeJwt(material.credentials.serve!.jwt) as { nats?: { sub?: { allow?: string[] } } };
  const serveSubs = serve.nats?.sub?.allow ?? [];
  const registeredCommands = registered.serveGrant.commands;
  const missing = registeredCommands.filter((c) => !serveSubs.includes(`cotal.${space}.ep.inst.manager.${instanceId}.${c}.>`));
  check("renewed serve grant covers every registered command on this instance's rails",
    registeredCommands.length > 0 && missing.length === 0, { commands: registeredCommands.length, missing });
  const foreignInst = serveSubs.filter((s) => /\.ep\.(v1\.)?inst\./.test(s) && !s.includes(`.inst.manager.${instanceId}.`));
  check("renewed serve grant names no other instance", foreignInst.length === 0, foreignInst.slice(0, 3));

  console.log("refusals");
  check("a stale processEpoch refuses",
    /conflict/.test(await refusal(plane.issueManagerServiceAuthority({ owner, scope: ["supervise"], request: request({ processEpoch: registered.processEpoch + 1 }, registered.processEpoch + 1) }))));
  check("another account refuses",
    /permission-denied/.test(await refusal(plane.issueManagerServiceAuthority({ owner, scope: ["supervise"], request: request({ accountPublicKey: createSpaceAuthPub() }) }))));
  check("a foreign owner refuses",
    /permission-denied/.test(await refusal(plane.issueManagerServiceAuthority({ owner: `u_${"f".repeat(26)}`, scope: ["supervise"], request: request() }))));
  const swapped = { ...Object.fromEntries(names.map((n) => [n, { id: held[n].id }])), serve: { id: newIdentity().id } } as RemoteManagerAuthorityRequest["identities"];
  const tampered = { ...request(), identities: swapped } as RemoteManagerAuthorityRequest;
  check("an unregistered nkey refuses (the proof binds the held identities)",
    /permission-denied/.test(await refusal(plane.issueManagerServiceAuthority({ owner, scope: ["supervise"], request: tampered }))));
  const runRequest = request({
    operation: "renewRunDriver",
    run: { runId: `run-${"a".repeat(32)}`, holder: `host.${"b".repeat(16)}`, takeoverId: "b".repeat(16), epoch: 1, fencingToken: 1, driverId: newIdentity().id, mediatorId: newIdentity().id },
  });
  const run = await refusal(plane.issueManagerServiceAuthority({ owner, scope: ["supervise"], request: runRequest }));
  check("run renewal stays unavailable without an authoritative activated-run reader", /^unavailable:/.test(run), run);
} finally {
  try { await plane?.close(); } catch { /* broker may be gone */ }
  await killAndAwaitExit(srv, "SIGKILL");
  releaseBroker();
}
console.log(`manager standing renewal: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 && pass > 0 ? 0 : 1);

function createSpaceAuthPub(): string {
  // A syntactically valid account key that is not this space's data account.
  return `A${"B".repeat(55)}`;
}
