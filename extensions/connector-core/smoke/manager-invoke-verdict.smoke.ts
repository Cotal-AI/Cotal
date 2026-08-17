/**
 * WHAT A PEER-SIDE MANAGER CALL TELLS AN AGENT WHEN IT FAILS.
 *
 * `MeshAgent.managerInvoke` renders every manager-endpoint failure into the one line the `cotal_*`
 * tools hand back to an agent. It used to decide "nobody answered" from the CATALOG CODE — anything
 * `deadline-exceeded` got *"no responder answered - a manager may be down, or this credential holds
 * no <cmd> capability and the broker denied the request"*, and everything else got its bare code.
 * The code is not evidence of silence, and keying on it was wrong in BOTH directions:
 *
 *   - The broker's no-responders 503 is raised as `unavailable`, WITH the marker (endpoint-verbs
 *     `epCall`). That is the case where the capability-denial explanation is most certain, and the
 *     code-keyed branch was the one case that withheld it.
 *   - An answered `ok:false` describe is ALSO `unavailable`, WITHOUT the marker, and deliberately so.
 *     A manager answered. Telling an agent nobody did invites the retry that duplicates a spawn.
 *
 * THE AMBIGUOUS CELL, AND ITS TWIN. `unavailable` is correct under both conditions above, so no
 * single cell here pins anything. Cells 1 and 3 are the same code with the marker present and
 * absent, and they must render OPPOSITELY; either alone would stay green under a renderer that
 * ignored the marker entirely.
 *
 * WHAT THIS DOES AND DOES NOT PROVE. The errors below are CONSTRUCTED, so this grades the rendering
 * and nothing about the wire. That core attaches the marker exactly where it observed silence and
 * withholds it where a responder answered is gated separately and live, in `smoke:ep-invoke`
 * (`endpoint-invoke.smoke.ts:127` the deadline IS marked, `:139` an answered ok:false is NOT — "the
 * code alone is not evidence of silence"). Neither suite is sufficient alone.
 *
 * No broker: the MeshAgent constructor builds an endpoint but never connects, so `ep` is swapped for
 * one that throws. Run: pnpm smoke:manager-invoke-verdict
 */
import { EpEnvelopeError, EP_UNANSWERED, EP_UNBOUND_RESPONDER } from "@cotal-ai/core";
import { MeshAgent } from "../src/agent.js";
import type { AgentConfig } from "../src/config.js";

let pass = 0, fail = 0;
/** A cell RECORDS its verdict; it never throws. A throwing cell takes every cell below it with it,
 *  which turns one defect into a suite that reports nothing about anything after it. The tick is the
 *  repo's, not a word of this file's own: `mutation-proof` counts those ticks to tell "failed at my
 *  assertion" from "died before reaching it", and a suite that invents its own glyph reports zero
 *  marks and gives up that protection without saying so. */
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  \u2713 ${name}`); }
  else { fail++; console.log(`  \u2717 FAIL: ${name}`, extra ?? ""); }
};

const cfg: AgentConfig = {
  space: "smoke", name: "caller", servers: "nats://127.0.0.1:1",
  subscribe: [], allowSubscribe: [], allowPublish: [],
};

/** Render one failure through the real `managerInvoke`. `purgeHistory` is the shortest public path
 *  to it: no target block, no goal follow, so nothing between the throw and the rendering. */
async function render(thrown: unknown): Promise<string> {
  const a = new MeshAgent(cfg);
  (a as unknown as { ep: { invokeService: () => Promise<never>; principal: { owner: string; actor: string } } }).ep = {
    invokeService: () => Promise.reject(thrown),
    principal: { owner: "local", actor: "caller" },
  };
  (a as unknown as { _connected: boolean })._connected = true;
  const r = await a.purgeHistory();
  return r.ok === false ? (r.error ?? "") : `UNEXPECTED ok:true`;
}

const SILENCE = /no responder answered/;
const unanswered = { kind: EP_UNANSWERED, endpoint: "manager", command: "purge" };

console.log("the verdict comes from the marker, not the code:");

// 1. The live change. Broker no-responders is `unavailable` and carries the marker; the old
//    code-keyed branch printed the bare code and dropped the one explanation that was certain.
const noResponders = await render(new EpEnvelopeError("unavailable", "no responder for manager.purge (SPEC 13.5)", [unanswered]));
check("no-responders 503 (`unavailable`, MARKED) says nobody answered", SILENCE.test(noResponders), noResponders);
check("...and names the capability as a cause, which is what the code-keyed branch withheld",
  /capability and the broker denied/.test(noResponders), noResponders);

// 2. Unchanged: a describe that drew no reply at all.
const deadline = await render(new EpEnvelopeError("deadline-exceeded", "no describe reply from manager within 10000ms", [unanswered]));
check("an UNANSWERED deadline still says nobody answered", SILENCE.test(deadline), deadline);

// 3. THE TWIN of cell 1 — same code, no marker, opposite verdict. A manager answered.
const answered = await render(new EpEnvelopeError("unavailable", "describe(manager) failed: trusted auth view failed"));
check("an ANSWERED ok:false describe (`unavailable`, UNMARKED) does NOT say nobody answered", !SILENCE.test(answered), answered);
check("...it prints the responder's own cause under its own code",
  answered === "unavailable: describe(manager) failed: trusted auth view failed", answered);

// 4. The split. A responder handled the request; the effect may have landed. Core's account is what
//    an agent must read here, and it must not be overwritten with a claim of silence.
const split = await render(new EpEnvelopeError("failed-precondition",
  "instance A won the class queue but this UNPINNED handle resolved against B - THIS SAYS NOTHING ABOUT WHETHER THE COMMAND RAN",
  [{ kind: EP_UNBOUND_RESPONDER, endpoint: "manager", command: "purge", answeredBy: "A", boundTo: "B", pinned: false }]));
check("a class-queue split does NOT say nobody answered", !SILENCE.test(split), split);
check("...and core's account survives intact", split.includes("SAYS NOTHING ABOUT WHETHER THE COMMAND RAN"), split);

// 5. A failure carrying no envelope carries no provenance either, so no verdict is stated for it.
const plain = await render(new Error("connection closed"));
check("a non-envelope failure states no verdict at all", !SILENCE.test(plain) && plain === "connection closed", plain);

const EXPECTED_CELLS = 8;
const ran = pass + fail;
console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
if (ran !== EXPECTED_CELLS) {
  console.log(`SUITE INCOMPLETE — ran ${ran} of ${EXPECTED_CELLS} cells; a partial run is not a pass`);
  process.exitCode = 1;
} else process.exitCode = fail === 0 ? 0 : 1;
