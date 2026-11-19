// Request input and operator text, moved verbatim from web.ts: caller errors, body caps, operator
// quoting and escaping, and channel, history, agent-id and tap parsing. web.ts re-exports the public names.
import {
  deliveryOf,
  eventChannelPrincipal,
  parsePrincipalKey,
  parseSubject,
  principalKey,
  type DeliveryMode,
  assertValidChannel,
  type CotalMessage,
} from "@cotal-ai/core";

/** A request the CALLER got wrong, so the frame answers 400 rather than the 500 it gives a server
 *  fault. Without this every malformed query reads, in the log and in the body, exactly like the
 *  dashboard breaking. */
export class BadRequest extends Error {}

/** A body the caller sent that this server declines to READ, which is a different fact from a body
 *  it read and disliked, and carries its own status. Deliberately NOT a `BadRequest`: 400 says
 *  "what you sent is wrong", 413 says "I stopped before finding out", and a caller that retries on
 *  400 by fixing its payload would loop forever on a size it never learns is the problem. */
export class PayloadTooLarge extends Error {}

/** A delete upload that did not finish within its total body deadline. */
export class BodyDeadlineExceeded extends Error {}

/** A post the broker, or the operator's connection to it, refused. Neither the caller's fault nor
 *  this server's, so the frame answers 502 with the broker's own message, escaped by
 *  {@link escapeForOperator}. */
export class BrokerRefused extends Error {}

/** The most a request body may weigh before a body route refuses to keep reading it.
 *
 *  The delete route's body has one field, a channel name, and `assertValidChannel` bounds a usable
 *  name to dotted `[A-Za-z0-9_-]` segments that the wire will carry as a subject. The dashboard's
 *  own delete sends about sixty bytes. 8 KiB is therefore not a guess at a working size, it is two
 *  orders of magnitude ABOVE any name the broker would accept, chosen so that no legitimate
 *  caller can meet it and an abusive one meets it immediately. The send route shares the cap, so a
 *  post's text is bounded by it too.
 *
 *  MEASURED, before this existed, against the shipped route over a local broker with a raw socket
 *  rather than `fetch`, because `fetch` hides how much of the body actually left the client:
 *    30,000,000 bytes posted -> ALL 30,000,000 sent, 70,000,144 bytes of refusal returned,
 *    peak RSS +1.39 GB, 1022 ms. The read was unbounded and ran to completion before the route
 *    formed an opinion, so the refusal was the expensive part rather than the cheap one. */
export const MAX_BODY_BYTES = 8 * 1024;
export const DELETE_BODY_DEADLINE_MS = 10_000;

/** The only routes that read a request body. Every other route refuses an announced body. */
export const BODY_ROUTES = new Set(["/api/channel/delete", "/api/send"]);

