/**
 * `OpenCode2SessionSource`: what it hands over, and when, read through the paged 2.x message list.
 *
 * The first cells replay real sessions (`fixtures/opencode2-sessions.json`, redacted captures of an
 * OpenCode 2.2.5 server, polled while each turn ran). Reading a session snapshot by snapshot as it
 * grew must yield the records one read of the finished session yields, each one already final when
 * it was handed over. The constructed cells hold the states a capture is not sure to contain: a step
 * that has written nothing yet, a turn that ended over an unsettled element, a revert, a cursor deep
 * in a long session.
 *
 * Run: pnpm smoke:agui-opencode2-source
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createSuite } from "@cotal-ai/smoke-kit";
import { OpenCode2SessionSource, type OpenCode2Element, type OpenCode2Message, type OpenCode2Record } from "../src/agui-source2.js";

const { check, finish, passed, failed } = createSuite();

/** Serves a message list as the server does: newest first, `size` per page, a keyset cursor that is
 *  still set on a last full page, and an empty page with no cursor after the last. */
function server(size: number) {
  let list: OpenCode2Message[] = [];
  let fetches = 0;
  return {
    set(next: OpenCode2Message[]): void {
      list = next;
    },
    fetches: () => fetches,
    page: async (next: string | undefined) => {
      fetches += 1;
      const desc = [...list].sort((a, b) => (a.id < b.id ? 1 : -1));
      const start = next === undefined ? 0 : desc.findIndex((m) => m.id < next);
      const data = start < 0 ? [] : desc.slice(start, start + size);
      return { data, cursor: { next: data.at(-1)?.id ?? null } };
    },
  };
}

const keyOf = (r: OpenCode2Record): string => `${r.message.id}:${r.index}`;
const keys = (rs: { value: OpenCode2Record }[]): string => rs.map((r) => keyOf(r.value)).join(" ");

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, "fixtures", "opencode2-sessions.json"), "utf8")) as {
  sessions: { name: string; snapshots: OpenCode2Message[][] }[];
};

for (const session of fixture.sessions) {
  const grown = server(2);
  const src = new OpenCode2SessionSource({ page: grown.page });
  const handed: { value: OpenCode2Record }[] = [];
  let cursor = "";
  for (const snapshot of session.snapshots) {
    grown.set(snapshot);
    const read = await src.read(cursor);
    handed.push(...read.records);
    cursor = read.cursor;
  }
  const whole = server(200);
  whole.set(session.snapshots.at(-1)!);
  const all = (await new OpenCode2SessionSource({ page: whole.page }).read("")).records;
  check(`replay:${session.name}: read as it grew, it yields what one read of the finished session yields`,
    keys(handed) === keys(all) && handed.length > 0, { grown: keys(handed), whole: keys(all) });
  const finalElement = new Map(all.map((r) => [keyOf(r.value), JSON.stringify(r.value.element ?? null)]));
  const early = handed.filter((r) => JSON.stringify(r.value.element ?? null) !== finalElement.get(keyOf(r.value)));
  check(`replay:${session.name}: every element was final when it was handed over`, early.length === 0, early.map((r) => keyOf(r.value)));
}

const user = (id: string, created = 1): OpenCode2Message => ({ id, type: "user", time: { created } });
const idle = (id: string): OpenCode2Message => ({ id, type: "idle", time: { created: 9 }, outcome: "succeeded" });
const step = (id: string, content: OpenCode2Element[], marks: { streamed?: number; completed?: number } = {}): OpenCode2Message => ({
  id, type: "assistant", time: { created: 2, ...marks }, content,
});
const text = (body: string): OpenCode2Element => ({ type: "text", text: body });
const tool = (id: string, status: "running" | "completed"): OpenCode2Element => ({
  type: "tool", id, name: "shell", state: { status, input: {} }, time: { created: 3 },
});

{
  const s = server(200);
  const src = new OpenCode2SessionSource({ page: s.page });
  s.set([user("msg_1"), step("msg_2", []), { id: "msg_3", type: "model-switched", time: { created: 4 } }]);
  const first = await src.read("");
  check("hold:a step that has written nothing yet holds every record after it", keys(first.records) === "msg_1:-1", keys(first.records));
  s.set([user("msg_1"), step("msg_2", [text("a")], { streamed: 5, completed: 6 }), { id: "msg_3", type: "model-switched", time: { created: 4 } }]);
  const second = await src.read(first.cursor);
  check("hold:once it writes and finishes, its element comes before the record it held", keys(second.records) === "msg_2:0 msg_3:-1", keys(second.records));
}

