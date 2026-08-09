/**
 * SESSION-WRITER FAMILY + RENEWAL + CONFINEMENT smoke (control-surface P2 item 6, 6b-2) — the
 * broker-enforced musts for the manager's serving session-writer (the goal-writer precedent,
 * spawn-action-auth.smoke.ts):
 *
 *   FAMILY      the session-writer credId is STAGED in the §13.1 revocation family
 *               (epcred.<e>.<iid>) alongside the serve + goal-writer creds — so the takeover
 *               barrier's existing enumerate + revoke + evict retires a deposed manager's
 *               session-writer with NO barrier code change (a successor's new epoch also refuses
 *               the old grants). The family now carries >= 3 distinct active holders.
 *   RENEWAL     the manager is the session-writer's renewal owner — re-minting the SAME nkey
 *               through the scoped executor writes a DISTINCT §13.1 ledger row (a fresh credId for
 *               the same holderPrincipal), so the standing connection never dies at its TTL.
 *   CONFINEMENT (live §13.9 subject-blindness) the session-writer cred can leader-read its OWN
 *               dedicated sessions bucket but is broker-DENIED a read of the AUTH bucket — creds +
 *               gates are structurally unreachable. The dedicated bucket IS the fix.
 *
 * Run: pnpm smoke:session-writer-family   (needs nats-server + node on PATH; boots its own broker)
 */
import { spawn as spawnProc, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";
import {
  isReachable, createSpaceAuth, serverConfig, setupSpaceStreams, mintCreds, newIdentity,
  mintLifecycleUid, standaloneConnectOpts, principalKey, DEV_OWNER, rawDigest,
  epAuthBucket, epcredFamilyPrefix, sessionsBucket,
} from "@cotal-ai/core";
import { authDir, saveSpaceAuth } from "@cotal-ai/workspace";
import { Manager } from "../src/manager.js";
import { MANAGER_ENDPOINT } from "../src/manager-service-contract.js";

const enc = new TextEncoder(), dec = new TextDecoder();
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const freePort = (): Promise<number> =>
  new Promise((res, rej) => {
    const s = createServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => res(p)); });
  });
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra !== undefined ? JSON.stringify(extra) : ""); }
};

const credId = (creds: string): string => rawDigest(creds).replace("sha256:", "sha256-");

