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
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EpEnvelopeError, EP_UNANSWERED, LANG_PROBLEM_DETAIL_KIND, registry, type Command, type RunStatusView } from "@cotal-ai/core";
import { CommandFailure, exitCode, isCommandFailure } from "@cotal-ai/workspace";
import { runWorkflow } from "../src/index.js";
import { managerRefusal, renderLangProblem, unansweredManagerRefusal, withMatchingKeys, workflowArguments } from "../src/run-command.js";
import { printRunDetail } from "../src/workflow-views.js";

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

// A local start's ceiling entry is a channel or a pattern; one the wire layer would rewrite is refused by name.
{
  const local = (read: string, publish: string) => gate(["start"], { local: true, file: "p.cotal.js", "admit-read": read, "admit-publish": publish });
  for (const [read, publish, flag, entry] of [["a b", "none", "admit-read", "a b"], ["general,team x", "none", "admit-read", "team x"], ["none", "a b", "admit-publish", "a b"]] as const)
    c(`--${flag} ${JSON.stringify(entry)} is refused naming the entry`, usageRefusal(local(read, publish), `--${flag}: invalid channel "${entry}"`), local(read, publish));
  for (const [read, publish] of [["general,team.>", "none"], ["none", "general, ops"]] as const)
    c(`control: --admit-read ${JSON.stringify(read)} --admit-publish ${JSON.stringify(publish)} passes the grammar`, !(local(read, publish) instanceof Error), local(read, publish));
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

{
  // An answer value whose record would differ from what was typed is refused before anything is
  // sent: JSON keeps the last of two equal names, writes 1e999 as null, and cannot send a value
  // nested past the serializer's stack, so a value nests at most 1000 levels.
  const schemaRefusal = (got: unknown, says: string) =>
    isCommandFailure(got) && got.outcome === "refused" && got.code === "SCHEMA_INVALID" && got.message.includes(says) && got.message.includes("nothing was sent");
  const answerWith = (value: string) => gate(["answer", "run-0", "/checkpoint:probe#0"], { value });
  const duplicate = answerWith('{"a":1,"a":2}');
  c("an answer value that names a key twice is refused SCHEMA_INVALID", schemaRefusal(duplicate, '--value names "a" twice in one object'), duplicate);
  const huge = answerWith('{"n":[1e999]}');
  c("an answer value with a number outside the range JSON carries is refused SCHEMA_INVALID", schemaRefusal(huge, "outside the range JSON carries"), huge);
  const deep = answerWith("[".repeat(1001) + "]".repeat(1001));
  c("an answer value nested more than 1000 levels deep is refused SCHEMA_INVALID", schemaRefusal(deep, "--value nests more than 1000 levels deep"), deep);
  // An artifact reference names something, so an empty or blank one is refused before anything is sent.
  for (const verb of ["answer", "amend"]) for (const artifact of ["", "   "]) {
    const got = gate([verb, "run-0", "/checkpoint:probe#0"], { artifact });
    c(`${verb} --artifact ${JSON.stringify(artifact)} is refused USAGE_INVALID naming --artifact`, usageRefusal(got, "--artifact names the artifact the answer cites, so it cannot be empty"), got);
  }
  const fine = answerWith('{"a":1,"b":[1e300,"a"]}');
  const deepest = answerWith("[".repeat(1000) + "]".repeat(1000));
  c("and a value JSON carries as typed, 1000 levels deep at most, passes the gate",
    !(fine instanceof Error) && fine.verb === "answer" && !(deepest instanceof Error) && deepest.verb === "answer", { fine, deepest });
}

{
  // --timeout is the limit of every checkpoint, ask and turn that sets none of its own. A value that
  // is not a duration, or is zero, used to start the run and then fail it at the first checkpoint.
  const bad = ["5", "PT5M", "1.5s", "", "5S"].flatMap((t) =>
    [["start", "p.cotal.js"], ["resume", "run-0"]].map((positionals) => [t, positionals.join(" "), gate(positionals, { timeout: t })] as const));
  c("a --timeout that is not a duration is refused USAGE_INVALID on start and resume, with the duration's own text",
    bad.every(([t, , got]) => usageRefusal(got, `--timeout "${t}" is not a duration`)), bad.filter(([t, , got]) => !usageRefusal(got, `--timeout "${t}" is not a duration`)));
  const zero = gate(["start", "p.cotal.js"], { timeout: "0s" });
  c("and so is a zero one", usageRefusal(zero, "--timeout must be longer than zero"), zero);
  const fine = gate(["start", "p.cotal.js"], { timeout: "30m" });
  c("a duration longer than zero passes the gate", !(fine instanceof Error) && fine.verb === "start", fine);
}

{
  // A malformed run id is the same local check on every verb that takes one, so each refuses it as
  // usage before any contact, naming the id format.
  const idFormat = 'is not a run id, which is 1 to 64 letters, digits, "_" or "-"';
  const malformed: Array<[string[], Record<string, string | boolean>]> = [
    [["show", " run-0123"], {}], [["journal", "run-../../etc"], {}], [["show", `run-${"a".repeat(80)}`], {}], [["show", ""], {}],
    [["answer", "run-a b", "/checkpoint:a#0"], { value: "1" }], [["amend", "run-ä", "/checkpoint:a#0"], { value: "1" }],
    [["resume", "x/y"], {}], [["revoke", "run-a b"], { local: true, by: "tester", reason: "why" }], [["check", "run-a b", "edited.cotal.js"], {}],
  ];
  const refused = malformed.map(([positionals, values]) => [positionals.join(" "), gate(positionals, values)] as const);
  c("a malformed run id is refused USAGE_INVALID, naming the id format, on every verb that takes one",
    refused.every(([, got]) => usageRefusal(got, idFormat)), refused.filter(([, got]) => !usageRefusal(got, idFormat)).map(([line, got]) => [line, (got as Error)?.message ?? got]));
  const unknown = gate(["show", "RUN-0123"]);
  c("and a well-formed id passes the gate, so an unknown run is still the manager's TARGET_NOT_FOUND", !(unknown instanceof Error) && unknown.a === "RUN-0123", unknown);
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
  // Revoke is local only and needs --by, so a hosted one names that requirement with or without --by.
  for (const by of [{}, { by: "dana" }, { by: "dana", reason: "why" }] as Record<string, string>[]) {
    reset();
    const got5 = await attempt(["revoke", "run-0"], by);
    c(`hosted \`revoke\` ${JSON.stringify(by)} names what revoke requires`, usageRefusal(got5, "run revoke requires --local --by <actor> --reason <text>"), got5);
  }
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
    legacy.startsWith("the manager registered for this space did not answer on the endpoint rails (") && legacy.includes("is a manager running for this mesh?") && legacy.includes("--local"), legacy);
  const v1 = unansweredManagerRefusal(new EpEnvelopeError("deadline-exceeded", "no describe reply from manager within 10000ms on the ep.v1 rail", mark("ep.v1")));
  c("versioned rail: the refusal names ep.v1 and states what the silence does not establish",
    v1.startsWith("the manager registered for this space did not answer on the ep.v1 rail (") && v1.includes("disjoint at the broker (SPEC 13.15)")
    && v1.includes("does not tell no manager running apart from one older than ep.v1"), v1);
  c("versioned rail: neither the false question nor the --local remedy that follows from it is printed",
    !v1.includes("is a manager running for this mesh?") && !v1.includes("--local"), v1);
  const unmarked = unansweredManagerRefusal(new EpEnvelopeError("deadline-exceeded", "no describe reply from manager within 10000ms", mark()));
  c("an unanswered failure whose producer recorded no rail keeps the legacy wording", unmarked.includes("is a manager running for this mesh?"), unmarked);
}

