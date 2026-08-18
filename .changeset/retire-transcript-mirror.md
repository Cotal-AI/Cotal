---
"@cotal-ai/connector-claude-code": minor
"@cotal-ai/connector-opencode": minor
"@cotal-ai/connector-codex": minor
"@cotal-ai/connector-core": minor
"@cotal-ai/manager": minor
"@cotal-ai/workspace": minor
"@cotal-ai/core": minor
"@cotal-ai/cli": minor
"cotal-ai": minor
---

A Claude session publishes a structured event plane, and the `tr-<name>` transcript mirror is
retired

A session launched with `cotal spawn --events` now actually publishes. The Claude connector maps
its session records to structured events behind the same hook relay the mirror used to sit behind:
run boundaries per turn, assistant text, reasoning, and each tool call with its arguments, its end
and its result, written to a per-session write-ahead log before they go on the wire so a restart
resumes at its cursor instead of replaying or skipping. Until now no connector constructed the
emitter at all, so every event channel was empty.

The `tr-<name>` mirror is removed in the same change rather than deprecated alongside it. Gone with
it: the `--transcript` and `--no-transcript` flags on `cotal spawn`, the `transcript` field on the
manager's spawn op and its service contract, `COTAL_TRANSCRIPT` and `COTAL_TRANSCRIPT_DEFAULT`,
`LaunchOpts.transcript`, `Connector.transcriptChannel`, and the mirror in all three connectors that
carried one.

MIGRATION. If you read a `tr-<name>` channel, nothing publishes to it any more. A managed session no
longer mirrors its prose there under any flag or environment variable, and a spawn that passes
`--transcript` now fails on an unknown flag rather than being ignored. Read the session's event
channel instead: launch with `--events` and subscribe to `events.<owner>.<actor>`, which is keyed on
the principal the manager allocated rather than on the display name. `cotal console` and the web
console render event frames directly. The plane carries strictly more than the mirror did, since a
tool call arrives with its arguments rather than as a truncated one-liner, and it carries it in a
vocabulary a program can read rather than glyph-prefixed text.

A spawn may be granted the event plane of the agent it is creating, and no other. A spawn that names
a different agent's event channel in `allowSubscribe` or `allowPublish` is refused at the door,
because that channel carries the session's tool inputs and outputs. Grant a reader out of band with
`cotal actor grant`.