{
  const s = server(200);
  const src = new OpenCode2SessionSource({ page: s.page });
  s.set([user("msg_1"), step("msg_2", [tool("call_1", "completed"), text(""), tool("call_2", "running")])]);
  const first = await src.read("");
  check("settle:a finished tool is handed over before its step has finished streaming", keys(first.records) === "msg_1:-1 msg_2:0", keys(first.records));
  s.set([user("msg_1"), step("msg_2", [tool("call_1", "completed"), text("b"), tool("call_2", "running")], { streamed: 5 })]);
  const second = await src.read(first.cursor);
  check("settle:text is handed over once its step has streamed, and a running tool still holds the read",
    keys(second.records) === "msg_2:1", keys(second.records));
  s.set([user("msg_1"), step("msg_2", [tool("call_1", "completed"), text("b"), tool("call_2", "completed")], { streamed: 5, completed: 6 }), idle("msg_3")]);
  const third = await src.read(second.cursor);
  check("settle:the rest follows when the tool ends, then the turn end", keys(third.records) === "msg_2:2 msg_3:-1", keys(third.records));
}

{
  const s = server(200);
  s.set([user("msg_1"), step("msg_2", [text("")]), idle("msg_3")]);
  const read = await new OpenCode2SessionSource({ page: s.page }).read("");
  check("turn-end:a turn that ended settles an element its own marks never did",
    keys(read.records) === "msg_1:-1 msg_2:0 msg_3:-1", keys(read.records));
}

{
  const long = Array.from({ length: 25 }, (_, i) => user(`msg_${String(i + 1).padStart(2, "0")}`));
  const paged = server(4);
  paged.set(long);
  const src = new OpenCode2SessionSource({ page: paged.page });
  const all = await src.read("");
  check("paging:a session longer than a page is read whole from the start",
    all.records.length === 25 && keys(all.records) === long.map((m) => `${m.id}:-1`).join(" "), all.records.length);
  const before = paged.fetches();
  const tail = await src.read("msg_23:-1");
  check("paging:a read from a recent cursor fetches only the pages back to it",
    keys(tail.records) === "msg_24:-1 msg_25:-1" && paged.fetches() - before === 1, { tail: keys(tail.records), fetches: paged.fetches() - before });
}

{
  const s = server(200);
  const vanished: string[] = [];
  const src = new OpenCode2SessionSource({ page: s.page, onVanished: (c) => vanished.push(c) });
  s.set([user("msg_1"), step("msg_2", [text("a")], { streamed: 5, completed: 6 })]);
  const first = await src.read("");
  s.set([user("msg_1"), step("msg_4", [])]);
  const again = await src.read(first.cursor);
  await src.read(first.cursor);
  check("revert:a cursor whose record was removed is reported once and the read goes on by order",
    first.cursor === "msg_2:0" && again.records.length === 0 && vanished.join(" ") === "msg_2:0", { cursor: first.cursor, vanished });
  s.set([user("msg_1"), step("msg_4", [text("c")], { streamed: 7, completed: 8 })]);
  const after = await src.read(first.cursor);
  check("revert:what is written after the revert is read", keys(after.records) === "msg_4:0", keys(after.records));
}

{
  const s = server(200);
  const src = new OpenCode2SessionSource({ page: s.page });
  check("end:an empty session ends at the empty cursor", (await src.end()) === "");
  s.set([user("msg_1"), step("msg_2", [text("a"), tool("call_1", "completed")], { streamed: 5, completed: 6 })]);
  const adopt = await src.read(undefined);
  check("end:an adopt hands over nothing and lands on the last element", adopt.records.length === 0 && adopt.cursor === "msg_2:1", adopt);
  s.set([user("msg_1"), step("msg_2", [text("a"), tool("call_1", "completed")], { streamed: 5, completed: 6 }), user("msg_3")]);
  check("end:only what is written after the adopt is read", keys((await src.read(adopt.cursor)).records) === "msg_3:-1");
}

{
  const src = new OpenCode2SessionSource({ page: server(200).page });
  let refused = 0;
  for (const bad of ["msg_1", ":0", "msg_1:", "msg_1:01", "msg_1:-2", "msg_1:x"]) await src.read(bad).catch(() => (refused += 1));
  check("cursor:a malformed cursor is refused, never guessed at", refused === 6, refused);
}

const EXPECTED = 26;
check(`meta:every cell ran - ${EXPECTED} expected`, passed() + failed() === EXPECTED, `${passed() + failed()} cells reported`);
finish();