// A scripted checkpoint result is read by the simulator only for an `expired` status, so a
// malformed one would simulate as an answer. The results file is refused before the simulation,
// and a simulation that stops names why.
{
  const dir = mkdtempSync(join(tmpdir(), "run-simulate-script-"));
  const program = join(dir, "p.cotal.js");
  writeFileSync(program, 'await checkpoint("go", "Proceed?", { timeout: "4s", onExpiry: "proceed" });\n');
  const simulate = (script: unknown, values: Record<string, string | boolean> = {}) => {
    const handler = join(dir, "results.json");
    writeFileSync(handler, JSON.stringify(script));
    return runWorkflow({ values: { handler, ...values }, positionals: ["simulate", program], raw: [] }).then(() => undefined, (e: Error) => e);
  };
  const scriptRefusal = (got: unknown, says: string) =>
    isCommandFailure(got) && got.code === "SCHEMA_INVALID" && exitCode(got.outcome, got.code) === 1 && got.message.includes(says);
  const maybe = await simulate({ checkpoints: { go: { status: "maybe" } } });
  c("a scripted checkpoint status other than resolved or expired is refused SCHEMA_INVALID, exit 1",
    scriptRefusal(maybe, 'status must be "resolved" or "expired"'), maybe);
  const at = await simulate({ checkpoints: { go: { status: "resolved", at: 5 } } });
  c("a scripted checkpoint at is refused, since the simulator stamps it from virtual time",
    scriptRefusal(at, "at is stamped from virtual time"), at);
  // A simulation that stops says why and where: a missing entry is the script's gap, named with the
  // entry to add. An expired gate under the default onExpiry is a completed simulation whose program
  // failed with L4007 at that gate.
  const missing = await simulate({});
  c("a script with no result for an effect names the step and the entry to add",
    isCommandFailure(missing) && missing.code === "OPERATION_FAILED" && missing.message.includes('no checkpoints entry for "go" (step /checkpoint:go#0)')
      && (missing.detail().remedy ?? "").includes('{ checkpoints: { "go": <result> } }') && (missing.target as { step?: string } | undefined)?.step === "/checkpoint:go#0", missing);
  writeFileSync(program, 'await checkpoint("go", "Proceed?", { timeout: "4s" });\n');
  const out: string[] = [];
  const write = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => { out.push(String(chunk)); return true; }) as typeof process.stdout.write;
  let expired: unknown;
  try { expired = await simulate({ checkpoints: { go: { status: "expired" } } }, { json: true }); }
  finally { process.stdout.write = write; }
  let envelope: { outcome?: string; result?: { outcome?: string; failure?: { code?: string; step?: string; stepOutcome?: string }; effects?: { step: string }[] } } | undefined;
  try { envelope = JSON.parse(out.join("")); } catch { envelope = undefined; }
  c("a gate scripted expired under the default onExpiry is a completed simulation whose program failed at that gate with L4007",
    expired === undefined && envelope?.outcome === "ok" && envelope.result?.outcome === "failed" && envelope.result.failure?.code === "L4007"
      && envelope.result.failure.step === "/checkpoint:go#0" && envelope.result.failure.stepOutcome === "expired" && envelope.result.effects?.some((e) => e.step === "/checkpoint:go#0") === true, { expired, envelope });
  // A log line the program writes is printed: the language journals none, so this is where it is read.
  writeFileSync(program, 'log("hello", 42);\n');
  writeFileSync(join(dir, "results.json"), "{}");
  const written: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => { written.push(String(chunk)); return true; }) as typeof process.stdout.write;
  let logged: unknown;
  try { logged = await runWorkflow({ values: { handler: join(dir, "results.json"), json: true }, positionals: ["simulate", program], raw: [] }).then(() => undefined, (e: Error) => e); }
  finally { process.stdout.write = origWrite; }
  let logEnvelope: { result?: { log?: unknown } } | undefined;
  try { logEnvelope = JSON.parse(written.join("")) as typeof logEnvelope; } catch { logEnvelope = undefined; }
  c("a simulation's log line is printed, and --json carries it in result.log",
    logged === undefined && JSON.stringify(logEnvelope?.result?.log) === JSON.stringify([{ scope: "", values: ["hello", 42] }]), written.join("").slice(0, 400));
  writeFileSync(program, 'throw "boom";\n');
  const thrown = await simulate({});
  c("a program that throws fails naming what it threw, not an unscripted effect",
    isCommandFailure(thrown) && thrown.code === "OPERATION_FAILED" && thrown.message.includes('boom') && !thrown.message.includes("unscripted"), thrown);
  // A list one result short says which result the step needs, counted from 1. The step key keeps its
  // occurrence counted from 0.
  writeFileSync(program, 'await checkpoint("go", "Proceed?", { timeout: "4s" });\nawait checkpoint("go", "Again?", { timeout: "4s" });\n');
  const short = await simulate({ checkpoints: { go: [{ status: "resolved" }] } });
  c("a list one result short says the second step needs result 2",
    isCommandFailure(short) && short.code === "OPERATION_FAILED" && short.message.includes('the script gives 1 checkpoints result for "go", and step /checkpoint:go#1 needs result 2'), short);
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

