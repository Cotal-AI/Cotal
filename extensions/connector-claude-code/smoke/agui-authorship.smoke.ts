/**
 * THE EMITTER MUST NEVER REPUBLISH A BODY THIS PRINCIPAL DID NOT AUTHOR.
 *
 * `events.<owner>.<actor>` carries a DIFFERENT read ACL from the channel a peer message arrived on.
 * Re-emitting an injected mesh message's text there is a republication across an ACL boundary. §3.1
 * states the property as already true — *"a `RUN_STARTED` attributed to a peer republishes no
 * message body"* — and it was NOT: the mapper emitted `TEXT_MESSAGE_CONTENT` carrying the peer's
 * `content` verbatim, measured at 240 bytes in and 240 bytes out on a real session.
 *
 * **THIS IS A HOSTILE FIXTURE, NOT A HAPPY PATH.** Every record below is peer-authored or carries
 * another principal's text, and the suite's job is to prove none of it reaches the wire.
 *
 * **THE CLAIM IS JOINED, SO IT GETS A DECOY PER FACT (§57).** "No peer content is emitted" is
 * satisfied completely by a mapper that emits nothing at all, so a one-armed suite would go green
 * against a filter that had broken everything. The two arms are therefore:
 *
 *   A. SAFETY  — a peer record emits `RUN_STARTED` and **no `TEXT_MESSAGE_*` whatsoever**.
 *   B. LIVENESS — a self-authored record still emits its content in full.
 *
 * A mutation that suppresses all bodies reddens B while A stays green; a mutation that removes the
 * authorship check reddens A while B stays green. If one mutation reddened both, they would be
 * testing one axis under two names (§57) rather than two facts.
 *
 * **AND THE SAFETY CELL ASSERTS ABSENCE OF THE BYTES, NOT ABSENCE OF AN EVENT TYPE.** Checking only
 * that no `TEXT_MESSAGE_CONTENT` appears would pass a mapper that moved the peer's text into a
 * `delta` on some other event, or into `cotal` metadata. So the corpus is searched for the secret
 * itself, over every event, serialized — the property is "these bytes do not leave", and only a
 * search for those bytes expresses it.
 *
 * Run: npx tsx extensions/connector-claude-code/smoke/agui-authorship.smoke.ts
 */
import { createClaudeMapper, type ClaudeEntry } from "../src/agui-map.js";

let pass = 0;
let fail = 0;
const c = (n: string, v: boolean, extra?: unknown): void => {
  if (v) {
    pass += 1;
    return;
  }
  fail += 1;
  console.error(`  x FAIL: ${n}${extra === undefined ? "" : ` ${JSON.stringify(extra)}`}`);
};

/**
 * A canary a real session would never contain, so a hit is unambiguous.
 *
 * Distinct per record: one shared string could leak from record 1 and be reported against record 3,
 * and "something leaked" is a weaker finding than "THIS record leaked".
 */
const PEER_SECRET = "PEER-AUTHORED-CANARY-b4d9f1-DO-NOT-REPUBLISH";
const PEER_SECRET_2 = "PEER-AUTHORED-CANARY-7c2e08-ALSO-DO-NOT-REPUBLISH";
const TOOL_SECRET = "TOOL-RESULT-CANARY-3aa61c-ANOTHER-PRINCIPALS-TEXT";
const MINE = "my own words, authored by this principal";

const mk = (o: Partial<ClaudeEntry> & { uuid: string }): ClaudeEntry => o as ClaudeEntry;

/** Peer/mesh delivery — a turn, and NOT ours to republish. */
const peer = (uuid: string, text: string): ClaudeEntry =>
  mk({ uuid, type: "user", timestamp: "2026-08-15T00:00:00.000Z", origin: { kind: "channel" }, message: { role: "user", content: text } } as never);

/** The operator's own typed prompt — ours, and it stays. */
const human = (uuid: string, text: string): ClaudeEntry =>
  mk({ uuid, type: "user", timestamp: "2026-08-15T00:00:01.000Z", origin: { kind: "human" }, message: { role: "user", content: text } } as never);

const mapAll = (entries: ClaudeEntry[]) => {
  let n = 0;
  const m = createClaudeMapper({ threadId: "thread-hostile", mintRunId: () => `run-${++n}` });
  const events: Record<string, unknown>[] = [];
  for (const e of entries) {
    const out = m.map(e);
    if (out) events.push(...(out.events as unknown as Record<string, unknown>[]));
  }
  return { events, mapper: m };
};

