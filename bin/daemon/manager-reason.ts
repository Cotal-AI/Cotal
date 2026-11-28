/** A hosted Manager's `reason` says what happened without a command or a web address: the step
 *  to take is in `next`, and the Manager's own output stays in `lastExit` and its log. A web address
 *  becomes "the sign-in host", and each clause that holds a command is dropped. When nothing is left,
 *  `fallback` is the reason. */
export function plainManagerReason(text: string, fallback: string): string {
  const kept = text.replace(/https?:\/\/[^\s`'")]+/g, "the sign-in host").split(/(?<=[.;:])\s+|\s+-\s+/)
    .filter(clause => !/`|\bcotal [a-z]/.test(clause)).join(" ").replace(/[\s:;,-]+$/, "");
  return kept || fallback;
}