// A workflow source that cannot be read is refused naming its path and the cause, before any plane.
{
  const dir = mkdtempSync(join(tmpdir(), "run-source-"));
  mkdirSync(join(dir, "adir"));
  symlinkSync(join(dir, "nowhere.cotal.js"), join(dir, "dangling.cotal.js"));
  writeFileSync(join(dir, "locked.cotal.js"), "x\n", { mode: 0o000 });
  const cases: [string, string, string][] = [
    ["missing.cotal.js", "TARGET_NOT_FOUND", "does not exist"],
    ["adir", "USAGE_INVALID", "is a directory"],
    ["dangling.cotal.js", "TARGET_NOT_FOUND", "is a link whose target does not exist"],
    // root reads a mode-000 file, so the permission case runs only for another user.
    ...(process.getuid?.() === 0 ? [] : [["locked.cotal.js", "PERMISSION_DENIED", "is not readable"] as [string, string, string]]),
  ];
  for (const [name, code, says] of cases) {
    const path = join(dir, name);
    const got = await attempt(["start", path]);
    c(`run start of ${name} refuses ${code} naming its path and cause`, isCommandFailure(got) && got.code === code && got.message.includes(path) && got.message.includes(says), got);
  }
  const dash = await attempt(["start", "-"]);
  c("run start - says that - does not mean standard input", isCommandFailure(dash) && dash.code === "TARGET_NOT_FOUND" && dash.message.includes("- does not mean standard input"), dash);
  rmSync(dir, { recursive: true, force: true });
}