// ── ARM A: SAFETY — the hostile corpus ────────────────────────────────────────────────────────
{
  const { events } = mapAll([peer("u1", PEER_SECRET), peer("u2", PEER_SECRET_2)]);
  const wire = JSON.stringify(events);

  // THE PROPERTY, stated over BYTES rather than over event types.
  c("a peer record's text does NOT appear anywhere on the wire", !wire.includes(PEER_SECRET));
  c("...nor does a second, distinct peer record's text", !wire.includes(PEER_SECRET_2));

  // The run still opens: withholding the body must not cost the observer the fact of the turn.
  const types = events.map((e) => e.type);
  c("a peer-initiated turn still OPENS A RUN", types.includes("RUN_STARTED"), types);
  c("...attributed to the peer via cotal.turnSource",
    events.some((e) => e.type === "RUN_STARTED" && (e.cotal as Record<string, unknown> | undefined)?.turnSource === "channel"),
    events.find((e) => e.type === "RUN_STARTED")?.cotal);

  // No message envelope at all — not an empty one. An empty TEXT_MESSAGE_* triple would be a
  // message that exists and says nothing, which a renderer draws as a blank from a peer.
  c("NO TEXT_MESSAGE_* events are emitted for a peer record",
    !types.some((t) => typeof t === "string" && t.startsWith("TEXT_MESSAGE")), types);
}

// ── ARM B: LIVENESS — the decoy for the OTHER fact ────────────────────────────────────────────
// Without this, "emit nothing, ever" passes every cell above.
{
  const { events } = mapAll([human("u3", MINE)]);
  const wire = JSON.stringify(events);
  const types = events.map((e) => e.type);
  c("DECOY/LIVENESS — a self-authored record DOES still emit its content", wire.includes(MINE));
  c("...as a full TEXT_MESSAGE_START/CONTENT/END triple",
    types.includes("TEXT_MESSAGE_START") && types.includes("TEXT_MESSAGE_CONTENT") && types.includes("TEXT_MESSAGE_END"),
    types);
  c("...and it opens a run attributed to the human",
    events.some((e) => e.type === "RUN_STARTED" && (e.cotal as Record<string, unknown> | undefined)?.turnSource === "human"));
}

// ── ARM C: THE MIXED STREAM ───────────────────────────────────────────────────────────────────
// The two arms above are each homogeneous, and a filter keyed on the WRONG thing — position, a
// latched flag, "the first record" — can satisfy both while failing on an interleaving. This is the
// case a real session actually produces.
{
  const { events } = mapAll([
    human("u4", MINE),
    peer("u5", PEER_SECRET),
    human("u6", `${MINE} again`),
    peer("u7", PEER_SECRET_2),
  ]);
  const wire = JSON.stringify(events);
  c("MIXED — neither peer secret survives an interleaved stream",
    !wire.includes(PEER_SECRET) && !wire.includes(PEER_SECRET_2));
  c("MIXED — the human content in the SAME stream still does", wire.includes(MINE));
  // Every turn is still visible as a turn, peer ones included: 4 records, 4 runs.
  c("MIXED — all four turns open runs, so suppression cost no visibility",
    events.filter((e) => e.type === "RUN_STARTED").length === 4,
    events.filter((e) => e.type === "RUN_STARTED").length);
}

// ── ARM D: A TOOL RESULT CARRYING ANOTHER PRINCIPAL'S TEXT ────────────────────────────────────
// Named separately because it arrives by a different route: not an `origin.kind`, but a peer's
// words quoted inside this session's own tool output. Recorded as a KNOWN LIMIT rather than
// asserted as safe — see the cell name.
{
  const toolResult = mk({
    uuid: "u8",
    type: "user",
    timestamp: "2026-08-15T00:00:05.000Z",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: TOOL_SECRET }] },
  } as never);
  const { events } = mapAll([human("u9", MINE), toolResult]);
  const wire = JSON.stringify(events);
  // This is NOT a safety claim. A tool result is this session's own output and IS republished by
  // design; if it quotes a peer, that text rides along. Stating it as a measured limit so nobody
  // reads arm A as "no peer text can ever reach the wire".
  c("KNOWN LIMIT: a tool result IS emitted, so peer text quoted inside one is not covered by this filter",
    wire.includes(TOOL_SECRET));
}

// A COUNT, because several cells above build their own inputs and a regression that DELETES one
// leaves the run green with fewer cells rather than red. The PR body leans on this number, so the
// suite is what holds it rather than a sentence.
const EXPECTED = 12;
c(`every cell ran - ${EXPECTED} expected`, pass + fail === EXPECTED, `${pass + fail} cells reported`);

console.log(`agui-authorship smoke: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
