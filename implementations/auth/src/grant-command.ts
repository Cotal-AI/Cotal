/**
 * The one place a re-grant command is rendered for a human to run.
 *
 * Shared by the delegation refusals in `ledger.ts` and the elevated-view refusal in `idp.ts`,
 * because the two of them printing the same command two different ways is how one of them ended up
 * printing a command that widened the row it was repairing.
 */

/**
 * ONE re-grant command, with EVERY defaulting field named.
 *
 * `cotal actor grant` is an upsert of the whole row and `runActor` fills each flag the operator
 * omits from a WIDE default (`>` read, `>` post, `spawn,role:default` scope). So a printed remedy
 * that leaves a field off is not neutral about that field: it silently sets it to the widest value
 * the system can express. Every caller here passes real values from a real row. Nothing is
 * invented, because a command carrying an invented value is a command whose shortest successful
 * recovery is to delete the flag, which lands back on the default this exists to avoid.
 *
 * `--scope` is emitted even when the list is EMPTY, as `--scope ''`. Omitting it is not "no scope",
 * it is `spawn,role:default`.
 *
 * Free-form fields are POSIX single-quote escaped: a row label like `x'; rm -rf ~` must never
 * become a live command.
 */
export function grantCommandLine(
  owner: string,
  actor: string,
  row: { scope: string[]; allowSubscribe: string[]; allowPublish: string[]; role?: string; label?: string },
): string {
  const shq = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
  const parts = [
    `cotal actor grant ${actor} --owner ${owner}`,
    `--scope ${shq(row.scope.join(","))}`,
    `--allow-subscribe ${shq(row.allowSubscribe.join(","))}`,
    `--allow-publish ${shq(row.allowPublish.join(","))}`,
  ];
  if (row.role) parts.push(`--role ${shq(row.role)}`);
  if (row.label) parts.push(`--label ${shq(row.label)}`);
  return parts.join(" ");
}
