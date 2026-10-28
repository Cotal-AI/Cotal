/**
 * The label every surface prints for a peer: `name/role`, or the bare name when it has no role.
 * A role equal to the name is still printed, because a bare name is how a peer with no role reads
 * and the role is what an anycast addresses.
 *
 * Control characters, Unicode line and paragraph separators, and brackets become a space. A peer
 * writes its own presence record, so its name and role arrive checked only as strings, and every
 * surface prints the label on one line beside bracketed fields of its own (message attribution sits
 * inside brackets): a `]` or a newline would end that syntax early and forge what follows, and an ESC
 * or BEL would reach the operator's terminal as a control sequence.
 */
export function peerLabel(card: { name: string; role?: string }): string {
  return (card.role ? `${card.name}/${card.role}` : card.name).replace(/[\p{Cc}\p{Zl}\p{Zp}[\]]+/gu, " ");
}

/**
 * Every code point a line splitter may honour, which is more than what JavaScript splits on.
 *
 * Measured through the host frame a model is handed (an MCP text content part, stringified and
 * parsed back): U+2028, U+2029 and U+0085 survive JSON transport intact, and a Unicode-aware
 * splitter breaks a line on them where a JavaScript split on a newline and `wc -l` do not. A name
 * or message body holding one is therefore not a single line. Not global: a shared `/g` regex
 * carries `lastIndex` from one `test()` to the next. It lives beside {@link peerLabel} so the
 * connector's framing, which imports only this light module, shares the one definition.
 */
export const LINE_BREAK = /\r\n?|[\n\v\f\u0085\u2028\u2029]/;
