/**
 * `cotal run`'s verb gate, with no broker: an invocation the dispatcher cannot route is refused as a
 * usage error before any plane is opened, with exit 1, and every verb the gate routes is a declared
 * `run` subcommand or alias that the command's usage line names. Bare `cotal run` is the list
 * command, so it is not a refusal (docs/cli.mdx, "Workflow command forms").
 *
 * This is the runtime package's own `test` script, which the Windows required job runs on a box
 * with no nats-server, so everything here must stay off the wire. Every other runtime suite drives
 * a real broker and lives in the smoke:ci chain.
 *
 * Run: pnpm smoke:runtime-run-command-usage   (no broker)
 */
import { spawnSync } from "node:child_process";
import { chmodSync, closeSync, constants, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EpEnvelopeError, EP_UNANSWERED, LANG_PROBLEM_DETAIL_KIND, parseCommandArgs, registry, type Command, type RunStatusView } from "@cotal-ai/core";
import { CommandFailure, exitCode, isCommandFailure, runOperation, shellPath } from "@cotal-ai/workspace";
import { runWorkflow } from "../src/index.js";
import { managerRefusal, renderLangProblem, unansweredHostFailure, unansweredManagerRefusal, withMatchingKeys, workflowArguments } from "../src/run-command.js";
import { printRunDetail } from "../src/workflow-views.js";
import { sourceOf } from "../src/offline-command.js";

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

// Text-only forms give a retry without help: use a supported form or remove the output flag.
{
  const cases: [string, string[], Record<string, string | boolean>, string, string][] = [
    ["revoke --local --json", ["revoke", "run-1"], { local: true, by: "a", reason: "b", json: true }, "run revoke prints no --json output", "remove --json from the original command and rerun it"],
    ["revoke --local --plain", ["revoke", "run-1"], { local: true, by: "a", reason: "b", plain: true }, "run revoke prints no --plain output", "remove --plain from the original command and rerun it"],
    ["check --plain", ["check", "run-1", "p.cotal.js"], { plain: true }, "run check prints no --plain output", "run it without --plain: `cotal run check run-1 --file p.cotal.js`"],
    ["start --local --json", ["start", "p.cotal.js"], { local: true, "admit-read": "none", "admit-publish": "none", json: true }, "run start --local prints no --json output", "remove --json from the original command to keep driving it locally, or start it on the manager with `cotal run start --file p.cotal.js --json`"],
    ["resume --local --json", ["resume", "run-1"], { local: true, json: true }, "run resume --local prints no --json output", "remove --json from the original command to keep driving it locally, or resume it on the manager with `cotal run resume run-1 --json`"],
  ];
  for (const [what, positionals, values, message, remedy] of cases) {
    const got = gate(positionals, values);
    c(`${what} names the supported form and prints no help`,
      usageRefusal(got, message) && isCommandFailure(got) && got.message === message && got.remedy === remedy && got.selfContained === true, got);
  }
}

// Local answers need their explicit answerer before any plane is opened, in every output mode.
{
  const modes: Record<string, string | boolean>[] = [{}, { json: true }, { plain: true }];
  for (const verb of ["answer", "amend"]) for (const mode of modes) for (const by of [undefined, ""]) {
    const got = gate([verb, "run-1", "/checkpoint:a#0"], { local: true, ...mode, ...(by === undefined ? {} : { by }) });
    c(`${verb} --local with ${by === undefined ? "missing" : "empty"} --by refuses before contact in ${JSON.stringify(mode)}`,
      usageRefusal(got, `run ${verb} --local requires --by <who>`)
      && isCommandFailure(got) && got.remedy === "add --by <who> to name the local answerer" && got.selfContained === true, got);
  }
  for (const verb of ["answer", "amend"]) {
    c(`${verb} --local with a named answerer still passes the grammar`, !(gate([verb, "run-1", "/checkpoint:a#0"], { local: true, by: "operator" }) instanceof Error));
    c(`${verb} hosted still records the caller without --by`, !(gate([verb, "run-1", "/checkpoint:a#0"]) instanceof Error));
  }
}

// A local start's ceiling entry is a channel or a pattern; one the wire layer would rewrite is refused by name.
{
  const local = (read: string, publish: string) => gate(["start"], { local: true, file: "p.cotal.js", "admit-read": read, "admit-publish": publish });
  for (const [read, publish, flag, entry] of [["a b", "none", "admit-read", "a b"], ["general,team x", "none", "admit-read", "team x"], ["none", "a b", "admit-publish", "a b"]] as const)
    c(`--${flag} ${JSON.stringify(entry)} is refused naming the entry`, usageRefusal(local(read, publish), `--${flag}: invalid channel "${entry}"`), local(read, publish));
  for (const [read, publish] of [["general,team.>", "none"], ["none", "general, ops"]] as const)
    c(`control: --admit-read ${JSON.stringify(read)} --admit-publish ${JSON.stringify(publish)} passes the grammar`, !(local(read, publish) instanceof Error), local(read, publish));
}

