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
