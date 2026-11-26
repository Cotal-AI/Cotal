import { CommandFailure } from "@cotal-ai/workspace";

const SPECIAL = new Set(["|", "&", ";", "<", ">", "(", ")", "$", "`", "*", "?", "[", "]", "{", "}", "~"]);

/** Split `service add --exec` text into the program and its arguments as a POSIX shell quotes
 *  words, without running a shell. Single quotes keep everything. Inside double quotes, a backslash
 *  escapes `"`, `\`, `$` and backticks, and unescaped `$` and backticks are refused. Outside quotes,
 *  a backslash keeps the next character.
 *  Text a shell would expand or connect instead, such as a pipe, a redirection, a variable, a glob or
 *  `~`, refuses: it would not mean here what it means in a terminal. */
export function execWords(line: string): string[] {
  const refuse = (what: string, remedy = `quote it to pass it as text, or run a shell yourself: --exec "sh -c '<your command line>'"`) => new CommandFailure("refused", "USAGE_INVALID", `--exec runs one program without a shell, so ${what} would not work as it does in a terminal; nothing was saved`, {
    remedy,
  });
  if (/[\u0000\r\n]/u.test(line)) throw refuse("a line break");
  const words: string[] = [];
  let word = "", started = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index]!;
    if (char === " " || char === "\t") {
      if (started) words.push(word);
      word = ""; started = false;
      continue;
    }
    if (char === "'") {
      const end = line.indexOf("'", index + 1);
      if (end < 0) throw new CommandFailure("refused", "USAGE_INVALID", "--exec has a single quote that is never closed; nothing was saved");
      word += line.slice(index + 1, end); started = true; index = end;
      continue;
    }
    if (char === '"') {
      let closed = false;
      for (index++; index < line.length; index++) {
        const inner = line[index]!;
        if (inner === '"') { closed = true; break; }
        if (inner === "\\" && index + 1 < line.length && ['"', "\\", "$", "`"].includes(line[index + 1]!)) { word += line[++index]; continue; }
        if (inner === "$" || inner === "`") throw refuse(`${inner} inside double quotes`,
          `within the value passed to \`--exec\`, put the literal argument in single quotes or put a backslash before the character inside double quotes. To use shell expansion, run a shell yourself with \`--exec "sh -c '<your command line>'"\``);
        word += inner;
      }
      if (!closed) throw new CommandFailure("refused", "USAGE_INVALID", "--exec has a double quote that is never closed; nothing was saved");
      started = true;
      continue;
    }
    if (char === "\\") {
      if (index + 1 >= line.length) throw new CommandFailure("refused", "USAGE_INVALID", "--exec ends with a backslash that escapes nothing; nothing was saved");
      word += line[++index]; started = true;
      continue;
    }
    if (SPECIAL.has(char) || char === "#" && !started) throw refuse(`an unquoted ${char}`);
    word += char; started = true;
  }
  if (started) words.push(word);
  if (!words.length || !words[0]) throw new CommandFailure("refused", "USAGE_INVALID", "--exec needs the program to run, then its arguments; nothing was saved");
  return words;
}
