import type { Command } from "@cotal-ai/core";

/** The optimal string alignment distance between `a` and `b`: insertions, deletions, substitutions
 *  and swaps of two neighbouring characters, each one edit, so `stauts` is one edit from `status`. */
function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
    }
  return d[a.length]![b.length]!;
}

/** `did you mean <candidate>?` for the candidates nearest to a mistyped `word`, or an empty string
 *  when none is near: one edit for a word of four characters or fewer, two for a longer one, leading
 *  dashes not counted. The word itself is never suggested, and a tie names each nearest candidate. */
export function didYouMean(word: string, candidates: Iterable<string>): string {
  const bare = (text: string) => text.replace(/^-+/, "");
  const limit = bare(word).length <= 4 ? 1 : 2;
  let best = limit, nearest: string[] = [];
  for (const candidate of new Set(candidates)) {
    if (candidate === word || candidate.startsWith("-") !== word.startsWith("-")) continue;
    const distance = editDistance(bare(word), bare(candidate));
    if (distance > limit) continue;
    if (distance < best) { best = distance; nearest = [candidate]; }
    else if (distance === best) nearest.push(candidate);
  }
  return nearest.length ? `did you mean ${nearest.sort().join(" or ")}?` : "";
}

/** The tail of an unknown-word refusal: the suggestion for `word` if there is one, then `remedy`. */
export function suggestThen(word: string, candidates: Iterable<string>, remedy: string): string {
  const hint = didYouMean(word, candidates);
  return hint ? `${hint} Or ${remedy}` : remedy;
}

/** The flags `cotal` reads before a command word, the words a mistyped leading flag is matched to. */
const LEADING_FLAGS = ["--json", "--plain", "--no-color", "--no-input", "--version", "--help"];

/** The words that name a listed command: its name and aliases. A word that begins with `-` is
 *  matched to the leading flags instead. */
function commandWords(commands: readonly Command[], word: string): string[] {
  if (word.startsWith("-")) return LEADING_FLAGS;
  return commands.filter((cmd) => !cmd.hidden && !cmd.name.startsWith("__")).flatMap((cmd) => [cmd.name, ...(cmd.aliases ?? [])]);
}

/** The usage line for a word that names no command, with the nearest command or leading flag. */
export function unknownCommandMessage(commands: readonly Command[], word: string): string {
  return `unknown command: ${word} - ${suggestThen(word, commandWords(commands, word), "run `cotal help` to list commands")}`;
}

/** The usage line for a first word that names none of `surface`'s subcommands, with the nearest. */
export function unknownSubcommandMessage(path: string, surface: Pick<Command, "subcommands">, word: string): string {
  const words = (surface.subcommands ?? []).filter((sub) => !sub.hidden).flatMap((sub) => [sub.name, ...(sub.aliases ?? [])]);
  return `cotal ${path} has no subcommand "${word}" - ${suggestThen(word, words, `run \`cotal help ${path}\``)}`;
}
