/** The clack prompts the CLI asks with, plus the plain line question. Each question here ends when
 *  its input does, as the cancel Ctrl-C gives (see {@link untilInputEnds}); everything else is
 *  clack's own. Import prompts from this module, never from `@clack/prompts` or a readline
 *  question, so no question can hang or exit 13 on a closed input. */
import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import { styleText } from "node:util";
import * as clack from "@clack/prompts";
import type { ConfirmOptions, MultiSelectOptions, PasswordOptions, SelectOptions, TextOptions } from "@clack/prompts";
import { untilInputEnds, wrapWords } from "@cotal-ai/workspace";

export * from "@clack/prompts";

/** A yes-or-no question. One that defaults to No is answered by typing: `y` or `yes`, in any case,
 *  then Enter confirms it, and Enter alone or any other text keeps No. Clack's toggle took stray
 *  text as Yes, because `h`, `j`, `k` and `l` move its selection and a `y` inside a word submits
 *  it, so "ok" and Enter confirmed a purge. One that defaults to Yes keeps clack's toggle. */
export async function confirm(opts: ConfirmOptions): Promise<boolean | symbol> {
  if (opts.initialValue !== false) return untilInputEnds((signal) => clack.confirm({ ...opts, signal }), opts.input);
  const answer = await untilInputEnds((signal) => clack.text({
    message: titleLines(opts.message, opts.output),
    placeholder: "type y to confirm; Enter keeps No",
    input: opts.input,
    output: opts.output,
    signal,
  }), opts.input);
  return typeof answer === "symbol" ? answer : typeof answer === "string" && /^y(es)?$/i.test(answer.trim());
}

/** `message` as a text prompt's title on `output`, which clack does not wrap: broken at spaces to
 *  fit beside clack's three-column mark, with each continuation line under clack's bar. */
function titleLines(message: string, output: Writable | undefined): string {
  const columns = ((output ?? process.stdout) as { columns?: number }).columns ?? 80;
  return message.split("\n").flatMap((line) => wrapWords(line, columns - 3)).join(`\n${styleText("gray", clack.S_BAR)}  `);
}
export const text = (opts: TextOptions) => untilInputEnds((signal) => clack.text({ ...opts, signal }), opts.input);
export const password = (opts: PasswordOptions) => untilInputEnds((signal) => clack.password({ ...opts, signal }), opts.input);
export const select = <Value>(opts: SelectOptions<Value>) => untilInputEnds((signal) => clack.select({ ...opts, signal }), opts.input);
export const multiselect = <Value>(opts: MultiSelectOptions<Value>) => untilInputEnds((signal) => clack.multiselect({ ...opts, signal }), opts.input);

/** One line typed in answer to `query`, written to stderr, or undefined when the input ends or
 *  closes first, or Ctrl-D on an empty line or Ctrl-C cancels it. A line the input end cut off
 *  before its newline is not an answer. */
export async function askLine(query: string, opts: { input?: Readable; output?: Writable } = {}): Promise<string | undefined> {
  const input = opts.input ?? process.stdin;
  const io = createInterface({ input, output: opts.output ?? process.stderr });
  try {
    // The input-end abort rejects the question with an AbortError, and so does readline itself
    // for Ctrl-D on an empty line and for Ctrl-C. A closed input only closes readline, which leaves
    // its question pending until that abort.
    const answer = await untilInputEnds((signal) => io.question(query, { signal }).catch((error: unknown) => {
      if ((error as { name?: unknown } | null)?.name === "AbortError") return undefined;
      throw error;
    }), input);
    return typeof answer === "string" ? answer : undefined;
  } finally {
    io.close();
  }
}
