/**
 * The claude connector must REFUSE a model it cannot serve, rather than pass it through and start a
 * session on a different one. No `claude` binary, no model call - this drives `buildLaunch` and
 * reads the argv it renders.
 *
 * WHY THIS EXISTS. `model:` on an agent file is honoured by the opencode connector and was a dead
 * letter here. Two review seats ran for hours as `claude --model xai/grok-4.6` - a model `claude`
 * cannot serve - and did not fail closed. They came up on a Claude model while every observable
 * signal said grok: the agent file said grok, `COTAL_MODEL` in their environment said grok, and
 * their operator reported two-vendor corroboration that did not exist. Only the process argv
 * disagreed, and nothing inside the session could see it.
 *
 * SO THE PROPERTY UNDER TEST IS NOT "the right model runs". It is that a model this connector
 * cannot serve stops the launch instead of silently relabelling the seat. A wrong model that
 * crashes costs one spawn; a wrong model that answers costs every conclusion drawn from it, and
 * costs them retroactively.
 *
 * THE ACCEPTANCE CELLS ARE THE LOAD-BEARING ONES. A guard that refuses everything would satisfy
 * every refusal cell here and break the connector completely, so the plain-name and `arn:` cases
 * are what stop this suite from grading a rule that cannot pass.
 *
 * Run: pnpm smoke:claude-launch-model
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeConnector } from "../src/extension.js";
import { createSuite } from "@cotal-ai/smoke-kit";

const { check, finish, passed, failed } = createSuite();
// Each launch makes its private directories under the temp dir, and nothing here starts a child to
// remove them, so they go in a scratch temp dir this suite removes.
const scratch = mkdtempSync(join(tmpdir(), "claude-launch-model-"));
process.env.TMPDIR = scratch;

const launch = (extra: Record<string, unknown>) =>
  claudeConnector.buildLaunch({ space: "s", name: "seat", events: false, ...extra } as never);

/** The refusal must be the MODEL refusal, not any error the launch happens to throw. */
const refusalFor = (extra: Record<string, unknown>): string | null => {
  try {
    launch(extra);
    return null;
  } catch (e) {
    return String((e as Error).message);
  }
};

console.log("claude connector: a model it cannot serve must stop the launch");

// ---- an initial prompt is delivered trimmed as the leading positional, or refused when empty ------
{
  const spec = launch({ prompt: "  greet the operator  " });
  check("prompt is claude's leading positional, trimmed, after one space", spec.args[0] === " greet the operator", spec.args[0]);
  const msg = refusalFor({ prompt: "   " });
  check("an empty prompt refuses the launch", msg !== null && /empty/.test(msg), msg);
  check("no prompt, no positional", launch({}).args[0] === "--dangerously-load-development-channels");
}

// ---- REFUSED: provider-prefixed specifiers belonging to another runtime -------------------------
for (const model of ["xai/grok-4.6", "openai/gpt-5.6-sol-fast", "google/gemini-2.5-pro"]) {
  const msg = refusalFor({ model });
  check(`--model ${model} is refused at launch`, msg !== null && /cannot serve model/.test(msg), msg);
  // A refusal that does not name the working route leaves the operator to guess it.
  check(`the ${model} refusal points at the connector that can serve it`, !!msg && /opencode/.test(msg), msg);
}

// ---- THE AGENT FILE, which is the route that actually bit ----------------------------------------
// The seats in the incident carried `model:` in frontmatter, not on the spawn call. The launcher
// resolves that `model:` into the explicit option refused above; the connector never reads it from
// the file, so a file model reaches neither the guard nor argv by any other route.
const dir = mkdtempSync(join(tmpdir(), "cotal-launch-model-"));
const agentFile = join(dir, "seat.md");
writeFileSync(agentFile, `---\nname: seat\nmodel: xai/grok-4.6\n---\n`);
const viaFile = launch({ configPath: agentFile }) as { args: string[] };
check("an AGENT FILE model is not rendered by the connector", !viaFile.args.includes("--model"), viaFile.args);

