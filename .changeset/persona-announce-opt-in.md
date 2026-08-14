---
"@cotal-ai/connector-core": minor
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

The announcement was never how peers discovered a persona: it named one and nothing else, and a peer
joining afterwards never saw it. Discovery is the catalog — `cotal personas list` / `show` read it
directly within a workspace — plus `cotal_spawn` failing loud on a name that does not exist.
