---
"cotal-ai": minor
"@cotal-ai/core": minor
"@cotal-ai/connector-core": minor
"@cotal-ai/cli": minor
"@cotal-ai/web": minor
---

Display an agent event frame, and separate event channels from chat.

An `ag-ui.frame` part carries no text part by design, so every surface that renders a message as
flat text drew one as `[unrenderable part kind "ag-ui.frame"]`. A renderer now folds a frame's
events into readable lines: streamed text and reasoning deltas accumulate into one line rather than
one line each, a tool call reports its name, its arguments and its result, and a stream that ended
without its terminator is flushed and marked truncated instead of being dropped. An event type this
build does not know is named rather than skipped, because a skipped event is a hole in a transcript
that still looks complete. It registers through the part-renderer seam, so the standard resolves it
by the part's own kind and never learns what the vocabulary means.

The renderer is loaded by the composition root rather than by a connector. Connectors are removable
extensions materialized on demand, and no surface that renders imports one, so a provider that
registered only inside a connector would be absent from every process that draws.

The event channel's name and its classifier move into the standard, beside the frame's identity.
Both are things a reader needs in order to recognise an agent's stream without knowing which adapter
produced it, and the two surfaces that most need to classify cannot reach an extension package at
all. The constructor is re-exported from its former home, so no caller changes.

The classifier is now a derivation rather than a prefix test, and the two disagree on names a real
mesh produces. Nothing reserves the `events.` prefix, so a channel a human created and talks on
answered yes to "does this start with `events.`" and was swept out of the chat pane it was sent to.
A name that does not resolve to a principal is no longer treated as machine traffic, which returns
those channels to the view, and leaves a malformed publisher visible rather than hidden. The
collision is narrowed rather than closed: a chat channel whose remainder is itself principal shaped
is still indistinguishable from an agent's stream, and closing that means reserving the prefix on
the wire.

The console keeps event channels out of the channel strip and out of the history prefill. The order
matters more than the result: the channel list carries one entry per retained subject, so filtering
after the fetch would read history for every event channel and discard it, which is unbounded work
to display nothing. Live rows are marked rather than dropped, because hiding them would delete the
only traffic this change taught the console to draw.

The dashboard gains the same rendering through a per-kind lookup, so its dispatcher stays ignorant
of every kind anyone teaches it. A renderer that throws, returns a non-string, or shares a name with
an inherited object method is reported by name instead of blanking the body. The browser cannot
import the shared renderer, so the two implementations are held together by an executable
equivalence check rather than by intent.

The example harness records a message through the shared renderer instead of keeping only its text
parts, so a message whose content is not text is no longer written to the transcript as an empty
string and scored as an agent that said nothing.

No connector emits a frame yet, and no transcript mirror is removed. Display lands first on purpose:
a cutover shipped before a renderer would replace a readable mirror with a part every surface shows
as a marker.
