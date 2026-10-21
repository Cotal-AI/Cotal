/**
 * A prompt settles when its input ends. Ctrl-D on an empty line and a closed input both used to
 * leave clack's prompt unsettled, so the CLI drained and exited 13 with Node's unsettled top-level
 * await warning, or hung while a broker connection kept it alive at a typed-name confirmation. Each
 * is now the cancel Ctrl-C gives. Enter and a typed answer still answer, and a settled prompt leaves
 * no listener on its input. Every CLI prompt asks through lib/prompts.ts, which applies this, and no
 * CLI source imports clack's prompts directly.
 *
 * The plain removal questions read one line with readline, which had the same hole: a closed input,
 * or a line with no newline before it, left the question pending. They ask through askLine now, and
 * no other CLI source asks a readline question.
 *
 * Drives the real clack prompts and readline over in-memory streams. No binary, broker or terminal.
 *
 * Run: pnpm smoke:prompt-input-end
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import * as prompts from "@clack/prompts";
import { createSuite } from "@cotal-ai/smoke-kit";
import { untilInputEnds } from "@cotal-ai/workspace";
import * as cliPrompts from "../src/lib/prompts.js";

const { check, finish } = createSuite();
const sink = () => new Writable({ write(_chunk, _encoding, done) { done(); } });
const settle = <T>(promise: Promise<T>, ms = 2000) => Promise.race([promise.then((value) => ({ settled: true as const, value })), new Promise<{ settled: false }>((done) => setTimeout(() => done({ settled: false }), ms))]);
const ask = (input: PassThrough) => untilInputEnds((signal) => prompts.confirm({ message: "Stop the service?", initialValue: false, input, output: sink(), signal }), input);
const tick = () => new Promise<void>((done) => setImmediate(done));

{
  const input = new PassThrough();
  const answer = ask(input);
  await tick();
  input.write("\u0004");
  const result = await settle(answer);
  check("Ctrl-D on the empty prompt settles it as a cancel", result.settled && prompts.isCancel(result.value), result);
  input.end();
}

{
  const input = new PassThrough();
  const answer = ask(input);
  await tick();
  input.end();
  const result = await settle(answer);
  check("closed input settles the prompt as a cancel", result.settled && prompts.isCancel(result.value), result);
}

{
  const input = new PassThrough();
  input.end();
  input.resume();
  await tick();
  const result = await settle(ask(input));
  check("input that ended before the prompt settles it as a cancel", result.settled && prompts.isCancel(result.value), result);
}

{
  const input = new PassThrough();
  const answer = ask(input);
  await tick();
  input.write("\r");
  const result = await settle(answer);
  check("Enter still answers with the default No", result.settled && result.value === false, result);
  check("the settled prompt leaves no keypress listener behind", input.listenerCount("keypress") === 0, input.listenerCount("keypress"));
  input.end();
}

{
  const input = new PassThrough();
  const answer = ask(input);
  await tick();
  input.write("y");
  input.write("\r");
  const result = await settle(answer);
  check("a typed y still answers yes", result.settled && result.value === true, result);
  input.end();
}

{
  const input = new PassThrough();
  const answer = ask(input);
  await tick();
  input.write("\u0003");
  const result = await settle(answer);
  check("Ctrl-C keeps its own cancel", result.settled && prompts.isCancel(result.value), result);
  input.end();
}

{
  const input = new PassThrough();
  const answer = cliPrompts.text({ message: "Type the exact space name", validate: (value) => value === "b4" ? undefined : "Type b4 to confirm, or cancel", input, output: sink() });
  await tick();
  input.write("b5\r");
  await tick();
  input.end();
  const result = await settle(answer);
  check("a closed input after a wrong typed name settles the confirmation as a cancel", result.settled && prompts.isCancel(result.value), result);
}

{
  const input = new PassThrough();
  const answer = cliPrompts.select({ message: "Choose", options: [{ value: "a", label: "a" }, { value: "b", label: "b" }], input, output: sink() });
  await tick();
  input.write("\u0004");
  const result = await settle(answer);
  check("Ctrl-D at a CLI select settles it as a cancel", result.settled && prompts.isCancel(result.value), result);
  input.end();
}

{
  const input = new PassThrough();
  const answer = cliPrompts.confirm({ message: "Stop it?", initialValue: false, input, output: sink() });
  await tick();
  input.write("y");
  input.write("\r");
  const result = await settle(answer);
  check("a CLI confirm still answers", result.settled && result.value === true, result);
  input.end();
}

// A sink that says it is a terminal, so readline runs in terminal mode and reads keypresses.
const ttySink = () => Object.assign(sink(), { isTTY: true, columns: 80 });
// A rejection is reported as the cell's value, so a question that throws fails its own cell.
const line = (input: PassThrough, output: Writable = sink()) => cliPrompts.askLine("Remove #x?\n1) Cancel\n2) Remove\nChoice [1]: ", { input, output })
  .catch((error: unknown) => ({ rejected: String(error) }));

{
  const input = new PassThrough();
  const answer = line(input);
  await tick();
  input.write("2\n");
  const result = await settle(answer);
  check("a plain line question still answers with the typed line", result.settled && result.value === "2", result);
  input.end();
}

{
  const input = new PassThrough();
  const answer = line(input);
  await tick();
  input.end();
  const result = await settle(answer);
  check("closed input settles a plain line question as a cancel", result.settled && result.value === undefined, result);
}

{
  const input = new PassThrough();
  const answer = line(input);
  await tick();
  input.write("2");
  input.end();
  const result = await settle(answer);
  check("a line with no newline before the input ends is a cancel, never a confirmation", result.settled && result.value === undefined, result);
}

{
  const input = new PassThrough();
  input.end();
  input.resume();
  await tick();
  const result = await settle(line(input));
  check("input that ended before a plain line question settles it as a cancel", result.settled && result.value === undefined, result);
}

{
  const input = new PassThrough();
  const answer = line(input, ttySink());
  await tick();
  input.write("\u0004");
  const result = await settle(answer);
  check("Ctrl-D on an empty plain line question settles it as a cancel", result.settled && result.value === undefined, result);
  input.end();
}

{
  const input = new PassThrough();
  const answer = line(input, ttySink());
  await tick();
  input.write("\u0003");
  const result = await settle(answer);
  check("Ctrl-C at a plain line question settles it as a cancel", result.settled && result.value === undefined, result);
  input.end();
}

const src = join(import.meta.dirname, "..", "src");
const direct = readdirSync(src, { recursive: true, encoding: "utf8" })
  .filter((file) => file.endsWith(".ts") && file !== join("lib", "prompts.ts"))
  .filter((file) => /from "@clack\/prompts"|import\("@clack\/prompts"\)/.test(readFileSync(join(src, file), "utf8")));
check("no CLI source asks through clack directly; every prompt goes through lib/prompts.ts", direct.length === 0, direct);
const rawLine = readdirSync(src, { recursive: true, encoding: "utf8" })
  .filter((file) => file.endsWith(".ts") && file !== join("lib", "prompts.ts"))
  .filter((file) => /\.question\(|from "node:readline\/promises"/.test(readFileSync(join(src, file), "utf8")));
check("no CLI source asks a readline question directly; a plain line question goes through askLine", rawLine.length === 0, rawLine);

finish();
process.exit(process.exitCode ?? 0);
