/**
 * A Jcode seat lists Jcode's native session operations as commands for its `agent` endpoint, runs
 * each through its Harness request, refuses a call whose arguments Jcode cannot take before Jcode
 * sees it, and stops a running turn through Jcode's cancel.
 *
 * The shipped dispatcher runs over a fake session that answers as Jcode 0.99.0 was measured to:
 * `compact` refuses with `invalid_request` when there is too little to compact, `rewind N` keeps the
 * first N messages, and `cancel` on a running turn ends it with `turn_done`. No broker is started.
 *
 * Run: pnpm smoke:jcode-commands
 */
import { HarnessError } from "@1jehuang/jcode-sdk";
import { CommandRefused, type AgentCommand } from "@cotal-ai/connector-core";
import { emitSentinel } from "@cotal-ai/smoke-kit";
import { jcodeCommands } from "../src/commands.js";
import type { HostTurnState } from "../src/host-turns.js";

let passed = 0;
let failed = 0;
const check = (label: string, ok: boolean, extra?: unknown): void => {
  if (ok) { passed++; console.log(`  ✓ ${label}`); return; }
  failed++;
  console.log(`  FAIL  ${label}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
};

const TOO_LITTLE = "⚠ **Cannot compact:** Context usage too low (1.7%) - nothing to compact";
const calls: unknown[][] = [];
let compactAnswer: () => Promise<string> = async () => "compaction scheduled";
const session = {
  cancel: async (id: string) => { calls.push(["cancel", id]); },
  compact: async (id: string) => { calls.push(["compact", id]); return compactAnswer(); },
  rewind: async (id: string, index: number) => { calls.push(["rewind", id, index]); },
  renameSession: async (...a: [string, string?]) => { calls.push(["renameSession", ...a]); },
};
const host = { client: session, sessionId: "session_1", turnActive: false } as unknown as Pick<HostTurnState, "client" | "sessionId" | "turnActive">;
const commands = jcodeCommands(host);
const run = (name: string, args = "") => commands.dispatch({ target: "command", name, args } satisfies AgentCommand);
async function outcome(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return "started";
  } catch (e) {
    return e instanceof CommandRefused ? `${e.code}: ${e.message}` : `unknown: ${(e as Error).message}`;
  }
}
const fresh = () => { calls.length = 0; };

console.log("Jcode commands");
{
  const listed = await commands.list();
  check("lists compact, rewind and rename, each described", JSON.stringify(listed.map((c) => c.name)) === JSON.stringify(["compact", "rewind", "rename"]) &&
    listed.every((c) => c.target === "command" && (c.description ?? "").length > 0), listed);
  check("rewind and rename name the argument they take", listed.find((c) => c.name === "rewind")?.inputHint === "message number" &&
    listed.find((c) => c.name === "rename")?.inputHint === "session name or --clear" && listed.find((c) => c.name === "compact")?.inputHint === undefined, listed);
  check("runs commands only, no skills", [...commands.targets].join() === "command");

  fresh();
  check("compact starts Jcode's compaction", (await outcome(run("compact"))) === "started" && JSON.stringify(calls) === JSON.stringify([["compact", "session_1"]]), calls);
  fresh();
  compactAnswer = async () => { throw new HarnessError("invalid_request", TOO_LITTLE); };
  check("Jcode's refusal to compact is the command's refusal, with Jcode's reason",
    (await outcome(run("compact"))) === `failed-precondition: invalid_request: ${TOO_LITTLE}`, calls);
  fresh();
  compactAnswer = async () => { throw new HarnessError("internal", "harness connection closed"); };
  check("a failure that is not a refusal leaves the outcome unknown", (await outcome(run("compact"))).startsWith("unknown:"));
  fresh();
  check("compact with arguments is refused before Jcode sees it", (await outcome(run("compact", "now"))) === "failed-precondition: Jcode's compact takes no arguments" && calls.length === 0, calls);

  fresh();
  check("rewind N keeps the first N messages", (await outcome(run("rewind", " 3 "))) === "started" && JSON.stringify(calls) === JSON.stringify([["rewind", "session_1", 3]]), calls);
  fresh();
  const bad = await Promise.all(["", "0", "two", "-1", "2.5"].map((a) => outcome(run("rewind", a))));
  check("rewind without a message number of 1 or more is refused before Jcode sees it",
    bad.every((o) => o === "failed-precondition: rewind needs a message number, 1 or more") && calls.length === 0, bad);

  fresh();
  check("rename names the session", (await outcome(run("rename", "release review"))) === "started" &&
    JSON.stringify(calls) === JSON.stringify([["renameSession", "session_1", "release review"]]), calls);
  fresh();
  check("rename --clear restores the generated title", (await outcome(run("rename", "--clear"))) === "started" &&
    JSON.stringify(calls) === JSON.stringify([["renameSession", "session_1"]]), calls);
  fresh();
  check("rename with no name is refused before Jcode sees it", (await outcome(run("rename"))) === "failed-precondition: rename needs a name, or --clear" && calls.length === 0);

  fresh();
  check("a name Jcode's list does not hold is not found", (await outcome(run("clear"))) === 'not-found: Jcode has no command named "clear"' && calls.length === 0);
  host.sessionId = undefined;
  check("a command before the session exists is refused", (await outcome(run("compact"))) === "failed-precondition: Jcode's session is not ready" && calls.length === 0);
  host.sessionId = "session_1";
}

console.log("Jcode interrupt");
{
  fresh();
  host.turnActive = false;
  check("an idle session answers idle and is sent no cancel", (await commands.interrupt!()) === "idle" && calls.length === 0, calls);
  host.turnActive = true;
  check("a running turn is cancelled and answers interrupted", (await commands.interrupt!()) === "interrupted" &&
    JSON.stringify(calls) === JSON.stringify([["cancel", "session_1"]]), calls);
}

console.log(`\n${failed === 0 ? "JCODE-COMMANDS SMOKE OK" : "JCODE-COMMANDS SMOKE FAILED"}  (${passed} passed, ${failed} failed)`);
emitSentinel({ passed, failed });
process.exit(failed === 0 ? 0 : 1);