// ---- ACCEPTED: the controls. Without these, a guard that refuses everything grades green. -------
for (const model of ["opus", "sonnet", "claude-opus-5"]) {
  const msg = refusalFor({ model });
  check(`--model ${model} still launches - the guard does not refuse Claude models`, msg === null, msg);
  if (msg === null) {
    const spec = launch({ model }) as { args: string[]; env: Record<string, string> };
    const i = spec.args.indexOf("--model");
    check(`--model ${model} is rendered into argv`, i >= 0 && spec.args[i + 1] === model, spec.args);
    check(`COTAL_MODEL is set to ${model} for the session`, spec.env.COTAL_MODEL === model, spec.env.COTAL_MODEL);
  }
}

for (const model of ["claude-opus-5-5", undefined]) {
  const override = "gpt-6.2-sol";
  const spec = launch({ model, launchOptions: { model: override, print: "" } });
  const models = spec.args.flatMap((arg, i) => arg === "--model" ? [spec.args[i + 1]] : []);
  check(model ? "a native model replaces the launch pin" : "a native model works without a launch pin",
    models.length === 1 && models[0] === override && spec.env?.COTAL_MODEL === override && spec.args.includes("--print"), spec);
}

// A Bedrock inference-profile ARN legitimately carries a slash and `claude` does serve it, so the
// exemption has to be exercised. An exemption no cell enters is an exemption nobody knows is broken.
const arn = "arn:aws:bedrock:us-east-1:1234:inference-profile/us.anthropic.claude-opus-5";
check(`an arn: model carrying a slash is NOT refused`, refusalFor({ model: arn }) === null);

// ---- The environment must not disagree with reality on a refusal -------------------------------
// `COTAL_MODEL` is what an operator greps to find out what a seat is running; it is the signal that
// lied throughout the incident. A refused launch must produce no session at all rather than a
// half-built one carrying that label.
check(
  "a refused launch yields no LaunchSpec, so nothing carries COTAL_MODEL for a model that never ran",
  refusalFor({ model: "xai/grok-4.6" }) !== null,
);

// ---- EFFORT: the variant is claude's `--effort` level ------------------------------------------
// claude 2.1.330 warns and runs at its default effort when `--effort` names a level it does not
// know, so an unknown level has to stop the launch here or the seat runs on a level nobody chose.
check("the connector declares model variant support", claudeConnector.supportsModelVariant === true);
for (const variant of ["low", "medium", "high", "xhigh", "max"]) {
  const msg = refusalFor({ model: "opus", variant });
  const spec = msg === null ? (launch({ model: "opus", variant }) as { args: string[]; env: Record<string, string> }) : undefined;
  const at = spec?.args.indexOf("--effort") ?? -1;
  check(`variant ${variant} renders --effort ${variant} and labels the seat with it`, at >= 0 && spec?.args[at + 1] === variant && spec?.env.COTAL_VARIANT === variant, msg ?? spec?.args);
}
for (const variant of ["extreme", "minimal", "HIGH"]) {
  for (const validateOnly of [false, true]) {
    const msg = refusalFor({ model: "opus", variant, validateOnly });
    check(`variant ${variant} is refused${validateOnly ? " by launch validation" : ""}, naming the levels claude accepts`, msg !== null && msg.includes(`"${variant}"`) && msg.includes("low, medium, high, xhigh, max"), msg);
  }
}
{
  const spec = launch({ model: "opus" }) as { args: string[]; env: Record<string, string> };
  check("no variant renders no --effort and no label", !spec.args.includes("--effort") && spec.env.COTAL_VARIANT === undefined, spec.args);
  const passed = launch({ model: "opus", variant: "high", launchOptions: { effort: "low" } }) as { args: string[]; env: Record<string, string> };
  const efforts = passed.args.flatMap((a, i) => (a === "--effort" ? [passed.args[i + 1]] : []));
  check(
    "an explicit --opt effort wins over the variant, and the seat is not labelled with the variant it did not run",
    JSON.stringify(efforts) === JSON.stringify(["low"]) && passed.env.COTAL_VARIANT === undefined,
    { efforts, label: passed.env.COTAL_VARIANT },
  );
}

