/**
 * #1351: a cotal_persona prompt that is already a complete agent file must MERGE, not wrap.
 *
 * THE DEFECT. definePersona stuffed the prompt into persona and saveAgentFile wrapped it in a
 * fresh `subscribe: []` block. loadAgentFile keeps only the outer empty grants. Authored
 * subscribe / allowSubscribe / allowPublish / role / agent / model became body text.
 *
 * WHAT THIS SUITE ASSERTS, against composeWirePersona + saveAgentFile + loadAgentFile (the
 * writer the manager now calls):
 *
 *   1. A frontmattered prompt writes ONE fence pair. Loaded grants, role, agent, and model
 *      match the prompt. The body does not start with `---`.
 *   2. An explicit tool model wins over the prompt's model:.
 *   3. capabilities and owner in the prompt never land (policy).
 *   4. A prose prompt still writes subscribe: [] with scope_source: wire-default.
 *   5. A prompt that starts with `---` but is not a closed valid block throws prompt-frontmatter
 *      and writes nothing.
 *
 * Run: pnpm smoke:persona-frontmatter
 */
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROMPT_FRONTMATTER,
  composeWirePersona,
  loadAgentFile,
  saveAgentFile,
} from "../src/agent-file.js";

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

const dir = mkdtempSync(join(tmpdir(), "persona-frontmatter-"));
const prompt = [
  "---",
  "name: ignored",
  "role: reviewer",
  "agent: jcode",
  "model: grok-from-prompt",
  "subscribe: [review.1351]",
  "allowSubscribe: [review.1351, fix.1351]",
  "allowPublish: [review.1351, fix.1351]",
  "capabilities: [spawn]",
  "owner: attacker",
  "---",
  "",
  "You review PRs.",
].join("\n");

const mergedPath = join(dir, "merged.md");
const def = composeWirePersona({
  name: "panel-glm",
  owner: "mgr-i1351",
  prompt,
});
saveAgentFile(mergedPath, def);
const written = readFileSync(mergedPath, "utf8");
const fences = [...written.matchAll(/^---$/gm)].length;
const loaded = loadAgentFile(mergedPath);

ok("a frontmattered prompt writes exactly one frontmatter block", fences === 2, { fences, written });
ok("loaded subscribe is the authored grant, not []", JSON.stringify(loaded.subscribe) === JSON.stringify(["review.1351"]), loaded.subscribe);
ok("loaded allowSubscribe survives", JSON.stringify(loaded.allowSubscribe) === JSON.stringify(["review.1351", "fix.1351"]), loaded.allowSubscribe);
ok("loaded allowPublish survives", JSON.stringify(loaded.allowPublish) === JSON.stringify(["review.1351", "fix.1351"]), loaded.allowPublish);
ok("loaded role survives", loaded.role === "reviewer", loaded.role);
ok("loaded agent survives", loaded.agent === "jcode", loaded.agent);
ok("loaded model survives", loaded.model === "grok-from-prompt", loaded.model);
ok("the persona body does not start with a fence", loaded.persona === "You review PRs.", loaded.persona);
ok("prompt capabilities never land", loaded.capabilities === undefined, loaded.capabilities);
ok("prompt owner never lands; the caller is owner", loaded.owner === "mgr-i1351", loaded.owner);
ok("the tool name wins over the prompt's name:", loaded.name === "panel-glm", loaded.name);
ok("an authored read set drops the wire-default marker", loaded.meta?.scope_source === undefined, loaded.meta);

const overridePath = join(dir, "override.md");
saveAgentFile(overridePath, composeWirePersona({
  name: "panel-glm",
  owner: "mgr-i1351",
  prompt,
  model: "grok-from-arg",
}));
ok("an explicit tool model wins over the prompt's model:", loadAgentFile(overridePath).model === "grok-from-arg");

const prosePath = join(dir, "prose.md");
saveAgentFile(prosePath, composeWirePersona({
  name: "plain",
  owner: "mgr-i1351",
  prompt: "You are a plain worker.",
}));
const prose = loadAgentFile(prosePath);
ok("a prose prompt still declares an empty read set", JSON.stringify(prose.subscribe) === JSON.stringify([]), prose.subscribe);
ok("a prose prompt records that the caller could not choose", prose.meta?.scope_source === "wire-default", prose.meta);
ok("a prose prompt writes exactly one frontmatter block", [...readFileSync(prosePath, "utf8").matchAll(/^---$/gm)].length === 2);

const throwsNamed = (label: string, bad: string) => {
  const path = join(dir, "bad.md");
  let named = false;
  let wrote = false;
  try {
    const d = composeWirePersona({ name: "bad", owner: "mgr-i1351", prompt: bad });
    saveAgentFile(path, d);
    wrote = existsSync(path);
  } catch (e) {
    named = String((e as Error).message).startsWith(`${PROMPT_FRONTMATTER}:`);
  }
  ok(label, named && !wrote, { named, wrote });
};
throwsNamed("an open fence is refused as prompt-frontmatter and writes nothing", "---\nsubscribe: [review.1351]\nYou review PRs.\n");
throwsNamed("malformed YAML frontmatter is refused as prompt-frontmatter and writes nothing", "---\nsubscribe: [\n---\nbody\n");

console.log(`\npersona-frontmatter smoke: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