// `journal --limit` says how many of the last journal rows the text view prints. The view printed only
// the last 20, and the only way to read more was --json, which holds the whole journal and so takes
// no --limit. A ps --limit still belongs to --page.
{
  const ok50 = gate(["journal", "run-0"], { limit: "50" });
  c("run journal takes --limit from 1 to 1000", !(ok50 instanceof Error) && ok50.values.limit === "50"
    && !(gate(["show", "run-0"], { limit: "1000" }) instanceof Error), ok50);
  for (const limit of ["0", "1001", "x"])
    c(`run show --limit ${limit} is refused`, usageRefusal(gate(["show", "run-0"], { limit }), "--limit must be between 1 and 1000"), limit);
  c("run journal --limit with --json is refused", usageRefusal(gate(["journal", "run-0"], { limit: "5", json: true }), "--json returns the whole journal"));
  c("run ps --limit without --page is still refused", usageRefusal(gate(["ps"], { limit: "5" }), "diagnostic paging requires run --page"));
  const view = { runId: "run-0", endpoint: "manager", spec: {} as RunStatusView["spec"],
    journal: Array.from({ length: 30 }, (_, n) => ({ n, kind: "activation" as const, holder: "h", epoch: n, replayedTo: 0 })) } satisfies RunStatusView;
  const printed = (limit?: string): string => {
    const out: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => { out.push(a.map(String).join(" ")); };
    try { printRunDetail("usage", view, { plain: true, ...(limit === undefined ? {} : { limit }) }); } finally { console.log = origLog; process.exitCode = 0; }
    return out.join("\n");
  };
  const rows = (text: string) => text.split("\n").filter((line) => line.includes("holder activation")).length;
  const bare = printed(), limited = printed("25");
  c("the text view prints the last 20 rows by default and the last n under --limit n",
    bare.includes("last 20 of 30") && rows(bare) === 20 && limited.includes("last 25 of 30") && rows(limited) === 25 && limited.includes("epoch 29") && !limited.split("\n").some((line) => line.trimEnd().endsWith("epoch 4")),
    { bare: rows(bare), limited: rows(limited) });
  // A failure raised outside any step is in no journal row. When the status recorded its cause, the
  // view prints the cause and does not also say that nothing records why.
  const failed = (failure?: { message: string }): string => {
    const out: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => { out.push(a.map(String).join(" ")); };
    try { printRunDetail("usage", { ...view, journal: [], status: { state: "failed", ...(failure ? { failure } : {}) } as RunStatusView["status"] }, { plain: true }); } finally { console.log = origLog; process.exitCode = 0; }
    return out.join("\n");
  };
  const caused = failed({ message: "the program gave up outside any step" }), uncaused = failed();
  c("a failure outside any step whose cause the status recorded prints that cause and not that no row records why",
    caused.includes("the program gave up outside any step") && !caused.includes("No journal row records why") && caused.includes("cotal service logs stack-manager --space usage"), caused);
  c("one whose status recorded no cause says no journal row records why, and names the manager's log",
    uncaused.includes("No journal row records why this run failed") && uncaused.includes("cotal service logs stack-manager --space usage"), uncaused);
}

