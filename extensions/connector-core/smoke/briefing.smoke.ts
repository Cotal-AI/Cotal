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
