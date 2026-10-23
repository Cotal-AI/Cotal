/**
 * `cotal run`'s verb gate, with no broker: an invocation the dispatcher cannot route is refused as a
 * usage error before any plane is opened, with exit 1, and every verb the gate routes is a declared
 * `run` subcommand or alias that the command's usage line names. Bare `cotal run` is the list
 * command, so it is not a refusal (docs/cli.md, "Workflow command forms").
 *
 * This is the runtime package's own `test` script, which the Windows required job runs on a box
 * with no nats-server, so everything here must stay off the wire. Every other runtime suite drives
 * a real broker and lives in the smoke:ci chain.
 *
 * Run: pnpm smoke:runtime-run-command-usage   (no broker)
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EpEnvelopeError, EP_UNANSWERED, registry, type Command } from "@cotal-ai/core";
import { exitCode, isCommandFailure } from "@cotal-ai/workspace";
import { runWorkflow } from "../src/index.js";
import { unansweredManagerRefusal, workflowArguments } from "../src/run-command.js";

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => {
  if (v) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ FAIL: ${n}`, extra ?? ""); }
};

// A hosted refusal that is not part of the grammar still ends through `process.exit`; the suite
// turns that into a thrown sentinel so the exit code is graded rather than taken.
class Exited extends Error { constructor(readonly code: number | string | null | undefined) { super(`exit ${code}`); } }
const ERR: string[] = [];
const origErr = console.error;
const origExit = process.exit;
console.error = (...a: unknown[]) => { ERR.push(a.map(String).join(" ")); };
process.exit = ((code?: number | string | null) => { throw new Exited(code); }) as typeof process.exit;
const reset = () => { ERR.length = 0; };
const restore = () => { console.error = origErr; process.exit = origExit; };

// The address names a port nothing listens on, so a call that got past the grammar to a connect
// would come back as a broker failure rather than a usage refusal.
const attempt = async (positionals: string[], values: Record<string, string | boolean> = {}): Promise<Exited | Error | undefined> =>
  runWorkflow({ values: { server: "nats://127.0.0.1:1", space: "usage", ...values }, positionals, raw: [] })
    .then(() => undefined, (e: Error) => e);
/** The grammar's refusal, read the way the kernel reads it: a USAGE_INVALID failure that exits 1. */
const usageRefusal = (got: unknown, says: string) =>
  isCommandFailure(got) && got.outcome === "refused" && got.code === "USAGE_INVALID" && exitCode(got.outcome, got.code) === 1 && got.message.includes(says);
const gateMessage = "choose a declared run command";
const gate = (positionals: string[], values: Record<string, string | boolean> = {}) => {
  try { return workflowArguments({ values, positionals, raw: [] }); } catch (e) { return e as Error; }
};

{
  const bare = gate([]);
  c("no verb at all is the list command, not a refusal", !(bare instanceof Error) && bare.verb === "ps", bare);
}

{
  reset();
  // Complete answer-shaped arguments and invalid JSON: the verb gate must answer before either the
  // answer arity or the value check could.
  const got = await attempt(["frobnicate", "run-0", "/checkpoint:probe#0"], { value: "{" });
  c("an unknown verb is refused as a usage error before any plane is opened", usageRefusal(got, gateMessage), got);
  const run = registry.resolve<Command>("command", "run");
  let hooked: unknown;
  try { run.validate?.({ values: {}, positionals: ["frobnicate"], raw: [] }); } catch (e) { hooked = e; }
  c("and the registered command's validate hook, which the kernel runs before the command, refuses it the same way",
    usageRefusal(hooked, gateMessage), hooked);
}

// The gate and the declaration are two lists of the same verbs, kept by hand. Grade that they agree:
// every verb the gate routes is declared, every declared name passes the gate, and the usage line
// names every listed subcommand.
const VERBS = ["start", "resume", "ps", "journal", "answer", "amend", "revoke", "migrate", "validate", "plan", "simulate", "turns", "yield"];
{
  const run = registry.resolve<Command>("command", "run");
  const subcommands = run.subcommands ?? [];
  const declared = new Set(subcommands.flatMap((s) => [s.name, ...(s.aliases ?? [])]));
  for (const verb of VERBS) c(`the declared run command names \`${verb}\``, declared.has(verb), [...declared]);
  for (const name of declared) {
    const routed = gate([name]);
    c(`the verb gate routes the declared \`${name}\``, !(routed instanceof Error && routed.message.includes(gateMessage)), routed);
  }
  for (const s of subcommands.filter((s) => !s.hidden))
    c(`the usage line names \`${s.name}\``, new RegExp(`(^|[\\s[|])${s.name}( |\\]|$)`).test(run.usage ?? ""), run.usage);
}

