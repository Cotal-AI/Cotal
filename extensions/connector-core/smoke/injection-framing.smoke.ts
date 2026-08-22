/**
 * Injection framing test (no broker, pure function) — the block that carries peer messages into a
 * turn must tell the agent to ACT on what it was asked, not merely to reply.
 *
 * The regression this pins, found by dogfooding a live jcode seat: the operator DM'd a seat
 * "create PROOF.txt ... then confirm by DM". The seat sent the confirmation DM five seconds later,
 * claiming the file was written, having called ZERO file tools. It did it twice. The file did not
 * exist. Only an audit DM that demanded tool-quoted evidence produced a real `write` call.
 *
 * The delivered block ended in `(Reply with cotal_send / cotal_dm, or cotal_roster to see who's
 * here.)` — three reply verbs, no mention of doing the work, offered at the exact moment the model
 * decides what to do next. A weak model reads that as "this is a chat turn; answer it", and an
 * answer that sounds complete is cheaper than the work. That framing is a connector-side
 * contributor to fabricated completions, so the tail names the order of operations instead.
 *
 * The model is not obliged to obey a footer. This does not make fabrication impossible; it stops
 * the connector from actively steering toward it, which is the part we own.
 *
 * Run: pnpm smoke:injection-framing
 */
import { strict as assert } from "node:assert";
import { formatInjection } from "../src/control.js";
import type { InboxItem } from "../src/agent.js";

let pass = 0;
const check = (name: string, cond: boolean, extra?: unknown): void => {
  assert.ok(cond, `${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

const dm = (text: string, over: Partial<InboxItem> = {}): InboxItem =>
  ({
    kind: "dm",
    fromName: "operator",
    fromRole: undefined,
    text,
    historical: false,
    ...over,
  }) as InboxItem;

console.log("injection framing");

// 1. An order carrying work must not be framed as reply-only.
{
  const out = formatInjection([dm("Create PROOF.txt containing exactly: alive-8847, then confirm.")]);
  check("returns a block for one item", typeof out === "string" && out.length > 0);
  const tail = (out ?? "").split("\n").at(-1) ?? "";
  check(
    "tail does not open with a bare reply instruction",
    !/^\(Reply with/.test(tail),
    tail,
  );
  check(
    "tail names doing the work before answering",
    /\b(do|act|perform|carry out|use your (own )?tools)\b/i.test(tail),
    tail,
  );
  check(
    "tail still names the reply verbs (an agent must know how to answer)",
    tail.includes("cotal_dm") && tail.includes("cotal_send"),
    tail,
  );
}

// 2. The claim-only failure mode is named, because that is the observed bug.
{
  const out = formatInjection([dm("Write the file and report back.")]) ?? "";
  const tail = out.split("\n").at(-1) ?? "";
  check(
    "tail warns against reporting work that was not performed",
    /\b(not|never|don't|do not)\b[^.]*\b(claim|report|say)\b/i.test(tail),
    tail,
  );
}

// 3. Everything the block already guaranteed still holds.
{
  const items = [dm("first"), dm("second", { fromName: "peer2", fromRole: "reviewer" })];
  const out = formatInjection(items) ?? "";
  check("header counts items", out.includes("2 new messages"), out.split("\n")[0]);
  check("each item is rendered", out.includes("first") && out.includes("second"));
  check("sender identity is preserved", out.includes("peer2/reviewer"));
  check("empty input yields no block", formatInjection([]) === undefined);
}

// 4. Historical items keep their marker (the #775 contract) and are not re-framed as orders.
{
  const out = formatInjection([dm("old channel chatter", { historical: true })]) ?? "";
  check("historical marker survives", out.includes("(history)"), out);
}

console.log(`injection framing: ${pass} cells OK`);