// A source file that cannot be read is refused with the path to check.
{
  const missing = join(tmpdir(), `run-source-missing-${process.pid}.cotal.js`);
  reset();
  const refused = await runWorkflow({ values: {}, positionals: ["validate", missing], raw: [] }).then(() => undefined, (e: Error) => e);
  c("validate refuses a file it cannot read, TARGET_NOT_FOUND, with a remedy naming the path", isCommandFailure(refused) && refused.code === "TARGET_NOT_FOUND" && refused.detail().remedy === `check that ${missing} exists and this account can read it`, refused);
}

// A source file that is empty or not UTF-8 is refused by validate and by a hosted start alike,
// before anything is checked or sent. Validate used to pass an empty file that start then broke on,
// and Latin-1 text used to be stored with U+FFFD in place of its bytes.
{
  const dir = mkdtempSync(join(tmpdir(), "run-source-bytes-"));
  const empty = join(dir, "e.cotal.js"), latin1 = join(dir, "l.cotal.js");
  writeFileSync(empty, "");
  writeFileSync(latin1, Buffer.from('const d = await checkpoint("go", "Weiter mit \xe4nderung?");\n', "latin1"));
  for (const [file, says] of [[empty, "is empty"], [latin1, "is not valid UTF-8"]] as const) {
    reset();
    const validated = await runWorkflow({ values: {}, positionals: ["validate", file], raw: [] }).then(() => undefined, (e: Error) => e);
    c(`validate refuses a source file that ${says}, SCHEMA_INVALID, exit 1`, isCommandFailure(validated) && validated.code === "SCHEMA_INVALID" && exitCode(validated.outcome, validated.code) === 1 && validated.message.includes(says), validated);
    reset();
    const started = await attempt(["start"], { file });
    c(`a hosted start refuses a source file that ${says} the same way, before any connect`, isCommandFailure(started) && started.code === "SCHEMA_INVALID" && started.message.includes(says), started);
  }
  rmSync(dir, { recursive: true, force: true });
}

// An open checkpoint with a `to` shows beside its question whom it escalates to, and once it has
// escalated, until when that attempt is open. The escalation's attempt is armed with `proceed`.
{
  const detail = (journal: object[]) => {
    const out: string[] = [];
    const log = console.log, error = console.error;
    console.log = console.error = (...args: unknown[]) => { out.push(args.map(String).join(" ")); };
    try { printRunDetail("s", { runId: "run-1", endpoint: "manager", status: { state: "running" }, journal } as unknown as RunStatusView, {}); }
    finally { console.log = log; console.error = error; }
    return out.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
  };
  const open = (name: string, more: object) => ({ n: 1, kind: "step", step: `/checkpoint:${name}#0`, effect: "checkpoint", name, state: "pending", outcome: "pending", startedAt: 0, asks: `${name}?`, ...more });
  const shown = detail([
    open("first", { addressee: "dana", deadlineAt: 0, onExpiry: "escalate" }),
    open("second", { addressee: "erik", deadlineAt: Date.UTC(2026, 9, 24, 6, 0, 0), onExpiry: "proceed" }),
    open("third", { onExpiry: "fail" }),
  ]);
  c("an open checkpoint names whom it escalates to, and an escalated one its addressee and deadline",
    /Step\s+Request\s+Escalation/.test(shown) && /first\?\s+to dana if it expires/.test(shown) && shown.includes("second?  escalated to erik, open until 2026-10-24T06:00:00.000Z"), shown);
  c("with no checkpoint addressed, the table has no Escalation column", !detail([open("third", { onExpiry: "fail" })]).includes("Escalation"));
}

