/**
 * `OpenCodeSessionSource`: the cursor, the settle rule, and what a revert does to a resume.
 *
 * **Why this suite is built from constructed sessions while the mapping suite refuses to be.** The
 * mapping suite asserts what OpenCode actually writes, so a hand-written record would be asserting
 * the author's belief about the source. This suite asserts the source's own ORDERING and STOPPING
 * behaviour at boundaries a real session mostly does not contain: an id inversion across a message
 * boundary, a part that never settles, a cursor whose record was reverted away. Those are exactly
 * the states a captured session cannot be relied on to hold, and every one of them is reachable in
 * production. The real session is not absent from the evidence: the last cell replays the committed
 * fixture, which is derived from one, and asserts it drains completely.
 *
 * Never prints record content: cells report counts, ids of the fixture's own making, and type names.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  OpenCodeSessionSource,
  isSettled,
  cursorOf,
  type OpenCodeMessageWithParts,
  type OpenCodePart,
} from "../src/agui-source.js";

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

/** A settled assistant text part. */
const text = (id: string, messageID: string, end = 2): OpenCodePart => ({
  id, messageID, type: "text", text: "body", time: { start: 1, end },
});
/** A text part still streaming: no end mark. */
const openText = (id: string, messageID: string): OpenCodePart => ({
  id, messageID, type: "text", text: "body", time: { start: 1 },
});
const tool = (id: string, messageID: string, status: string): OpenCodePart => ({
  id, messageID, type: "tool", callID: `call-${id}`, tool: "read", state: { status, input: {}, output: "out" },
});
const assistant = (id: string, parts: OpenCodePart[], completed?: number): OpenCodeMessageWithParts => ({
  info: { id, role: "assistant", time: { created: 1, ...(completed === undefined ? {} : { completed }) } },
  parts,
});
/** A user message as OpenCode really shapes one: `time` carries `created` ONLY, and its text part
 *  carries no `time` object at all. Both are measured properties, and both are why the authorship
 *  gate has to come first. */
const user = (id: string, partId: string): OpenCodeMessageWithParts => ({
  info: { id, role: "user", time: { created: 1 } },
  parts: [{ id: partId, messageID: id, type: "text", text: "prompt" }],
});

const drain = async (src: OpenCodeSessionSource, from: string | undefined) => {
  const ids: string[] = [];
  let cursor = from;
  for (;;) {
    const r = await src.read(cursor);
    if (r.records.length === 0) return { ids, cursor: r.cursor };
    for (const rec of r.records) ids.push(rec.value.part.id);
    cursor = r.cursor;
  }
};

// ---------------------------------------------------------------------------- fresh adopt
{
  const data = [assistant("msg_1", [text("prt_1", "msg_1"), text("prt_2", "msg_1")], 9)];
  const src = new OpenCodeSessionSource({ read: async () => data });
  const first = await src.read(undefined);
  c("adopt:a fresh adopt returns NO records", first.records.length === 0, first.records.length);
  c("adopt:a fresh adopt returns the position of the END", first.cursor === "msg_1:prt_2", first.cursor);
  const second = await src.read(first.cursor);
  c("adopt:and the next read from it returns nothing, so history is not rebroadcast",
    second.records.length === 0, second.records.length);
}
{
  const src = new OpenCodeSessionSource({ read: async () => [] });
  const first = await src.read(undefined);
  c("adopt:an empty session adopts to the empty cursor", first.cursor === "" && first.records.length === 0, first);
  const second = await src.read("");
  c("adopt:reading from the empty cursor on an empty session stays empty",
    second.records.length === 0 && second.cursor === "", second);
}

// ---------------------------------------------------------------------------- the pair cursor
{
  // The measured inversion, reproduced: a LATER message whose first part id sorts BELOW the last
  // part id of the message before it. In the corpus this is a user prompt part created while the
  // assistant's final part was still being written, 16 times in 14 759 ordered pairs.
  const data = [
    assistant("msg_1", [text("prt_500", "msg_1")], 9),
    assistant("msg_2", [text("prt_100", "msg_2")], 9),
  ];
  const src = new OpenCodeSessionSource({ read: async () => data });
  const all = await drain(src, "");
  c("cursor:both parts drain even though the second id sorts below the first",
    all.ids.join(",") === "prt_500,prt_100", all.ids);
  const after = await src.read("msg_1:prt_500");
  c("cursor:resuming after the first message yields the LOWER-id part in the next message",
    after.records.length === 1 && after.records[0]!.value.part.id === "prt_100",
    after.records.map((r) => r.value.part.id));
  // The control that gives the cell its meaning: a part-id-only comparison, which is what the plan
  // specified before this was measured, drops that record entirely.
  const partIdOnly = data.flatMap((m) => m.parts).filter((p) => p.id > "prt_500");
  c("cursor:CONTROL - a bare part-id cursor would have skipped it", partIdOnly.length === 0, partIdOnly.length);
}
{
  const src = new OpenCodeSessionSource({ read: async () => [] });
  let refused = "";
  await src.read("no-colon-here").catch((e: unknown) => { refused = String((e as Error).message); });
  c("cursor:a malformed cursor is refused loudly", /malformed cursor/.test(refused), refused.slice(0, 40));
}

