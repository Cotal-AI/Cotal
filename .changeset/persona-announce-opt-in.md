---
"@cotal-ai/connector-core": minor
"@cotal-ai/core": minor
---

`cotal_persona`: defining a persona no longer announces on the mesh by default

Defining a persona used to post "persona X is now available — spawn it to bring it online" on the
definer's first concrete channel — `#general` for most personas, since nothing ever chose the
destination: the send passed no channel, so it fell through to whichever concrete channel happened
to be first in the caller's list. Standing up a review panel therefore put one broadcast per seat
into every peer's inbox, and the wording read as an instruction to strangers to launch an agent they
knew nothing about, from a principal they had no relationship with.

`cotal_persona` and `MeshAgent.definePersona` now take an optional `announce` channel:

- **Omitted (the default): silent.** Nothing is published.
- **Supplied: that channel only**, never one inferred from ordering, with post rights enforced by
  the broker as for any other message and no fallback. The channel is validated before the write, so
  an empty string, a wildcard, or a name the subject layer would rewrite is refused loudly rather
  than publishing somewhere you did not name.
- The message is now a statement of what the sender did rather than an imperative aimed at the
  reader.
- A persona whose announcement is refused is reported as **saved but not announced**, pointing at
  `allowPublish` — not as a failed definition, which named the wrong fix and invited a retry that
  posted the duplicate.

No durable or deliberately-consultable read path is removed: `cotal personas list` / `show` read the
catalog directly within a workspace, and `cotal_spawn` still fails loud on a name that does not
exist. What is lost is unsolicited awareness of a bare name — real discovery, but incidental,
incomplete (no prompt, model, or role) and invisible to anyone who joined later.

`@cotal-ai/core` gains `isPublishPermissionDenied`, a public helper beside `isPermissionDenied` that
is true only for a typed permission violation whose `operation` is `"publish"`. `isPermissionDenied`
is deliberately operation-agnostic — it separates a denial from a missing service, where the
operation is irrelevant — so it cannot answer "did this message get stored?". A JetStream publish is
request/PubAck, and a denial on the reply-inbox *subscription* rejects `js.publish()` while the
stream may already hold the message. Callers that report delivery must ask the narrower question.