// A local start names its admission ceiling on the command line, so a missing or empty
// option is refused by the gate, before any broker contact, and the help already calls
// both options required.
{
  const local = (values: Record<string, string | boolean>) => gate(["start"], { local: true, file: "p.cotal.js", ...values });
  for (const [flag, values] of [
    ["admit-read", { "admit-publish": "none" }],
    ["admit-publish", { "admit-read": "none" }],
  ] as const) {
    const missing = local(values);
    c(`start --local with missing --${flag} refuses before contact naming the flag`,
      usageRefusal(missing, `run start --local requires --${flag} <channels>`)
      && isCommandFailure(missing) && (missing.remedy ?? "").includes(`--${flag} <channels>`) && missing.selfContained === true, missing);
  }
  for (const [flag, values] of [
    ["admit-read", { "admit-read": "", "admit-publish": "none" }],
    ["admit-publish", { "admit-read": "none", "admit-publish": "   " }],
    ["admit-read", { "admit-read": " , , ", "admit-publish": "none" }],
    ["admit-publish", { "admit-read": "none", "admit-publish": " , , " }],
  ] as const) {
    const empty = local(values);
    c(`start --local with --${flag} ${JSON.stringify(values[flag])} refuses before contact naming the flag`,
      usageRefusal(empty, `run start --local requires --${flag} <channels>`), empty);
  }
  c("start --local with both ceilings named still passes the grammar",
    !(local({ "admit-read": "none", "admit-publish": "none" }) instanceof Error));
  c("a hosted start still takes no admission ceiling",
    !(gate(["start"], { file: "p.cotal.js" }) instanceof Error));
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
  // A results file is named by --handler, so an empty or blank one is refused before the file is read.
  for (const handler of ["", "   "]) {
    const got = gate(["simulate", "p.cotal.js"], { handler });
    c(`simulate --handler ${JSON.stringify(handler)} is refused USAGE_INVALID naming --handler`,
      usageRefusal(got, "--handler names the simulation results file, so it cannot be empty") && isCommandFailure(got) && (got.remedy ?? "").includes("omit `--handler`"), got);
  }
  const handlerFine = gate(["simulate", "p.cotal.js"], { handler: "results.json" });
  c("and a named results file passes the gate", !(handlerFine instanceof Error) && handlerFine.verb === "simulate", handlerFine);
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
  const server = "nats://127.0.0.1:4422", on = "a".repeat(26);
  for (const operands of [[], ["bad/id"], ["first", "second"]]) {
    const got = gate(["show", ...operands], { space: "beta", server, on, json: true });
    const target = ` --space beta --server '${server}' --on ${on} --json`;
    c("the suggested list and show read the requested manager", isCommandFailure(got) && got.remedy === `\`cotal run${target}\` lists the runs; run \`cotal run show <run-id>${target}\``, got);
  }
  for (const [kind, ids, correction] of [
    ["missing", [], "Then add a run ID after `run resume` in the original command"],
    ["malformed", ["bad/id"], "Then replace only the run ID in the original command"],
  ] as const) {
    const hostedResume = gate(["resume", ...ids], { space: "beta", server, on, json: true, timeout: "5m" });
    c(`a ${kind} hosted resume ID lists runs on the requested manager`, isCommandFailure(hostedResume) && hostedResume.remedy === `list the recorded runs with \`cotal run list --space beta --server '${server}' --on ${on} --json\`. ${correction}`, hostedResume);
    const privateResume = gate(["resume", ...ids], { space: "beta", server: "wss://broker.example/ws?token=private", plain: true });
    c(`a ${kind} hosted resume ID keeps private broker options out of its inventory hint`, isCommandFailure(privateResume) && privateResume.remedy === `run \`cotal run list --plain\` with the original target options. ${correction}`, privateResume);
  }
  const local = gate(["journal"], { local: true, space: "beta", endpoint: "worker", limit: "5", plain: true });
  c("the local lookup retains its endpoint and leaves the journal limit for the read", isCommandFailure(local) && local.remedy === "`cotal run --local --space beta --endpoint worker --plain` lists the runs; run `cotal run journal <run-id> --local --space beta --endpoint worker --limit 5 --plain`", local);
  for (const [ids, message, correction] of [
    [[], "run resume takes one identifier", "Then add a run ID after `run resume` in the original command"],
    [["bad/id"], idFormat, "Then replace only the run ID in the original command"],
  ] as const) {
    const resume = gate(["resume", ...ids], { local: true, space: "beta", server: "wss://broker.example/ws?token=private", file: "workflow.cotal.js", timeout: "5m" });
    c("the local resume remedy names the local list without repeating a private broker URL",
      usageRefusal(resume, message) && isCommandFailure(resume)
        && resume.remedy === `run \`cotal run list --local\` with the original target options. ${correction}`, resume);
  }
  for (const verb of ["answer", "amend"]) {
    const got = gate([verb, "bad/id", "/checkpoint:a#0"], { local: true, space: "beta", server: "wss://broker.example/ws?token=private", by: "operator", value: "true" });
    c(`the local ${verb} remedy keeps the original target without repeating a private broker URL`,
      usageRefusal(got, idFormat) && isCommandFailure(got) && got.selfContained === true
        && got.remedy === "run `cotal run list --local` with the original target options. Then replace only the run ID in the original command", got);
  }
  const hidden = gate(["show"], { space: "beta", server: "wss://example.invalid/socket?test=private" });
  c("a broker address that cannot be displayed is not copied or replaced by an unscoped lookup", isCommandFailure(hidden) && hidden.remedy?.includes("same broker") === true && !hidden.remedy.includes("private") && !hidden.remedy.includes("`cotal run`"), hidden);
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
  const revoke = subcommands.find((s) => s.name === "revoke");
  c("the help says a revoke does not cancel work that touches no channel", revoke?.summary?.endsWith("; it does not cancel work that touches no channel") === true, revoke?.summary);
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
  c("hosted `resume --file` is refused with instructions to keep all the other options",
    usageRefusal(got3, "--file is not taken") && isCommandFailure(got3)
      && got3.remedy?.startsWith("remove only --file and its value from the original command") === true
      && got3.remedy.includes("cotal run resume run-0 --local --file <program>"), got3);
  for (const verb of ["check", "migrate"]) for (const [flag, value] of [["adopt", "h1"], ["release", "h1"], ["discard-approvals", true]] as const) {
    const got = await attempt([verb, "run-0", "p.cotal.js"], { [flag]: value });
    c(`${verb} --${flag} is a usage refusal before a connection`, usageRefusal(got, `--${flag} decides what a commit does`), got);
  }
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

// A start whose request went out and whose reply never came may have been recorded: the manager
// started and completed such a run while the CLI printed "Request refused", so a retry ran it twice.
// Core marks that silence `unknown`; silence before the request, or no responder, stays refused.
{
  const sent = (command: string) => new EpEnvelopeError("deadline-exceeded", `no reply to manager.${command} within the 25000ms budget (SPEC 13.5)`,
    [{ kind: EP_UNANSWERED, endpoint: "manager", command, rail: "ep.v1", requestId: "r1" }], "unknown");
  for (const command of ["run-start", "run-resume", "run-answer", "run-amend"]) {
    const f = unansweredHostFailure(command, "s", sent(command));
    c(`${command} published and unanswered is unknown, exit 3, with the read-before-retry remedy`,
      f.outcome === "unknown" && f.code === "OPERATION_UNKNOWN" && exitCode(f.outcome, f.code) === 3 && f.message.endsWith("; the manager may already have recorded it")
      && String(f.remedy).startsWith("read the run with `cotal run show`, or list the runs with `cotal run`, before trying again"), { outcome: f.outcome, code: f.code, message: f.message });
  }
  // The describe before a read was answered on the same rail, so the rail and skew wording does not
  // apply: one run failed, and reading it again is safe. A list that misses its budget may miss it
  // again, so the remedy names one page of the same list, with the flags the caller already passed.
  {
    const read = unansweredHostFailure("run-status", "s", sent("run-status"));
    c("run-status published and unanswered failed, exit 5, and names neither the rail nor a restart",
      read.outcome === "failed" && read.code === "OPERATION_FAILED" && exitCode(read.outcome, read.code) === 5
      && read.message.endsWith("The manager answered on this rail just before, so it runs and did not reply in time")
      && !read.message.includes("disjoint at the broker") && read.remedy === "a read changes nothing, so it is safe to run again", { outcome: read.outcome, code: read.code, message: read.message });
  }
  {
    const read = unansweredHostFailure("run-ps", "s", sent("run-ps"), { space: "s", server: "nats://127.0.0.1:4222", creds: "op.creds", endpoint: "manager", json: true });
    const page = "a list that misses its budget may miss it again; `cotal run --page --on <instance> --space s --server 'nats://127.0.0.1:4222' --creds '<file>' --endpoint manager --json` reads one page. <instance> is one `cotal ps` names, and a page needs a manager at contract revision 29 or later";
    c("run-ps published and unanswered failed, exit 5, and names a page of the same list",
      read.outcome === "failed" && read.code === "OPERATION_FAILED" && exitCode(read.outcome, read.code) === 5
      && read.message.endsWith("The manager answered on this rail just before, so it runs and did not reply in time")
      && !read.message.includes("disjoint at the broker") && read.remedy === page && !String(read.remedy).includes("op.creds"), { outcome: read.outcome, code: read.code, message: read.message, remedy: read.remedy });
  }
  {
    const hidden = unansweredHostFailure("run-ps", "s", sent("run-ps"), { server: "nats://sample:private-token@localhost:4222", creds: "private-caller.creds" });
    c("a list remedy keeps the caller's flags and prints neither a credentials path nor a server that carries credentials",
      !String(hidden.remedy).includes("private-token") && !String(hidden.remedy).includes("private-caller.creds")
      && String(hidden.remedy).includes("--creds '<file>'") && !String(hidden.remedy).includes("--server"), hidden.remedy);
  }
  // The printed page is parsed as the command line parses it, then accepted by the page grammar.
  // `--plain` is not kept: a page refuses it.
  {
    const run = registry.resolve("command", "run") as Command;
    const instance = "m".repeat(26);
    const commandOf = (remedy: string | undefined) => remedy?.match(/`([^`]+)`/)?.[1]?.replace("<instance>", instance);
    const accepted = (values: Record<string, string | boolean>) => {
      const remedy = unansweredHostFailure("run-ps", "s", sent("run-ps"), values).remedy;
      const command = commandOf(remedy);
      if (command === undefined) return { remedy, accepted: false };
      let parsed: ReturnType<typeof parseCommandArgs>;
      try { parsed = parseCommandArgs(run, command.split(/\s+/).slice(2)); } catch (e) { return { remedy, command, accepted: false, error: String(e) }; }
      let grammar: unknown;
      try { grammar = workflowArguments(parsed); } catch (e) { grammar = e; }
      return { remedy, command, parsed, grammar, accepted: !(grammar instanceof Error) };
    };
    for (const [name, values, kept] of [
      ["neither", {}, ""],
      ["--json", { json: true }, " --json"],
      ["--plain", { plain: true }, ""],
    ] as const) {
      const got = accepted({ space: "s", server: "nats://127.0.0.1:4222", endpoint: "manager", ...values });
      const expected = `cotal run --page --on ${instance} --space s --server 'nats://127.0.0.1:4222' --endpoint manager${kept}`;
      c(`the page named for a ${name} list parses and the page form accepts it`,
        got.accepted === true && got.command === expected && !(got.command ?? "").includes("--plain"), got);
    }
  }
  {
    const paged = unansweredHostFailure("run-ps", "s", sent("run-ps"), { page: true });
    c("a page that itself drew no reply keeps the retry a read of one run gets",
      paged.outcome === "failed" && paged.code === "OPERATION_FAILED" && paged.remedy === "a read changes nothing, so it is safe to run again", paged.remedy);
  }
  const readDescribed = unansweredHostFailure("run-ps", "s", new EpEnvelopeError("deadline-exceeded", "no describe reply from manager within 10000ms on the ep.v1 rail",
    [{ kind: EP_UNANSWERED, endpoint: "manager", command: "describe", rail: "ep.v1" }]));
  c("a read whose describe drew no answer stays TARGET_UNAVAILABLE", readDescribed.outcome === "refused" && readDescribed.code === "TARGET_UNAVAILABLE", { outcome: readDescribed.outcome, code: readDescribed.code });
  const described = unansweredHostFailure("run-start", "s", new EpEnvelopeError("deadline-exceeded", "no describe reply from manager within 10000ms on the ep.v1 rail",
    [{ kind: EP_UNANSWERED, endpoint: "manager", command: "describe", rail: "ep.v1" }]));
  c("a start whose describe drew no answer sent nothing and stays TARGET_UNAVAILABLE", described.outcome === "refused" && described.code === "TARGET_UNAVAILABLE", { outcome: described.outcome, code: described.code });
  const noResponder = unansweredHostFailure("run-start", "s", new EpEnvelopeError("unavailable", "no responder for manager.run-start (SPEC 13.5)",
    [{ kind: EP_UNANSWERED, endpoint: "manager", command: "run-start", rail: "ep.v1" }], "not-executed"));
  c("a start the broker saw no responder for was not executed and stays TARGET_UNAVAILABLE", noResponder.outcome === "refused" && noResponder.code === "TARGET_UNAVAILABLE", { outcome: noResponder.outcome, code: noResponder.code });
}

{
  const example = (file: string, section: string, language: string) => {
    const page = readFileSync(new URL(`../../../docs/${file}.mdx`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
    const fence = `\`\`\`${language}\n`;
    const block = page.split(section)[1]?.split(fence)[1]?.split("\n```")[0];
    if (!block) throw new Error(`Missing ${language} example in ${file}: ${section}`);
    return block;
  };
  const dir = mkdtempSync(join(tmpdir(), "run-simulate-docs-"));
  const program = join(dir, "workflow.cotal.js"), handler = join(dir, "results.json");
  const chunks: string[] = [];
  const write = process.stdout.write;
  try {
    writeFileSync(program, example("workflows", "## An example program", "js"));
    writeFileSync(handler, example("cli-runs", "### Offline commands", "json"));
    process.stdout.write = ((chunk: string | Uint8Array) => { chunks.push(String(chunk)); return true; }) as typeof process.stdout.write;
    await runWorkflow({ values: { handler, json: true }, positionals: ["simulate", program], raw: [] });
  } finally {
    process.stdout.write = write;
    rmSync(dir, { recursive: true, force: true });
  }
  const output = JSON.parse(chunks.join(""));
  c("the published results file completes the guide workflow without unused results",
    output.result.outcome === "completed" && output.result.unusedScript.length === 0, output);
}

