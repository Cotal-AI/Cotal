/**
 * THE §13.19.2 CAPTURE FRONTIER IS A POSITION, NOT A CLOCK.
 *
 * A consent may read a tool result only when the result's START lies AFTER the durable position `P`
 * the connector sampled when that consent was verified. `queueFrontier` places `P` against each
 * read through the same source-only comparison `queueTerminal` uses, and `eligibleAt(i)` answers
 * which consents a record at index `i` is eligible for.
 *
 * What this file is really guarding, in order of how much it would cost to get wrong:
 *
 * 1. **An unplaced frontier grants nothing.** §13.19.2 says so outright. The tempting failure is to
 *    treat a frontier in flight as "eligible from now on", which hands the consent every record the
 *    pump happens to reach before the position resolves.
 * 2. **A superseded life generation commits nothing.** A revoke landing while the position resolves
 *    must not produce a narrowed frontier or a frontier starting at the revoke — the consent is
 *    gone, and the activation commits nothing at all.
 * 3. **Records BEFORE `P` stay ineligible**, including records already in the source when the
 *    consent arrived. This is the cell that fails if anyone ever compares wall-clock capture time
 *    instead of position, which §13.19.2 forbids by name.
 *
 * The source is a real `JsonlFileSource` on a real filesystem and `P` is a real `end()` cursor, so
 * the placement being tested is the production one rather than a restatement of it.
 *
 * Run: pnpm smoke:tool-result-frontier
 */
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eventChannel, type Part } from "@cotal-ai/core";
import { memorySubjectFrontier } from "@cotal-ai/smoke-kit";
import {
  runFinished,
  runStarted,
  textMessageContent,
  textMessageEnd,
  textMessageStart,
  type AguiEvent,
} from "../src/agui.js";
import { AguiEmitter } from "../src/agui-emitter.js";
import { JsonlFileSource } from "../src/durable-source.js";
import { EventWal } from "../src/event-wal.js";

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

const PRINCIPAL = { owner: "local", actor: "aaa" };
const PRINCIPAL_KEY = "local.aaa";
const SPACE = "main";
const THREAD = "thread-1";
const CHANNEL = eventChannel(PRINCIPAL);

class FakeEndpoint {
  readonly principal = PRINCIPAL;
  readonly actorIsEphemeral = false;
  maxPayload = 65536;
  publishes: { parts: Part[] }[] = [];
  async assertExpectationSemantics(): Promise<void> {}
  encodedSize(o: { channel: string; parts: Part[]; id: string; expectedLastSubjectSeq: number }): number {
    return Buffer.byteLength(JSON.stringify(o), "utf8") + 64;
  }
  async multicastExpecting(o: { channel: string; parts: Part[] }): Promise<{ ack: { seq: number; duplicate: boolean } }> {
    this.publishes.push({ parts: o.parts });
    return { ack: { seq: this.publishes.length, duplicate: false } };
  }
}

const turn = (runId: string, messageId: string, text: string): AguiEvent[] => [
  runStarted({ threadId: THREAD, runId, timestamp: 1 }),
  textMessageStart({ messageId, timestamp: 2, role: "assistant" }),
  textMessageContent({ messageId, delta: text, timestamp: 3 }),
  textMessageEnd({ messageId, timestamp: 4 }),
  runFinished({ threadId: THREAD, runId, timestamp: 5 }),
];

type Rec = { run: string; msg: string; text: string };
const mapper = (r: Rec) => ({ runId: r.run, events: turn(r.run, r.msg, r.text) });

const block = async (name: string, fn: () => Promise<void>): Promise<void> => {
  try {
    await fn();
  } catch (e) {
    c(`${name} (block crashed)`, false, String(e));
  }
};

const dir = mkdtempSync(join(tmpdir(), "tool-result-frontier-"));

