/**
 * SIBLING-MINT FENCE smoke (control-surface v0.4, Lane B finding 3) — the manager's SIBLING
 * credential mints (`goal-writer`, `session-writer`) must run the SAME §13.1 open-and-commit fence
 * `finalizeServeIssuance` runs for the serve credential itself:
 *
 *     observe -> require the gate state `open` -> stage the row -> commit(observedRevision)
 *     -> release ONLY on the win; revoke the staged row on a loss.
 *
 * Without the fence a sibling mint is `observe -> stage -> return`, so a takeover barrier that has
 * already FROZEN the gate (and, worse, already ENUMERATED the family it is about to revoke) still
 * lets a deposed manager stage AND release a live credential into that family. The row lands after
 * the enumeration, so nothing ever revokes it: the deposed manager keeps a working goal-writer and
 * session-writer against the endpoint the successor now owns.
 *
 * Both legs drive the REAL manager mint path against a REAL broker + auth store:
 *   FROZEN   a barrier froze the gate before the mint -> the mint must refuse; the family must gain
 *            no new active row for that sibling.
 *   MOVED    the gate advances between the mint's own observe and its commit (the takeover race) ->
 *            the commit CAS must lose, the mint must refuse, and the row it staged must be REVOKED,
 *            never left active.
 *
 * Run: pnpm smoke:sibling-mint-fence   (needs nats-server + node on PATH; boots its own broker)
 */
