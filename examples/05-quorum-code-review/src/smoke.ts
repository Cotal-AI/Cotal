// Mock end-to-end smoke: broker up, reviewer daemon with 3 instances, orchestrator on the fixture
// PR. Proves the transport + vote without model quota, and checks the isolation the mechanism needs.
// Run: pnpm --filter @cotal-ai/example-05-quorum-code-review smoke  (needs nats-server on PATH)
import { mintLifecycleUid, epCallerReplyFilter, type EpCaller } from "@cotal-ai/core";
import { startBroker, connectNats } from "./space.js";
import { startReviewer } from "./reviewer.js";
import { reviewPr } from "./orchestrator.js";
import { SAMPLE_PR } from "./fixtures/sample-pr.js";

let ok = 0;
let fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) ok++;
  else { fail++; console.log("  x FAIL:", name, extra ?? ""); }
};

async function main() {
  const space = "review";
  const k = 3;
  const broker = await startBroker();
  const instanceIds = Array.from({ length: 3 }, () => mintLifecycleUid());
  const reviewer = await startReviewer({ url: broker.url, space, instanceIds, mock: true });

  // An eavesdropper on a DIFFERENT caller's reply rail: replies are addressed to the orchestrator's
  // caller (nonce-scoped, §13.9), so a foreign caller subscribed to its own rail must see nothing.
  const evil: EpCaller = { owner: "u_evil", actor: "spy", uid: mintLifecycleUid() };
  const spyNc = await connectNats(broker.url);
  let spied = 0;
  spyNc.subscribe(epCallerReplyFilter(space, evil), { callback: () => { spied++; } });
  await spyNc.flush();

  try {
    const result = await reviewPr({ url: broker.url, space, packet: SAMPLE_PR, k, deadlineMs: 8_000, mock: true });

    // Fan-out + broker-derived attribution: every persona scatter draws one reply per instance.
    for (const s of result.stats) {
      check(`${s.persona}: complete scatter over 3 attributed instances`,
        s.complete && s.responders.length === 3 && new Set(s.responders).size === 3, JSON.stringify(s));
      check(`${s.persona}: no anomalies (missing/churn/duplicate/unexpected/invalid all 0)`,
        s.missing + s.churn + s.duplicate + s.unexpected + s.invalid === 0, JSON.stringify(s));
    }

    // The 3 scatters cover the SAME instance set, so runs reconstruct cleanly.
    const responderSets = result.stats.map((s) => [...s.responders].sort().join(","));
    check("the 3 persona scatters cover the same instance set (runs pair up)",
      new Set(responderSets).size === 1, responderSets);
    check("3 runs reconstructed", result.runs.length === 3);

    // The vote: shared findings (in all 3 runs) survive; per-instance noise (1 run) is filtered.
    check("k-of-N kept exactly the 2 shared findings", result.voted.length === 2, result.voted);
    check("every survivor has full 3/3 support", result.voted.every((f) => f.support === 3), result.voted);
    check("the HIGH off-by-one on src/auth.ts:42 survived",
      result.voted.some((f) => f.path === "src/auth.ts" && f.line === 42 && f.severity === "HIGH"));
    check("the cache-before-commit finding on src/cache.ts survived",
      result.voted.some((f) => f.path === "src/cache.ts"));
    check("the per-instance noise on src/util.ts was voted out (support 1 < 3)",
      !result.voted.some((f) => f.path === "src/util.ts"), result.voted);

    // Isolation: a foreign caller never saw the orchestrator's replies.
    check("a foreign caller's reply rail received 0 replies (per-caller nonce-scoped rails)", spied === 0, { spied });
  } finally {
    await spyNc.close();
    await reviewer.stop();
    broker.stop();
  }

  console.log(`\nQUORUM REVIEW SMOKE ${fail === 0 ? "OK" : "FAILED"}  (${ok} passed, ${fail} failed)`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });
