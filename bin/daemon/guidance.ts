import { homeCotalDir, shellPath } from "@cotal-ai/workspace";

export const NON_USER_AUTH_MESSAGE = "this space does not use user sign-in. The machine service hosts Managers only for user-auth participant spaces";
export const NON_USER_AUTH_REMEDY = "run `cotal up` in the folder that hosts the local space. Its stack runs the Manager";

/** A copyable command for this daemon. Tuples keep option values distinct from boolean flags;
 *  leading-hyphen values need `=` even when shell-quoted. Windows copy targets PowerShell. */
export function daemonCommandCopy(op: string, home?: string, args: readonly (string | readonly [string, string])[] = []): string {
  const quote = process.platform === "win32"
    ? (value: string) => /^[A-Za-z0-9_./:-]+$/.test(value) ? value : `'${value.replaceAll("'", "''")}'`
    : shellPath;
  const words: (string | readonly [string, string])[] = ["cotal", "daemon", op, ...args];
  if (home !== undefined && home !== homeCotalDir()) words.push(["--daemon-home", home]);
  return words.map(word => typeof word === "string" ? quote(word)
    : `${word[0]}${word[1].startsWith("-") ? "=" : " "}${quote(word[1])}`).join(" ");
}
