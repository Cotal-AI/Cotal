/** Round-trip + safety proof for the yaml-backed agent-file parser (launchOptions map support). */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAgentFile, saveAgentFile, type AgentDef } from "../src/agent-file.js";

// Every cell runs and the suite reports at the end. Throwing on the first failure stopped the run
// before the summary line, which reads as "stopped early" rather than "this cell is red" — the
// mutation proof cannot tell a named failure from a crash, and the cells after the first are never
// exercised at all, so one mutation could only ever be graded against one assertion.
let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) {
    fail++;
    console.log(`  ✗ FAIL: ${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
    return;
  }
  pass++;
  console.log(`  ✓ ${name}`);
};
const dir = mkdtempSync(join(tmpdir(), "agentfile-yaml-"));

// 1) Full round-trip incl. a nested launchOptions map and tricky scalar values.
const def: AgentDef = {
  name: "builder",
  role: "builder",
  description: "handles: config, deploy # careful",      // colon + hash — the old parser would misread
  tags: ["edit", "test"],
  subscribe: ["general", "ops"],
  allowSubscribe: ["general", "ops"],
  allowPublish: ["ops"],
  model: "opus",
  variant: "high",
  launchOptions: { temperature: "0.2", reasoning: "high", verbose: true, retries: 3 },
  capabilities: ["spawn"],
  meta: { theme: "dark" },
  persona: "You build things.",
};
const p = join(dir, "builder.md");
saveAgentFile(p, def);
const back = loadAgentFile(p);
ok("round-trips name/role/model/variant", back.name === "builder" && back.role === "builder" && back.model === "opus" && back.variant === "high");
ok("round-trips tricky description with : and #", back.description === "handles: config, deploy # careful", back.description);
ok("round-trips list fields", JSON.stringify(back.subscribe) === JSON.stringify(["general", "ops"]) && JSON.stringify(back.allowPublish) === JSON.stringify(["ops"]));
ok("round-trips launchOptions map (typed values preserved)", JSON.stringify(back.launchOptions) === JSON.stringify({ temperature: "0.2", reasoning: "high", verbose: true, retries: 3 }), back.launchOptions);
ok("round-trips meta + persona + capabilities", back.meta?.theme === "dark" && back.persona === "You build things." && JSON.stringify(back.capabilities) === JSON.stringify(["spawn"]));

// 2) Block-style lists + nested launchOptions parse (impossible for the old subset parser).
writeFileSync(join(dir, "blk.md"), [
  "---",
  "name: blocky",
  "subscribe:",
  "  - general",
  "  - team",
  "launchOptions:",
  "  model-args: --fast",
  "  depth: 4",
  "---",
  "body",
].join("\n"));
const blk = loadAgentFile(join(dir, "blk.md"));
ok("block-style list parses", JSON.stringify(blk.subscribe) === JSON.stringify(["general", "team"]), blk.subscribe);
ok("block-style launchOptions map parses", JSON.stringify(blk.launchOptions) === JSON.stringify({ "model-args": "--fast", depth: 4 }), blk.launchOptions);

// 3) The channel-policy fields survive a save unchanged, EMPTY INCLUDED — an empty read set is a
//    declaration ("no channels"), and a writer that drops it turns a persona that declined every
//    channel into one that never named the field. `cotal_persona` redefine is load-then-save, so a
//    dropped field is not cosmetic: it rewrites the stored policy of a live agent.
const reread = (file: string, d: AgentDef): AgentDef => { saveAgentFile(file, d); return loadAgentFile(file); };
for (const [label, value] of [
  ["empty", [] as string[]],
  ["one channel", ["ops"]],
  ["several", ["general", "ops"]],
] as const) {
  const back = reread(join(dir, `policy-${label.replace(/ /g, "-")}.md`), {
    name: "policy", subscribe: value, allowSubscribe: value, allowPublish: value,
  });
  ok(`a ${label} subscribe survives a save`, JSON.stringify(back.subscribe) === JSON.stringify(value), back.subscribe);
  ok(`a ${label} allowSubscribe survives a save`, JSON.stringify(back.allowSubscribe) === JSON.stringify(value), back.allowSubscribe);
  ok(`a ${label} allowPublish survives a save`, JSON.stringify(back.allowPublish) === JSON.stringify(value), back.allowPublish);
}
// An UNSET field stays unset: emitting on "is set" must not invent a field the author never wrote,
// or every persona grows three keys and omitted stops being distinguishable from declared-empty.
const bare = reread(join(dir, "policy-unset.md"), { name: "policy" });
ok("an unset subscribe stays unset", bare.subscribe === undefined, bare.subscribe);
ok("an unset allowSubscribe stays unset", bare.allowSubscribe === undefined, bare.allowSubscribe);
ok("an unset allowPublish stays unset", bare.allowPublish === undefined, bare.allowPublish);

// 4) Saving is idempotent from the second application. The FIRST save of a hand-written file may
//    canonicalize key ORDER (the writer emits a fixed read order), so a mass redefine shows a
//    reorder-only diff once per file; what must never happen is two saves disagreeing, which would
//    make every redefine churn the tree forever and hide real edits in the noise.
const hand = join(dir, "hand-ordered.md");
writeFileSync(hand, [
  "---",
  "name: handy",
  "model: opus",                 // deliberately BEFORE the policy fields, unlike the writer's order
  "subscribe:",
  "  - review.one",
  "allowPublish:",
  "  - review.one",
  "---",
  "body",
].join("\n"));
saveAgentFile(hand, loadAgentFile(hand));
const once = readFileSync(hand, "utf8");
saveAgentFile(hand, loadAgentFile(hand));
const twice = readFileSync(hand, "utf8");
ok("a second save changes nothing (fixpoint in one save)", once === twice, { once, twice });
const handBack = loadAgentFile(hand);
ok("canonicalizing key order preserves every value",
  handBack.model === "opus" && JSON.stringify(handBack.subscribe) === JSON.stringify(["review.one"])
  && JSON.stringify(handBack.allowPublish) === JSON.stringify(["review.one"]), handBack);

// 5) The redefine path itself, not just the writer under it. The mutation table proves the suite
//    depends on saveAgentFile; it cannot show a real caller reaches it. This replays what the
//    manager does on `cotal_persona` against an existing name (load, patch content only, save) and
//    asserts the channel policy comes through untouched — that sequence is the whole reason the
//    dropped field mattered, since it edits prose and must not edit access.
const live = join(dir, "live-agent.md");
writeFileSync(live, [
  "---",
  "name: liveagent",
  "subscribe: []",              // this agent deliberately reads NO channels
  "allowSubscribe: []",
  "allowPublish: []",
  "model: opus",
  "---",
  "The original persona text.",
].join("\n"));
const redefine = (file: string, persona: string, model?: string) => {
  const d0 = loadAgentFile(file);                 // manager.ts: load the stored file
  if (model !== undefined) d0.model = model;      //   patch model only when provided
  d0.persona = persona;                           //   overwrite content
  saveAgentFile(file, d0);                        //   write it back
};
redefine(live, "Rewritten persona text.");
const afterRedefine = loadAgentFile(live);
ok("a redefine keeps the declared-empty read set", JSON.stringify(afterRedefine.subscribe) === JSON.stringify([]), afterRedefine.subscribe);
ok("a redefine keeps the declared-empty read ACL", JSON.stringify(afterRedefine.allowSubscribe) === JSON.stringify([]), afterRedefine.allowSubscribe);
ok("a redefine keeps the declared-empty post ACL", JSON.stringify(afterRedefine.allowPublish) === JSON.stringify([]), afterRedefine.allowPublish);
ok("a redefine still rewrites the content it was asked to", afterRedefine.persona === "Rewritten persona text.", afterRedefine.persona);
ok("a redefine without a model keeps the stored one", afterRedefine.model === "opus", afterRedefine.model);

// A non-empty policy must survive the same path: the bug's mirror image is a redefine that widens
// or narrows a real read set, which would be an access change made by a content edit.
const live2 = join(dir, "live-agent-2.md");
writeFileSync(live2, "---\nname: liveagent2\nsubscribe: [ops]\nallowPublish: [ops]\n---\nbefore\n");
redefine(live2, "after", "sonnet");
const after2 = loadAgentFile(live2);
ok("a redefine keeps a non-empty read set exactly", JSON.stringify(after2.subscribe) === JSON.stringify(["ops"]), after2.subscribe);
ok("a redefine keeps a non-empty post ACL exactly", JSON.stringify(after2.allowPublish) === JSON.stringify(["ops"]), after2.allowPublish);
ok("a redefine applies an explicit model override", after2.model === "sonnet", after2.model);

// 6) Fail-loud cases.
const throws = (name: string, body: string) => {
  writeFileSync(join(dir, "bad.md"), body);
  let threw = false;
  try { loadAgentFile(join(dir, "bad.md")); } catch { threw = true; }
  ok(name, threw);
};
throws("launchOptions as scalar throws", "---\nname: x\nlaunchOptions: nope\n---\n");
throws("launchOptions as sequence throws", "---\nname: x\nlaunchOptions:\n  - a\n---\n");
throws("renamed field 'channels' still fails loud", "---\nname: x\nchannels: [general]\n---\n");
throws("malformed YAML fails loud", "---\nname: x\n  bad: : indent\n\t- weird\n---\n");

console.log(`\nagent-file yaml smoke: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