// A fault keyed by a step's old name is never injected. The run still completes, since the fault
// could target a branch this run did not take, and the report names the fault as unused.
{
  const dir = mkdtempSync(join(tmpdir(), "run-simulate-fault-"));
  const program = join(dir, "timer.cotal.js"), handler = join(dir, "unknown-fault.json");
  const chunks: string[] = [];
  const write = process.stdout.write;
  try {
    writeFileSync(program, 'await sleep("1s", { name: "timer" })\n');
    writeFileSync(handler, JSON.stringify({ faults: [{ at: "/sleep:typo#0", kind: "error", code: "L4002", message: "intended timer failure" }] }));
    process.stdout.write = ((chunk: string | Uint8Array) => { chunks.push(String(chunk)); return true; }) as typeof process.stdout.write;
    await runWorkflow({ values: { handler, json: true }, positionals: ["simulate", program], raw: [] });
  } finally {
    process.stdout.write = write;
    rmSync(dir, { recursive: true, force: true });
  }
  const output = JSON.parse(chunks.join(""));
  c("a fault whose step was never reached leaves the run completed and is listed as unused",
    output.result.outcome === "completed" && JSON.stringify(output.result.unusedScript) === JSON.stringify(["faults./sleep:typo#0"]), output);
}

// A scripted checkpoint result is read by the simulator only for an `expired` status, so a
// malformed one would simulate as an answer. The results file is refused before the simulation,
// and a simulation that stops names why.
{
  const dir = mkdtempSync(join(tmpdir(), "run-simulate-script-"));
  const program = join(dir, "p.cotal.js");
  writeFileSync(program, 'await checkpoint("go", "Proceed?", { timeout: "4s", onExpiry: "proceed" });\n');
  const simulateText = (text: string, values: Record<string, string | boolean> = {}) => {
    const handler = join(dir, "results.json");
    writeFileSync(handler, text);
    return runWorkflow({ values: { handler, ...values }, positionals: ["simulate", program], raw: [] }).then(() => undefined, (e: Error) => e);
  };
  const simulate = (script: unknown, values: Record<string, string | boolean> = {}) => simulateText(JSON.stringify(script), values);
  const scriptRefusal = (got: unknown, says: string) =>
    isCommandFailure(got) && got.code === "SCHEMA_INVALID" && exitCode(got.outcome, got.code) === 1 && got.message.includes(says);
  const maybe = await simulate({ checkpoints: { go: { status: "maybe" } } });
  c("a scripted checkpoint status other than resolved or expired is refused SCHEMA_INVALID, exit 1",
    scriptRefusal(maybe, 'status must be "resolved" or "expired"'), maybe);
  const at = await simulate({ checkpoints: { go: { status: "resolved", at: 5 } } });
  c("a scripted checkpoint at is refused, since the simulator stamps it from virtual time",
    scriptRefusal(at, "at is stamped from virtual time"), at);
  const handler = join(dir, "results.json");
  const invalidList = await simulate({ checkpoints: { go: [{ status: "resolved" }, { status: "done" }] } });
  c("a wrong checkpoint status in a list names the results file and indexes the result to correct",
    isCommandFailure(invalidList) && scriptRefusal(invalidList, `in ${handler}: status must be "resolved" or "expired"`)
    && (invalidList.target as { file?: string })?.file === handler
    && invalidList.remedy === `set checkpoints.go[1].status in ${handler} to "resolved" or "expired", then rerun the simulation`, invalidList);
  // Scripted turn results go to the program as written, so invalid results are refused even
  // when unused. A valid handoff still delivers the handle.
  const fertig = await simulate({ checkpoints: { go: { status: "resolved", value: true } }, turns: { build: { status: "fertig" } } });
  c("a scripted turn status other than done, blocked or handoff is refused SCHEMA_INVALID, exit 1",
    scriptRefusal(fertig, `invalid scripted turn 'build' in ${handler}: turns.build.status must be "done", "blocked" or "handoff"`), fertig);
  const turnAt = await simulate({ checkpoints: { go: { status: "resolved", value: true } }, turns: { build: [{ status: "done" }, { status: "done", at: 5 }] } });
  c("a scripted turn at, in any entry of a list, is refused, since the simulator stamps it from virtual time",
    scriptRefusal(turnAt, `invalid scripted turn 'build' in ${handler}: turns.build[1].at is stamped from virtual time`), turnAt);
  for (const [build, path] of [
    [{ status: "handoff" }, "turns.build.to"],
    [[{ status: "done" }, { status: "handoff" }], "turns.build[1].to"],
  ] as const) {
    const missing = await simulate({ checkpoints: { go: { status: "resolved" } }, turns: { build } });
    c(`a scripted handoff without a destination names ${path} even when unused`,
      scriptRefusal(missing, `${path} is required when status is "handoff"`), missing);
  }
  const destination = { agent: "sim.ana", persona: "ana" };
  for (const [build, path] of [
    [{ status: "done", to: destination }, "turns.build.to"],
    [[{ status: "done" }, { status: "blocked", to: destination }], "turns.build[1].to"],
  ] as const) {
    const unexpected = await simulate({ checkpoints: { go: { status: "resolved" } }, turns: { build } });
    c(`a scripted non-handoff rejects the destination at ${path}`,
      scriptRefusal(unexpected, `${path} is only allowed when status is "handoff"`), unexpected);
  }
  for (const to of [42, "ana", null, { agent: "sim.ana" }, { agent: "sim.ana", persona: "ana", worktree: 1 }]) {
    const invalid = await simulate({ turns: { build: [{ status: "blocked" }, { status: "handoff", to }] } });
    c(`a malformed scripted handoff names turns.build[1].to (${JSON.stringify(to)})`, scriptRefusal(invalid, "turns.build[1].to must be an agent handle"), invalid);
  }
  for (const text of ['{"clock":{"start":"1000"}}', '{"clock":{"start":null}}', '{"clock":{"start":1e999}}']) {
    const invalid = await simulateText(text);
    c(`an invalid clock start is refused (${text})`,
      scriptRefusal(invalid, `clock.start in the simulation results script ${handler} must be a finite number in milliseconds`), invalid);
  }
  // A start past the safe-integer range cannot step by whole milliseconds: 9007199254740992
  // plus a 1ms sleep rounds back to the start, so the simulation would report elapsedMs 0.
  // It is refused before simulation, naming the supported range, while the largest safe
  // integer still measures the sleep.
  {
    const tooLarge = await simulateText('{"clock":{"start":9007199254740992}}');
    c("a clock start past the safe-integer range is refused naming clock.start and the supported range",
      scriptRefusal(tooLarge, "clock.start must be a safe integer in milliseconds")
      && isCommandFailure(tooLarge) && (tooLarge.remedy ?? "").includes("9007199254740991"), tooLarge);
    const shown: string[] = [];
    const write = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => { shown.push(String(chunk)); return true; }) as typeof process.stdout.write;
    let atMax: unknown;
    try {
      writeFileSync(program, 'await sleep("1ms");\nlog("done");\n');
      atMax = await simulate({ clock: { start: 9007199254740991 } }, { json: true });
    } finally { process.stdout.write = write; }
    let atMaxEnvelope: { result?: { elapsedMs?: number } } | undefined;
    try { atMaxEnvelope = JSON.parse(shown.join("")); } catch { atMaxEnvelope = undefined; }
    c("the largest safe-integer clock start still measures a one-millisecond sleep",
      atMax === undefined && atMaxEnvelope?.result?.elapsedMs === 1, { atMax, atMaxEnvelope });
    writeFileSync(program, 'await checkpoint("go", "Proceed?", { timeout: "4s", onExpiry: "proceed" });\n');
  }
  // The reported typo: `clock.checkpoints` silently fell back to the 60s default, so the
  // simulation measured 60000ms instead of the 3000ms the author asked for. An unknown clock
  // key is refused naming the field, the results file, and the key to use instead, and the
  // singular key measures the delay the author asked for.
  {
    const typo = await simulate({ clock: { checkpoints: "3s" }, checkpoints: { go: { status: "resolved" } } });
    c("an unknown clock field is refused naming the field, the results file, and the singular key",
      scriptRefusal(typo, `unknown clock field 'checkpoints' in the simulation results script ${handler}`)
      && isCommandFailure(typo) && (typo.target as { file?: string })?.file === handler
      && typo.remedy === `use clock.checkpoint in ${handler} instead of clock.checkpoints, then rerun the simulation`, typo);
    const unknown = await simulate({ clock: { cadence: "3s" }, checkpoints: { go: { status: "resolved" } } });
    c("an unknown clock field with no singular key is refused naming the field and the file",
      scriptRefusal(unknown, `unknown clock field 'cadence' in the simulation results script ${handler}`)
      && isCommandFailure(unknown) && (unknown.target as { file?: string })?.file === handler
      && unknown.remedy === `remove clock.cadence from ${handler}, then rerun the simulation`, unknown);
    // A fault entry is matched only on `at`, so a misspelled field or an entry that names no
    // step would simulate as if the fault were not there. Both are refused naming the entry
    // and the results file, and a well-formed fault still raises at its step.
    const typoFault = await simulate({ faults: [{ att: "/sleep#0", kind: "timeout" }] });
    c("a fault entry with a misspelled field is refused naming the entry and the file",
      scriptRefusal(typoFault, `invalid scripted fault faults[0] in ${handler}: unknown field 'att'`)
      && isCommandFailure(typoFault) && (typoFault.target as { file?: string })?.file === handler
      && typoFault.remedy === `correct faults[0] in ${handler}, then rerun the simulation`, typoFault);
    const noStep = await simulate({ faults: [{ kind: "timeout" }] });
    c("a fault entry that names no step is refused naming the entry and the file",
      scriptRefusal(noStep, `invalid scripted fault faults[0] in ${handler}: at must name the step to fault`)
      && isCommandFailure(noStep) && (noStep.target as { file?: string })?.file === handler
      && noStep.remedy === `correct faults[0] in ${handler}, then rerun the simulation`, noStep);
    {
      const shown: string[] = [];
      const write = process.stdout.write;
      process.stdout.write = ((chunk: string | Uint8Array) => { shown.push(String(chunk)); return true; }) as typeof process.stdout.write;
      let fired: unknown;
      try {
        writeFileSync(program, 'await sleep("1s");\n');
        fired = await simulate({ faults: [{ at: "/sleep#0", kind: "timeout" }] }, { json: true });
      } finally { process.stdout.write = write; }
      const out = JSON.parse(shown.join("").trim());
      c("a well-formed fault still raises at its step (L4002)", fired === undefined && out.result?.failure?.code === "L4002", { fired, out });

      shown.length = 0;
      process.stdout.write = ((chunk: string | Uint8Array) => { shown.push(String(chunk)); return true; }) as typeof process.stdout.write;
      try {
        writeFileSync(program, 'const winner = await race({ slow: () => sleep("3s"), fast: () => sleep("1s") }, { name: "first" });\nlog(winner.index);\n');
        fired = await simulate({ faults: [{ at: "/race:first#0", kind: "test-refusal", code: "L4002", message: "injected race failure" }] }, { json: true });
      } finally { process.stdout.write = write; }
      const race = JSON.parse(shown.join("").trim());
      c("a scripted race fault fails the race itself before any arm runs", fired === undefined && race.outcome === "ok"
        && race.result.outcome === "failed" && race.result.failure.code === "L4002" && race.result.failure.title === "injected race failure"
        && race.result.failure.step === "/race:first#0" && race.result.effects.length === 1 && race.result.effects[0].status === "failed"
        && race.result.elapsedMs === 0 && race.result.log.length === 0, { fired, race });
      writeFileSync(program, 'await checkpoint("go", "Proceed?", { timeout: "4s", onExpiry: "proceed" });\n');
    }
    writeFileSync(program, 'const answer = await checkpoint("approve", "Approve the example?", { timeout: "10m", onExpiry: "proceed" });\nlog(answer.status);\n');
    const timedOut: string[] = [];
    const timedWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => { timedOut.push(String(chunk)); return true; }) as typeof process.stdout.write;
    let timed: unknown;
    try { timed = await simulate({ clock: { checkpoint: "3s" }, checkpoints: { approve: { status: "resolved" } } }, { json: true }); }
    finally { process.stdout.write = timedWrite; }
    let timedEnvelope: { result?: { elapsedMs?: number } } | undefined;
    try { timedEnvelope = JSON.parse(timedOut.join("")); } catch { timedEnvelope = undefined; }
    c("clock.checkpoint measures the delay the author asked for (3s, not the 60s default)",
      timed === undefined && timedEnvelope?.result?.elapsedMs === 3000, { timed, timedEnvelope });
    writeFileSync(program, 'await checkpoint("go", "Proceed?", { timeout: "4s", onExpiry: "proceed" });\n');
  }
  for (const text of ['{"turns":{"build":{"status":"blocked"},"build":{"status":"done"}}}',
    String.raw`{"turns":{"build":{"status":"blocked"},"b\u0075ild":{"status":"done"}}}`]) {
    const duplicate = await simulateText(text);
    c("duplicate scripted results name the key and suggest an array", scriptRefusal(duplicate, 'names "build" twice')
      && isCommandFailure(duplicate) && duplicate.remedy?.includes("array") === true, duplicate);
  }
  {
    const shown: string[] = [];
    const write = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => { shown.push(String(chunk)); return true; }) as typeof process.stdout.write;
    const to = { kind: "spawned", agent: "sim.ana", persona: "ana" };
    let handoff: unknown, clock: unknown;
    try {
      writeFileSync(program, 'const builder = await spawn("builder");\nconst ana = await spawn("ana");\nfor (const attempt of [1, 2]) {\n  const result = await turn(builder, { name: "build" });\n  log(result.status, result.to?.agent === ana.agent);\n}\n');
      handoff = await simulate({ turns: { build: [{ status: "blocked" }, { status: "handoff", to, note: "yours" }] } }, { json: true });
      writeFileSync(program, 'await sleep("1ms");\nlog("done");\n');
      clock = await simulate({ clock: { start: 1000 } }, { json: true });
    } finally { process.stdout.write = write; }
    const [turnOut, clockOut] = shown.join("").trim().split("\n").map((line) => JSON.parse(line));
    c("sequential turn results preserve their order and carry the agent handle", handoff === undefined && turnOut.result?.outcome === "completed"
      && JSON.stringify(turnOut.result.log.map((entry: { values: unknown }) => entry.values)) === JSON.stringify([["blocked", false], ["handoff", true]]), { handoff, turnOut });
    c("a finite nonzero clock start still measures elapsed time from that start", clock === undefined && clockOut.result?.elapsedMs === 1, { clock, clockOut });
  }
  writeFileSync(program, 'await checkpoint("go", "Proceed?", { timeout: "4s", onExpiry: "proceed" });\n');
  // A simulation that stops says why and where: a missing entry is the script's gap, named with the
  // entry to add. An expired gate under the default onExpiry is a completed simulation whose program
  // failed with L4007 at that gate.
  const missing = await simulate({});
  c("a script with no result for an effect names the step and the entry to add",
    isCommandFailure(missing) && missing.code === "OPERATION_FAILED" && missing.message.includes('no checkpoints entry for "go" (step /checkpoint:go#0)')
      && (missing.detail().remedy ?? "").includes('{ checkpoints: { "go": <result> } }') && (missing.target as { step?: string } | undefined)?.step === "/checkpoint:go#0"
      && (missing.detail().remedy ?? "").includes(`add it to ${join(dir, "results.json")} and rerun with \`cotal run simulate ${shellPath(program)} --handler ${shellPath(handler)}\``), missing);
  // Without a results file there is nothing to edit: the remedy says to save one and pass it
  // with --handler, instead of only showing the result object.
  const noHandler = await runWorkflow({ values: {}, positionals: ["simulate", program], raw: [] }).then(() => undefined, (e: Error) => e);
  c("a simulation run without a results file is told to save one and pass it with --handler",
    isCommandFailure(noHandler) && noHandler.code === "OPERATION_FAILED"
      && (noHandler.detail().remedy ?? "").includes("save it in a results file, for example results.json")
      && (noHandler.detail().remedy ?? "").includes(`rerun with \`cotal run simulate ${shellPath(program)} --handler results.json\``), noHandler);
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
  writeFileSync(program, `
const items = [1, 2];
const selected = items.filter((item, index, array) => { array[index] = item + 10; return true; });
const first = items.find((item, index, array) => { array[index] = 99; return true; });
const last = items.findLast((item, index, array) => { array[index] = 77; return true; });
log({ items, selected, first, last });
const xs = [1, 2];
const filtered = await filter(xs, async (item, index) => { await 0; xs[index] = item + 10; return true; });
const found = await find(xs, async (item, index) => { await 0; xs[index] = 99; return index === 1; });
log({ xs, filtered, found });
log([].filter(() => true), [].find(() => true) === undefined, [].findLast(() => true) === undefined, await find([], () => true));
`);
  written.length = 0;
  process.stdout.write = ((chunk: string | Uint8Array) => { written.push(String(chunk)); return true; }) as typeof process.stdout.write;
  try { logged = await simulate({}, { json: true }); }
  finally { process.stdout.write = origWrite; }
  try { logEnvelope = JSON.parse(written.join("")) as typeof logEnvelope; } catch { logEnvelope = undefined; }
  c("simulate retains predicate input values for filter, find and findLast, including awaited free builtins",
    logged === undefined && JSON.stringify(logEnvelope?.result?.log) === JSON.stringify([
      { scope: "", values: [{ items: [99, 77], selected: [1, 2], first: 11, last: 12 }] },
      { scope: "", values: [{ xs: [99, 99], filtered: [1, 2], found: 12 }] },
      { scope: "", values: [[], true, true, null] },
    ]), { logged, output: written.join("") });
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