// Flags the HOSTED path does not take are refused by name before any plane is opened, never
// dropped: a hosted drive is recorded under the manager's own endpoint, the manager resumes from
// the recorded program, and it records the answerer from the caller's credential.
{
  reset();
  const got = await attempt(["start"], { file: "p.cotal.js", endpoint: "elsewhere" });
  c("hosted `start --endpoint` is refused", usageRefusal(got, "--endpoint is only for the local path"), got);
  reset();
  const got2 = await attempt(["resume", "run-0"], { endpoint: "elsewhere" });
  c("hosted `resume --endpoint` is refused", usageRefusal(got2, "--endpoint is only for the local path"), got2);
  reset();
  const got3 = await attempt(["resume", "run-0"], { file: "p.cotal.js" });
  c("hosted `resume --file` is refused, and the sentence hands back a command with the run id in it",
    got3 instanceof Exited && got3.code === 1 && ERR.some((l) => l.includes("cotal run resume run-0 --local --file <program>")), ERR);
  reset();
  const got4 = await attempt(["answer", "run-0", "/checkpoint:approve#0"], { by: "dana" });
  c("hosted `answer --by` is refused: the manager records the caller", usageRefusal(got4, "--by is only for the local path"), got4);
  const flags = registry.resolve<Command>("command", "run").flags ?? [];
  const help = (name: string) => flags.find((f) => f.name === name)?.description ?? "";
  c("and the declared flag help places `--file` on resume and `--by` on answer and amend only beside `--local`",
    help("file").includes("resume --local") && help("by").includes("answer --local") && help("by").includes("amend --local"),
    { file: help("file"), by: help("by") });
  // The manager serves no `run-migrate` command (SPEC 14.3's table), so the grammar runs every
  // check on the local drive rather than routing it into an unanswered describe.
  const check = gate(["migrate", "run-0"], { file: "p.cotal.js" });
  const checkAlias = gate(["check", "run-0", "p.cotal.js"]);
  c("hosted `migrate` is never routed to a manager: the grammar runs every check on the local drive",
    !(check instanceof Error) && check.verb === "migrate" && check.values.local === true
    && !(checkAlias instanceof Error) && checkAlias.verb === "migrate" && checkAlias.values.local === true && checkAlias.values.file === "p.cotal.js",
    { check, checkAlias });
}

// #1630: what a hosted verb prints when the manager describe drew no answer. The rail the describe
// rode decides it (SPEC 13.15: `ep` and `ep.v1` are disjoint at the broker and an endpoint serves
// both), because the old single sentence asserted "no manager is running" and offered `--local`
// against a manager that was up the whole time, and `--local` names the caller as the run's own
// answerer. Off the wire: the renderer takes the error, so no broker is needed.
{
  const mark = (rail?: string) => [{ kind: EP_UNANSWERED, endpoint: "manager", command: "describe", ...(rail !== undefined ? { rail } : {}) }];
  const legacy = unansweredManagerRefusal(new EpEnvelopeError("deadline-exceeded", "no describe reply from manager within 10000ms on the ep rail", mark("ep")));
  c("legacy rail: the question and the --local remedy stand (one rail, and nothing answered on it)",
    legacy.startsWith("no manager answered on the endpoint rails (") && legacy.includes("is a manager running for this mesh?") && legacy.includes("--local"), legacy);
  const v1 = unansweredManagerRefusal(new EpEnvelopeError("deadline-exceeded", "no describe reply from manager within 10000ms on the ep.v1 rail", mark("ep.v1")));
  c("versioned rail: the refusal names ep.v1 and states what the silence does not establish",
    v1.startsWith("no manager answered on the ep.v1 rail (") && v1.includes("disjoint at the broker (SPEC 13.15)")
    && v1.includes("does not tell no manager running apart from one older than ep.v1"), v1);
  c("versioned rail: neither the false question nor the --local remedy that follows from it is printed",
    !v1.includes("is a manager running for this mesh?") && !v1.includes("--local"), v1);
  const unmarked = unansweredManagerRefusal(new EpEnvelopeError("deadline-exceeded", "no describe reply from manager within 10000ms", mark()));
  c("an unanswered failure whose producer recorded no rail keeps the legacy wording", unmarked.includes("is a manager running for this mesh?"), unmarked);
}

// A scripted checkpoint result is read by the simulator only for an `expired` status, so a
// malformed one would simulate as an answer. The results file is refused before the simulation.
{
  const dir = mkdtempSync(join(tmpdir(), "run-simulate-script-"));
  const program = join(dir, "p.cotal.js");
  writeFileSync(program, 'await checkpoint("go", "Proceed?", { timeout: "4s", onExpiry: "proceed" });\n');
  const simulate = (script: unknown) => {
    const handler = join(dir, "results.json");
    writeFileSync(handler, JSON.stringify(script));
    return runWorkflow({ values: { handler }, positionals: ["simulate", program], raw: [] }).then(() => undefined, (e: Error) => e);
  };
  const scriptRefusal = (got: unknown, says: string) =>
    isCommandFailure(got) && got.code === "SCHEMA_INVALID" && exitCode(got.outcome, got.code) === 1 && got.message.includes(says);
  const maybe = await simulate({ checkpoints: { go: { status: "maybe" } } });
  c("a scripted checkpoint status other than resolved or expired is refused SCHEMA_INVALID, exit 1",
    scriptRefusal(maybe, 'status must be "resolved" or "expired"'), maybe);
  const at = await simulate({ checkpoints: { go: { status: "resolved", at: 5 } } });
  c("a scripted checkpoint at is refused, since the simulator stamps it from virtual time",
    scriptRefusal(at, "at is stamped from virtual time"), at);
  rmSync(dir, { recursive: true, force: true });
}

// A validator warning names its code, position, cause and fix, as a problem does. L3021 on a literal
// list is a fan-out the run refuses, and the warning used to say only that something was found.
{
  const dir = mkdtempSync(join(tmpdir(), "run-validate-warning-"));
  const program = join(dir, "fanout.cotal.js");
  writeFileSync(program, 'await fanOut(["x", "y"], (x) => sleep("1s", { name: "nap" }), { name: "fo" });\n');
  reset();
  await runWorkflow({ values: {}, positionals: ["validate", program], raw: [] });
  const said = ERR.join(" ").replace(/\s+/g, " ");
  c("a validator warning names its code, title, position and fix on stderr",
    said.includes(`L3021 \`fanOut\` has no stable key (${program}:1:7)`) && said.includes("Fix: Pass a key function"), said);
  rmSync(dir, { recursive: true, force: true });
}

restore();
console.log(`run-command-usage: ${ok} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
