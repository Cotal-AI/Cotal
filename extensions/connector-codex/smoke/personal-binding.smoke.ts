/** A personal Codex server binds to the conversation Codex names in each call's request metadata,
 *  never to a tool argument, and its queued notices carry no peer content. */
import { strict as assert } from "node:assert";
import { createCodexPersonalHost } from "../src/personal-host.js";
import { approvalNotice, NOTICE, wakeNotice } from "../src/personal.js";

let pass = 0;
function check(name: string, ok: unknown): void { assert.ok(ok, name); pass++; console.log(`ok ${name}`); }
const opened: string[] = [];
const host = createCodexPersonalHost({
  cotal: () => { throw new Error("no CLI in this smoke"); },
  env: {},
  thread: async (id) => { opened.push(id); throw new Error("no Codex in this smoke"); },
});
const thread = "01a1b107-0a6b-7d03-97af-c54f45efa0df";
assert.throws(() => host.account(undefined), /no Codex conversation identity/);
assert.throws(() => host.account(undefined, { threadId: 42 }), /no Codex conversation identity/);
assert.throws(() => host.account(undefined, { threadId: "../x" }), /no Codex conversation identity/);
check("a call without Codex's thread metadata names no account", true);
assert.throws(() => host.account(undefined, { threadId: thread, "x-codex-turn-metadata": { thread_id: "another" } }), /inconsistent/);
check("inconsistent thread metadata names no account", true);
check("the thread Codex names is the account", host.account(undefined, { threadId: thread, "x-codex-turn-metadata": { thread_id: thread } }) === thread);
assert.throws(() => host.account(undefined, { threadId: "01a1b107-0000-7000-8000-000000000000" }), /another Codex conversation/);
check("a server serves only the first conversation that called it", true);
check("an unknown connection is no connection", await host.find(thread, "missing") === undefined && !(await host.close(thread, "missing")));
await assert.rejects(host.open(thread, "codex_personal"), /no Codex in this smoke/);
check("connect reads Codex's record of the bound thread before any identity request", opened.length === 1 && opened[0] === thread);
const wake = wakeNotice("conn-1");
check("the wake notice is labelled, names the connection and points at cotal_inbox", wake.startsWith(NOTICE) && wake.includes("conn-1") && wake.includes("cotal_inbox"));
check("decision notices are labelled", [approvalNotice({ name: "n", status: "approved", id: "a".repeat(26) }), approvalNotice({ name: "n", status: "denied", id: "a".repeat(26) })].every((t) => t.startsWith(NOTICE)));
console.log(`personal-binding: ${pass} checks passed`);