if (process.platform !== "win32") {
  const dir = mkdtempSync(join(tmpdir(), "run-simulate-retry-"));
  try {
    const entry = join(dir, "run-cli.mts");
    writeFileSync(entry, `
      import ${JSON.stringify(new URL("../src/index.ts", import.meta.url).href)};
      import { registry } from ${JSON.stringify(import.meta.resolve("@cotal-ai/core"))};
      import { runCli } from ${JSON.stringify(new URL("../../cli/src/command.ts", import.meta.url).href)};
      await runCli(registry, process.argv.slice(2));
    `);
    const program = "timer file.cotal.js";
    writeFileSync(join(dir, program), 'await sleep("20s");\nawait checkpoint("expiry", "Let this expire", { timeout: "3s", onExpiry: "proceed" });\n');
    const cli = [process.execPath, "--import", import.meta.resolve("tsx"), entry];
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_")));
    Object.assign(env, { HOME: dir, COTAL_HOME: dir, XDG_CONFIG_HOME: join(dir, "config"), COTAL_TELEMETRY: "off", NO_COLOR: "1" });
    const options = { cwd: dir, env, encoding: "utf8", timeout: 30_000 } as const;
    const run = (...args: string[]) => spawnSync(cli[0]!, [...cli.slice(1), "run", ...args], options);
    const dashProgram = "--wibble";
    writeFileSync(join(dir, dashProgram), 'await sleep("1ms", { name: "pause" });\n');
    for (const verb of ["plan", "validate", "simulate"]) {
      const filled = run(verb, `./${dashProgram}`, dashProgram, "--json");
      const empty = run(verb, dashProgram, "--json");
      const retry = run(verb, `./${dashProgram}`, "--json");
      const separated = run(verb, "--json", "--", dashProgram);
      const refusal = JSON.parse(filled.stdout || "{}");
      c(`run ${verb} suggests a separator only when its source slot is open`,
        filled.status === 1 && filled.stderr === "" && refusal.outcome === "refused" && refusal.error?.code === "USAGE_INVALID"
        && refusal.error.message === "Unknown option '--wibble'" && refusal.error.remedy === "drop the unknown option"
        && empty.status === 1 && JSON.parse(empty.stdout || "{}").error?.remedy?.includes("put -- before it")
        && [retry, separated].every((r) => r.status === 0 && r.stderr === "" && JSON.parse(r.stdout).outcome === "ok"),
        { filled, empty, retry, separated });
    }
    const turnProgram = "turn.cotal.js", turnHandler = "malformed.json";
    writeFileSync(join(dir, turnProgram), 'const r = await spawn("reviewer");\nawait turn(r, { name: "review" });\nawait turn(r, { name: "review" });\n');
    writeFileSync(join(dir, turnHandler), '{"turns":{"review":[{"status":"handoff","to":"reviewer"}]}}');
    const plain = run("simulate", turnProgram, "--handler", turnHandler, "--plain");
    const json = run("simulate", turnProgram, "--handler", turnHandler, "--json");
    const refusal = JSON.parse(json.stdout);
    const remedy = `correct turns.review[0].to in ${turnHandler}, then rerun the simulation`;
    c("a malformed scripted handoff names the file and exact destination in plain output and JSON",
      plain.status === 1 && plain.stderr.includes(`in ${turnHandler}: turns.review[0].to must be an agent handle`) &&
      plain.stderr.includes(`\nNext\n  ${remedy}`) && json.status === 1 && refusal.target?.file === turnHandler &&
      refusal.error?.code === "SCHEMA_INVALID" && refusal.error?.remedy === remedy, { plain, json });
    writeFileSync(join(dir, turnHandler), '{"turns":{"review":{"status":"done"}}}');
    const corrected = run("simulate", turnProgram, "--handler", turnHandler, "--plain");
    c("correcting the named file lets the same command complete both turns", corrected.status === 0 &&
      /Program outcome:\s+completed/.test(corrected.stdout) && corrected.stdout.includes("/turn:review#1"), corrected);

    const checkpointProgram = "checkpoint.cotal.js", badTable = "bad-table.json";
    writeFileSync(join(dir, checkpointProgram), 'const approval = await checkpoint("approve", "Proceed with review?", { timeout: "10m" });\nif (approval.status === "resolved" && approval.value === true) {\n  await sleep("1ms", { name: "approved" });\n}\n');
    writeFileSync(join(dir, badTable), '{"checkpoints":[]}');
    const table = run("simulate", checkpointProgram, "--handler", badTable, "--json");
    const tableError = JSON.parse(table.stdout);
    c("a malformed checkpoint table names the file, required shape and correction",
      table.status === 1 && table.stderr === "" && tableError.target?.file === badTable && tableError.error?.code === "SCHEMA_INVALID"
      && tableError.error?.message === `checkpoints in the simulation results script ${badTable} must be an object keyed by checkpoint name, not an array`
      && tableError.error?.remedy === `replace checkpoints in ${badTable} with an object keyed by checkpoint name, then rerun the simulation`, table);
    writeFileSync(join(dir, badTable), '{"checkpoints":{"approve":{"status":"resolved","value":true}}}');
    const validTable = run("simulate", checkpointProgram, "--handler", badTable, "--json");
    const accepted = JSON.parse(validTable.stdout);
    c("a corrected checkpoint table lets the same simulation reach the approved step", validTable.status === 0
      && accepted.result?.outcome === "completed" && accepted.result.effects[1]?.step === "/sleep:approved#0", validTable);

    const timerProgram = "timer.cotal.js", listHandler = "list.json";
    writeFileSync(join(dir, timerProgram), 'await sleep("1s", { name: "timer" });\n');
    writeFileSync(join(dir, listHandler), "[]");
    const arrayJson = run("simulate", timerProgram, "--handler", listHandler, "--json");
    const arrayPlain = run("simulate", timerProgram, "--handler", listHandler, "--plain");
    const arrayError = JSON.parse(arrayJson.stdout);
    const arrayMessage = `the simulation results script ${listHandler} must be a top-level JSON object, not an array`;
    const arrayRemedy = `save a JSON results object in ${listHandler} and rerun the simulation. Use {} if no scripted results are needed`;
    c("a top-level array names the results file, actual shape and fix in JSON and plain output",
      arrayJson.status === 1 && arrayJson.stderr === "" && arrayError.outcome === "refused" && arrayError.target?.file === listHandler
      && arrayError.error?.code === "SCHEMA_INVALID" && arrayError.error?.message === arrayMessage && arrayError.error?.remedy === arrayRemedy
      && arrayPlain.status === 1 && arrayPlain.stdout === "" && arrayPlain.stderr.includes(arrayMessage)
      && arrayPlain.stderr.includes(`\nNext\n  ${arrayRemedy}`), { arrayJson, arrayPlain });
    writeFileSync(join(dir, listHandler), "{}");
    const validObject = run("simulate", timerProgram, "--handler", listHandler, "--json");
    c("an empty object lets the same timer simulation complete", validObject.status === 0
      && validObject.stderr === "" && JSON.parse(validObject.stdout).result?.outcome === "completed", validObject);

    for (const [field, file, invalid, valid, requirement, remedy] of [
      ["start", "bad start.json", "0", 0, "a finite number in milliseconds",
        "set clock.start in ./bad start.json to a JSON integer such as 0 (without quotes), then rerun the simulation"],
      ["wait", "bad clock.json", "one minute", "5m", 'a duration string such as "5m"',
        'replace clock.wait in ./bad clock.json with a quoted duration such as "5m", then rerun the simulation'],
    ] as const) {
      const handler = `./${file}`;
      writeFileSync(join(dir, file), JSON.stringify({ clock: { [field]: invalid } }));
      const plain = run("simulate", timerProgram, "--handler", handler, "--plain");
      const json = run("simulate", timerProgram, "--handler", handler, "--json");
      const refusal = JSON.parse(json.stdout);
      const message = `clock.${field} in the simulation results script ${handler} must be ${requirement}`;
      c(`invalid clock.${field} names the results file and correction in plain output and JSON`,
        plain.status === 1 && plain.stdout === "" && plain.stderr.includes(message) && plain.stderr.includes(`\nNext\n  ${remedy}`)
        && json.status === 1 && json.stderr === "" && refusal.outcome === "refused" && refusal.target?.file === handler
        && refusal.error?.code === "SCHEMA_INVALID" && refusal.error?.message === message && refusal.error?.remedy === remedy, { plain, json });
      writeFileSync(join(dir, file), JSON.stringify({ clock: { [field]: valid } }));
      const corrected = run("simulate", timerProgram, "--handler", handler, "--json");
      const report = JSON.parse(corrected.stdout);
      c(`correcting clock.${field} lets the same simulation complete`, corrected.status === 0
        && corrected.stderr === "" && report.result?.outcome === "completed" && report.result.elapsedMs === 1000, corrected);
    }

    const typoHandler = "typo.json";
    writeFileSync(join(dir, timerProgram), 'await sleep("1ms", { name: "timer" });\n');
    writeFileSync(join(dir, typoHandler), '{"turn":{}}');
    const typoJson = run("simulate", timerProgram, "--handler", typoHandler, "--json");
    const typoPlain = run("simulate", timerProgram, "--handler", typoHandler, "--plain");
    const typoError = JSON.parse(typoJson.stdout);
    const typoMessage = `unknown simulation script field "turn" in the simulation results script ${typoHandler}`;
    const typoRemedy = `replace "turn" in ${typoHandler} with "turns", then rerun the simulation`;
    c("an unknown top-level key names the handler file and its supported replacement",
      typoJson.status === 1 && typoJson.stderr === "" && typoError.outcome === "refused" && typoError.target?.file === typoHandler
      && typoError.error?.code === "SCHEMA_INVALID" && typoError.error?.message === typoMessage && typoError.error?.remedy === typoRemedy
      && typoPlain.status === 1 && typoPlain.stdout === "" && typoPlain.stderr.includes(typoMessage)
      && typoPlain.stderr.includes(`\nNext\n  ${typoRemedy}`), { typoJson, typoPlain });
    writeFileSync(join(dir, typoHandler), '{"turns":{}}');
    const fixedTypo = run("simulate", timerProgram, "--handler", typoHandler, "--json");
    const fixedResult = JSON.parse(fixedTypo.stdout).result;
    c("replacing turn with turns lets the timer simulation complete in 1 ms",
      fixedTypo.status === 0 && fixedTypo.stderr === "" && fixedResult?.outcome === "completed" && fixedResult.elapsedMs === 1, fixedTypo);
    writeFileSync(join(dir, typoHandler), '{"other":{}}');
    const unknownKey = run("simulate", timerProgram, "--handler", typoHandler, "--json");
    c("an unknown key with no suggested replacement lists the supported keys",
      unknownKey.status === 1 && JSON.parse(unknownKey.stdout).error?.remedy ===
        `remove "other" from ${typoHandler} or use a supported top-level key: turns, asks, checkpoints, events, clock, faults`, unknownKey);

    const parallelProgram = "parallel.cotal.js", parallelHandler = "parallel-fault.json";
    writeFileSync(join(dir, parallelProgram), 'await parallel({ first: () => sleep("1s"), second: () => sleep("2s") }, { name: "batch" });\n');
    const step = "/parallel:batch#0";
    writeFileSync(join(dir, parallelHandler), JSON.stringify({ faults: [{ at: step, kind: "error", code: "L4002", message: "simulated batch failure" }] }));
    const parallel = run("simulate", parallelProgram, "--handler", parallelHandler, "--json");
    const report = JSON.parse(parallel.stdout);
    c("a fault at the parallel step completes the simulation with a failed program and no branch effects",
      parallel.status === 0 && parallel.stderr === "" && report.outcome === "ok" && report.result?.outcome === "failed"
      && report.result.failure?.step === step && report.result.failure.code === "L4002" && report.result.failure.title === "simulated batch failure"
      && report.result.elapsedMs === 0 && report.result.effects.length === 1 && report.result.effects[0]?.status === "failed", parallel);

    const colorEnv = Object.assign({}, env, { FORCE_COLOR: "1" });
    delete colorEnv.NO_COLOR;
    for (const handler of [undefined, "timer's $results file.json"]) for (const mode of ["rich", "plain", "json"]) {
      if (handler !== undefined) writeFileSync(join(dir, handler), "{}");
      const retryOptions = mode === "plain" ? { ...options, env: colorEnv } : options;
      const args = ["run", "simulate", program, ...(handler === undefined ? [] : ["--handler", handler]), ...(mode === "rich" ? [] : [`--${mode}`])];
      const missing = spawnSync(cli[0]!, [...cli.slice(1), ...args], retryOptions);
      const jsonMode = mode === "json";
      const failure = jsonMode ? JSON.parse(missing.stdout) : undefined;
      const retry = /rerun with `([^`]+)`/.exec(jsonMode ? failure.error?.remedy ?? "" : missing.stderr ?? "")?.[1];
      writeFileSync(join(dir, handler ?? "results.json"), '{"checkpoints":{"expiry":{"status":"expired"}}}');
      const replayed = retry && /^(?:pnpm )?cotal run simulate /.test(retry)
        ? spawnSync("sh", ["-c", `cotal() { ${cli.map(shellPath).join(" ")} "$@"; }\npnpm() { "$@"; }\n${retry}`], retryOptions)
        : undefined;
      const envelope = jsonMode && retry?.endsWith(" --json") && replayed?.status === 0 ? JSON.parse(replayed.stdout) : undefined;
      c(`the printed simulation retry runs verbatim in ${mode} mode with ${handler === undefined ? "a new handler" : "the existing handler path"}`,
        missing.status === 5 && replayed?.status === 0 && (jsonMode
          ? missing.stderr === "" && failure.error?.code === "OPERATION_FAILED" && failure.error?.cause?.code === "L6001"
            && replayed.stderr === "" && envelope?.outcome === "ok" && envelope.completeness === "complete"
            && envelope.result?.outcome === "completed" && envelope.result.elapsedMs === 23000
          : /Program outcome:\s+completed/.test(replayed.stdout) && /Virtual time:\s+23000 ms/.test(replayed.stdout)
            && (mode !== "plain" || (retry?.endsWith(" --plain") === true && missing.stdout === "" && !missing.stderr.includes("\x1b")
              && replayed.stderr === "" && !replayed.stdout.includes("\x1b")))), { missing, replayed });
    }
    for (const [empty, named] of [["--admit-read", "--admit-publish"], ["--admit-publish", "--admit-read"]]) {
      const refused = run("start", program, "--local", "--server", "nats://127.0.0.1:1", empty!, " , , ", named!, "none");
      c(`the CLI refuses a separator-only ${empty} as missing before contacting the broker`, refused.status === 1
        && refused.stderr.includes(`run start --local requires ${empty} <channels>`)
        && refused.stderr.includes(`pass ${empty} <channels> (comma-separated channel patterns, or \`none\`)`), refused);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// Handler bytes must reach the simulated program unchanged, just as source bytes do. Reject
