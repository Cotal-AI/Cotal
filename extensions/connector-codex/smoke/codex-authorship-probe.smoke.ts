/**
 * THE CODEX AUTHORSHIP PROBE — where does an injected peer batch land in the DURABLE rollout?
 *
 * This is the one question deciding whether Codex can cut over at all, and **only an executed
 * probe closes it, never an argument.** `[P6]` rules the rollout JSONL the data path, so what
 * matters is not what the notification stream carries but what is WRITTEN.
 *
 * What is already settled, so this probe does not re-ask it: measured over 40 real rollouts /
 * 16338 records, `event_msg/user_message` carries only `{images,message,type}` and
 * `{images,local_images,message,text_elements,type}` — **no `origin` field, and nothing else
 * separating a human-typed prompt from an injected peer batch.** That is PROVEN.
 *
 * What is NOT settled, and is the whole point of this file: that injected batches actually LAND
 * there. That was INFERRED from `connector-codex/src/transcript.ts:43`, which omits `userMessage`
 * with the inline reason "(injected peer batches)". A corpus of personal sessions cannot contain
 * what only a Cotal-managed session produces, so the corpus is the wrong instrument for this one
 * question and no amount of it will do.
 *
 * **THE INCONCLUSIVE CASE IS THE ONE THIS FILE EXISTS TO GET RIGHT.** A probe that reports "no
 * peer text found in the rollout" after writing no rollout at all would be the worst possible
 * output: a safety conclusion manufactured from an absence of evidence. So every exit here is
 * one of three NAMED verdicts, and the middle one is not a pass:
 *
 *   LANDED       — a new rollout exists AND carries the injected text. Ruling applies: Codex
 *                  emits no user-authored text at all.
 *   NOT-PRESENT  — a new rollout exists, the turn ran, and the injected text is NOT in it.
 *                  This would OVERTURN the inference and must be reported loudly, not quietly.
 *   INCONCLUSIVE — no new rollout, or no turn ran. **Exit 2. Never conflated with either.**
 *
 * The known cause of INCONCLUSIVE today is an expired `codex` login: the turn aborts before the
 * model runs and an auth-failed session writes NO rollout whatsoever (measured: 0 new files).
 * Fix with `codex login`, then re-run. That is a human action; nothing here can substitute for it.
 *
 * Run: COTAL_E2E_CODEX=1 npx tsx extensions/connector-codex/smoke/codex-authorship-probe.smoke.ts
 * NOT in smoke:ci — it needs real auth and a live model turn, so it can never be gate evidence.
 */
import { spawn } from "node:child_process";

import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

if (!/^(1|true|yes|on)$/i.test(process.env.COTAL_E2E_CODEX ?? "")) {
  console.log("SKIP codex authorship probe — set COTAL_E2E_CODEX=1 (needs an authenticated `codex` CLI)");
  process.exit(0);
}

const SESSIONS = join(homedir(), ".codex", "sessions");

