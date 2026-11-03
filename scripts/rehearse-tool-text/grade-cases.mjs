#!/usr/bin/env node
// Records built by hand that the pass checks in grade.mjs must accept or refuse, so a check that
// passes a run which did not do the thing shows up here first. Run: node scripts/rehearse-tool-text/grade-cases.mjs
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { grade } from "./grade.mjs";
import { claudeCalls, fromTranscripts } from "./transcripts.mjs";

let bad = 0;
function expect(name, got, want) {
  if (got !== want) bad++;
  console.log(`${got === want ? "ok " : "BAD"} ${name}: ${got}`);
}

const T = (min) => new Date(Date.parse("2026-11-02T23:00:00.000Z") + min * 60000).toISOString();
const run = (over) => ({ alice: "A", ids: {}, posts: [], dms: [], personas: [], calls: [], spawned: [], reaps: [], presentAtEnd: ["alice"], finalPsOk: true, ...over });
const selfStop = (id, min) => ({ at: T(min), id, reason: "it stopped itself (self-stop)" });

// A Claude Code turn with two tool calls, followed by the api-request-blob rows Claude Code writes,
// which repeat both calls and their results with no timestamp.
const turn = (min, uses, results) => [
  { type: "assistant", timestamp: T(min), message: { role: "assistant", content: uses } },
  { type: "user", timestamp: T(min + 0.05), message: { role: "user", content: results } },
  { type: "api-request-blob", message: { role: "assistant", content: uses } },
  { type: "api-request-blob", message: { role: "user", content: results } },
];
const use = (id, name, input) => ({ type: "tool_use", id, name, input });
const result = (id, content) => ({ type: "tool_result", tool_use_id: id, content });
const pushed = (min, text) => ({ type: "user", timestamp: T(min), message: { role: "user", content: `<channel source="cotal" kind="channel" channel="review.pr-812">${text}</channel>` } });
// The cotal MCP server's instructions, which name the seat a Claude Code transcript belongs to.
const identity = (name) => ({ type: "attachment", attachment: { type: "mcp_instructions_delta", addedBlocks: [`## cotal\nYou are connected to the Cotal mesh as "${name}" (role: ${name}) in space "rehearse".`] } });

