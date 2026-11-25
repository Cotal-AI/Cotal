/**
 * A Jcode seat lists Jcode's native session operations as commands for its `agent` endpoint, runs
 * each through its Harness request, refuses a call whose arguments Jcode cannot take before Jcode
 * sees it, and stops a running turn through Jcode's cancel. Its `set-model` switches the model with
 * Jcode's `set_model`, then the effort with `set_reasoning_effort`, between turns only, and answers
 * with the model and effort Jcode's runtime info names. A refusal that left the session unchanged is
 * the switch's refusal; an effort refused after the model switched leaves the outcome unknown.
 *
 * The shipped dispatcher runs over a fake session that answers as Jcode 0.99.0 was measured to:
 * `compact` refuses with `invalid_request` when there is too little to compact, `rewind N` keeps the
 * first N messages, and `cancel` on a running turn ends it with `turn_done`. The switch then runs
 * through the SDK's own client against the fake Harness (`fake-jcode.mjs`), whose next turn records
 * the model and effort it ran on. No broker is started.
 *
 * Run: pnpm smoke:jcode-commands
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { HarnessError, JcodeClient } from "@1jehuang/jcode-sdk";
import { CommandRefused, type AgentCommand } from "@cotal-ai/connector-core";
import { emitSentinel, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";
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
let modelAnswer: () => Promise<void> = async () => {};
let effortAnswer: () => Promise<void> = async () => {};
let runtime: Record<string, unknown> = {};
const session = {
  cancel: async (id: string) => { calls.push(["cancel", id]); },
  compact: async (id: string) => { calls.push(["compact", id]); return compactAnswer(); },
  rewind: async (id: string, index: number) => { calls.push(["rewind", id, index]); },
  renameSession: async (...a: [string, string?]) => { calls.push(["renameSession", ...a]); },
  setModel: async (id: string, model: string) => { calls.push(["setModel", id, model]); return modelAnswer(); },
  setReasoningEffort: async (id: string, effort: string) => { calls.push(["setReasoningEffort", id, effort]); return effortAnswer(); },
  request: async (req: { req: string; session_id?: string }) => { calls.push([req.req, req.session_id]); return { v: 1, ...runtime }; },
};
type Host = Pick<HostTurnState, "client" | "sessionId" | "turnActive" | "driving" | "reconnecting">;
const host = { client: session, sessionId: "session_1", turnActive: false, driving: false, reconnecting: false } as unknown as Host;
const commands = jcodeCommands(host, async () => { throw new Error("no turn in this smoke"); });
const run = (name: string, args = "") => commands.dispatch({ target: "command", name, args } satisfies AgentCommand);
const failure = (e: unknown): string => (e instanceof CommandRefused ? `${e.code}: ${e.message}` : `unknown: ${(e as Error).message}`);
async function outcome(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return "started";
  } catch (e) {
    return failure(e);
  }
}
const fresh = () => { calls.length = 0; };
const answer = (work: Promise<unknown>): Promise<string> => work.then((value) => JSON.stringify(value), failure);
const switchTo = (model?: string, variant?: string) => answer(commands.setModel!(model, variant));
const runtimeInfo = (fields: Record<string, unknown>) => { runtime = { ev: "runtime_info", session_id: "session_1", routes: [], ...fields }; };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

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

console.log("Jcode set-model");
{
  host.turnActive = false;
  check("the dispatcher switches models", typeof commands.setModel === "function");

  fresh();
  runtimeInfo({ model: "gpt-6", reasoning_effort: "high" });
  check("a model and variant switch the model, then the effort, then read what Jcode runs",
    (await switchTo("gpt-6", "high")) === '{"model":"gpt-6","variant":"high"}' &&
    same(calls, [["setModel", "session_1", "gpt-6"], ["setReasoningEffort", "session_1", "high"], ["get_runtime_info", "session_1"]]), calls);
  fresh();
  runtimeInfo({ model: "gpt-6-2026-05" });
  check("the answer names the model as Jcode names it, and no variant when Jcode names no effort",
    (await switchTo("gpt-6")) === '{"model":"gpt-6-2026-05"}' && same(calls, [["setModel", "session_1", "gpt-6"], ["get_runtime_info", "session_1"]]), calls);
  fresh();
  runtimeInfo({ model: "gpt-6", reasoning_effort: "low" });
  check("a variant alone sets only the effort", (await switchTo(undefined, "low")) === '{"model":"gpt-6","variant":"low"}' &&
    same(calls, [["setReasoningEffort", "session_1", "low"], ["get_runtime_info", "session_1"]]), calls);

  fresh();
  modelAnswer = async () => { throw new HarnessError("invalid_request", "unknown model gpt-0"); };
  check("Jcode refusing the model is the switch's refusal, and no effort is sent",
    (await switchTo("gpt-0", "high")) === "failed-precondition: invalid_request: unknown model gpt-0" && same(calls, [["setModel", "session_1", "gpt-0"]]), calls);
  fresh();
  modelAnswer = async () => { throw new HarnessError("timeout", "no reply to set_model within 30000ms"); };
  check("a model failure that is not a refusal leaves the model unknown", (await switchTo("gpt-6")).startsWith("unknown: timeout:"));
  modelAnswer = async () => {};

  fresh();
  effortAnswer = async () => { throw new HarnessError("invalid_request", "Reasoning effort 'max' is not supported"); };
  const halfway = await switchTo("gpt-6", "max");
  check("an effort Jcode refuses after the model switched is no refusal, and names both",
    halfway === `unknown: Jcode switched to model "gpt-6", then did not take variant "max": invalid_request: Reasoning effort 'max' is not supported` &&
    same(calls, [["setModel", "session_1", "gpt-6"], ["setReasoningEffort", "session_1", "max"]]), halfway);
  fresh();
  check("an effort Jcode refuses with no model switch is the switch's refusal",
    (await switchTo(undefined, "max")) === "failed-precondition: invalid_request: Reasoning effort 'max' is not supported");
  effortAnswer = async () => {};

  fresh();
  runtimeInfo({});
  check("a runtime answer that names no model leaves the model unknown", (await switchTo("gpt-6")).startsWith("unknown: Jcode took the switch"));

  fresh();
  check("a provider-prefixed id is refused before Jcode sees it, naming the bare id",
    (await switchTo("openai/gpt-6", "high")) === `failed-precondition: Jcode takes a bare model id: pass "gpt-6". Jcode's configuration chooses the provider.` &&
    calls.length === 0, calls);
  const between = "failed-precondition: Jcode switches models between turns; ask again when this turn ends";
  host.turnActive = true;
  check("a switch while a turn runs is refused before Jcode sees it", (await switchTo("gpt-6")) === between && calls.length === 0, calls);
  host.turnActive = false;
  host.driving = true;
  check("a switch while the host is starting a turn is refused", (await switchTo(undefined, "low")) === between && calls.length === 0, calls);
  host.driving = false;
  host.reconnecting = true;
  check("a switch while Jcode's connection is replaced is refused",
    (await switchTo("gpt-6")) === "failed-precondition: Jcode's session is not ready" && calls.length === 0, calls);
  host.reconnecting = false;
}

console.log("Jcode set-model over the Harness API");
{
  const dir = mkdtempSync(join("/tmp", "jcsm-"));
  const socketPath = join(dir, "api.sock");
  const logPath = join(dir, "fake.jsonl");
  const ambient = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(COTAL|JCODE|FAKE_JCODE)_/.test(key)));
  const bridge = spawn(process.execPath, [fileURLToPath(new URL("./fake-jcode.mjs", import.meta.url)), "api-bridge", "--api-socket", socketPath], {
    env: { ...ambient, FAKE_JCODE_LOG: logPath, FAKE_JCODE_DEFAULT_MODEL: "model-a", FAKE_JCODE_REFUSE_MODEL: "model-refused", FAKE_JCODE_REFUSE_EFFORT: "max" },
    stdio: "ignore",
  });
  const release = teardownOnSignal(bridge, dir);
  let client: JcodeClient | undefined;
  try {
    for (let i = 0; i < 200 && !existsSync(socketPath); i++) await new Promise((resolve) => setTimeout(resolve, 25));
    client = await JcodeClient.connect({ socketPath, clientName: "jcode-commands-smoke" });
    const sessionId = (await client.createSession(dir)).session_id;
    const live = jcodeCommands({ client, sessionId, turnActive: false, driving: false, reconnecting: false }, async () => { throw new Error("no turn in this smoke"); });
    type Logged = { ev: string; frame?: { req: string; model?: string; effort?: string }; content?: string; model?: string; effort?: string | null };
    const logged = (): Logged[] => readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Logged);
    const sentAfter = (from: number) => logged().slice(from).flatMap((e) =>
      e.ev === "request" && e.frame ? [[e.frame.req, e.frame.model ?? e.frame.effort].filter((x) => x !== undefined)] : []);
    const ranOn = async (content: string) => {
      await client!.run(sessionId, content);
      const ran = logged().find((e) => e.ev === "turn_run" && e.content === content);
      return { model: ran?.model, effort: ran?.effort };
    };
    const liveSwitch = (model?: string, variant?: string) => answer(live.setModel!(model, variant));

    let from = logged().length;
    check("Jcode is sent set_model, then set_reasoning_effort, and the answer is what its runtime info names",
      (await liveSwitch("model-b", "high")) === '{"model":"model-b","variant":"high"}' &&
      same(sentAfter(from), [["set_model", "model-b"], ["set_reasoning_effort", "high"], ["get_runtime_info"]]), sentAfter(from));
    check("the next turn runs on the new model and effort", same(await ranOn("first turn after the switch"), { model: "model-b", effort: "high" }));
    from = logged().length;
    check("a switch with no variant sends no effort, and answers the effort Jcode kept",
      (await liveSwitch("model-c")) === '{"model":"model-c","variant":"high"}' && same(sentAfter(from), [["set_model", "model-c"], ["get_runtime_info"]]), sentAfter(from));
    check("the next turn runs on the new model and the kept effort", same(await ranOn("turn on model-c"), { model: "model-c", effort: "high" }));
    from = logged().length;
    check("a variant alone sends only the effort", (await liveSwitch(undefined, "low")) === '{"model":"model-c","variant":"low"}' &&
      same(sentAfter(from), [["set_reasoning_effort", "low"], ["get_runtime_info"]]), sentAfter(from));
    check("the next turn runs on the new effort", same(await ranOn("turn on low effort"), { model: "model-c", effort: "low" }));
    check("Jcode refusing a model is the switch's refusal",
      (await liveSwitch("model-refused", "high")) === "failed-precondition: invalid_request: model model-refused was refused");
    check("after a refused model the next turn runs on the model and effort it ran before",
      same(await ranOn("turn after a refused model"), { model: "model-c", effort: "low" }));
    const halfway = await liveSwitch("model-d", "max");
    check("Jcode refusing the effort after the model switched leaves the outcome unknown",
      halfway.startsWith(`unknown: Jcode switched to model "model-d", then did not take variant "max": invalid_request: `), halfway);
    check("and the next turn runs on the switched model with the effort Jcode kept",
      same(await ranOn("turn after a refused effort"), { model: "model-d", effort: "low" }));
  } catch (e) {
    check("the fake Harness answered the switch", false, (e as Error).message);
  } finally {
    await client?.close();
    await killAndAwaitExit(bridge);
    rmSync(dir, { recursive: true, force: true });
    release();
  }
}

console.log(`\n${failed === 0 ? "JCODE-COMMANDS SMOKE OK" : "JCODE-COMMANDS SMOKE FAILED"}  (${passed} passed, ${failed} failed)`);
emitSentinel({ passed, failed });
process.exit(failed === 0 ? 0 : 1);
