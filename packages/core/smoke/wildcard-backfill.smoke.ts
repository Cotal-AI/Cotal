/**
 * Wildcard backfill / tail-drop test (open mode — no auth). Closes two untested OPEN-MODE
 * wildcard paths that `channels.smoke.ts` leaves uncovered:
 *   - 4A WILDCARD BACKFILL: with `defaults.replay = true`, a fresh recorder that boots a wildcard
 *     channel (`wbk.>`) backfills the WHOLE retained subtree (`wbk.security`, `wbk.a.b`) as
 *     `historical` — proving `chat.*.wbk.>` filters + replays the subtree and `joinPolicyFresh`
 *     skips the illegal `>` KV get WITHOUT no-op'ing the backfill. The reference's wildcard block
 *     only tests LIVE delivery (its backfilled count is structurally 0).
 *   - 8B NO-REPLAY WILDCARD TAIL-DROP: with `defaults.replay = false`, a pre-join message on a
 *     concrete sub-channel (`tld.security`) is SUPPRESSED on a wildcard (`tld.>`) join via
 *     `dropWatermark` matching `subjectMatches('tld.>','tld.security')`, and post-join live still
 *     flows. The reference tail-drop block only exercises a CONCRETE channel pattern, never the
 *     wildcard pattern-match form.
 *
 * Spins up its OWN nats-server on an OS-assigned free port and tears it down with await-exit, so it never
 * collides with brokers from concurrent test runs.
 * Run: pnpm smoke:wildcard-backfill
 */
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CotalEndpoint, seedChannelRegistry, isReachable,
  type CotalMessage, type Delivery, type MessageMeta,
} from "../src/index.js";
import { pickFreePort } from "./_free-port.js";

// Fresh OS-assigned port per run: a fixed port lets a leaked broker from a crashed prior run serve
// stale JetStream state to the next run (reads as a flaky gate). A fresh port isolates each run even
// if teardown ever leaks; the await-exit in `finally` keeps a clean run from ever leaking.
const PORT = await pickFreePort();
const servers = `nats://127.0.0.1:${PORT}`;
const space = "wbksmoke";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Poll a condition until it holds or the timeout elapses — for "the expected messages arrived"
 *  waits. Replaces a fixed `sleep()` before a POSITIVE assertion: backfill + live delivery settle in
 *  variable time under load, so a tight fixed wait flakes. Absence checks still settle via a plain
 *  sleep (you cannot poll for non-arrival). Returns the final condition value for the assertion. */
const until = async (cond: () => boolean, timeoutMs = 8000, stepMs = 50): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (!cond() && Date.now() < deadline) await sleep(stepMs);
  return cond();
};
const textOf = (m: CotalMessage) => m.parts.map((p) => (p.kind === "text" ? p.text : "")).join("");

interface Rec { channel?: string; text: string; historical: boolean; kind?: MessageMeta["kind"] }
function recorder(name: string, id: string, channels: string[]) {
  const got: Rec[] = [];
  const ep = new CotalEndpoint({ space, servers, card: { name, kind: "agent", id }, channels });
  ep.on("error", () => {});
  ep.on("message", (m: CotalMessage, d: Delivery, meta?: MessageMeta) => {
    got.push({ channel: m.channel, text: textOf(m), historical: meta?.historical ?? false, kind: meta?.kind });
    d.ack();
  });
  return { ep, got };
}
const has = (got: Rec[], text: string) => got.filter((g) => g.text === text);