/** Codepoints `JSON.stringify` leaves RAW that PRODUCE NO GLYPH OF THEIR OWN, or that reorder the
 *  text around them, stated as Unicode PROPERTIES rather than as a hand list. That wording is
 *  narrower than "change what a reader sees" on purpose, and the narrowing is a review finding:
 *  the looser phrase admits every combining mark, and the paragraph at the end of this comment is
 *  why escaping those would be this issue pointed the other way. The first version of this WAS a hand list, and review
 *  found it missing U+061C, U+2060, the variation selectors and the tag characters, every one of
 *  which is exactly the thing the list said it closed. A list is a claim about a set nobody
 *  maintains; the property IS the set, and it moves with the Unicode version the runtime carries.
 *
 *  Two properties, because neither contains the other and both name the same harm from a different
 *  side. `Default_Ignorable_Code_Point` is the renders-as-nothing family: the soft hyphen, the
 *  zero-width characters, the word joiner, the variation selectors, the tag characters and the BOM.
 *  `Cf` is the format family: characters with no glyph of their own that change how the text around
 *  them is read, which is where the interlinear annotation controls U+FFF9 to U+FFFB live. Review
 *  found those three arriving raw against a class that had only the first property, and they are the
 *  clearest case of the harm: they mark a span as base text plus its gloss, so a reader whose
 *  terminal does not implement them sees the two runs concatenated into a sentence nobody wrote.
 *  Measured, the second property adds 32 codepoints and not one of them is a letter or a digit.
 *
 *  `Bidi_Control` is deliberately absent: measured on this runtime, all twelve of its codepoints,
 *  U+061C and the isolates included, are already default-ignorable, so naming it would be a second
 *  name for one set. The suite pins those twelve by hand, so a Unicode version that separated them
 *  goes red rather than quietly leaving a reordering character raw.
 *
 *  What no property covers is DEL and the C1 controls, which are `Cc`, and U+2028/U+2029, which are
 *  line and paragraph separators, so those are named. C0 is absent because `JSON.stringify` already
 *  escapes all of it.
 *
 *  NOT IN THIS CLASS, and deliberately: a VISIBLE character that merely resembles another. A Cyrillic
 *  small a is a letter, it renders as itself, and escaping it would make a refusal about a name a
 *  human typed unreadable, which is this issue pointed the other way. Confusables are a different
 *  problem with a different answer, and quoting for a human to read is not it.
 *
 *  NOT IN THIS CLASS EITHER, and this one review reached by finding U+0338 COMBINING LONG SOLIDUS
 *  OVERLAY arriving raw and asking whether it belonged: a COMBINING MARK. It produces a visible
 *  mark on a visible base, and the property that carries it, `gc=Mn`, is the same one carrying the
 *  acute accent in a name written in NFD, the Devanagari vowel signs, the Arabic and Hebrew points
 *  and the Vietnamese tones. Measured on this runtime, marks are 2543 codepoints and only 263 of
 *  them are already in the class, so escaping them would take about 2280 codepoints of ordinary
 *  written language and render an accented name as its escapes. A mark CAN build a confusable
 *  (U+0338 over `=` renders as a not-equals sign, so a quoted `a=b` can display as `a` not-equals
 *  `b`), which is a real harm and the same one the paragraph above declines: it is unbounded, it
 *  needs no combining mark to exist, and its answer is normalization or confusable detection
 *  rather than making every script that writes with marks unreadable. The suite asserts both
 *  exclusions rather than only describing them. */
const INVISIBLE_AFTER_JSON = /[\p{Default_Ignorable_Code_Point}\p{gc=Cf}\u007f-\u009f\u2028\u2029]/gu;

/** QUOTE A CALLER'S OWN VALUE SO AN OPERATOR CAN READ IT.
 *
 *  `JSON.stringify` was doing two jobs at every site below and only claims one of them. It builds
 *  valid JSON, and on the way it escapes every C0 control, so `ESC` arrives as the six characters
 *  `\u001b` and a newline as `\n`. It is not a renderer for humans and never said it was: DEL, the
 *  C1 range, `U+2028`/`U+2029`, the bidi controls and the zero-width characters are all valid JSON
 *  string content and pass through untouched.
 *
 *  MEASURED against the shipped `web()` entry before this existed, driving `/api/activity?limit=`
 *  with each codepoint percent-encoded and reading the answer as BYTES rather than through a JSON
 *  parse (a parse decodes the very thing under test and hands the input back whatever the server
 *  wrote). Six of eight arrived raw in BOTH the 400 body and the operator's stderr line: DEL,
 *  `U+0085`, `U+009B`, `U+202E`, `U+2028`, `U+2029`. `ESC` and `LF` came back escaped, which is
 *  what makes the other six a finding rather than a property of the harness.
 *
 *  The escape is emitted as `\uXXXX`, so the message stays valid JSON on the body path and reads as
 *  the codepoint it is on the terminal path. Applied where the value is QUOTED rather than where it
 *  is written out, because the untrusted thing is the value and the message is derived from it: a
 *  guard at the two exits fences those two exits, while a guard here travels with the sentence.
 *
 *  The loop below is per UTF-16 UNIT, not per codepoint: `u` hands the callback a whole codepoint,
 *  so an astral one (a tag character, a musical control) arrives as its surrogate pair and has to
 *  leave as two escapes. `\u1d173` is not a JSON escape, and a body carrying it would stop parsing
 *  for the caller who asked what was wrong with their request. */
export function quoteForOperator(value: string): string {
  return JSON.stringify(value).replace(INVISIBLE_AFTER_JSON, (ch) => {
    let out = "";
    for (let i = 0; i < ch.length; i++) out += "\\u" + ch.charCodeAt(i).toString(16).padStart(4, "0");
    return out;
  });
}

/** Every codepoint {@link quoteForOperator} escapes, the C0 controls included, without its quotes. */
const UNREADABLE = new RegExp(`[\\u0000-\\u001f]|${INVISIBLE_AFTER_JSON.source}`, "gu");

/** Escapes a message someone else wrote, keeping its wording. A broker refusal names the subject it
 *  refused, and a DM subject carries a recipient id taken from another agent's presence card, so the
 *  message reaches the 502 body and the operator's line as untrusted text. Each codepoint the quoter
 *  escapes leaves as its escape; the rest, quotes included, stays as the broker wrote it. */
