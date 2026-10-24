import { credsClaims } from "@cotal-ai/core";
import { CommandFailure, type Connection } from "@cotal-ai/workspace";

/**
 * A write the broker refused was not applied, so it is refused with `PERMISSION_DENIED`, naming the
 * credential's profile, the write it lacks and the subject the broker refused. An explicit `--creds`
 * is pointed at the operator credential this machine records for the space.
 */
export function deniedWrite(connection: Connection, explicitCreds: boolean, write: string, kept: string, error: unknown, extra: Omit<NonNullable<ConstructorParameters<typeof CommandFailure>[3]>, "remedy"> = {}): CommandFailure {
  let profile: string | undefined;
  try { profile = connection.creds ? credsClaims(connection.creds).name : undefined; } catch { profile = undefined; }
  const native = (error as { cause?: { message?: unknown } } | null)?.cause?.message ?? (error as Error | null)?.message;
  return new CommandFailure("refused", "PERMISSION_DENIED", `this ${profile ? `${profile} ` : ""}credential may not ${write} in ${connection.space}, so nothing was ${kept}${typeof native === "string" ? `: ${native}` : ""}`, {
    ...extra,
    remedy: explicitCreds
      ? `run it without --creds to use the operator credential this machine records for ${connection.space}, or use a credential that may ${write}`
      : `use a credential that may ${write} in ${connection.space}`,
  });
}
