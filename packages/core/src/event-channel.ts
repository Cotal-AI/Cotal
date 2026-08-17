/**
 * The per-agent EVENT channel: how its name is FORMED, and how one is RECOGNISED.
 *
 * WHY THIS IS IN CORE, beside `agui-kind.ts`, and not in the connector that emits on it. The same
 * test `agui-kind.ts` applies to the frame's identity applies here: could one adapter change this
 * while the others are unaffected? It could not. Every connector publishes to this name, a grant is
 * minted from the same value, and a reader on the other side of the wire has to recognise it without
 * knowing which adapter produced it. A shape all adapters must agree on is a protocol shape.
 *
 * The direct evidence is the READER. `cotal console`'s mesh view and the dashboard classify live
 * traffic to keep an agent's event stream out of the chat pane, and neither one imports a connector:
 * `bin/run.ts` loads connectors as removable, lazily-materialized `cotal ext` plugins, so a
 * classifier living in `connector-core` is not merely inconvenient for a console, it is ABSENT from
 * the process that needs it. The alternative every consumer reached for instead was re-spelling
 * `events.` locally, which is one more copy of a convention with nothing recomputing that the copies
 * agree.
 *
 * NAMING AND CLASSIFICATION ONLY, AND THAT LINE IS DELIBERATE. What an event channel CARRIES, when
 * it is written, and who may write it all stay in `connector-core`: the emitter, the write-ahead
 * log, the durable source, the ephemeral-identity refusal, and the display-name resolver, which
 * needs presence records core has no business reading. Core learns the name and the predicate,
 * because those are what a reader needs, and nothing beyond them.
 *
 * CORE GAINS NO DEPENDENCY FOR THIS. Both halves are built out of `subjects.ts`, which is already
 * here: {@link principalKey} forms the name and {@link parsePrincipalKey} takes it apart.
 */
import { principalKey, parsePrincipalKey } from "./subjects.js";

/**
 * The one place the `events.` convention is spelled.
 *
 * {@link eventChannel} and {@link eventChannelPrincipal} both read it, which is the only reason the
 * constructor and the classifier are allowed to be two functions.
 */
export const EVENT_CHANNEL_PREFIX = "events.";

/**
 * The event channel for a principal: `events.<owner>.<actor>`.
 *
 * THE KEY IS THE PRINCIPAL BECAUSE THE DISPLAY NAME IS NOT AN IDENTITY. An earlier version took a
 * name and reduced it to `[a-z0-9_-]`, which FUSED distinct principals onto one channel:
 * `assertValidName` deliberately permits internal spaces and dots (human display names like
 * "Ada Lovelace"), so `Alice Bob`, `Alice.Bob`, `alice bob` and `alice-bob` all collapsed to
 * `events.alice-bob`, and case-folding collapsed `Alice` onto `alice` besides. Eight valid distinct
 * names measured onto three channels. That was an ISOLATION defect rather than a cosmetic one: the
 * publish grant is minted FROM this value, so two distinct principals received the same grant and
 * published to the same subject.
 *
 * The name-keyed version answered that with a sanitiser plus a truncated digest, and could therefore
 * only ever claim COLLISION RESISTANCE, a defence that itself shipped two constructible collisions.
 * Keyed on the principal there is no lossy transform to defend: {@link assertValidOwnerToken} is
 * `[A-Za-z0-9_]+` and FAILS LOUD rather than rewriting, and `.` separates two tokens that cannot
 * contain one. Distinct principals give distinct channels, injective by construction rather than by
 * digest length.
 *
 * THE DOT FORM COSTS TWO SEGMENTS, deliberately. `principalKey().key` is `<owner>.<actor>`, so a
 * channel is three tokens and `events.<owner>.>` is expressible and means OWNER-WIDE: every actor
 * under one owner, not one agent's sessions. The single-token name form (`<owner>-<actor>`) would
 * avoid that, but the dot form is the canonical serialization every authority enforcing per-agent
 * grants already checks against, and a second encoding of a principal is the drift this design
 * refuses everywhere else.
 *
 * Validation is `principalKey`'s own, reused rather than re-implemented: this function derives an
 * AUTHORIZATION value and must not depend on a caller having validated first.
 *
 * @throws via {@link assertValidOwnerToken} on a token outside `[A-Za-z0-9_]+`. A caller holding
 *   untrusted input wants {@link eventChannelPrincipal}, which answers with `null`.
 */
export function eventChannel(principal: { owner: string; actor: string }): string {
  return `${EVENT_CHANNEL_PREFIX}${principalKey(principal.owner, principal.actor).key}`;
}

