import assert from "node:assert/strict";
import type { Presence } from "@cotal-ai/core";
import type { ParticipantEngine } from "../src/chat/engine.js";
import { resolveDmTarget } from "../src/chat/native-session.js";

let checks = 0;
const ok = (condition: unknown, message: string): void => {
  assert.equal(condition, true, message);
  checks++;
  console.log(`  ✓ ${message}`);
};

const me = { principal: "u_a.me", answerOne: "answer one" };
const peer = (id: string, name: string): Presence => ({ card: { id, name, kind: "agent" }, status: "idle", ts: 0 });
const engine = (heard?: { id: string; name: string }): ParticipantEngine => ({
  senderName: (id: string) => (heard?.id === id ? heard.name : undefined),
  sendersNamed: (name: string) => (heard && heard.name === name ? [heard] : []),
}) as unknown as ParticipantEngine;

const resolved = (to: string, roster: Presence[], heard?: { id: string; name: string }) => {
  const result = resolveDmTarget(to, roster, "current", engine(heard), me);
  if ("outcome" in result) throw new Error(`${to} refused: ${result.code}`);
  return result;
};

ok(resolved("u_b.blank", [peer("u_b.blank", " ")]).name === "u_b.blank", "a whitespace roster name is the principal");
ok(resolved("u_b.blank", [peer("u_b.blank", "")]).name === "u_b.blank", "an empty roster name is the principal");
ok(resolved("u_b.blank", [peer("u_b.blank", "\n")]).name === "u_b.blank", "a newline roster name is the principal");
ok(resolved("u_b.blank", [peer("u_b.blank", " ada")]).name === " ada", "a roster name with a leading space stays");
ok(resolved("u_b.blank", [peer("u_b.blank", "Ada")]).name === "Ada", "a roster name stays");
ok(resolved("u_b.blank", []).name === "u_b.blank", "a principal with no roster row stays the principal");
ok(resolved("u_b.blank", [], { id: "u_b.blank", name: " " }).name === "u_b.blank", "a whitespace heard name is the principal");
ok(resolved("u_b.blank", [], { id: "u_b.blank", name: "Ada" }).name === "Ada", "a heard name stays when the roster has no row");
ok(resolved("Ada", [peer("u_b.blank", "Ada")]).name === "Ada", "a typed name still resolves to that name");

console.log(`dm blank name: ${checks} checks passed`);
