/**
 * `down --preserve-state`'s lease walk must survive a cleanly stopped manager.
 *
 * WHY. The manager liveness lease was demoted to one `lease.<instanceId>` key per instance, and the
 * preserve-state cut was moved off the (now unwritten) bare `lease` subject onto a STREAM.INFO
 * enumeration plus per-subject point-gets. That enumeration was copied from the two sibling walks in
 * the same function and did NOT copy their `allowEmpty: true`. STREAM.INFO lists TOMBSTONED
 * subjects, so a cleanly released key is in the walk, and without `allowEmpty` the point-get throws
 * `maintenance inventory is missing <subject>` instead of returning undefined for the holder check
 * to skip. The cut then dies naming a dead manager's key.
 *
 * ORDER DECIDES WHETHER IT FIRES, so this asserts BOTH orderings. `Object.keys` follows the order
 * the server returns subjects in, and real instance ids are random lifecycle uids, so in production
 * this is a coin flip rather than a deterministic failure. A cell that pinned one ordering would
 * report a frequency it did not measure.
 *
 * THIS RUNS THROUGH THE SHIPPED `readPresenceWithoutConsumer`, deliberately. A transcription of the
 * loop carries its own `allowEmpty` parameter, so it stays green when the argument at the real call
 * site is removed: it would assert on a copy of the bug rather than on the fix. ACCEPTANCE FOR THIS
 * CELL IS THE MUTATION, not the green - delete `, true` at the lease walk, watch this go red,
 * restore.
 *
 * WHAT THIS DOES NOT COVER: the full `cotal down --preserve-state` cut against a tombstoned sibling
 * is still unexecuted by anyone. This reaches the function the three production callers use; it does
 * not drive the command.
 *
 * Needs nats-server on PATH. Run: pnpm smoke:down-lease-tombstone
 */
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";
import { isReachable, managerBucket, managerLeaseKey, presenceBucket, principalKey, DEV_OWNER } from "@cotal-ai/core";
import { pickFreePort } from "../../../packages/core/smoke/_free-port.js";
import { readPresenceWithoutConsumer } from "../src/commands/down.js";

const PORT = await pickFreePort();
const SERVER = `nats://127.0.0.1:${PORT}`;
const SPACE = "leasetomb";   // base; each cell appends its ordering so it gets its own bucket
const store = mkdtempSync(join(tmpdir(), "cotal-leasetomb-"));
let pass = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, `${name}${extra !== undefined ? ` - ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

const srv = spawn("nats-server", ["-p", String(PORT), "-js", "-sd", store], { stdio: "ignore" });
process.on("exit", () => { try { srv.kill("SIGKILL"); } catch { /* gone */ } rmSync(store, { recursive: true, force: true }); });

const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
const holderKey = principalKey(DEV_OWNER, "mgr").key;
const lease = (instanceId: string) => ({ instanceId, holder: holderKey, pid: 1, root: "/tmp", runtime: "pty", since: Date.now() });

/** Each ordering gets its OWN space, so it gets its own bucket and its own subject order. Writing
 *  the tombstoned key FIRST and then the live one is what makes the failing branch reachable; the
 *  reverse pins that the fix is not merely order luck. (A fresh space per cell rather than a
 *  destroy-and-recreate: `Kvm` in the pinned client has no `destroy`, and a reused bucket would
 *  carry the previous cell's subject order into the next one anyway.) */
const seed = async (kvm: Kvm, space: string, tombId: string, liveId: string) => {
  const kv = await kvm.create(managerBucket(space), { ttl: 10_000 });
  await kv.put(managerLeaseKey(tombId), enc(lease(tombId)));
  await kv.delete(managerLeaseKey(tombId));           // exactly what releaseManagerLease issues
  await kv.put(managerLeaseKey(liveId), enc(lease(liveId)));
  return kv;
};

/** The ENUMERATION order, read back from the server rather than assumed. `Object.keys` follows what
 *  STREAM.INFO returns, which is NOT the order the keys were written: the first version of this cell
 *  wrote the tombstone first and still visited the live key first, so the walk `break`ed before ever
 *  point-getting the tombstone and the suite passed with the fix reverted. Choosing ids whose sort
 *  order is the intended visit order is only half of it; the cell must also CHECK that it got the
 *  order it wanted, or it silently stops testing the thing again. */
const firstSubject = async (nc: Awaited<ReturnType<typeof connect>>, space: string) => {
  const { jetstreamManager } = await import("@nats-io/jetstream");
  const info = await (await jetstreamManager(nc)).streams.info(`KV_${managerBucket(space)}`, {
    subjects_filter: `$KV.${managerBucket(space)}.lease.*`,
  });
  return Object.keys(info.state.subjects ?? {});
};

try {
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    if (await isReachable(SERVER)) { up = true; break; }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!up) throw new Error(`fixture broker never came up on ${SERVER} - refusing to report on a server that never started`);

  const nc = await connect({ servers: SERVER });
  const kvm = new Kvm(nc);

  // ids chosen so the SORT order is the intended visit order, then verified below.
  const cells = [
    { name: "tombstone-first", tomb: "aaastopped", live: "zzzlive" },
    { name: "live-first",      tomb: "zzzstopped", live: "aaalive" },
  ] as const;

  for (const cell of cells) {
    console.log(`CELL - a cleanly stopped manager beside a live one, ${cell.name}`);
    const space = `${SPACE}${cell.name.replace("-", "")}`;
    await kvm.create(presenceBucket(space)).catch(() => { /* already there */ });
    await seed(kvm, space, cell.tomb, cell.live);

    const subjects = await firstSubject(nc, space);
    check(`${cell.name}: both keys are in the enumeration (the tombstone is not filtered out)`,
      subjects.some((x) => x.endsWith(`.${cell.tomb}`)) && subjects.some((x) => x.endsWith(`.${cell.live}`)), subjects);
    const wantFirst = cell.name === "tombstone-first" ? cell.tomb : cell.live;
    check(`${cell.name}: the walk really visits ${wantFirst} first (premise verified, not assumed)`,
      subjects[0]?.endsWith(`.${wantFirst}`) === true, subjects);

    let threw: unknown;
    let got: { managerId: string } | undefined;
    try { got = await readPresenceWithoutConsumer(space, SERVER); } catch (e) { threw = e; }
    check(`${cell.name}: the lease walk does not die on the released key`,
      threw === undefined, (threw as Error)?.message?.slice(0, 140));
    check(`${cell.name}: the live manager is reported as the holder`,
      got?.managerId === holderKey, { got: got?.managerId, want: holderKey });
  }

  await nc.close().catch(() => { /* already closed */ });
} finally {
  try { srv.kill("SIGKILL"); } catch { /* gone */ }
}

console.log(`\ndown-lease-tombstone: ${pass} checks passed`);