// ---- MODES: fast and ultracode are claude settings, rendered in its one `--settings` flag ---------
// claude keeps only the last `--settings` it is given, and reads `--effort ultracode` as xhigh plus
// ultracode that a later `--effort` cancels (measured on 2.1.332), so modes ride one settings flag.
{
  const flagValues = (args: string[], flag: string) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));
  check("the connector declares mode support", claudeConnector.supportsModes === true);
  const uc = launch({ model: "opus", variant: "high", modes: { ultracode: true } }) as { args: string[] };
  check(
    "ultracode renders one --settings turning it on, beside the variant's --effort, and never as an effort",
    JSON.stringify(flagValues(uc.args, "--settings")) === JSON.stringify(['{"ultracode":true}']) && JSON.stringify(flagValues(uc.args, "--effort")) === JSON.stringify(["high"]),
    uc.args,
  );
  const both = launch({ model: "opus", modes: { fast: false, ultracode: true } }) as { args: string[] };
  const rendered = flagValues(both.args, "--settings");
  check(
    "two modes render in one --settings, and a mode turned off is written as false",
    rendered.length === 1 && JSON.stringify(JSON.parse(rendered[0]!)) === JSON.stringify({ fastMode: false, ultracode: true }),
    both.args,
  );
  check("no modes, or none chosen, render no --settings", !(launch({ model: "opus" }) as { args: string[] }).args.includes("--settings") && !(launch({ model: "opus", modes: {} }) as { args: string[] }).args.includes("--settings"));
  for (const validateOnly of [false, true]) {
    const msg = refusalFor({ model: "opus", modes: { fast: true }, launchOptions: { settings: '{"theme":"dark"}' }, validateOnly });
    check(`modes with --opt settings= are refused${validateOnly ? " by launch validation" : ""}, since claude would drop one of them`, msg !== null && /--opt settings=/.test(msg), msg);
  }
  // reasoningEvents sets claude's thinking summaries, a setting too, so it joins the modes' one flag.
  const reasoning = launch({ model: "opus", modes: { fast: true, ultracode: false }, reasoningEvents: true }) as { args: string[] };
  const joined = flagValues(reasoning.args, "--settings");
  check(
    "a mode with reasoningEvents renders one --settings carrying the modes and the thinking summaries",
    joined.length === 1 && JSON.stringify(JSON.parse(joined[0]!)) === JSON.stringify({ showThinkingSummaries: true, fastMode: true, ultracode: false }),
    reasoning.args,
  );
  const doubled = refusalFor({ model: "opus", modes: { ultracode: true }, reasoningEvents: true, launchOptions: { settings: "{}" } });
  check("a mode and reasoningEvents with --opt settings= are refused, naming both", doubled !== null && /reasoningEvents and the modes/.test(doubled) && /--opt settings=/.test(doubled), doubled);
  const raw = launch({ model: "opus", launchOptions: { settings: '{"theme":"dark"}' } }) as { args: string[] };
  check("--opt settings= without modes still passes through as written", JSON.stringify(flagValues(raw.args, "--settings")) === JSON.stringify(['{"theme":"dark"}']), raw.args);
  const unknown = refusalFor({ model: "opus", modes: { turbo: true } });
  check("a mode claude does not have is refused, naming the ones it has", unknown !== null && unknown.includes('"turbo"') && /fast and ultracode/.test(unknown), unknown);
  const choice = refusalFor({ model: "opus", modes: { fast: "on" } });
  check("a toggle given anything but true or false is refused", choice !== null && /true or false/.test(choice), choice);
}

// ---- The cell count itself, because three cells above are conditional ------------------------
// The argv and COTAL_MODEL checks only run when the launch was accepted, so a regression that makes
// the guard refuse EVERYTHING does not fail them - it DELETES them. Six assertions stop existing
// and the run still prints a summary line. This was measured, not imagined: a mutation predicted to
// kill ten cells killed four, and the missing six had silently vanished.
//
// A count is the only thing that sees a cell that is not there. It is a real assertion and it is
// allowed to fail on a legitimate edit: change the cases above and change this number deliberately.
const EXPECTED = 48;
check(
  `every cell ran - ${EXPECTED} expected, a conditional cell that vanishes is invisible without this`,
  passed() + failed() === EXPECTED, // counted BEFORE this check lands, so it counts the cells above it
  `${passed() + failed()} cells reported`,
);

console.log(`SUITE COMPLETE: ${passed()} passed, ${failed()} failed`);
rmSync(scratch, { recursive: true, force: true });
finish();
process.exit(failed() === 0 ? 0 : 1);