const fresh = async (name: string) => {
  const d = join(dir, name);
  mkdirSync(d, { recursive: true });
  const src = join(d, "session.jsonl");
  writeFileSync(src, "");
  const wal = await EventWal.open(join(d, "wal.json"), {
    space: SPACE,
    threadId: THREAD,
    principal: PRINCIPAL_KEY,
    subjectMayExist: false,
  });
  const source = new JsonlFileSource<Rec>(src);
  const ep = new FakeEndpoint();
  const em = await AguiEmitter.start({ endpoint: ep, wal, subjectFrontier: memorySubjectFrontier(), source, map: mapper });
  // PRIME THE ADOPT POINT BEFORE ANY FIXTURE RECORD EXISTS. A fresh adopt reads from the source's
  // CURRENT END, so records appended before the emitter's first read are skipped by it — and a
  // frontier sampled among those records then sits behind everything the emitter ever reads, which
  // `boundary` correctly reports as a position it has already read past. Pumping the empty source
  // first fixes the adopt at offset 0, so every fixture append after this is a record the emitter
  // actually reads and can place a position against.
  await em.pump();
  return { src, source, em, ep };
};

const append = (path: string, ...recs: Rec[]): void => {
  appendFileSync(path, recs.map((r) => JSON.stringify(r)).join("\n") + "\n");
};

const rec = (n: number): Rec => ({ run: `run-${n}`, msg: `msg-${n}`, text: `t${n}` });

