/**
 * Smoke for the shared briefing — pure (no broker). Every harness renders the same paragraphs from
 * one module; what differs is the one sentence saying how a peer message arrives, and the gateway
 * leaves that sentence out because its connect result says so itself. Run: `pnpm smoke:briefing`.
 */
import assert from "node:assert/strict";
import { emitSentinel } from "@cotal-ai/smoke-kit";
// RELATIVE, not the package specifier, so the bytes mutated are the bytes graded (see orientation.smoke.ts).
import {
  ATTENTION_GUIDANCE,
  BRIEFING_HARNESSES,
  briefing,
  CHANNEL_GUIDANCE,
  feedbackLine,
  MESH_FIRST_STEER,
  ORIENTATION_BOOTSTRAP,
  REPLY_ETIQUETTE,
  REPLY_GUIDANCE,
  WORKFLOW_STEER,
  type BriefingHarness,
} from "../src/index.js";

let passed = 0;
let failed = 0;
function cell(name: string, run: () => void): void {
  try {
    run();
    passed++;
    console.log(`✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`✗ ${name}\n  ${(e as Error).message}`);
  }
}

const cfg = { name: "alice", role: "reviewer", space: "demo" };
const all = BRIEFING_HARNESSES.map((h) => [h, briefing(cfg, h)] as const);

cell("every harness opens with the identity line", () => {
  for (const [h, text] of all)
    assert.ok(text.startsWith('You are connected to the Cotal mesh as "alice" (role: reviewer) in space "demo".'), `${h}: ${text.slice(0, 90)}`);
});

cell("the identity line omits the role when there is none", () => {
  const text = briefing({ name: "bob", space: "demo" }, "codex");
  assert.ok(text.startsWith('You are connected to the Cotal mesh as "bob" in space "demo".'), text.slice(0, 90));
  assert.ok(!text.includes("(role:"));
});

cell("every harness carries the shared paragraphs", () => {
  for (const [h, text] of all)
    for (const p of [ORIENTATION_BOOTSTRAP, MESH_FIRST_STEER, WORKFLOW_STEER, CHANNEL_GUIDANCE, REPLY_GUIDANCE, ATTENTION_GUIDANCE])
      assert.ok(text.includes(p), `${h} lacks: ${p.slice(0, 50)}`);
});

// Claude Code loads a tool's description only after picking the tool by name, so this sentence is
// what an agent reads before it chooses between a post and a DM.
cell("the channel guidance sends a status for a peer to the shared channel with a mention", () => {
  assert.ok(
    CHANNEL_GUIDANCE.includes("When you are asked to tell a peer about shared work, such as a status or a result, post it on the channel you share and mention that peer there."),
    CHANNEL_GUIDANCE,
  );
  assert.ok(CHANNEL_GUIDANCE.includes("Use cotal_dm only for something one peer alone needs"), CHANNEL_GUIDANCE);
});

cell("the briefing says a live post misses an agent that is away, and where once works", () => {
  assert.ok(CHANNEL_GUIDANCE.includes("on a live channel, one that is disconnected or busy then misses it, unless the post mentions it by a name only it has and it may read the channel."), CHANNEL_GUIDANCE);
  assert.ok(MESH_FIRST_STEER.includes("starts a Claude Code, jcode, OpenCode or pi helper that is stopped when the task ends."), MESH_FIRST_STEER);
});

cell("every harness states channel retention defaults and operator control", () => {
  for (const [h, text] of all) {
    assert.ok(text.includes("no age limit and 1000 posts per sender per channel"), `${h}: missing retention defaults`);
    assert.ok(text.includes("an operator can change those limits with cotal history limit"), `${h}: missing operator control`);
    assert.ok(text.includes("older posts may no longer be available"), `${h}: missing history limitation`);
  }
});

cell("every harness says to leave when the task or its part is done, after the wake guidance", () => {
  const guidance =
    "A post wakes an idle agent unless it set dnd or focus or made the channel quiet. " +
    "Leave a channel with cotal_leave when its task is finished or your part is done. " +
    "Its posts then stop waking you, and the space shows only who is still working there.";
  for (const [h, text] of all) assert.ok(text.includes(guidance), `${h}: missing leave guidance after the idle-wake sentence`);
});

cell("every harness carries the reply etiquette", () => {
  for (const [h, text] of all) assert.ok(text.includes(REPLY_ETIQUETTE), h);
});

cell("the feedback paragraph follows the key: keyless names the public intake, keyed does not", () => {
  const keyless = feedbackLine({}).trim();
  for (const [h, text] of all) assert.ok(text.includes(keyless), h);
  const keyed = briefing({ ...cfg, feedbackKey: "k" }, "codex");
  assert.ok(keyed.includes(feedbackLine({ feedbackKey: "k" }).trim()) && !keyed.includes("public cotal.ai intake"), keyed);
});

cell("each launched harness says how a peer message arrives, in its own shape", () => {
  const arrival: Record<Exclude<BriefingHarness, "gateway">, RegExp> = {
    "claude-code": /<channel source="cotal"[^\n]*📨/,
    codex: /blocks marked 📨/,
    jcode: /blocks marked 📨/,
    opencode: /blocks marked 📨/,
    hermes: /blocks marked 📨/,
    pi: /user messages tagged 📨/,
  };
  for (const [h, re] of Object.entries(arrival)) assert.match(briefing(cfg, h as BriefingHarness), re, h);
});

cell("the gateway briefing leaves the arrival sentence out", () => {
  const text = briefing(cfg, "gateway");
  assert.ok(!text.includes("📨") && !text.includes("<channel"), text);
  assert.ok(text.includes(`Other agents coordinate with you here as lateral peers. ${REPLY_GUIDANCE}`), text);
});

cell("the paragraphs split cleanly on blank lines, so a harness that takes a list gets whole paragraphs", () => {
  for (const [h, text] of all) {
    const parts = text.split("\n\n");
    assert.equal(parts.length, 9, h);
    assert.ok(parts.every((p) => p.length > 0 && p.trim() === p), h);
  }
});

console.log(`\nBRIEFING SMOKE ${failed === 0 ? "OK ✅" : "FAILED ❌"} — ${passed} passed, ${failed} failed`);
emitSentinel({ passed, failed });
process.exit(failed === 0 ? 0 : 1);