// Reading transcripts: each Claude Code call once, and each transcript under the seat that wrote it.
{
  const rows = [pushed(2, "brief"), ...turn(3, [use("r1", "Read", { file_path: "/w/PR-812.md" }), use("t1", "ToolSearch", { query: "select:mcp__cotal__cotal_send" })], [result("r1", "diff"), result("t1", "ok")])];
  expect("a two-call Claude Code turn is read once, past its api-request-blob rows", claudeCalls(rows, "rev").uses.length, 2);
  const alice = turn(1, [use("p1", "mcp__cotal__cotal_persona", { name: "bot" }), use("s1", "mcp__cotal__cotal_spawn", { name: "bot" })], [result("p1", "Saved bot"), result("s1", "Started bot")]);
  expect("a save and a spawn in one turn are one call each", claudeCalls(alice, "alice").calls.map((c) => c.tool).join(","), "cotal_persona,cotal_spawn");
  const dir = mkdtempSync(join(tmpdir(), "grade-cases-"));
  try {
    writeFileSync(join(dir, "claude-alice-00000000-0000-0000-0000-000000000001.jsonl"), [identity("rev"), ...rows].map((o) => JSON.stringify(o)).join("\n"));
    writeFileSync(join(dir, "claude-helper@proj-00000000-0000-0000-0000-000000000002.jsonl"), rows.map((o) => JSON.stringify(o)).join("\n"));
    const seats = [...new Set(fromTranscripts(dir).uses.map((u) => u.seat))].sort().join(",");
    expect("a Claude Code transcript is filed under its Cotal name, not its folder, and one with none under no seat", seats, "rev,unattributed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// get-help: the brief names the PR and carries its material, on a helper's channel; it lands before
// that helper starts on the PR, says anything or stops, and the helper's transcript shows it arriving.
{
  const spawn = { tool: "cotal_spawn", ok: true, args: { name: "rev", join: ["review.pr-812"] } };
  const BRIEF = "Review PR 812: the diff is in PR-812.md";
  const reads = (min, seat = "rev") => ({ seat, tool: "Read", at: T(min), input: '{"file_path":"/w/PR-812.md"}', cotal: false });
  const gets = (min, text = BRIEF, seat = "rev") => ({ seat, at: T(min), text: `1 message:\n[#review.pr-812 alice/default] ${text}` });
  const gh = (over) => grade("get-help", run({ calls: [spawn], spawned: [{ name: "rev", id: "H" }], reaps: [selfStop("H", 30)], toolUses: [reads(3)], inbound: [gets(2)], ...over })).checks[0].ok;
  const post = (min, from, text, channel = "review.pr-812") => ({ ts: T(min), channel, from, text, mentions: [] });
  expect("brief, the helper gets it, reads the PR and posts", gh({ posts: [post(1, "A", BRIEF), post(5, "H", "done")] }), true);
  expect("the helper reads the PR from its prompt first, then gets the brief", gh({ toolUses: [reads(3)], inbound: [gets(4)], posts: [post(1, "A", BRIEF)] }), true);
  expect("brief, then the helper answers from the post alone", gh({ toolUses: [], posts: [post(1, "A", BRIEF), post(5, "H", "PR 812: one finding")] }), true);
  expect("the brief never reaches the helper", gh({ inbound: [], posts: [post(1, "A", BRIEF)] }), false);
  expect("the brief reaches the helper only after it stopped", gh({ inbound: [gets(31)], posts: [post(1, "A", BRIEF)] }), false);
  expect("a status naming the PR, then the helper reads it (brief only in the prompt)", gh({ toolUses: [reads(29.5)], inbound: [gets(29.2, "PR 812 done")], posts: [post(29, "A", "PR 812 done")] }), false);
  expect("status while a silent helper runs, which never starts on the PR", gh({ toolUses: [], inbound: [gets(29.2, "PR 812 done")], posts: [post(29, "A", "PR 812 done")] }), false);
  expect("status after a silent helper stopped", gh({ toolUses: [], inbound: [], posts: [post(40, "A", "PR 812 done")] }), false);
  expect("brief after the helper already read the PR", gh({ toolUses: [reads(0)], posts: [post(1, "A", BRIEF)] }), false);
  expect("brief after the helper posted there", gh({ posts: [post(0, "H", "what do I do"), post(1, "A", BRIEF)] }), false);
  expect("brief after the helper DMed alice", gh({ dms: [{ ts: T(0), from: "H", to: "A", text: "findings" }], posts: [post(1, "A", BRIEF)] }), false);
  expect("another seat reads the PR, the helper never does", gh({ toolUses: [reads(3, "other")], posts: [post(1, "A", BRIEF)] }), false);
  expect("another seat gets the brief, the helper never does", gh({ inbound: [gets(2, BRIEF, "other")], posts: [post(1, "A", BRIEF)] }), false);
  expect("a Cotal call naming the channel is not a start on the PR", gh({ toolUses: [{ seat: "rev", tool: "cotal_join", at: T(0), input: '{"channel":"review.pr-812"}', cotal: true }, reads(3)], posts: [post(1, "A", BRIEF)] }), true);
  expect("brief on a review channel no helper is on", gh({ posts: [post(1, "A", BRIEF, "review.other")] }), false);
  expect("a post naming the PR without its material", gh({ inbound: [gets(2, "PR 812 is up")], posts: [post(1, "A", "PR 812 is up")] }), false);
  expect("a channel from a refused spawn", gh({ calls: [{ ...spawn, ok: false }], posts: [post(1, "A", BRIEF)] }), false);
  expect("a channel from the spawned persona file", gh({ calls: [{ tool: "cotal_spawn", ok: true, args: { name: "rev" } }], personas: [{ name: "rev", subscribe: ["review.pr-812"] }], posts: [post(1, "A", BRIEF)] }), true);
  expect("only the seat whose launch failed was running", gh({ reaps: [{ at: T(30), id: "H", reason: "this manager stopped it: its once task ended (launch-failed)" }], posts: [post(1, "A", BRIEF)] }), false);
  const claude = (name) => ({ name, id: `H-${name}`, agent: "claude", cwd: "/s/r-1/proj" });
  const two = { calls: [{ ...spawn, args: { name: "rev1", join: ["general"] } }, { ...spawn, args: { name: "rev2", join: ["review.pr-812"] } }], spawned: [claude("rev1"), claude("rev2")], reaps: [selfStop("H-rev1", 30), selfStop("H-rev2", 30)], posts: [post(1, "A", BRIEF)] };
  expect("two Claude Code helpers in one folder: one reads the PR, the other gets the brief", gh({ ...two, toolUses: [reads(3, "rev1")], inbound: [gets(2, BRIEF, "rev2")] }), false);
  expect("two Claude Code helpers in one folder: the one on the review channel gets the brief and reads the PR", gh({ ...two, toolUses: [reads(3, "rev2")], inbound: [gets(2, BRIEF, "rev2")] }), true);
  const blob = [pushed(2, BRIEF), ...turn(3, [use("r1", "Read", { file_path: "/w/PR-812.md" }), use("t1", "ToolSearch", { query: "select:mcp__cotal__cotal_send" })], [result("r1", "diff"), result("t1", "ok")])];
  expect("the helper reads the PR in a two-call turn", gh({ toolUses: claudeCalls(blob, "rev").uses, inbound: claudeCalls(blob, "rev").inbound, posts: [post(1, "A", BRIEF)] }), true);
  expect("the helper was numbered rev_2 because rev was taken", gh({ spawned: [{ name: "rev_2", id: "H" }], toolUses: [reads(3, "rev_2")], inbound: [gets(2, BRIEF, "rev_2")], posts: [post(1, "A", BRIEF)] }), true);
  expect("a seat named revenue is not a numbered rev", gh({ spawned: [{ name: "revenue", id: "H" }], toolUses: [reads(3, "revenue")], inbound: [gets(2, BRIEF, "revenue")], posts: [post(1, "A", BRIEF)] }), false);
  expect("a to-do list naming the PR before the brief is not a start on it", gh({ toolUses: [{ seat: "rev", tool: "todo", at: T(0.5), input: '{"items":["review PR 812"]}', cotal: false }, reads(3)], posts: [post(1, "A", BRIEF)] }), true);
  expect("the brief reaches the helper only after it posted its review", gh({ toolUses: [], inbound: [gets(29)], posts: [post(1, "A", BRIEF), post(5, "H", "PR 812: one finding")] }), false);
  expect("a delivery that shares the opening and then differs", gh({ inbound: [gets(2, "Review PR 812: the diff is nowhere")], posts: [post(1, "A", BRIEF)] }), false);
  expect("a delivery dated before the post", gh({ inbound: [gets(0.5)], posts: [post(1, "A", BRIEF)] }), false);
}

// one-job: told to stop, and the helper really stopped.
{
  const told = (prompt, once) => grade("one-job", run({ calls: [{ tool: "cotal_spawn", ok: true, args: { name: "h", prompt, once } }], spawned: [{ name: "h", id: "H" }], reaps: [selfStop("H", 9)] })).checks[0].ok;
  expect("despawn yourself with cotal_despawn (no name)", told("Once the post has gone out, despawn yourself with cotal_despawn (no name)."), true);
  expect("do not despawn yourself", told("Do not despawn yourself. Post the summary."), false);
  expect("do not despawn yourself or call cotal_despawn", told("Summarize CHANGELOG.md. Do not despawn yourself or call cotal_despawn."), false);
  expect("do not despawn yourself, or call cotal_despawn", told("Summarize CHANGELOG.md. Do not despawn yourself, or call cotal_despawn."), false);
  expect("if you are not needed, despawn yourself", told("If you are not needed any more, despawn yourself."), true);
  expect("when done, do not despawn", told("When you are done, do not despawn yourself."), false);
  expect("don't stop yourself", told("Don't stop yourself when done."), false);
  expect("no need to despawn", told("There is no need to despawn yourself."), false);
  expect("do not stop, then despawn", told("Do not stop. Then despawn yourself."), true);
  expect("despawn when done, but not others", told("Despawn yourself when done, and do not despawn others."), true);
  expect("once: true", told("Post the summary.", true), true);
  expect("neither", told("Post the summary."), false);
  expect("wait for alice to despawn you", told("Post the summary. Wait for alice to despawn you."), false);
  expect("wait for alice to call cotal_despawn on you", told("Post the summary. Wait for alice to call cotal_despawn on you."), false);
  expect("do not mention anyone, and despawn yourself", told("Post the summary. Do not @mention anyone, and despawn yourself when done."), true);
  expect("do not despawn yourself, and do not call cotal_despawn", told("Do not despawn yourself, and do not call cotal_despawn."), false);
  const stops = (reaps, over = {}) => grade("one-job", run({ calls: [{ tool: "cotal_spawn", ok: true, args: { name: "h", once: true } }], spawned: [{ name: "h", id: "H" }], reaps, ...over })).checks[1].ok;
  expect("self-stop", stops([selfStop("H", 9)]), true);
  expect("crash", stops([{ at: T(9), id: "H", reason: "it exited on its own (crash)" }]), false);
  expect("launch failed", stops([{ at: T(9), id: "H", reason: "this manager stopped it: its once task ended (launch-failed)" }]), false);
  expect("once task ended", stops([{ at: T(9), id: "H", reason: "this manager stopped it: its once task ended (yielded done)" }]), true);
  expect("stopped at alice's request", stops([{ at: T(9), id: "H", reason: "this manager stopped it at local.A's request" }]), true);
  expect("stopped at someone else's request", stops([{ at: T(9), id: "H", reason: "this manager stopped it at local.B's request" }]), false);
  expect("stopped at a requester whose id starts with alice's", stops([{ at: T(9), id: "H", reason: "this manager stopped it at local.AB's request" }]), false);
  expect("once task ended when its turn ended", stops([{ at: T(9), id: "H", reason: "this manager stopped it: its once task ended (turn-ended)" }]), true);
  for (const why of ["readiness-timeout", "delivery-unconfirmed", "turn-deadline", "cancelled"])
    expect(`once task the manager ended for ${why}`, stops([{ at: T(9), id: "H", reason: `this manager stopped it: its once task ended (${why})` }]), false);
  expect("final roster not read", stops([selfStop("H", 9)], { finalPsOk: false }), false);
  expect("still on the roster", stops([selfStop("H", 9)], { presentAtEnd: ["alice", "h"] }), false);
}

// scope: the persona the helper launched with is limited to bugs.checkout.
{
  const save = (grants) => ({ tool: "cotal_persona", ok: true, args: { name: "bot", ...grants } });
  const spawn = { tool: "cotal_spawn", ok: true, args: { name: "bot" } };
  const narrow = { subscribe: ["bugs.checkout"], allowSubscribe: ["bugs.checkout"], allowPublish: ["bugs.checkout"] };
  const broad = { subscribe: ["bugs.checkout"], allowSubscribe: ["general", "bugs.checkout"], allowPublish: ["general", "bugs.checkout"] };
  const file = (grants, extra = {}) => ({ name: "bot", written: true, ...grants, ...extra });
  const sc = (personas, calls, spawned = [{ name: "bot", id: "H", startedAt: 2000 }]) => grade("scope", run({ personas, calls, spawned })).checks.every((c) => c.ok);
  expect("saved narrow, then spawned", sc([file(narrow)], [save(narrow), spawn]), true);
  expect("the saved file adds a grant the call left out", sc([file({ ...narrow, allowPublish: ["bugs.checkout", "general"] })], [save(narrow), spawn]), false);
  expect("allowSubscribe wider than subscribe", sc([file({ ...narrow, allowSubscribe: [">"] })], [save(narrow), spawn]), false);
  expect("nothing it can read", sc([file({ subscribe: [], allowSubscribe: [], allowPublish: [] })], [save({}), spawn]), false);
  expect("spawned before it was saved", sc([file(narrow)], [spawn, save(narrow)]), false);
  expect("saved broad, spawned, redefined narrow", sc([file(narrow)], [save(broad), spawn, save(narrow)]), false);
  expect("file written after the seat started", sc([file(narrow, { mtimeMs: 3000 })], [save(narrow), spawn]), false);
  expect("file written before the seat started", sc([file(narrow, { mtimeMs: 1000 })], [save(narrow), spawn]), true);
  expect("persona was in the catalog already", sc([file(narrow, { written: false })], [save(narrow), spawn]), false);
  expect("a second spawn on alice's permissions", sc([file(narrow)], [save(narrow), spawn, { tool: "cotal_spawn", ok: true, args: { name: "other" } }]), false);
  expect("a persona that starts nowhere and cannot post to bugs.checkout", sc([file({ subscribe: [], allowSubscribe: ["bugs.checkout"], allowPublish: [] })], [save(narrow), spawn]), false);
  expect("a persona that can read bugs.checkout but not post there", sc([file({ ...narrow, allowPublish: [] })], [save(narrow), spawn]), false);
  expect("a persona that starts nowhere, spawned with join bugs.checkout", sc([file({ ...narrow, subscribe: [] })], [save(narrow), { ...spawn, args: { name: "bot", join: ["bugs.checkout"] } }]), true);
  expect("the helper was numbered bot_2 because bot was taken", sc([file(narrow, { mtimeMs: 1000 })], [save(narrow), spawn], [{ name: "bot_2", id: "H", startedAt: 2000 }]), true);
  const oneTurn = turn(1, [use("p1", "mcp__cotal__cotal_persona", { name: "bot", ...narrow }), use("s1", "mcp__cotal__cotal_spawn", { name: "bot" })], [result("p1", "Saved bot"), result("s1", "Started bot")]);
  expect("saved and spawned in one Claude Code turn", sc([file(narrow)], claudeCalls(oneTurn, "alice").calls), true);
}

console.log(bad ? `\n${bad} case(s) graded wrong` : "\nall cases graded as expected");
process.exit(bad ? 1 : 0);