const PORT = await freePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const space = `sesswriter-fam-${mintLifecycleUid().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), "cotal-sesswriter-fam-"));
const workspaceRoot = join(dir, "ws");
mkdirSync(join(workspaceRoot, ".cotal", "agents"), { recursive: true });
saveSpaceAuth(authDir(workspaceRoot), auth);
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { port: PORT, storeDir: join(dir, "js") }));

const kids: ChildProcess[] = [];
const conns: NatsConnection[] = [];
const srv = spawnProc("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
kids.push(srv);
let mgr: InstanceType<typeof Manager> | undefined;

try {
  let up = false;
  for (let i = 0; i < 60; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`auth nats-server did not come up on ${PORT}`);
  await setupSpaceStreams({ servers: SERVERS, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });

  mgr = new Manager({ space, servers: SERVERS, runtime: "pty", workspaceRoot });
  await mgr.start();
  const M = mgr as unknown as {
    managerInstanceId: string;
    sessionWriterIdentity?: { id: string };
    sessionWriterCreds?: string;
    sessionPlane?: { liveSessions: number };
    mintAndStageSessionWriter(authKv: unknown): Promise<string>;
  };
  // The registration gate + §13.1 family are keyed by the persisted registration instanceId
  // (item 3's split), NOT the per-process lifecycleUid — read/drive at the same key the manager registers under.
  const iid = M.managerInstanceId;

  check("the manager stood up its ONE session plane at boot", M.sessionPlane !== undefined && M.sessionPlane.liveSessions === 0);
  check("the session-writer credential is minted + stashed (auth mode)", typeof M.sessionWriterCreds === "string" && M.sessionWriterCreds.length > 0);

  const swPrincipal = principalKey(DEV_OWNER, M.sessionWriterIdentity!.id).key;
  const gwId0 = credId(M.sessionWriterCreds!);

  // Read the §13.1 revocation family over a scoped executor (the FAMILY + RENEWAL assertions).
  const execCreds = await mintCreds(auth, newIdentity(), "endpoint-serve-executor", { endpointServeExecutor: { endpoint: MANAGER_ENDPOINT, instanceId: iid } });
  const execNc = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds: execCreds }), maxReconnectAttempts: 0 });
  conns.push(execNc);
  const authKv = await new Kvm(execNc).open(epAuthBucket(space));
  const familyRows = async (): Promise<Array<{ holderPrincipal?: string; state?: string; credentialId?: string }>> => {
    const rows: Array<{ holderPrincipal?: string; state?: string; credentialId?: string }> = [];
    for await (const k of await authKv.keys(`${epcredFamilyPrefix(MANAGER_ENDPOINT, iid)}.>`)) {
      const e = await authKv.get(k);
      if (e && e.operation === "PUT") rows.push(JSON.parse(dec.decode(e.value)));
    }
    return rows;
  };

  // ── FAMILY: the session-writer credId is STAGED alongside the serve + goal-writer creds ──────
  {
    const rows = await familyRows();
    const active = rows.filter((r) => r.state === "active");
    const activeHolders = new Set(active.map((r) => r.holderPrincipal));
    check("FAMILY the session-writer joined the §13.1 revocation family (epcred.<e>.<iid>)", activeHolders.has(swPrincipal), { activeHolders: [...activeHolders], swPrincipal });
    check("FAMILY its active row carries the CURRENT session-writer credId", active.some((r) => r.holderPrincipal === swPrincipal && r.credentialId === gwId0), gwId0);
    check("FAMILY the family carries >= 3 distinct active holders (serve + goal-writer + session-writer)", activeHolders.size >= 3, [...activeHolders]);
  }

  // ── RENEWAL: re-minting the SAME nkey stages a DISTINCT ledger row (the renewal owner tick) ──
  {
    // JWT iat/exp are second-granularity, so a same-second re-mint would be byte-identical (production
    // renewal is a half-TTL apart). Cross a second boundary so the fresh issuance is genuinely distinct.
    await wait(1100);
    const fresh = await M.mintAndStageSessionWriter(authKv);
    const freshId = credId(fresh);
    check("RENEWAL a renewal tick re-mints the session-writer (a fresh credId for the SAME nkey)", freshId !== gwId0, { gwId0, freshId });
    const rows = await familyRows();
    const swRows = rows.filter((r) => r.holderPrincipal === swPrincipal && r.state === "active");
    check("RENEWAL the fresh credId is staged in the family (a distinct §13.1 row, same holderPrincipal)", swRows.some((r) => r.credentialId === freshId), swRows.map((r) => r.credentialId));
  }

  // ── CONFINEMENT (live §13.9): the session-writer reads its OWN sessions bucket, DENIED the auth
  //    bucket. Raw STREAM.MSG.GET requests: an ALLOWED read returns a response (even "not found"); a
  //    DENIED read gets no responder → times out (the M7 broker-denial pattern). ─────────────────
  {
    const swNc = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds: M.sessionWriterCreds! }), maxReconnectAttempts: 0 });
    conns.push(swNc);
    const msgGet = async (bucket: string, key: string): Promise<boolean> => {
      // true = ALLOWED (a response arrived); false = DENIED (no responder / timeout).
      try { await swNc.request(`$JS.API.STREAM.MSG.GET.KV_${bucket}`, enc.encode(JSON.stringify({ last_by_subj: `$KV.${bucket}.${key}` })), { timeout: 1500 }); return true; }
      catch { return false; }
    };
    check("CONFINEMENT the session-writer CAN leader-read its OWN sessions bucket", await msgGet(sessionsBucket(space), "session.probe"));
    check("CONFINEMENT the session-writer is broker-DENIED a read of the AUTH bucket (creds/gates unreachable — the §13.9 subject-blindness fix)", !(await msgGet(epAuthBucket(space), "cred.probe.probe")));
  }

  console.log(`\nsession-writer-family smoke: ${pass} passed, ${fail} failed`);
} finally {
  for (const c of conns) await c.drain().catch(() => c.close());
  await mgr?.stop().catch(() => {});
  for (const k of kids) { k.kill("SIGKILL"); }
  await wait(200);
}

process.exit(fail > 0 ? 1 : 0);
