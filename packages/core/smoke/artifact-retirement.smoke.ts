/**
 * Possession rows OUTLIVE the lifecycle that earned them — fold #3, against a real broker.
 *
 * TWO OPERATIONS ARE BOTH TEARDOWN-SHAPED AND ONLY ONE IS THE TEST. `deleteSpace` removes the
 * possession bucket, and that is CORRECT: the whole space is going. **Lifecycle RETIREMENT must not
 * touch possession rows at all.** A cell that drove space deletion and asserted possession survived
 * would be asserting a bug, so this suite names the operation rather than the category, and pins
 * both directions so a later edit cannot conflate them.
 *
 * WHY IT MATTERS: a delayed message must still attach after its publisher retires. If retirement
 * reaped possession, `confirmAttach` would find nothing at consume time and a legitimate publication
 * would silently never attach — the exact branch the whole 2b design exists to close, re-fired with
 * no adversary involved.
 *
 * WHAT THIS GUARDS TODAY, STATED PLAINLY: `deprovisionAgent` currently deletes two durable consumers
 * and the lifecycle-exact ACL row, and touches possession NOWHERE. So this cell guards against a
 * FUTURE edit rather than a present defect — someone adding a "clean up the agent's artifact state"
 * line to a teardown that already looks comprehensive. That is worth stating rather than implying:
 * a green here today means "still untouched", not "a bug was fixed".
 *
 * Run: pnpm smoke:artifact-retirement   (needs nats-server on PATH)
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kvm } from "@nats-io/kv";
import { connect } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import {
  isReachable, setupSpaceStreams, deleteSpace, deprovisionAgent,
  possessionBucket, possessionKey, principalKey, aclKey, aclBucket,
} from "../src/index.js";
import { pickFreePort } from "./_free-port.js";

let ok = 0, fail = 0;
const check = (name: string, pass: boolean, extra?: unknown) => {
  if (pass) { ok++; console.log("  ✓", name); }
  else { fail++; console.log("  ✗ FAIL:", name, extra ?? ""); }
};

const SPACE = "artretire";
const OWNER = "UAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const ACTOR = "agent";
const LC_A = "01h" + "z".repeat(22) + "a";
const D = "sha256:" + "ab".repeat(32);

const PORT = await pickFreePort();
const sd = mkdtempSync(join(tmpdir(), "cotal-artretire-"));
const broker = spawn("nats-server", ["-js", "-sd", sd, "-p", String(PORT), "-a", "127.0.0.1"], { stdio: "ignore" });
const servers = `nats://127.0.0.1:${PORT}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { up = await isReachable(servers); if (!up) await wait(100); }
  if (!up) throw new Error(`broker never came up on ${PORT}`);

  await setupSpaceStreams({ servers, space: SPACE });
  const principal = principalKey(OWNER, ACTOR).key;
  const key = possessionKey(D, principal, LC_A);

  // Write a possession row for the lifecycle about to be retired, AND the lifecycle-keyed ACL row
  // that retirement is supposed to take. The ACL row is the standing control: it is the thing
  // `deprovisionAgent` actually removes (`streams.ts`, `deleteAcl`), so its disappearance is what
  // distinguishes "retirement ran" from "retirement no-opped".
  const aclRowKey = aclKey(principal, LC_A);
  {
    const nc = await connect({ servers });
    const kv = await new Kvm(nc).open(possessionBucket(SPACE));
    await kv.put(key, new TextEncoder().encode("1"));
    const before = await kv.get(key);
    check("a possession row exists before retirement",
      before !== null && before.operation === "PUT", { key, op: before?.operation });

    const acl = await new Kvm(nc).open(aclBucket(SPACE));
    await acl.put(aclRowKey, new TextEncoder().encode(JSON.stringify({ allowSubscribe: ["general"] })));
    const aclBefore = await acl.get(aclRowKey);
    check("(control precondition) the lifecycle-keyed ACL row exists before retirement",
      aclBefore !== null && aclBefore.operation === "PUT",
      { aclRowKey, op: aclBefore?.operation });
    await nc.close();
  }

  // ---- THE INVARIANT: retire the LIFECYCLE, not the space ---------------------------------------
  await deprovisionAgent({ servers, space: SPACE, targetId: `${OWNER}.${ACTOR}`, lifecycleUid: LC_A });

  {
    const nc = await connect({ servers });
    const kv = await new Kvm(nc).open(possessionBucket(SPACE));
    const after = await kv.get(key);
    // NOT `after !== null`. A real KV `get()` on a DELETED key returns an entry with
    // `operation: "DEL"` — measured — so a null-check reads a tombstone as presence. The first
    // version of this cell did exactly that, and SURVIVED a mutation that deleted the row in front
    // of it: the probe printed "[PROBE] DELETED <key>" and the cell still passed.
    check("RETIREMENT LEAVES THE POSSESSION ROW INTACT — a delayed message can still attach",
      after !== null && after.operation === "PUT",
      { key, found: after === null ? "absent" : after.operation });

    // ---- THE POSITIVE CONTROL, AND THE OLD ONE WAS VACUOUS ------------------------------------
    //
    // This cell used to assert that the possession BUCKET exists — which is true before retirement,
    // true after it, and true if `deprovisionAgent` never ran at all. Replacing the call with
    // `Promise.resolve()` survived every cell in this suite. Its comment named the right check ("so
    // the suite proves retirement ran rather than passing because deprovisionAgent no-opped") and
    // the code asserted the invariant itself: a right comment beside wrong code, which camouflages
    // best from the author, who re-reads the intent and sees it confirmed.
    //
    // It also fooled an adversarial reviewer, who accepted that retirement had run on the separate
    // evidence that the companion `deleteSpace` cell still worked — so the round that should have
    // caught it supplied a second reason to believe it.
    //
    // The real control is the ACL row: lifecycle-keyed, and the thing deprovision actually deletes.
    // Read as `operation === "PUT"`, never `!== null`, because a tombstone is not absence — that is
    // the defect this very suite was written to close, and a control that repeated it would assert
    // the presence of a deletion.
    const acl = await new Kvm(nc).open(aclBucket(SPACE));
    const aclAfter = await acl.get(aclRowKey);
    check("POSITIVE CONTROL — retirement really RAN: the lifecycle-keyed ACL row is gone",
      aclAfter === null || aclAfter.operation !== "PUT",
      { aclRowKey, found: aclAfter === null ? "absent" : aclAfter.operation });
    await nc.close();
  }

  // ---- THE COMPANION: space deletion MUST still remove the bucket -------------------------------
  // Without this, a later edit could satisfy the invariant above by never deleting possession at all,
  // turning a correct teardown into a permanent leak — teardown is the sole STREAM.DELETE holder.
  await deleteSpace({ servers, space: SPACE });
  {
    const nc = await connect({ servers });
    const jsm = await jetstreamManager(nc);
    const names: string[] = [];
    for await (const si of jsm.streams.list()) names.push(si.config.name);
    check("SPACE DELETION still removes the possession bucket — the two paths are not the same",
      !names.includes(`KV_${possessionBucket(SPACE)}`), names.filter((n) => n.includes("artpossess")));
    await nc.close();
  }
} finally {
  broker.kill("SIGKILL");
  rmSync(sd, { recursive: true, force: true });
}

console.log(`\nartifact-retirement: ${ok} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