try {
  // ── AN UNPLACED FRONTIER GRANTS NOTHING ────────────────────────────────────────────────────────
  await block("AN UNPLACED FRONTIER GRANTS NOTHING", async () => {
    const { source, em } = await fresh("unplaced");
    // A position that never resolves: the consent is verified, the end() call has not answered.
    em.queueFrontier({ consentId: "c-pending", at: new Promise<string>(() => {}), generation: () => 1 });
    c("unplaced: the frontier is waiting", em.waitingFrontiers === 1, em.waitingFrontiers);
    c("unplaced: no record is eligible for it", em.eligibleAt(0).length === 0, em.eligibleAt(0));
    c("unplaced: nor is a later record", em.eligibleAt(99).length === 0, em.eligibleAt(99));
    // And it is still unplaced afterwards: a pump does not resolve what the source has not answered.
    void source;
  });

  // ── RECORDS AFTER `P` ARE ELIGIBLE; RECORDS BEFORE IT ARE NOT ──────────────────────────────────
  await block("RECORDS AFTER P ARE ELIGIBLE; RECORDS BEFORE IT ARE NOT", async () => {
    const { src, source, em } = await fresh("split");
    // Two records are already in the source when the consent arrives — the backlog §13.19.2 names.
    append(src, rec(1), rec(2));
    const P = await source.end();
    em.queueFrontier({ consentId: "c-mid", at: Promise.resolve(P), generation: () => 1 });
    // Two more arrive after it. One read now covers records both before and after `P`.
    append(src, rec(3), rec(4));
    await em.pump();
    c("split: the frontier was placed", em.waitingFrontiers === 0, em.waitingFrontiers);
    c("split: the backlog's first record is NOT eligible", !em.eligibleAt(0).includes("c-mid"), em.eligibleAt(0));
    c("split: the backlog's second record is NOT eligible", !em.eligibleAt(1).includes("c-mid"), em.eligibleAt(1));
    c("split: the first record after P IS eligible", em.eligibleAt(2).includes("c-mid"), em.eligibleAt(2));
    c("split: the second record after P IS eligible", em.eligibleAt(3).includes("c-mid"), em.eligibleAt(3));
  });

  // ── A FRONTIER PLACED IN AN EARLIER READ COVERS EVERY LATER RECORD ─────────────────────────────
  await block("A FRONTIER PLACED IN AN EARLIER READ COVERS EVERY LATER RECORD", async () => {
    const { src, source, em } = await fresh("settled");
    append(src, rec(1));
    const P = await source.end();
    em.queueFrontier({ consentId: "c-settled", at: Promise.resolve(P), generation: () => 1 });
    append(src, rec(2));
    await em.pump();
    c("settled: placed in the first read", em.waitingFrontiers === 0, em.waitingFrontiers);
    c("settled: the pre-P record is not eligible", !em.eligibleAt(0).includes("c-settled"), em.eligibleAt(0));
    append(src, rec(3), rec(4));
    await em.pump();
    // In the SECOND read it needs no index: every record of it is after a position in the first.
    c("settled: the next read's first record is eligible", em.eligibleAt(0).includes("c-settled"), em.eligibleAt(0));
    c("settled: and so is its last", em.eligibleAt(1).includes("c-settled"), em.eligibleAt(1));
  });

  // ── A SUPERSEDED LIFE GENERATION COMMITS NOTHING ───────────────────────────────────────────────
  await block("A SUPERSEDED LIFE GENERATION COMMITS NOTHING", async () => {
    const { src, source, em } = await fresh("generation");
    const P = await source.end();
    // The consent is verified at generation 1; a revoke advances it while the position resolves.
    let generation = 1;
    em.queueFrontier({ consentId: "c-revoked", at: Promise.resolve(P), generation: () => generation });
    em.queueFrontier({ consentId: "c-live", at: Promise.resolve(P), generation: () => 1 });
    generation = 2;
    append(src, rec(1), rec(2));
    await em.pump();
    c("generation: both frontiers left the queue", em.waitingFrontiers === 0, em.waitingFrontiers);
    c(
      "generation: the superseded consent commits NOTHING, not a narrowed frontier",
      !em.eligibleAt(0).includes("c-revoked") && !em.eligibleAt(1).includes("c-revoked"),
      { at0: em.eligibleAt(0), at1: em.eligibleAt(1) },
    );
    // The control: an identical frontier whose generation did not move IS committed, so the cell
    // above is measuring the fence and not a placement that silently failed for both.
    c("generation: the untouched consent is still committed", em.eligibleAt(0).includes("c-live"), em.eligibleAt(0));
    append(src, rec(3));
    await em.pump();
    c("generation: the superseded consent stays gone in later reads", !em.eligibleAt(0).includes("c-revoked"), em.eligibleAt(0));
  });

  // ── AN UNREADABLE POSITION DROPS THE FRONTIER AND SAYS SO ──────────────────────────────────────
  await block("AN UNREADABLE POSITION DROPS THE FRONTIER AND SAYS SO", async () => {
    const { src, em } = await fresh("unreadable");
    em.queueFrontier({
      consentId: "c-broken",
      at: Promise.reject(new Error("end() failed")),
      generation: () => 1,
    });
    append(src, rec(1));
    let message = "";
    try {
      await em.pump();
    } catch (e) {
      message = (e as Error).message;
    }
    c("unreadable: the pump reports the drop", message.includes("the capture frontier for consent c-broken"), message);
    c("unreadable: the frontier is dropped, not retried forever", em.waitingFrontiers === 0, em.waitingFrontiers);
    c("unreadable: it grants nothing", !em.eligibleAt(0).includes("c-broken"), em.eligibleAt(0));
    // The next pump goes on without it, rather than the plane ending at that position.
    await em.pump();
    c("unreadable: a later pump succeeds", em.waitingFrontiers === 0, em.waitingFrontiers);
  });

  // ── THE ANSWER CANNOT BE USED TO WIDEN THE EMITTER'S OWN STATE ─────────────────────────────────
  await block("THE ANSWER CANNOT BE USED TO WIDEN THE EMITTER'S OWN STATE", async () => {
    const { src, source, em } = await fresh("isolation");
    const P = await source.end();
    em.queueFrontier({ consentId: "c-one", at: Promise.resolve(P), generation: () => 1 });
    append(src, rec(1));
    await em.pump();
    const answer = em.eligibleAt(0);
    c("isolation: the consent is eligible", answer.includes("c-one"), answer);
    answer.push("c-smuggled");
    c(
      "isolation: mutating a returned answer does not add a consent",
      !em.eligibleAt(0).includes("c-smuggled"),
      em.eligibleAt(0),
    );
  });

  const FLOOR = 22;
  c(`the run executed at least ${FLOOR} cells`, pass >= FLOOR, pass);

  console.log(`tool-result-frontier smoke: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
} catch (e) {
  console.error("FATAL:", e);
  process.exit(1);
} finally {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