export function escapeForOperator(text: string): string {
  return text.replace(UNREADABLE, (ch) => quoteForOperator(ch).slice(1, -1));
}

/** The channel name out of the path. A percent escape the decoder cannot read is the caller having
 *  typed a bad one, so it is refused as a bad request like any other malformed input. Left as a
 *  bare `URIError` it reached the request frame unrecognised and was reported as a server fault,
 *  which is the one thing the 400/500 split exists to prevent. */
export function channelNameFromPath(raw: string): string {
  let name: string;
  try {
    name = decodeURIComponent(raw);
  } catch {
    throw new BadRequest(`channel name ${quoteForOperator(raw)} is not valid percent-encoded text`);
  }
  return canonicalChannel(name);
}

/** A caller's channel name, refused unless it is ALREADY the name the wire uses.
 *
 *  The wire builds a channel's subject through `token()`, which rewrites anything outside
 *  `[A-Za-z0-9_-]` to `_` rather than refusing it, so a name a caller invented and a real channel
 *  collide: `abc` + U+202E and `abc_` are one channel on the wire while the dashboard answers with
 *  whichever the caller typed. Measured against the shipped routes on a local broker before this
 *  existed, with one message seeded on `abc_`: the history read under the first name returned the
 *  second's message, and the delete route purged the second while answering
 *  `{"ok":true,"channel":"abc<U+202E>","purged":1}`. Rendering that answer readably would have made
 *  the lie legible without removing it, which is why this refuses the name instead.
 *
 *  Core already owns the rule, written for the same aliasing gap on the ACL side; the dashboard
 *  simply never asked it. Its message is rebuilt here rather than passed through, because core
 *  quotes the raw name with `JSON.stringify` and this route is the one place that must not. */
export function canonicalChannel(name: string): string {
  try {
    return assertValidChannel(name);
  } catch {
    throw new BadRequest(
      `channel name ${quoteForOperator(name)} is not a channel: dotted segments of [A-Za-z0-9_-], ` +
        `and a name the wire would rewrite would address a different channel than it names`,
    );
  }
}

/** The most messages one read may ask for. A route reads up to `limit` messages and holds them all
 *  before it answers, so a limit with no ceiling lets one request make the server read a stream's
 *  whole retained history. The dashboard asks for at most 500. */
export const MAX_HISTORY_LIMIT = 2000;

/** The `limit` out of the query. The ceiling refusal is reachable only through the digits-only test
 *  above it, so its value cannot carry anything the quoter would escape today. It quotes anyway:
 *  the guarantee that a refusal renders its input unambiguously should hold because the quoting site
 *  holds it, not because a regex two lines up stays exactly as narrow as it is this morning.
 *
 *  THE LIMIT, PARSED ONCE, because three routes each re-deriving
 *  `query.get("limit") ? Number(...) : N` is how they came to disagree about the same parameter.
 *
 *  MEASURED ON THE SHIPPED ROUTES, against a real broker, before this existed:
 *    ?limit=abc       `Number("abc")` is NaN and every comparison against NaN is false, so core's
 *                     `limit <= 0` guard does not fire and the widening search's two exits can
 *                     never be true. No answer after 30s, and the ABANDONED request kept consuming
 *                     half a core with its caller long gone, invisible because the process keeps
 *                     serving everything else.
 *    ?limit=Infinity  passes the same guard, and `slice(-Infinity)` is the whole array: a channel's
 *                     entire retained history from a one word request. `1e999` is the same value.
 *    ?limit=2.5       silently truncated to 2.
 *    ?limit=" 5"      accepted as 5, because `Number()` trims whitespace.
 *
 *  So the accepted form is the narrow one: a plain run of digits no larger than
 *  {@link MAX_HISTORY_LIMIT}. `0` keeps
 *  meaning zero, which is what it already did and what a caller expects; an absent or empty
 *  parameter keeps meaning the route's own default, the one shape the old parse got right.
 *
 *  Everything else is REFUSED rather than clamped. A clamp would answer a request nobody made, and
 *  the caller who wrote `limit=2.5` would never learn that the page they read was not the page they
 *  asked for. */