// An answer refused for a step key the run holds no open request at names the open keys whose step
// name matches what was typed, as `frage` names `/checkpoint:frage#0`.
{
  const notFound = () => new CommandFailure("refused", "TARGET_NOT_FOUND", "the run has no open checkpoint at frage", { remedy: "read the run's open requests with cotal run show run-1" });
  const row = (step: string, state: string, asks?: string) => ({ kind: "step", step, state, ...(asks ? { asks } : {}) });
  const view = (...journal: object[]) => async () => ({ journal }) as unknown as RunStatusView;
  const one = await withMatchingKeys(notFound(), "run-1", "frage", {}, view(row("/checkpoint:frage#0", "pending", "Proceed?"), row("/checkpoint:done#0", "pending", "Done?")));
  c("an answer to a checkpoint's name names its open key and the command, with the code and message kept",
    one instanceof CommandFailure && one.code === "TARGET_NOT_FOUND" && one.message === "the run has no open checkpoint at frage"
    && one.remedy === "the open request '/checkpoint:frage#0' matches; answer it with cotal run answer run-1 '/checkpoint:frage#0' --value '<json>'", one);
  const pinned = await withMatchingKeys(notFound(), "run-1", "frage", { on: "mgr-1" }, view(row("/checkpoint:frage#0", "pending", "Proceed?")));
  c("the suggested command keeps an explicit --on", pinned instanceof CommandFailure && pinned.remedy?.endsWith(" --on mgr-1") === true, pinned);
  const two = await withMatchingKeys(notFound(), "run-1", "frage", {}, view(row("/checkpoint:frage#0", "pending", "A?"), row("/fanOut:x#0/checkpoint:frage#1", "pending", "B?")));
  c("several matching open keys are listed to pick from", two instanceof CommandFailure && two.remedy === "the open requests that match are '/checkpoint:frage#0', '/fanOut:x#0/checkpoint:frage#1'; pass one of them as the step", two);
  const settled = notFound();
  c("a settled step with that name is not offered", await withMatchingKeys(settled, "run-1", "frage", {}, view(row("/checkpoint:frage#0", "pending", "A?"), row("/checkpoint:frage#0", "settled"))) === settled);
  const unread = notFound();
  c("a run view that cannot be read leaves the refusal as it was", await withMatchingKeys(unread, "run-1", "frage", {}, async () => { throw new Error("no answer"); }) === unread);
  const other = new CommandFailure("refused", "LIFECYCLE_BLOCKED", "revoked");
  c("a refusal other than TARGET_NOT_FOUND is left as it was", await withMatchingKeys(other, "run-1", "frage", {}, view(row("/checkpoint:frage#0", "pending", "A?"))) === other);
  const escaped = await withMatchingKeys(notFound(), "run-1", "fr\x1b[2Jage", {}, view(row("/checkpoint:fr\x1b[2Jage#0", "pending", "A?")));
  c("a step name from the program is escaped before the terminal shows it", escaped instanceof CommandFailure && !escaped.remedy?.includes("\x1b") && escaped.remedy?.includes("\\u001b") === true, escaped instanceof CommandFailure ? escaped.remedy : escaped);
}

// A resume the manager refuses as a precondition, as of a completed run, appended nothing, so the
// next step reads the run's recorded state, keeping an explicit pin.
{
  const finished = { code: "failed-precondition", message: "run run-1 is already completed, so there is nothing to resume; a resume continues a run that is running or released" };
  const blocked = managerRefusal("run-resume", "s", { runId: "run-1" }, finished);
  c("a resume of a completed run is LIFECYCLE_BLOCKED with the manager's sentence, and Next reads the run", blocked.code === "LIFECYCLE_BLOCKED" && blocked.message === finished.message && blocked.remedy === "read the run's recorded state with cotal run show run-1", blocked);
  c("the Next keeps an explicit --on", managerRefusal("run-resume", "s", { runId: "run-1" }, finished, "mgr-1").remedy === "read the run's recorded state with cotal run show run-1 --on mgr-1");
  c("a start refused as a precondition gets no run show Next", managerRefusal("run-start", "s", { source: "log(1)" }, { code: "failed-precondition", message: "no" }).remedy === undefined);
}

// A validation problem a hosted start prints quotes the program, so a step name's control characters
// reach the terminal escaped, as run validate shows them.
{
  const name = "\u001b]52;c;SGFsbG8=\u0007\u001b]0;FENSTER\u0007";
  const shown = renderLangProblem({ kind: LANG_PROBLEM_DETAIL_KIND, code: "L3014", title: "Malformed step name", where: { file: "osc.cotal.js", line: 1, column: 28 }, cause: `"${name}" is not a well-formed step name.`, fix: "Use kebab-case." });
  c("a hosted start's problem line escapes a step name's control characters", !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(shown) && shown.includes("\\u001b]52;c;SGFsbG8=\\u0007") && shown.startsWith("  L3014 Malformed step name (osc.cotal.js:1:28)\n    "), shown);
}

restore();
console.log(`run-command-usage: ${ok} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