import { spawn as spawnProc, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { Kvm, type KV, type KvEntry } from "@nats-io/kv";
import {
  isReachable, createSpaceAuth, serverConfig, setupSpaceStreams, mintCreds, newIdentity,
  mintLifecycleUid, standaloneConnectOpts, principalKey, DEV_OWNER, rawDigest,
  epAuthBucket, epcredFamilyPrefix, epgateKey, parseEndpointGate,
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
const space = `sibfence-${mintLifecycleUid().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), "cotal-sibfence-"));
const workspaceRoot = join(dir, "ws");
mkdirSync(join(workspaceRoot, ".cotal", "agents"), { recursive: true });
saveSpaceAuth(authDir(workspaceRoot), auth);
writeFileSync(join(dir, "server.conf"), serverConfig(auth, { port: PORT, storeDir: join(dir, "js") }));

const kids: ChildProcess[] = [];
const conns: NatsConnection[] = [];
const srv = spawnProc("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
kids.push(srv);
let mgr: InstanceType<typeof Manager> | undefined;

interface FamilyRow { holderPrincipal?: string; state?: string; credentialId?: string }

try {
  let up = false;
  for (let i = 0; i < 60; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`auth nats-server did not come up on ${PORT}`);
  await setupSpaceStreams({ servers: SERVERS, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });

  mgr = new Manager({ space, servers: SERVERS, runtime: "pty", workspaceRoot });
  await mgr.start();
  const M = mgr as unknown as {
    managerInstanceId: string;
    goalWriterIdentity?: { id: string };
    sessionWriterIdentity?: { id: string };
    mintAndStageGoalWriter(authKv: KV): Promise<string>;
    mintAndStageSessionWriter(authKv: KV): Promise<string>;
  };
  const iid = M.managerInstanceId;
  const gateKey = epgateKey(MANAGER_ENDPOINT, iid);
  const BARRIER_OP = mintLifecycleUid(); // the barrier's opId is a §13.1 lifecycle token

  const execCreds = await mintCreds(auth, newIdentity(), "endpoint-serve-executor", { endpointServeExecutor: { endpoint: MANAGER_ENDPOINT, instanceId: iid } });
  const execNc = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds: execCreds }), maxReconnectAttempts: 0 });
  conns.push(execNc);
  const authKv = await new Kvm(execNc).open(epAuthBucket(space));

  const familyRows = async (): Promise<FamilyRow[]> => {
    const rows: FamilyRow[] = [];
    for await (const k of await authKv.keys(`${epcredFamilyPrefix(MANAGER_ENDPOINT, iid)}.>`)) {
      const e = await authKv.get(k);
      if (e && e.operation === "PUT") rows.push(JSON.parse(dec.decode(e.value)) as FamilyRow);
    }
    return rows;
  };
  const activeFor = async (principal: string): Promise<FamilyRow[]> =>
    (await familyRows()).filter((r) => r.holderPrincipal === principal && r.state === "active");
  const rowFor = async (id: string): Promise<FamilyRow | undefined> =>
    (await familyRows()).find((r) => r.credentialId === id);
  const readGate = async (): Promise<{ row: ReturnType<typeof parseEndpointGate>; revision: number }> => {
    const e = await authKv.get(gateKey);
    if (!e || e.operation !== "PUT") throw new Error(`no gate at ${gateKey}`);
    return { row: parseEndpointGate(e.value, gateKey), revision: e.revision };
  };
  /** Drive the gate exactly as the §13.1 registration barrier does: a revision-pinned freeze CAS. */
  const freezeGate = async (): Promise<void> => {
    const g = await readGate();
    await authKv.update(gateKey, enc.encode(JSON.stringify({ ...g.row, state: "frozen", op: { opId: BARRIER_OP, kind: "registration" } })), g.revision);
  };
  const openGate = async (): Promise<void> => {
    const g = await readGate();
    const { op: _op, ...rest } = g.row as Record<string, unknown>;
    void _op;
    await authKv.update(gateKey, enc.encode(JSON.stringify({ ...rest, state: "open" })), g.revision);
  };

  const gwPrincipal = principalKey(DEV_OWNER, M.goalWriterIdentity!.id).key;
  const swPrincipal = principalKey(DEV_OWNER, M.sessionWriterIdentity!.id).key;

  // ── LEG 1 (FROZEN): a barrier froze the gate; a sibling mint must release NOTHING ──────────────
  console.log("A. FROZEN gate: the takeover barrier is mid-operation");
  {
    await freezeGate();
    check("the gate really is frozen (the barrier's own CAS shape)", (await readGate()).row.state === "frozen");

    for (const [label, principal, mint] of [
      ["goal-writer", gwPrincipal, () => M.mintAndStageGoalWriter(authKv)],
      ["session-writer", swPrincipal, () => M.mintAndStageSessionWriter(authKv)],
    ] as const) {
      const before = (await activeFor(principal)).map((r) => r.credentialId);
      let released: string | undefined;
      let refused: string | undefined;
      // Cross a second boundary so a fresh mint would be a genuinely distinct JWT (iat granularity).
      await wait(1100);
      try { released = await mint(); } catch (e) { refused = (e as Error).message; }
      check(`FROZEN the ${label} mint REFUSES against a frozen gate`, refused !== undefined && released === undefined, { refused, released: released ? credId(released) : undefined });
      const after = (await activeFor(principal)).map((r) => r.credentialId);
      check(`FROZEN the ${label} stages NO new active row into the deposed family`,
        after.length === before.length && after.every((id) => before.includes(id)),
        { before, after });
    }
    await openGate();
    check("the gate reopened for leg 2", (await readGate()).row.state === "open");
  }

  // ── LEG 2 (MOVED): the gate advances between the mint's OWN observe and its commit ─────────────
  //    The takeover race: our observe reads `open`, a barrier freezes, our stage lands. Only a
  //    revision-pinned commit CAS catches it — and the row it staged must end up REVOKED.
  console.log("B. MOVED gate: a barrier advances the gate between the mint's observe and its commit");
  {
    // A KV facade over the real bucket: the FIRST gate read the mint performs returns the true
    // (stale-by-the-time-it-commits) entry, and immediately after it the gate is advanced for real,
    // exactly as a concurrent barrier would. Every other operation passes through untouched.
    const racing = (kv: KV): KV => {
      let armed = true;
      const facade = Object.create(kv) as KV;
      facade.get = async (key: string): Promise<KvEntry | null> => {
        const entry = await kv.get(key);
        if (armed && key === gateKey && entry && entry.operation === "PUT") {
          armed = false;
          await freezeGate(); // a barrier wins the gate between our observe and our commit
        }
        return entry;
      };
      return facade;
    };

    for (const [label, principal, mint] of [
      ["goal-writer", gwPrincipal, (kv: KV) => M.mintAndStageGoalWriter(kv)],
      ["session-writer", swPrincipal, (kv: KV) => M.mintAndStageSessionWriter(kv)],
    ] as const) {
      await openGate();
      const before = (await activeFor(principal)).map((r) => r.credentialId);
      await wait(1100);
      let released: string | undefined;
      let refused: string | undefined;
      try { released = await mint(racing(authKv)); } catch (e) { refused = (e as Error).message; }
      check(`MOVED the ${label} mint REFUSES when the gate moved under it`, refused !== undefined && released === undefined, { refused, released: released ? credId(released) : undefined });
      const after = await activeFor(principal);
      const fresh = after.filter((r) => !before.includes(r.credentialId));
      check(`MOVED the ${label} leaves NO active row behind (a staged row is revoked on the lost CAS)`,
        fresh.length === 0, { before, after: after.map((r) => r.credentialId) });
      if (released) {
        const row = await rowFor(credId(released));
        check(`MOVED (diagnostic) the released ${label} row state`, row?.state === "revoked", row);
      }
    }
    await openGate();
  }

  console.log(`\nsibling-mint-fence smoke: ${pass} passed, ${fail} failed`);
} finally {
  for (const c of conns) await c.drain().catch(() => c.close());
  await mgr?.stop().catch(() => {});
  for (const k of kids) { k.kill("SIGKILL"); }
  await wait(200);
}

process.exit(fail > 0 ? 1 : 0);
