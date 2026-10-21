/** The clack prompts the CLI asks with, plus the plain line question. Each question here ends when
 *  its input does, as the cancel Ctrl-C gives (see {@link untilInputEnds}); everything else is
 *  clack's own. Import prompts from this module, never from `@clack/prompts` or a readline
 *  question, so no question can hang or exit 13 on a closed input. */
import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import * as clack from "@clack/prompts";
import type { ConfirmOptions, MultiSelectOptions, PasswordOptions, SelectOptions, TextOptions } from "@clack/prompts";
import { untilInputEnds } from "@cotal-ai/workspace";

export * from "@clack/prompts";

export const confirm = (opts: ConfirmOptions) => untilInputEnds((signal) => clack.confirm({ ...opts, signal }), opts.input);
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
