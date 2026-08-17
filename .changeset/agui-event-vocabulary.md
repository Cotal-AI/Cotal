---
"@cotal-ai/core": minor
"@cotal-ai/connector-core": minor
---

Adopt the AG-UI event vocabulary, and give a frame a wire identity a reader can recognise.

Cotal's agent-event stream carried glyph-prefixed text, so a consumer could display it and do nothing
else with it. The vocabulary replaces the payload: typed events with real identities, an envelope that
carries its own ordering, and a validator a surface can execute.

Core gains the frame's identity: the `ag-ui.frame` part kind, the event `type` discriminators, and
`isAguiFramePart`. It lives in core rather than in a connector because every connector emits it and
none may redefine it, which is what makes it a protocol shape rather than an adapter's choice. What
stays out of core is producer-side: the envelope version and every event constructor.

`@cotal-ai/connector-core` gains the vocabulary itself: the constructors, the frame envelope,
`parseAguiFrame`, the `AguiBrackets` stream machine, and the `cotal.*` CUSTOM table, which is empty
in v1. `parseAguiFrame` throws with the offending field named and `isAguiFramePart` never throws,
because routing and validity are different questions: collapsing them would make a protocol skew look
exactly like someone else's message, and a surface would show an empty pane for a stream it was
actively failing to parse. A protocol mismatch and an unrecognised event type are both refused rather
than partially rendered, since a skipped event is a hole in a transcript that still looks complete.

Bracketing is a property of a writer's stream and not of a single frame, so `AguiBrackets` is fed
frame after frame. A frame may legally open a run and not close it.

Nothing emits yet. The channel derivation, the payload-size split and the publishing emitter are not
in this change, and no connector constructs a frame outside a test.

`@ag-ui/core` is an exact-pinned, types-only devDependency: it declares zod as a runtime dependency
and connector-core is bundled into every seeded connector, so importing it at runtime would ship a
second zod major to every customer in order to validate events Cotal constructs itself. The
conformance suite imports the real schemas and parses every constructor's output under the schema
that owns it, which is what keeps the hand-written literals honest.
