import { homeCotalDir, shellPath } from "@cotal-ai/workspace";

/** A copyable command for this daemon. Windows copy targets PowerShell. */
export function daemonCommandCopy(op: string, home?: string, args: readonly string[] = []): string {
  const quote = process.platform === "win32"
    ? (value: string) => /^[A-Za-z0-9_./:-]+$/.test(value) ? value : `'${value.replaceAll("'", "''")}'`
    : shellPath;
  const words = ["cotal", "daemon", op, ...args];
  if (home !== undefined && home !== homeCotalDir()) words.push("--daemon-home", home);
  return words.map(quote).join(" ");
}