/**
 * The principal an event channel names, or `null` if the string does not name one.
 *
 * THIS IS A FULL DERIVATION, NOT A PREFIX TEST, AND THAT IS THE WHOLE POINT OF THE FUNCTION. The
 * classifier it replaces asked `channel.startsWith("events.")` and documented the gap as a known
 * limit: any string beginning with those seven characters classified as an event channel. The limit
 * was not harmless in the direction the comment argued. It reasoned that a MALFORMED publisher
 * should stay visible to a filter, but the cost lands on the other side: `assertValidName` permits a
 * dot inside a display name and nothing anywhere reserves the `events.` prefix, so an ordinary chat
 * channel a human called `events.standup` was classified as machine traffic and swept out of the
 * chat pane. A person's messages disappearing from the view they were sent to is a silent loss, and
 * it is exactly the failure this lane exists to remove.
 *
 * The derivation fails the other way, which is the correct direction: a string that does not resolve
 * to a principal is NOT an event channel, so a malformed `events.` name stays in the chat view where
 * a reader can see that something is publishing nonsense. A wrong answer that is visible beats a
 * wrong answer that is quiet.
 *
 * WHAT IT STILL CANNOT SEPARATE, STATED RATHER THAN LEFT FOR A READER TO DISCOVER. Nothing reserves
 * the `events.` prefix, so a human chat channel whose remainder happens to BE principal-shaped is
 * indistinguishable from an agent's stream: `events.team.standup` classifies as an event channel and
 * always will, because `team.standup` is a well-formed principal key and this function has no other
 * evidence to weigh. The derivation narrows the collision rather than closing it. Measured, the
 * narrowing is real and one-directional: `assertValidChannel` admits `-` in a segment and
 * {@link assertValidOwnerToken} does not, and a principal key is exactly two segments, so
 * `events.standup`, `events.my-team.standup` and `events.a.b.c` all return to the chat pane where
 * the prefix test had taken them. Only the exactly-two-underscore-or-alphanumeric-segment case
 * remains. Closing it entirely means reserving the prefix on the wire, which is a change to the
 * normative contract and is deliberately not made here.
 *
 * IT IS THE CONSTRUCTOR'S INVERSE, EXECUTED, not a second expression that resembles it. The parse is
 * checked by rebuilding the name with {@link eventChannel} and comparing. That comparison is
 * currently always true, and it is not decoration: it is the assertion that the two functions still
 * agree, evaluated on every classification rather than argued for in a comment. A change to how the
 * name is formed that forgot this file would be caught by it.
 *
 * IT CANNOT THROW, and that is a property of the order rather than a promise. {@link parsePrincipalKey}
 * admits exactly `[A-Za-z0-9_]+` on both sides of the first dot, which is character for character
 * what {@link assertValidOwnerToken} admits, so by the time {@link eventChannel} is called its
 * refusal is unreachable. The equivalence of those two alphabets is asserted at the boundary
 * characters by the suite rather than assumed here, because it is the load-bearing step and it is
 * one narrowing edit away from being false. No `try` swallows the refusal: a throw arriving here
 * would mean the constructor and the parser had diverged, and hiding that would turn a loud
 * contradiction into a channel silently reclassified as chat.
 *
 * THE SESSION-SCOPED FORM IS DELIBERATELY NOT RECOGNISED. `events.<owner>.<actor>.<session>` is a
 * planned later step, and nothing mints a grant for it or emits on one today. It parses to `null`
 * here, because a classifier that accepts a shape no producer writes is a claim no test can hold up.
 * The commit that starts emitting on a sub-channel is the commit that widens this, and until then
 * the failure if someone forgets is event traffic appearing in the chat pane, which is visible.
 */
export function eventChannelPrincipal(channel: unknown): { owner: string; actor: string } | null {
  if (typeof channel !== "string" || !channel.startsWith(EVENT_CHANNEL_PREFIX)) return null;
  const principal = parsePrincipalKey(channel.slice(EVENT_CHANNEL_PREFIX.length));
  if (principal === null) return null;
  return eventChannel(principal) === channel ? principal : null;
}

/**
 * Whether a channel name is an agent's structured-event channel rather than ordinary chat.
 *
 * The predicate a display filter wants, over {@link eventChannelPrincipal}'s derivation. It takes
 * `unknown` and means it: a surface classifies whatever its message carried, and a `channel` field
 * is absent on a direct message and on an anycast.
 */
export function isEventChannel(channel: unknown): boolean {
  return eventChannelPrincipal(channel) !== null;
}
