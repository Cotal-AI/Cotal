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
