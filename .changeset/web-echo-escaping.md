---
"@cotal-ai/web": minor
---

web: a refusal renders the value it names, instead of echoing it back invisibly

The dashboard quotes a caller's own value in two places: the 400 body and the line the request
frame prints for an operator. Both used `JSON.stringify`, which was doing double duty. It is a JSON
serializer and it is good at that; it is not a renderer for a human, and it never claimed to be.

Measured against the shipped server before the change, driving `/api/activity?limit=` with each
codepoint percent-encoded and reading the answer as bytes: `ESC` and `LF` came back escaped, because
`JSON.stringify` closes all of C0. `DEL`, `U+0085`, `U+009B`, `U+202E`, `U+2028` and `U+2029` came
back raw, in the body and in the operator's line alike. The issue named three of those; the class is
wider than the sample, and `U+202E` is the sharpest case, since it does not vanish but reverses the
rendering of everything after it.

Values are now quoted through one helper that escapes what `JSON.stringify` leaves: DEL and the C1
controls, the soft hyphen, the zero-width and bidi marks, the line and paragraph separators, and the
BOM. The escape is `\uXXXX`, so the body stays valid JSON and parses back to exactly what the caller
sent. Ordinary text is untouched, accents and non-Latin scripts included, because a quoter that
escaped everything over ASCII would make a refusal about a name a human typed unreadable, which is
the same defect pointed the other way.

Review of that fix found the list wrong in the way a hand-written list is always wrong: it was
missing U+061C, U+2060, the variation selectors and the tag characters, every one of them exactly
the thing the list said it closed. The class is now the Unicode property
`Default_Ignorable_Code_Point` plus the four codepoints no property carries: DEL, the C1 range, and
the line and paragraph separators. Astral members leave as their surrogate pair, because the
five-hex form is not a JSON escape and a body carrying it would stop parsing.

Review also found a second, older defect at the same boundary, and this fixes it too. The dashboard
took a channel name from the caller in the history path and in the delete body and handed it
straight to the wire, which rewrites anything outside `[A-Za-z0-9_-]` to `_` rather than refusing
it. Two different names were therefore one channel: a history read under a name carrying an
invisible character returned another channel's messages, and the delete route purged that other
channel while answering with the name the caller typed. Both boundaries now refuse a name the wire
would rewrite, using the validator core already had for the same aliasing gap on the ACL side.
Rendering the old answer readably would only have made the lie legible.
