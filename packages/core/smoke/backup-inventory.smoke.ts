/**
 * The backup inventory, validated against BROKER TRUTH, in the CI gate.
 *
 * WHY THIS SUITE EXISTS. #643: the gated backup smokes validated `spaceBackupInventory` against
 * its own output, the same list on both sides of an exact set-equality, so the check passed even
 * when a whole stream family was absent from the inventory. That is the mechanism that let the
 * unenumerated authority stores (#356) sit undetected: nothing in the gate compared the inventory
 * to a broker. A hand-pinned count cannot catch that class either, because it counts the
 * inventory's own length, and a family the inventory never knew has nothing to count.
 *
 * So this suite does what the artifact-plane S2 suite (`smoke:artifact-store`) does: it provisions
 * a real space on a real broker, enumerates what the broker ACTUALLY holds (its own stream list,
 * never a name synthesized from `spaceBackupInventory()`), and runs `validateSpaceBackupInventory`
 * against that. Exact set-equality against reality fails in BOTH directions: a stream created but
 * unenumerated, and a stream enumerated but never created. That is the property the circular
 * check could not have. It is GATED (ci-suites, `smoke:backup-inventory`); the hermetic
 * `backup.smoke.ts` comparator unit tests remain in `pnpm test` under the core package.
 *
 * Run: pnpm smoke:backup-inventory   (needs nats-server on PATH; part of smoke:ci)
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jetstreamManager } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";
import {
  canonicalBackupStreamConfig,
  dlvStream,
  isReachable,
  setupSpaceStreams,
  validateSpaceBackupInventory,
} from "../src/index.js";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

const SPACE = "bkinv";
const PORT = await pickFreePort();
const sd = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const broker = spawn("nats-server", ["-js", "-sd", sd, "-p", String(PORT), "-a", "127.0.0.1"], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(broker, sd);
const servers = `nats://127.0.0.1:${PORT}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

let ok = 0, fail = 0;
const check = (name: string, pass: boolean, extra?: unknown) => {
  if (pass) { ok++; } else { fail++; console.log("  ✗ FAIL:", name, extra ?? ""); }
};

// PRE-EXISTING GAP, NOT AN ACCEPTED ONE. `setupSpaceStreams` also creates the two SPEC 13.12
// authority stores via `ensureAuthorityStores`, and they are in NEITHER the backup inventory NOR
// `deleteSpace`'s explicit array (#356, owned by the control-surface lane). Subtracted HERE, by
// prefix, exactly as `smoke:artifact-store` subtracts them: the gap is per-space, so every space
// this suite creates leaks its own pair. This subtraction is why the equality below is "the
// inventory matches the broker, bar the named pair" and not "the inventory matches the broker":
// every OTHER family, on either side, still fails the check. When #356 enumerates them, DELETE
// THIS BLOCK and the equality tightens automatically.
const isUnenumeratedAuthority = (n: string) =>
  n.startsWith("KV_cotal_auth_") || n.startsWith("KV_cotal_records_");
const minusKnown = (names: string[]) => names.filter((n) => !isUnenumeratedAuthority(n));

/** The broker's OWN stream list, on a fresh connection each call: a probe that mutates the broker
 *  and re-validates must re-read it, or it grades a memory of the broker instead of the broker. */
const readBrokerStreams = async (): Promise<string[]> => {
  const c = await connect({ servers });
  try {
    const m = await jetstreamManager(c);
    const names: string[] = [];
    for await (const si of m.streams.list()) names.push(si.config.name);
    return names;
  } finally { await c.close(); }
};

/** Validate the broker's actual stream set for {@link SPACE}: "" on success, else the mismatch
 *  message, the validator's own words, so a red names the stream it reddened for. */
const validateAgainstBroker = async (): Promise<string> => {
  const names = await readBrokerStreams();
  try { validateSpaceBackupInventory(SPACE, minusKnown(names)); return ""; }
  catch (e) { return (e as Error).message; }
};

try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { up = await isReachable(servers); if (!up) await wait(100); }
  if (!up) throw new Error(`broker never came up on ${PORT}`);

  await setupSpaceStreams({ servers, space: SPACE });

  // THE LOAD-BEARING CELL. Exact set-equality between what the broker holds and what the inventory
  // declares, so a family created but unenumerated fails here, and one enumerated but never
  // created fails here too. Both directions, one assertion. This is the check the circular
  // `backup.smoke.ts` line could not be: remove a family from `spaceBackupInventory` and the
  // broker's list still names it, so the validator throws `unexpected` here.
  const equality = await validateAgainstBroker();
  check("the broker's own stream set equals the backup inventory exactly", equality === "", equality);

  // The named pair is the ONLY tolerance: prove the subtraction subtracts exactly the gap and
  // nothing more, so the equality above cannot be quietly widened by a rename or a fourth store.
  const raw = await readBrokerStreams();
  check("the known-unenumerated pair is exactly the two authority stores",
    raw.filter(isUnenumeratedAuthority).length === 2, raw);

  // TEETH, BOTH DIRECTIONS, ON A REAL BROKER. The equality above is a claim that CAN fail; these
  // cells make it fail on purpose, so the suite proves its own check is live rather than trusting
  // the mutation rig to visit it. Each probe mutates the BROKER (never the inventory): the
  // inventory under test stays the shipped one, and each probe is undone before the next cell
  // reads the broker, so no cell grades a leftover of another.
  const c0 = await connect({ servers });
  await (await jetstreamManager(c0)).streams.delete(dlvStream(SPACE));
  await c0.close();
  const missingErr = await validateAgainstBroker();
  check("a stream DELETED from the broker reddens the check as missing",
    missingErr.includes("missing") && missingErr.includes(dlvStream(SPACE)), missingErr);

  const c1 = await connect({ servers });
  const jsm1 = await jetstreamManager(c1);
  await jsm1.streams.add(canonicalBackupStreamConfig(SPACE, dlvStream(SPACE)));
  await jsm1.streams.add({ name: "FOREIGN_PROBE", subjects: ["foreign.probe.>"] });
  await c1.close();
  const unexpectedErr = await validateAgainstBroker();
  check("a stream the inventory does not know reddens the check as unexpected",
    unexpectedErr.includes("unexpected") && unexpectedErr.includes("FOREIGN_PROBE"), unexpectedErr);

  const c2 = await connect({ servers });
  await (await jetstreamManager(c2)).streams.delete("FOREIGN_PROBE");
  await c2.close();
  const restored = await validateAgainstBroker();
  check("the check is green again once the probes are undone", restored === "", restored);

  console.log(`\nbackup inventory vs broker truth: ${ok} passed, ${fail} failed`);
} finally {
  broker.kill("SIGKILL");
  rmSync(sd, { recursive: true, force: true });
  releaseBroker(); // last: ownership is held until this teardown has actually finished
}
process.exit(fail === 0 ? 0 : 1);