export function historyLimit(query: URLSearchParams, fallback: number): number {
  const raw = query.get("limit");
  if (raw === null || raw === "") return fallback;
  if (!/^[0-9]+$/.test(raw))
    throw new BadRequest(`limit must be a whole number of messages, received ${quoteForOperator(raw)}`);
  // The ceiling also covers a run of digits too long for a double to count exactly: every such
  // number is far above it.
  const n = Number(raw);
  if (n > MAX_HISTORY_LIMIT)
    throw new BadRequest(`limit ${quoteForOperator(raw)} is above the most this server reads at once, ${MAX_HISTORY_LIMIT} messages`);
  return n;
}

/** An agent id out of a path segment: decoded, and a principal key, or a BadRequest naming it.
 *
 *  The id is the roster's `card.id`, which is `principalKey(owner, actor).key` by construction, so
 *  the agent is named by its principal and never by a display name: two live agents with one name
 *  never share a session. The answer's `id` is rebuilt from the parsed tokens rather than passed
 *  through, so the id a route acts on is the one the event channel is formed from. */
export function agentIdFromPath(raw: string): { id: string; owner: string; actor: string } {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    throw new BadRequest(`agent id ${quoteForOperator(raw)} is not valid percent-encoded text`);
  }
  const principal = parsePrincipalKey(decoded);
  if (principal === null)
    throw new BadRequest(`agent id ${quoteForOperator(decoded)} is not an agent id: <owner>.<actor>, each of [A-Za-z0-9_]`);
  return { id: principalKey(principal.owner, principal.actor).key, ...principal };
}

/** What the live tap does with one message. A chat message on a principal-shaped event channel is an
 *  agent frame for `principalKey(owner, actor).key`; everything else goes out as today's `message`.
 *
 *  WHY FRAMES LEAVE THE BROADCAST. The observer taps `chat.>`, and an agent's event channel is a
 *  chat channel, so this one subscription receives every agent's frames. A NATS wildcard cannot
 *  exclude a sub-tree, so the observer still receives them; what changes is who it forwards them to.
 *  Sent as `message` to every browser, each frame cost every open dashboard a write whether or not
 *  anyone was reading that agent. As `agent-frame` it reaches only the feeds watching that agent.
 *
 *  The agent is the event channel's principal, the same derivation the chat-only filter reads, so a
 *  near-miss name such as `events.standup` stays an ordinary `message`. The channel is the one the
 *  broker policed, taken from the subject, never the payload's own claim.
 *
 *  A FRAME FROM ANYONE BUT THE AGENT IS DROPPED, and dropped rather than sent on as a `message`. The
 *  subject's sender is the verified publisher, and a frame is that agent's only when the agent
 *  published it. On a mesh where another principal may write the channel (an open mesh, or a grant
 *  wider than the agent's own), a forged frame would otherwise read as the agent's session, and
 *  falling through to `message` would hand it to every browser instead. */
export function classifyTap(subject: string, msg: CotalMessage | undefined):
  | { event: "message"; data: { mode: DeliveryMode; senderId?: string; channel?: string; msg: CotalMessage } }
  | { event: "agent-frame"; agent: string; data: { id: string; msg: CotalMessage } }
  | null {
  const parsed = parseSubject(subject);
  if (parsed?.kind === "evp") {
    if (!msg || parsed.sender !== msg.from?.id) return null;
    return { event: "agent-frame", agent: parsed.sender, data: { id: parsed.sender, msg } };
  }
  const mode = deliveryOf(subject);
  if (!mode || !msg) return null;
  // senderId is the subject's sender token, the *verified* publisher (the server policed who could
  // publish it), vs the advisory `from` in the payload.
  const senderId = parsed?.sender;
  // The channel the broker actually POLICED, taken from the subject rather than the payload: a
  // publish grant is per-channel (`chat.<owner>.<actor>.<ch>`), so this token is covered by the
  // minted grant, while `msg.channel` is publisher-supplied and backed by nothing.
  //
  // Gated on kind, and the gate is load-bearing rather than defensive: `rest` is the channel only
  // on the chat plane. On `inst` it is the RECIPIENT (`subjects.ts:599`) and on `svc` the route
  // (`:603`), so forwarding it ungated would label a DM's recipient as a channel.
  const channel = parsed?.kind === "chat" ? parsed.rest : undefined;
  const agent = channel === undefined ? null : eventChannelPrincipal(channel);
  if (agent !== null) {
    const id = principalKey(agent.owner, agent.actor).key;
    if (senderId !== id) return null;
    return { event: "agent-frame", agent: id, data: { id, msg } };
  }
  return { event: "message", data: { mode, senderId, channel, msg } };
}
