/** The longest name a chat session may appear as. */
export const CHAT_NAME_MAX = 128;

/** Why `value` cannot be a chat name, or undefined. `--name`, the `name` preference and every
 *  name a chat session resolves to are held to this one rule. */
export function chatNameProblem(value: string): string | undefined {
  if (!value.trim() || value.length > CHAT_NAME_MAX || /[\u0000-\u001f\u007f]/u.test(value))
    return `a name is 1 to ${CHAT_NAME_MAX} characters, not blank and without control characters`;
  return undefined;
}
