/**
 * The character class a peer-controlled field loses before it is printed inside a frame: every
 * control character, every Unicode line or paragraph separator, and both brackets.
 *
 * A peer writes these fields, and they arrive checked only as strings. Attribution, a channel and a
 * service are rendered inside brackets on one line, so a `]` or a line break ends that syntax early
 * and forges what follows, and an ESC or BEL reaches the operator's terminal as a control sequence.
 * Both brackets, not only the closing one: stripping `]` alone still leaves an opening bracket that
 * a reader of the innermost pair takes as a second frame. One class, because a second spelling of
 * the same rule is how a label and an attribution line drift.
 */
const FRAME_UNSAFE = /[\p{Cc}\p{Zl}\p{Zp}[\]]+/gu;

/** `text` with every character in {@link FRAME_UNSAFE} replaced by a space. */
export function frameField(s: string): string {
  return s.replace(FRAME_UNSAFE, " ");
}

/**
 * The label every surface prints for a peer: `name/role`, or the bare name when it has no role.
 * A role equal to the name is still printed, because a bare name is how a peer with no role reads
 * and the role is what an anycast addresses.
 */
export function peerLabel(card: { name: string; role?: string }): string {
  return frameField(card.role ? `${card.name}/${card.role}` : card.name);
}
