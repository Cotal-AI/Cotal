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
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeConnector } from "../src/extension.js";
import { createSuite } from "@cotal-ai/smoke-kit";

const { check, finish, passed, failed } = createSuite();

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

// ---- A variant is a Claude effort level, rendered as --effort ---------------------------------------
{
  const spec = launch({ model: "sonnet", variant: "high" }) as { args: string[]; env: Record<string, string> };
  const i = spec.args.indexOf("--effort");
  check("a variant is rendered as --effort <level>", i >= 0 && spec.args[i + 1] === "high", spec.args);
  check("COTAL_VARIANT names the effort level for the session", spec.env.COTAL_VARIANT === "high", spec.env.COTAL_VARIANT);
  const plain = launch({ model: "sonnet" }) as { args: string[]; env: Record<string, string> };
  check("no variant, no --effort and no COTAL_VARIANT", !plain.args.includes("--effort") && plain.env.COTAL_VARIANT === undefined, plain.args);
  const unknown = refusalFor({ variant: "turbo" });
  check("a variant that is not a Claude effort level refuses the launch", unknown !== null && /not a Claude effort level/.test(unknown), unknown);
  const twice = refusalFor({ variant: "high", launchOptions: { effort: "low" } });
  check("a variant with an effort launch option refuses the launch", twice !== null && /effort too/.test(twice), twice);
  check("the connector declares model variants", claudeConnector.supportsModelVariant === true);
}

// ---- The cell count itself, because three cells above are conditional ------------------------
// The argv and COTAL_MODEL checks only run when the launch was accepted, so a regression that makes
// the guard refuse EVERYTHING does not fail them - it DELETES them. Six assertions stop existing
// and the run still prints a summary line. This was measured, not imagined: a mutation predicted to
// kill ten cells killed four, and the missing six had silently vanished.
//
// A count is the only thing that sees a cell that is not there. It is a real assertion and it is
// allowed to fail on a legitimate edit: change the cases above and change this number deliberately.
const EXPECTED = 27;
check(
  `every cell ran - ${EXPECTED} expected, a conditional cell that vanishes is invisible without this`,
  passed() + failed() === EXPECTED, // counted BEFORE this check lands, so it counts the cells above it
  `${passed() + failed()} cells reported`,
);

console.log(`SUITE COMPLETE: ${passed()} passed, ${failed()} failed`);
finish();
process.exit(failed() === 0 ? 0 : 1);
