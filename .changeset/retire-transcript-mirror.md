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
the principal the manager allocated rather than on the display name. On a static mesh `<owner>` is
the literal `local`. `cotal console` and the web console render event frames directly. Unlike
`tr-<name>`, you cannot simply subscribe: the plane needs an out-of-band grant, and the command for
it is under "To let something read a plane" below.

What you gain and what you lose, both stated. A tool call now arrives with its full arguments, its
end and its result, in a vocabulary a program can read, where the mirror gave a truncated one-liner
of glyph-prefixed text. What you lose is prompt text somebody else wrote: the mirror republished
every prompt, and the event plane withholds the body of a turn the agent did not author, because
republishing a peer's message onto a channel that peer may not read crosses an ACL boundary. A
peer-authored turn still opens a run and still shows the work it caused.

A spawn may be granted the event plane of the agent it is creating, and no other. A spawn that names
a different agent's event channel in `allowSubscribe` or `allowPublish` is refused at the door,
because that channel carries the session's tool inputs and outputs. The same rule runs on a manager
resume: a retained inventory naming another agent's event channel is refused rather than adopted.

The rule reads a **concrete** channel, two principal tokens and nothing else. A pattern such as
`events.<owner>.>` is not an event channel to it and passes untouched, governed by ordinary ACL
authority. That is deliberate, since the pattern is the form an operator writes on purpose for an
observer.

To let something read a plane, grant it out of band. The refusal prints one command, spelled out in
full, for the mesh it is running on. On a user-auth mesh:
`cotal actor grant <reader> --owner <owner> --scope '' --allow-subscribe '<channel>' --allow-publish
''`, every field named because `actor grant` is an upsert of the whole row and an omitted flag is the
wide default (`>` read, `>` post, `spawn` scope), not "leave it alone". On a static mesh there is no
actor ledger for `actor grant` to write to, so mint the reader instead:
`cotal mint watcher --profile agent --allow-subscribe '<channel>' --provision`, the agent profile and
not the observer one, since `mint` reads `--allow-subscribe` only for that profile and refuses it off
that profile.

`cotal mint` now REFUSES `--allow-subscribe` / `--allow-publish` off the agent profile rather than
ignoring them. The observer and admin profiles carry a fixed read set over the whole chat plane, so
`--profile observer --allow-subscribe <one channel>` used to exit 0, print a success line, and hand
out a credential that reads every channel in the space: an operator asking to narrow got the
opposite, silently. `--role` and `--provision` were already refused there for the same reason. The
rows in `cli.md` and the sentence in `build-a-client.md` now say the same thing.