/** Every rollout path under ~/.codex/sessions, recursed — the layout is <yyyy>/<mm>/<dd>/. */
async function rollouts(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out; // the tree does not exist yet — a legitimate empty, handled by the caller
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await rollouts(p)));
    else if (e.name.startsWith("rollout-") && e.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

/**
 * WHAT TO SEARCH THE ROLLOUT FOR, DERIVED FROM THE SHIPPED FUNCTION RATHER THAN HARDCODED.
 *
 * The obvious design — mint a canary, search for the canary — is WRONG here and I built it that
 * way first: the live harness composes its own DM text, so a canary this file invents is never
 * actually sent, every search misses, and the probe reports NOT-PRESENT. That is precisely the
 * manufactured safety conclusion the header warns about, reached through the probe's own bug.
 *
 * So the search string is the ONE part guaranteed to be present in any injection regardless of who
 * composed the message: `formatInjection`'s own header, taken from the function itself. If that
 * format ever changes, this recomputes with it instead of silently searching for a dead string.
 */
const { formatInjection } = await import("@cotal-ai/connector-core");
const sample = formatInjection([
  { id: "probe-1", kind: "dm", fromName: "probepeer", fromRole: "prober", text: "x" } as never,
]);
if (!sample) throw new Error("formatInjection returned nothing for a non-empty batch — cannot derive a search key");
// The stable head, up to and including the em dash: "📨 Cotal —". Everything after it varies.
const MARKER = sample.slice(0, sample.indexOf("—") + 1);
if (MARKER.length < 3) throw new Error(`could not derive an injection marker from: ${JSON.stringify(sample.slice(0, 40))}`);

console.log(`searching rollouts for injection marker: ${JSON.stringify(MARKER)}`);
console.log("driving the live Codex E2E (it DMs a managed session, which is what produces an injection)…\n");

const before = new Set(await rollouts(SESSIONS));

const LIVE = fileURLToPath(new URL("./codex-live.smoke.ts", import.meta.url));

/**
 * SCRUB AMBIENT `COTAL_*` AT THIS BOUNDARY, not only at the next one.
 *
 * Every managed agent seat on this box carries its own mesh identity in the environment —
 * including `COTAL_SERVERS`, which points at the PRODUCTION broker. `codex-live` already scrubs
 * before spawning its host child, so this probe was safe; but it was safe because of the callee's
 * hygiene rather than anything this file did, and "safe because someone downstream remembered" is
 * a property that silently stops holding when the downstream file is edited.
 *
 * `COTAL_E2E_CODEX` is re-set AFTER the scrub because it starts with the same prefix — removing
 * every `COTAL_*` would strip the flag that enables the run and turn this into a silent skip.
 */
const childEnv: NodeJS.ProcessEnv = { ...process.env };
for (const k of Object.keys(childEnv)) if (k.startsWith("COTAL_")) delete childEnv[k];
childEnv.COTAL_E2E_CODEX = "1";

const child = spawn("npx", ["tsx", LIVE], {
  cwd: fileURLToPath(new URL("../../..", import.meta.url)),
  env: childEnv,
  stdio: ["ignore", "inherit", "inherit"],
});
const liveExit: number = await new Promise((r) => child.on("exit", (c) => r(c ?? 1)));
console.log(`\n— live harness exited ${liveExit}\n`);

const after = await rollouts(SESSIONS);
const fresh = after.filter((p) => !before.has(p));

// ── VERDICT ───────────────────────────────────────────────────────────────────────────────────
if (fresh.length === 0) {
  console.error("VERDICT: INCONCLUSIVE — the run produced NO new rollout file.");
  console.error("  Nothing was written, so nothing can be concluded about where injections land.");
  console.error("  This is NOT 'no peer text found'. Known cause: an expired codex login — the turn");
  console.error("  aborts before the model runs and an auth-failed session writes no rollout at all.");
  console.error("  Check the harness output above for 'Failed to refresh token' / 401, then `codex login`.");
  process.exit(2);
}

console.log(`new rollout file(s): ${fresh.length}`);
let hits = 0;
let records = 0;
for (const path of fresh) {
  const lines = (await readFile(path, "utf8")).split("\n").filter((l) => l.trim());
  records += lines.length;
  for (const line of lines) {
    let o: { type?: string; payload?: { type?: string } };
    try {
      o = JSON.parse(line);
    } catch {
      continue; // a partial trailing line; the durable-source rule, not this probe's business
    }
    if (!line.includes(MARKER)) continue;
    hits += 1;
    const p = (o.payload ?? {}) as Record<string, unknown>;
    console.log(`\n  HIT in ${o.type}/${p.type ?? "(none)"}`);
    console.log(`    payload keys: ${Object.keys(p).sort().join(",")}`);
    // The decisive question after "where": is there ANY field here that would let a filter
    // distinguish this from a human-typed prompt? Enumerated, not eyeballed.
    const discriminators = ["origin", "source", "injected", "synthetic", "ignored", "from", "kind"].filter(
      (k) => k in p,
    );
    console.log(`    candidate discriminator fields present: ${discriminators.length ? discriminators.join(",") : "NONE"}`);
  }
}

if (records === 0) {
  console.error("\nVERDICT: INCONCLUSIVE — a rollout file appeared but contains no records.");
  process.exit(2);
}

if (hits === 0) {
  console.error(`\nVERDICT: NOT-PRESENT — ${records} records written and the injected text is in NONE of them.`);
  console.error("  This OVERTURNS the standing inference that injected batches land in the rollout.");
  console.error("  Do not treat it as routine: report it, because the Codex safety ruling was issued");
  console.error("  on the opposite assumption and would need revisiting.");
  process.exit(1);
}

console.log(`\nVERDICT: LANDED — the injected peer text is written to the durable rollout (${hits} record(s)).`);
console.log("  The pre-committed ruling applies: Codex emits NO user-authored text at all —");
console.log("  runs open, bodies withheld across the board.");
process.exit(0);
