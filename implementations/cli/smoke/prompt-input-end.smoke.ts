/**
 * A confirmation prompt settles when its input ends. Ctrl-D on an empty line and a closed input
 * both used to leave clack's prompt unsettled, so the CLI drained and exited 13 with Node's
 * unsettled top-level await warning. Each is now the cancel Ctrl-C gives. Enter and a typed answer
 * still answer, and a settled prompt leaves no listener on its input.
 *
 * Drives the real clack confirm prompt over in-memory streams. No binary, broker or terminal.
 *
 * Run: pnpm smoke:prompt-input-end
 */
import { PassThrough, Writable } from "node:stream";
import * as prompts from "@clack/prompts";
import { createSuite } from "@cotal-ai/smoke-kit";
import { untilInputEnds } from "../src/lib/prompt-input.js";

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

finish();
process.exit(process.exitCode ?? 0);
