/** The longest name a chat session may appear as. */
export const CHAT_NAME_MAX = 128;

/** Letters, digits, `_`, `.` and `-`, starting and ending with a letter, digit or `_`: an
 *  `@name` in a message reaches every such name whole, including at the end of a sentence. */
const MENTIONABLE = /^[A-Za-z0-9_](?:[A-Za-z0-9_.-]*[A-Za-z0-9_])?$/;

/** Why `value` cannot be a chat name, or undefined. `--name`, the `name` preference and every
 *  name a chat session resolves to are held to this one rule, so an agent can mention each. */
export function chatNameProblem(value: string): string | undefined {
  if (value.length > CHAT_NAME_MAX || !MENTIONABLE.test(value))
    return `a name is 1 to ${CHAT_NAME_MAX} letters, digits, "_", "." or "-", starting and ending with a letter, digit or "_", so an @mention can reach it`;
  return undefined;
}