// malformed UTF-8 before parsing JSON, but accept Unicode and an intentionally encoded U+FFFD.
{
  const dir = mkdtempSync(join(tmpdir(), "run-handler-bytes-"));
  const program = join(dir, "p.cotal.js"), handler = join(dir, "results.json");
  writeFileSync(program, 'const answer = await checkpoint("go", "Proceed?");\nlog(answer.value);\n');
  const prefix = Buffer.from('{"checkpoints":{"go":{"status":"resolved","value":"');
  const suffix = Buffer.from('","by":"ana"}}}');
  const simulateBytes = async (bytes: Buffer, mode: Record<string, string | boolean> = {}) => {
    writeFileSync(handler, bytes);
    const out: string[] = [];
    const write = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => { out.push(String(chunk)); return true; }) as typeof process.stdout.write;
    try {
      const error = await runWorkflow({ values: { handler, ...mode }, positionals: ["simulate", program], raw: [] }).then(() => undefined, (e: Error) => e);
      return { error, out: out.join("") };
    } finally { process.stdout.write = write; }
  };
  const malformed: [string, number[]][] = [
    ["Latin-1", [0xe9]], ["truncated sequence", [0xf0, 0x9f, 0x98]],
    ["overlong sequence", [0xc0, 0xaf]], ["surrogate", [0xed, 0xa0, 0x80]],
    ["out-of-range code point", [0xf4, 0x90, 0x80, 0x80]],
  ];
  const modes: Record<string, string | boolean>[] = [{}, { plain: true }, { json: true }];
  for (const [name, bytes] of malformed) for (const mode of modes) {
    const { error, out } = await simulateBytes(Buffer.concat([prefix, Buffer.from(bytes), suffix]), mode);
    c(`simulate refuses ${name} handler bytes before output in ${JSON.stringify(mode)}`,
      isCommandFailure(error) && error.outcome === "refused" && error.code === "SCHEMA_INVALID"
      && exitCode(error.outcome, error.code) === 1 && error.message.includes("simulation results script is not valid UTF-8")
      && (error.target as { file?: string })?.file === handler && error.remedy === `save ${handler} as UTF-8 text`
      && out === "", { error, out });
  }
  const value = "café 😀 � \ufeff";
  const valid = await simulateBytes(Buffer.concat([prefix, Buffer.from(value), suffix]), { json: true });
  const envelope = JSON.parse(valid.out) as { result?: { outcome?: string; log?: unknown } };
  c("simulate preserves multibyte UTF-8 and an intentional U+FFFD in handler results",
    valid.error === undefined && envelope.result?.outcome === "completed"
    && JSON.stringify(envelope.result.log) === JSON.stringify([{ scope: "", values: [value] }]), valid);
  // A leading encoding signature is accepted, but a U+FEFF inside a result stays data.
  const bom = await simulateBytes(Buffer.concat([Buffer.from('\ufeff'), prefix, Buffer.from(value), suffix]), { json: true });
  c("simulate accepts a leading UTF-8 BOM and preserves U+FEFF inside a result",
    bom.error === undefined && JSON.stringify(JSON.parse(bom.out).result.log) === JSON.stringify([{ scope: "", values: [value] }]), bom);
  for (const [name, bytes] of [["invalid JSON", Buffer.from("{")], ["empty file", Buffer.alloc(0)]] as const) for (const mode of modes) {
    const { error, out } = await simulateBytes(bytes, mode);
    c(`simulate refuses ${name} naming the results file and a next step in ${JSON.stringify(mode)}`,
      isCommandFailure(error) && error.code === "SCHEMA_INVALID"
      && error.message.includes(handler) && error.message.includes(name === "empty file" ? "is empty" : "is not valid JSON")
      && (error.target as { file?: string })?.file === handler && error.remedy?.includes(handler) === true && out === "", { error, out });
  }
  rmSync(dir, { recursive: true, force: true });
}

