import { readMesh, homeCotalDir, shellPath } from "@cotal-ai/workspace";

export const NOT_USER_AUTH_MESSAGE = "this space does not use user sign-in, so the daemon cannot connect to it as its own service";
export const NOT_USER_AUTH_REMEDY = "run `cotal up` from the folder that hosts this local space; its Manager runs under `cotal up`. The machine service hosts Managers only for user-auth participant spaces";

/** Read only this space's record for guidance without contacting an auth provider. */
export function localSpaceRemedy(space: string): string | undefined {
  const entry = readMesh(space);
  return entry && (entry.mode !== "user" || !entry.userAuth) ? NOT_USER_AUTH_REMEDY : undefined;
}

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