const dir = mkdtempSync(join(tmpdir(), "cotal-wbk-"));
const srv = spawn("nats-server", ["-js", "-p", String(PORT), "-sd", join(dir, "js")], { stdio: "ignore" });
let pass = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, `${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

try {
  for (let i = 0; i < 50; i++) { if (await isReachable(servers)) break; await sleep(200); }

  // A single publisher with concrete channels on both fresh subtrees (publishes must be concrete).
  const A = new CotalEndpoint({ space, servers, card: { name: "A", kind: "agent", id: "A_pub" }, channels: ["wbk.security", "wbk.a.b", "tld.security"] });
  A.on("error", () => {});
  await A.start();
  await sleep(300);

  // ============================================================================================
  // ITEM 4A — WILDCARD BACKFILL ON JOIN (defaults.replay = true)
  // Pre-seed history on TWO levels of a fresh subtree BEFORE a fresh recorder boots `wbk.>`.
  // ============================================================================================
  await seedChannelRegistry({ servers, space, file: { defaults: { replay: true } } });
  await A.multicast("wbk-sec-hist", { channel: "wbk.security" }); // depth-1 subtree leaf
  await A.multicast("wbk-deep-hist", { channel: "wbk.a.b" });     // depth-2 subtree leaf
  await sleep(300);

  // Fresh recorder boots the wildcard `wbk.>` (anchored by concrete `wbk` so the durable filter is
  // well-formed). NOTHING was published to bare `wbk`, so both pre-seeds can only arrive via the
  // wildcard `chat.*.wbk.>` filter — concrete `chat.*.wbk` would not match either.
  const WB = recorder("WB", "WB_wild", ["wbk", "wbk.>"]);
  await WB.ep.start();
  // Catches a wildcard join that builds a broken subtree filter (or throws on the `>` KV get): then
  // these would backfill 0 and this poll would time out false.
  check("wildcard boot backfills the whole subtree as historical",
    await until(() => WB.got.filter((g) => g.historical && g.kind === "channel").length === 2));
  // Both pre-seeds present, BOTH from distinct subtree depths — proves the wildcard, not a single
  // concrete entry, drove the replay. If `joinPolicyFresh` no-op'd the `>` replay, neither arrives.
  check("both subtree depths backfilled as historical=true, kind=channel",
    has(WB.got, "wbk-sec-hist").length === 1 && has(WB.got, "wbk-sec-hist")[0].historical === true && has(WB.got, "wbk-sec-hist")[0].kind === "channel" &&
    has(WB.got, "wbk-deep-hist").length === 1 && has(WB.got, "wbk-deep-hist")[0].historical === true);

  // Same proof via the explicit joinChannel result: a dynamic wildcard join must report backfilled>0.
  // (Regression: a wildcard join that fails to build the subtree filter, or throws on the `>` KV get,
  // returns backfilled 0.)
  const WB2 = recorder("WB2", "WB2_wild", ["wbk"]); // boots concrete-only…
  await WB2.ep.start();
  await sleep(200);
  const jw = await WB2.ep.joinChannel("wbk.>"); // …then dynamically joins the wildcard
  await until(() => WB2.got.filter((g) => g.historical).length === 2);
  check("dynamic wildcard join reports backfilled > 0 (subtree replayed)",
    jw.joined === true && jw.backfilled === 2 && WB2.got.filter((g) => g.historical).length === 2);
  await WB.ep.stop();
  await WB2.ep.stop();

  // ============================================================================================
  // ITEM 8B — NO-REPLAY WILDCARD TAIL-DROP (defaults.replay = false)
  // Pre-seed a concrete sub-channel BEFORE joining the wildcard; the wildcard dropWatermark must
  // suppress it via subjectMatches('tld.>','tld.security').
  // ============================================================================================
  // Flip the SPACE default to no-replay (merge-on-write). A wildcard join reads space defaults only,
  // so this is what gates the backfill off — and arms the live tail-drop instead.
  await seedChannelRegistry({ servers, space, file: { defaults: { replay: false } } });
  await A.multicast("tld-sec-prejoin", { channel: "tld.security" }); // pre-join history on a concrete leaf
  await sleep(300);

  const TD = recorder("TD", "TD_wild", ["tld", "tld.>"]); // boots the wildcard over a no-replay subtree
  await TD.ep.start();
  await sleep(600); // ABSENCE assertion: cannot poll for non-arrival — settle then assert nothing leaked.
  // Two regressions in one line: (a) a wildcard backfill that ignored the no-replay default would
  // emit the pre-join message as historical (backfilled > 0); (b) if dropWatermark didn't match the
  // wildcard pattern against the concrete channel, the pre-join live message would leak un-dropped.
  check("no-replay wildcard boot: pre-join concrete message is dropped (not backfilled, not leaked live)",
    has(TD.got, "tld-sec-prejoin").length === 0,
    { got: TD.got.map((g) => g.text) });

  // Post-join live on the SAME concrete sub-channel must still flow through the wildcard sub —
  // proving the drop is watermark-scoped (seq <= join frontier), not a blanket suppression.
  await A.multicast("tld-sec-postjoin", { channel: "tld.security" });
  await until(() => has(TD.got, "tld-sec-postjoin").length === 1);
  check("post-join live on the concrete leaf flows through the wildcard sub",
    has(TD.got, "tld-sec-postjoin").length === 1 && has(TD.got, "tld-sec-postjoin")[0].historical === false);
  await TD.ep.stop();

  await A.stop();
  console.log(`\nWILDCARD BACKFILL / TAIL-DROP TESTS PASSED ✅  (${pass} checks)`);
} finally {
  // Await the broker's ACTUAL exit before cleanup — SIGKILL signals the child but does not free the
  // port synchronously; returning early can leave the broker alive past teardown, leaking the port.
  // Bounded by a timeout so teardown can never hang.
  srv.kill("SIGKILL");
  await new Promise<void>((resolve) => {
    if (srv.exitCode !== null || srv.signalCode !== null) return resolve();
    srv.once("exit", () => resolve());
    setTimeout(resolve, 3000);
  });
  rmSync(dir, { recursive: true, force: true });
}
process.exit(0);