// ---------------------------------------------------------------------------- the settle rule
{
  const data = [assistant("msg_1", [text("prt_1", "msg_1"), openText("prt_2", "msg_1"), text("prt_3", "msg_1")])];
  const src = new OpenCodeSessionSource({ read: async () => data });
  const r = await src.read("");
  c("settle:the read STOPS at the first unsettled part", r.records.map((x) => x.value.part.id).join(",") === "prt_1", r.records.length);
  c("settle:and the cursor does not advance past it", r.cursor === "msg_1:prt_1", r.cursor);
  c("settle:the part AFTER the unsettled one is withheld, not emitted around",
    !r.records.some((x) => x.value.part.id === "prt_3"), r.records.map((x) => x.value.part.id));
  // The stall clears, and nothing was lost.
  data[0]!.parts[1] = text("prt_2", "msg_1");
  const after = await drain(src, r.cursor);
  c("settle:when it settles, it and everything behind it arrive in order",
    after.ids.join(",") === "prt_2,prt_3", after.ids);
}
{
  const pending = [assistant("msg_1", [tool("prt_1", "msg_1", "pending")])];
  const running = [assistant("msg_1", [tool("prt_1", "msg_1", "running")])];
  const done = [assistant("msg_1", [tool("prt_1", "msg_1", "completed")])];
  const errored = [assistant("msg_1", [tool("prt_1", "msg_1", "error")])];
  const read = async (d: OpenCodeMessageWithParts[]) => (await new OpenCodeSessionSource({ read: async () => d }).read("")).records.length;
  c("settle:a tool part is withheld while pending", (await read(pending)) === 0);
  c("settle:a tool part is withheld while running", (await read(running)) === 0);
  c("settle:a completed tool part is released", (await read(done)) === 1);
  c("settle:an errored tool part is released, because error IS a terminal state", (await read(errored)) === 1);
}
{
  // The turn-level backstop: a part that never got its own end mark is settled once the message says
  // the turn is over. Without it a markless turn wedges the stream permanently.
  const open = [assistant("msg_1", [openText("prt_1", "msg_1")])];
  const closed = [assistant("msg_1", [openText("prt_1", "msg_1")], 9)];
  const read = async (d: OpenCodeMessageWithParts[]) => (await new OpenCodeSessionSource({ read: async () => d }).read("")).records.length;
  c("settle:an end-less part is withheld while its turn is open", (await read(open)) === 0);
  c("settle:message.time.completed settles it", (await read(closed)) === 1);
}
{
  // AUTHORSHIP GATES BEFORE PART TYPE, and this is the cell that proves the wedge is gone. A user
  // message carries no `completed` (the field does not exist on `UserMessage`) and its text part
  // carries no `time` at all, so under a type-first rule neither settle signal can ever arrive.
  const data = [user("msg_1", "prt_1"), assistant("msg_2", [text("prt_2", "msg_2")], 9)];
  const src = new OpenCodeSessionSource({ read: async () => data });
  const all = await drain(src, "");
  c("settle:a user prompt part does NOT wedge the stream", all.ids.join(",") === "prt_1,prt_2", all.ids);
  c("settle:isSettled says so directly for a user part with no time and no completed",
    isSettled({ part: data[0]!.parts[0]!, message: data[0]!.info }), false);
}
{
  // A part with no emitting arm cannot be the reason a frame is wrong, so it does not gate one.
  const step: OpenCodePart = { id: "prt_1", messageID: "msg_1", type: "step-start" };
  const data = [assistant("msg_1", [step, text("prt_2", "msg_1")])];
  const src = new OpenCodeSessionSource({ read: async () => data });
  const r = await src.read("");
  c("settle:a non-emitting part passes straight through", r.records.length === 2, r.records.length);
}

// ---------------------------------------------------------------------------- removal
{
  const full = [assistant("msg_1", [text("prt_1", "msg_1"), text("prt_2", "msg_1")], 9),
                assistant("msg_2", [text("prt_3", "msg_2")], 9)];
  const reverted = [assistant("msg_1", [text("prt_1", "msg_1")], 9),
                    assistant("msg_2", [text("prt_3", "msg_2")], 9)];
  let current: OpenCodeMessageWithParts[] = full;
  const seen: string[] = [];
  const src = new OpenCodeSessionSource({ read: async () => current, onVanished: (x) => seen.push(x) });
  await src.read("");
  current = reverted; // the revert removes prt_2, which is exactly where the cursor stands
  const after = await src.read("msg_1:prt_2");
  c("removal:a resume whose own record was reverted away still returns the records after it",
    after.records.map((r) => r.value.part.id).join(",") === "prt_3", after.records.map((r) => r.value.part.id));
  c("removal:the divergence is reported, naming the cursor", seen.join(",") === "msg_1:prt_2", seen);
  await src.read("msg_1:prt_2");
  await src.read("msg_1:prt_2");
  c("removal:and reported ONCE, not once per read, so it cannot bury the next one", seen.length === 1, seen.length);
}

// ---------------------------------------------------------------------------- the real session
{
  const here = dirname(fileURLToPath(import.meta.url));
  const fixture = JSON.parse(
    readFileSync(join(here, "fixtures", "session-shape.json"), "utf8"),
  ) as OpenCodeMessageWithParts[];
  const parts = fixture.reduce((n, m) => n + m.parts.length, 0);
  const src = new OpenCodeSessionSource({ read: async () => fixture });
  const all = await drain(src, "");
  c("fixture:the whole derived-from-real session drains", all.ids.length === parts, { drained: all.ids.length, parts });
  c("fixture:it drains in id order, which is what the cursor claims to guarantee",
    all.ids.join(",") === [...all.ids].sort().join(","), all.ids.length);
  const last = fixture.at(-1)!;
  c("fixture:the final cursor is the last part of the last message",
    all.cursor === cursorOf({ part: last.parts.at(-1)!, message: last.info }), all.cursor);
}

const EXPECTED = 28;
c(`meta:every cell ran - ${EXPECTED} expected`, pass + fail === EXPECTED, `${pass + fail} cells reported`);

console.log(`agui-opencode-source smoke: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