// Reading --handler uses the same regular-file gate as reading the program, before JSON parsing.
{
  const dir = mkdtempSync(join(tmpdir(), "run-handler-files-"));
  const program = join(dir, "p.cotal.js");
  writeFileSync(program, 'log("ready");\n');
  const cases = [[join(dir, "missing.json"), "TARGET_NOT_FOUND", "does not exist"],
    [dir, "USAGE_INVALID", "is a directory"]];
  if (process.platform !== "win32") {
    const dangling = join(dir, "dangling.json"), unreadable = join(dir, "unreadable.json");
    symlinkSync(join(dir, "absent.json"), dangling);
    cases.push([dangling, "TARGET_NOT_FOUND", "is a link whose target does not exist"]);
    if (process.getuid?.() !== 0) {
      writeFileSync(unreadable, "{}");
      chmodSync(unreadable, 0);
      cases.push([unreadable, "PERMISSION_DENIED", "is not readable"]);
    }
  }
  try {
    for (const [handler, code, cause] of cases) for (const mode of [{}, { plain: true }, { json: true }]) {
      const got = await runWorkflow({ values: { handler, ...mode }, positionals: ["simulate", program], raw: [] }).then(() => undefined, (e: Error) => e);
      c(`simulate refuses ${cause} results as ${code} in ${JSON.stringify(mode)}`,
        isCommandFailure(got) && got.outcome === "refused" && got.code === code
        && exitCode(got.outcome, got.code) === (code === "USAGE_INVALID" ? 1 : 2)
        && got.message.includes(handler) && got.message.includes(cause)
        && (got.target as { file?: string })?.file === handler && !!got.remedy, got);
    }
    if (process.platform !== "win32") {
      const handler = join(dir, "good.json"), linked = join(dir, "linked.json"), fifo = join(dir, "pipe.json");
      writeFileSync(handler, "{}");
      symlinkSync(handler, linked);
      const write = process.stdout.write;
      process.stdout.write = (() => true) as typeof process.stdout.write;
      let got: unknown;
      try { got = await runWorkflow({ values: { handler: linked, json: true }, positionals: ["simulate", program], raw: [] }).then(() => undefined, (e: Error) => e); }
      finally { process.stdout.write = write; }
      c("simulate accepts a symlink to a regular results file", got === undefined, got);
      const made = spawnSync("mkfifo", [fifo], { encoding: "utf8" });
      if (made.error) throw made.error;
      if (made.status !== 0) throw new Error(`mkfifo failed: ${made.stderr}`);
      const child = `import { runWorkflow } from ${JSON.stringify(new URL("../src/index.ts", import.meta.url).href)};
        try { await runWorkflow({ values: { handler: process.argv[2] }, positionals: ["simulate", process.argv[1]], raw: [] }); }
        catch (e) { console.error(e.code + ": " + e.message); process.exitCode = 1; }`;
      for (const [file, kind] of [[fifo, "a FIFO (named pipe)"], ["/dev/null", "a character device"]]) {
        const refused = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", child, program, file], { encoding: "utf8", timeout: 10_000 });
        c(`simulate promptly refuses ${kind} results without reading them`,
          !refused.error && refused.signal === null && refused.status === 1
          && refused.stderr.includes("USAGE_INVALID:") && refused.stderr.includes(file) && refused.stderr.includes(`is ${kind}`), refused);
      }
    }
  } finally {
    const unreadable = join(dir, "unreadable.json");
    if (cases.some(([file]) => file === unreadable)) chmodSync(unreadable, 0o600);
    rmSync(dir, { recursive: true, force: true });
  }
}

