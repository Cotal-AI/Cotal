#!/usr/bin/env node
// Records built by hand that the pass checks in grade.mjs must accept or refuse, so a check that
// passes a run which did not do the thing shows up here first. Run: node scripts/rehearse-tool-text/grade-cases.mjs
import { grade } from "./grade.mjs";

let bad = 0;
function expect(name, got, want) {
  if (got !== want) bad++;
  console.log(`${got === want ? "ok " : "BAD"} ${name}: ${got}`);
}

const T = (min) => `2026-11-02T23:${String(min).padStart(2, "0")}:00.000Z`;
const run = (over) => ({ alice: "A", ids: {}, posts: [], dms: [], personas: [], calls: [], spawned: [], reaps: [], presentAtEnd: ["alice"], finalPsOk: true, ...over });
const selfStop = (id, min) => ({ at: T(min), id, reason: "it stopped itself (self-stop)" });

// get-help: the brief is alice's post naming the PR on a helper's channel, while that helper runs and
// before it has said anything.
{
  const spawn = { tool: "cotal_spawn", ok: true, args: { name: "rev", join: ["review.pr-812"] } };
  const gh = (over) => grade("get-help", run({ calls: [spawn], spawned: [{ name: "rev", id: "H" }], reaps: [selfStop("H", 30)], ...over })).checks[0].ok;
  const post = (min, from, text, channel = "review.pr-812") => ({ ts: T(min), channel, from, text, mentions: [] });
  expect("brief before the helper's first post", gh({ posts: [post(1, "A", "Review PR 812"), post(5, "H", "done")] }), true);
  expect("brief on a review channel no helper is on", gh({ posts: [post(1, "A", "PR 812", "review.other")] }), false);
  expect("post only after the helper posted there", gh({ posts: [post(1, "H", "what do I do"), post(2, "A", "PR 812")] }), false);
  expect("post only after the helper DMed alice", gh({ dms: [{ ts: T(1), from: "H", to: "A", text: "findings" }], posts: [post(2, "A", "PR 812 done")] }), false);
  expect("status after a silent helper stopped (brief only in the prompt)", gh({ posts: [post(40, "A", "PR 812 done")] }), false);
  expect("post without the PR", gh({ posts: [post(1, "A", "hello")] }), false);
  expect("a channel from a refused spawn", gh({ calls: [{ ...spawn, ok: false }], posts: [post(1, "A", "PR 812")] }), false);
  expect("a channel from the spawned persona file", gh({ calls: [{ tool: "cotal_spawn", ok: true, args: { name: "rev" } }], personas: [{ name: "rev", subscribe: ["review.pr-812"] }], posts: [post(1, "A", "PR 812")] }), true);
  expect("only the seat whose launch failed was running", gh({ reaps: [{ at: T(30), id: "H", reason: "this manager stopped it: its once task ended (launch-failed)" }], posts: [post(1, "A", "PR 812")] }), false);
}

// one-job: told to stop, and the helper really stopped.
{
  const told = (prompt, once) => grade("one-job", run({ calls: [{ tool: "cotal_spawn", ok: true, args: { name: "h", prompt, once } }], spawned: [{ name: "h", id: "H" }], reaps: [selfStop("H", 9)] })).checks[0].ok;
  expect("despawn yourself with cotal_despawn (no name)", told("Once the post has gone out, despawn yourself with cotal_despawn (no name)."), true);
  expect("do not despawn yourself", told("Do not despawn yourself. Post the summary."), false);
  expect("do not despawn yourself or call cotal_despawn", told("Summarize CHANGELOG.md. Do not despawn yourself or call cotal_despawn."), false);
  expect("don't stop yourself", told("Don't stop yourself when done."), false);
  expect("no need to despawn", told("There is no need to despawn yourself."), false);
  expect("do not stop, then despawn", told("Do not stop. Then despawn yourself."), true);
  expect("despawn when done, but not others", told("Despawn yourself when done, and do not despawn others."), true);
  expect("once: true", told("Post the summary.", true), true);
  expect("neither", told("Post the summary."), false);
  const stops = (reaps, over = {}) => grade("one-job", run({ calls: [{ tool: "cotal_spawn", ok: true, args: { name: "h", once: true } }], spawned: [{ name: "h", id: "H" }], reaps, ...over })).checks[1].ok;
  expect("self-stop", stops([selfStop("H", 9)]), true);
  expect("crash", stops([{ at: T(9), id: "H", reason: "it exited on its own (crash)" }]), false);
  expect("launch failed", stops([{ at: T(9), id: "H", reason: "this manager stopped it: its once task ended (launch-failed)" }]), false);
  expect("once task ended", stops([{ at: T(9), id: "H", reason: "this manager stopped it: its once task ended (yielded done)" }]), true);
  expect("stopped at alice's request", stops([{ at: T(9), id: "H", reason: "this manager stopped it at local.A" }]), true);
  expect("stopped at someone else's request", stops([{ at: T(9), id: "H", reason: "this manager stopped it at local.B" }]), false);
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
}

console.log(bad ? `\n${bad} case(s) graded wrong` : "\nall cases graded as expected");
process.exit(bad ? 1 : 0);