// An in-process caller can capture an invalid workflow's complete JSON refusal through stdout.write.
{
  const dir = mkdtempSync(join(tmpdir(), "run-invalid-workflow-"));
  const program = join(dir, "invalid.cotal.js");
  writeFileSync(program, "const = ;\n");
  const chunks: string[] = [];
  const write = process.stdout.write, previousExit = process.exitCode;
  process.stdout.write = ((chunk: string) => { chunks.push(chunk); return true; }) as typeof process.stdout.write;
  let status: typeof process.exitCode;
  try {
    await runWorkflow({ values: { json: true }, positionals: ["validate", program], raw: [] });
    status = process.exitCode;
  } finally {
    process.stdout.write = write;
    process.exitCode = previousExit;
    rmSync(dir, { recursive: true, force: true });
  }
  const receipt = JSON.parse(chunks.join("") || "null");
  c("a validation refusal reaches an in-process stdout.write capture with its findings and exit 1",
    status === 1 && receipt?.outcome === "refused" && receipt.error.code === "SCHEMA_INVALID"
    && receipt.result.problems[0].code === "L1008" && receipt.result.problems[0].span.column === 7, receipt);
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

// A simulation that fails after validation keeps the validation warning: the failure still
// exits 5 as OPERATION_FAILED, and the warning is printed with the failure instead of lost.
{
  const dir = mkdtempSync(join(tmpdir(), "run-simulate-warning-"));
  const program = join(dir, "warning-fail.js");
  const handler = join(dir, "results.json");
  writeFileSync(program, 'if (false) {\n  await fanOut(["x", "y"], (x) => sleep("1s", { name: "nap" }), { name: "fo" });\n}\nthrow "boom";\n');
  writeFileSync(handler, "{}\n");
  const err: string[] = [];
  const write = process.stderr.write;
  process.stderr.write = ((chunk: unknown) => { err.push(String(chunk)); return true; }) as typeof process.stderr.write;
  let got: unknown;
  // The kernel runs a command inside its operation scope, where recorded warnings live; the
  // direct call below does the same so the failure carries what the kernel would carry.
  try { got = await runOperation({}, () => runWorkflow({ values: { handler }, positionals: ["simulate", program], raw: [] })).then(() => undefined, (e: Error) => e); }
  finally { process.stderr.write = write; }
  const said = err.join(" ").replace(/\s+/g, " ");
  c("a failed simulation keeps its validation warning on stderr",
    isCommandFailure(got) && got.outcome === "failed" && got.code === "OPERATION_FAILED" && exitCode(got.outcome, got.code) === 5
    && said.includes("L3021") && said.includes("has no stable key"), { got, said });
  rmSync(dir, { recursive: true, force: true });
}

// Validation is offline, so its scope line names the broker's message limit among what it did not
// check: a valid program over that limit is still refused by a hosted start.
{
  const dir = mkdtempSync(join(tmpdir(), "run-validate-scope-"));
  const program = join(dir, "ok.cotal.js");
  writeFileSync(program, 'log("hi");\n');
  const out: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => { out.push(a.map(String).join(" ")); };
  try { await runWorkflow({ values: { plain: true }, positionals: ["validate", program], raw: [] }); } finally { console.log = log; }
  c("validate says it checked no broker message limit", out.join("\n").includes("No mesh, authority, runtime, application or broker message limit was checked."), out);
  rmSync(dir, { recursive: true, force: true });
}

// Plans use the parser's line breaks in both formats, including in a file with mixed endings.
{
  const dir = mkdtempSync(join(tmpdir(), "run-plan-lines-"));
  const program = join(dir, "mixed.cotal.js");
  const text: string[] = [], json: string[] = [];
  const log = console.log, write = process.stdout.write;
  try {
    writeFileSync(program, 'log(1)\rlog(2)\r\nlog(3)\nlog(4)\u2028log(5)\u2029log(6); log(7)\nconst numbers = [1, 2]\nconst fn = "join"\nlog(numbers[fn]("-"), numbers.join("-"))');
    console.log = (...args: unknown[]) => { text.push(args.map(String).join(" ")); };
    process.stdout.write = ((chunk: string | Uint8Array) => { json.push(String(chunk)); return true; }) as typeof process.stdout.write;
    await runWorkflow({ values: { plain: true }, positionals: ["plan", program], raw: [] });
    await runWorkflow({ values: { json: true }, positionals: ["plan", program], raw: [] });
  } finally {
    console.log = log;
    process.stdout.write = write;
    rmSync(dir, { recursive: true, force: true });
  }
  const expected = [1, 2, 3, 4, 5, 6, 6, 9];
  const textPlan = text.join("\n");
  const rows = Array.from(textPlan.matchAll(/^[ \t]*(\d+)[ \t]+log[ \t]*$/gm), (match) => Number(match[1]));
  const envelope = JSON.parse(json.join("")) as { outcome: string; result: { calls: unknown } };
  c("plan text counts each JavaScript line break once", rows.join() === expected.join(), rows);
  c("plan text distinguishes computed access from a named method", textPlan.includes("derived call")
    && textPlan.includes("numbers.join") && !textPlan.includes("numbers.fn"), textPlan);
  c("plan JSON keeps line numbers and distinguishes computed access from a named method", envelope.outcome === "ok"
    && JSON.stringify(envelope.result.calls) === JSON.stringify([...expected.map((line) => ({ call: "log", line })),
      { call: "derived call", line: 9 }, { call: "numbers.join", line: 9 }]), envelope);
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
  const program = join(dir, "ok.cotal.js");
  const source = "const answer = 1;\n";
  writeFileSync(program, source);
  symlinkSync(program, join(dir, "linked.cotal.js"));
  c("regular workflow sources and symlinks to them keep their text", sourceOf(program) === source && sourceOf(join(dir, "linked.cotal.js")) === source);
  if (process.platform !== "win32") {
    for (const verb of ["start", "validate", "plan", "simulate"]) {
      const got = await runWorkflow({ values: {}, positionals: [verb, "/dev/null"], raw: [] }).then(() => undefined, (e: Error) => e);
      c(`run ${verb} refuses a character device without suggesting writing into it`,
        usageRefusal(got, "is a character device") && isCommandFailure(got)
        && got.remedy === "save the program in a regular file and use that path instead", got);
    }
    const fifo = join(dir, "pipe.cotal.js");
    const made = spawnSync("mkfifo", [fifo], { encoding: "utf8" });
    if (made.error) throw made.error;
    if (made.status !== 0) throw new Error(`mkfifo failed: ${made.stderr}`);
    symlinkSync(fifo, join(dir, "linked-pipe.cotal.js"));
    // A separate process bounds the regression: the old synchronous read blocks this event loop.
    const child = `import { runWorkflow } from ${JSON.stringify(new URL("../src/index.ts", import.meta.url).href)};
      try { await runWorkflow({ values: {}, positionals: process.argv.slice(1), raw: [] }); }
      catch (e) { console.error(e.code + ": " + e.message); process.exitCode = 1; }`;
    const refusedPipe = (label: string, path: string, verb: string) => {
      const got = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", child, verb, path], { encoding: "utf8", timeout: 10_000 });
      c(`${label}: run ${verb} promptly refuses a FIFO naming its kind`,
        !got.error && got.signal === null && got.status === 1 && got.stderr.includes("USAGE_INVALID:")
        && got.stderr.includes(path) && got.stderr.includes("is a FIFO (named pipe)"), got);
    };
    for (const verb of ["validate", "start"]) refusedPipe("no writer", fifo, verb);
    refusedPipe("symlink, no writer", join(dir, "linked-pipe.cotal.js"), "validate");
    const writer = openSync(fifo, constants.O_RDWR | constants.O_NONBLOCK);
    try {
      writeFileSync(writer, source);
      refusedPipe("writer with readable data", fifo, "validate");
    } finally { closeSync(writer); }
  }
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
  for (const ids of [["run-0"], [], ["bad/id"], ["one", "two"]]) {
    const got = gate(["journal", ...ids], { limit: "5", json: true });
    c("run journal resolves --limit with --json before suggesting an ID retry", isCommandFailure(got) && usageRefusal(got, "--json returns the whole journal") && got.remedy === "omit --json for a limited text view, or omit --limit for the full JSON journal", got);
  }
  const cursor = gate(["show", "run-0"], { cursor: "AAAAAAAA", limit: "1" });
  c("run show refuses an inventory cursor even with a journal limit", isCommandFailure(cursor) && cursor.code === "USAGE_INVALID" && cursor.remedy?.includes("remove --cursor") === true, cursor);
  c("run ps --limit without --page is still refused", usageRefusal(gate(["ps"], { limit: "5" }), "diagnostic paging requires run --page"));
  const pagePins: Record<string, string>[] = [{}, { on: "short" }];
  for (const pin of pagePins) {
    const page = gate(["list"], { page: true, limit: "3", json: true, space: "other", server: "nats://127.0.0.1:4223", ...pin });
    c("a missing or malformed page pin offers the roster for its target and output mode", isCommandFailure(page) && page.code === "USAGE_INVALID" &&
      page.remedy?.includes("`cotal ps --space other --server 'nats://127.0.0.1:4223' --json`") === true && page.remedy.includes("all other options unchanged"), page);
  }
  const privateTargets: Record<string, string>[] = [{ creds: "private-caller.creds" }, { server: "nats://sample:private-token@localhost:4222" }];
  for (const privateTarget of privateTargets) {
    const page = gate(["list"], { page: true, ...privateTarget });
    c("page pin advice does not expose private target values or substitute an unscoped roster", isCommandFailure(page) &&
      !!page.remedy && page.remedy.includes("same space, broker and caller") && !/private-|cotal ps/.test(page.remedy), page);
  }
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
  // A released status records no reason or execution host. A local read may still inspect a hosted run.
  const inState = (state: "released" | "running", local = false): string => {
    const out: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => { out.push(a.map(String).join(" ")); };
    try { printRunDetail("usage", { ...view, journal: [], status: { state } as RunStatusView["status"] }, { plain: true, local }); } finally { console.log = origLog; process.exitCode = 0; }
    return out.join("\n");
  };
  const released = inState("released"), running = inState("running");
  c("a released run names missing reason and conditional evidence without guessing a local manager",
    /Recorded state:\s+released/.test(released) && released.includes("its status does not record why") && released.includes("executing manager's log") && released.includes("driving process's output") && !released.includes("cotal service logs stack-manager"), released);
  const localRead = inState("released", true);
  c("a local journal read does not establish where its run was driven", localRead.includes("For a hosted run") && localRead.includes("For a locally driven run") && !localRead.includes("cotal service logs stack-manager"), localRead);
  c("a running run names neither", !running.includes("does not record why") && !running.includes("cotal service logs stack-manager"), running);
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
  const notFound = () => new CommandFailure("refused", "TARGET_NOT_FOUND", "the run has no open checkpoint at frage", { remedy: "read the run's open requests with `cotal run show run-1`" });
  const row = (step: string, state: string, asks?: string) => ({ kind: "step", step, state, ...(asks ? { asks } : {}) });
  const view = (...journal: object[]) => async () => ({ journal }) as unknown as RunStatusView;
  const one = await withMatchingKeys(notFound(), "run-1", "frage", {}, view(row("/checkpoint:frage#0", "pending", "Proceed?"), row("/checkpoint:done#0", "pending", "Done?")));
  c("an answer to a checkpoint's name names its open key and the command, with the code and message kept",
    one instanceof CommandFailure && one.code === "TARGET_NOT_FOUND" && one.message === "the run has no open checkpoint at frage"
    && one.remedy === "the open request '/checkpoint:frage#0' matches; answer it with `cotal run answer run-1 '/checkpoint:frage#0'`", one);
  const pinned = await withMatchingKeys(notFound(), "run-1", "frage", { on: "mgr-1" }, view(row("/checkpoint:frage#0", "pending", "Proceed?")));
  c("the suggested command keeps an explicit --on", pinned instanceof CommandFailure && pinned.remedy?.endsWith(" --on mgr-1`") === true, pinned);
  const privateServer = await withMatchingKeys(notFound(), "run-1", "frage", { server: "wss://broker.example/ws?token=private" }, view(row("/checkpoint:frage#0", "pending", "Proceed?")));
  c("a retry does not print a private broker URL", privateServer instanceof CommandFailure && privateServer.remedy === "the open request '/checkpoint:frage#0' matches; replace the step in the original command with '/checkpoint:frage#0'", privateServer);
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
  for (const amend of [false, true]) {
    const missing = managerRefusal("run-answer", "beta", { runId: "run-missing", amend }, { code: "not-found", message: "run run-missing: no run is recorded under that id" }, { on: "mgr-1" });
    c(`a missing run on ${amend ? "amend" : "answer"} lists the same space and manager`, missing.remedy === "list the recorded runs with `cotal run --space beta --on mgr-1`", missing);
    const step = managerRefusal("run-answer", "beta", { runId: "run-1", endpoint: "other", amend }, { code: "not-found", message: "no step is recorded under that key" }, { on: "mgr-1" });
    c(`a missing step on ${amend ? "amend" : "answer"} reads the run on the same target`, step.remedy === `read the run's ${amend ? "answers" : "open requests"} with \`cotal run show run-1 --space beta --on mgr-1 --endpoint other\``, step);
  }
  c("a resume of a completed run is LIFECYCLE_BLOCKED with the manager's sentence, and Next reads the run", blocked.code === "LIFECYCLE_BLOCKED" && blocked.message === finished.message && blocked.remedy === "read the run's recorded state with `cotal run show run-1 --space s`", blocked);
  const notFound = { code: "not-found", message: "run run-1: no record on endpoint manager" };
  const missing = managerRefusal("run-status", "beta", { runId: "run-1" }, notFound, { on: "mgr-1", endpoint: "manager", server: "nats://127.0.0.1:4321", json: true });
  const selection = "--space beta --server 'nats://127.0.0.1:4321' --endpoint manager --on mgr-1 --json";
  c("a hosted missing journal lists and reads on the selected broker and manager in JSON", missing.code === "TARGET_NOT_FOUND" && missing.remedy === `\`cotal run ${selection}\` lists the runs; run \`cotal run show <run-id> ${selection}\``, missing);
  c("the Next keeps an explicit --on", managerRefusal("run-resume", "s", { runId: "run-1" }, finished, { on: "mgr-1" }).remedy === "read the run's recorded state with `cotal run show run-1 --space s --on mgr-1`");
  c("a start refused as a precondition gets no run show Next", managerRefusal("run-start", "s", { source: "log(1)" }, { code: "failed-precondition", message: "no" }).remedy === undefined);
  const unknown = { code: "not-found", message: "run unknown-workflow-id: no record on endpoint manager; a run that was never started cannot be resumed" };
  const hostedList = managerRefusal("run-resume", "project", { runId: "unknown-workflow-id" }, unknown, { server: "nats://127.0.0.1:37200", json: true });
  c("an unknown hosted run lists the same broker in the caller's output format",
    hostedList.remedy === "list the recorded runs with `cotal run --space project --server 'nats://127.0.0.1:37200' --json`", hostedList);
  const bare = managerRefusal("run-resume", "s", { runId: "run-1" }, { code: "not-found", message: "run run-1: no record on endpoint manager" });
  c("with no broker or format given the list Next names the space alone", bare.remedy === "list the recorded runs with `cotal run --space s`", bare);
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
