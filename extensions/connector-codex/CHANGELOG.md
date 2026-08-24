# @cotal-ai/connector-codex

## 0.28.0

## 0.27.0

## 0.26.0

## 0.25.0

### Minor Changes

- aa6c63d: Codex seats publish an AG-UI event plane

  A Codex seat launched with `cotal spawn --events` now publishes a structured account of its work on
  `events.<owner>.<actor>`: run boundaries per turn, assistant text, reasoning summaries, and the tool
  calls the model makes through Codex's function-call and custom-tool interfaces, each with its
  arguments, its end, and its result. Before this the connector had no event plane at all, so an
  external observer watching a mesh saw nothing from a Codex seat.

  The durable source is the thread's rollout file inside the seat's own isolated `CODEX_HOME`, not the
  live app-server stream. The file is written by the child and outlives this process's view of it, so a
  seat that restarts its own app-server picks a thread's records up where it stopped rather than from
  whatever the socket delivers next.

  Four behaviours are worth knowing before reading a stream. A turn that fails ends its run with a run
  error carrying the code Codex reported, rather than as a finished run, because Codex records a
  failure on the turn's own completion record. No user authored text is ever published: your prompts,
  the peer messages injected into the thread, and the persona's developer instructions are all
  withheld, because the events channel carries a different read ACL from the channel you typed into.
  A restarted app-server is a new thread and gets a new stream: the seat finishes the old one, closing
  any run it left open, before it begins the new one. That holds even when the new thread's file is
  slow to appear, though the order there is the other way round: the seat spends its whole bounded
  look for the successor first, and the old run is closed when that look gives up, not at the moment
  the restart happened. From the give-up on it publishes nothing until a later turn boundary binds
  the successor, rather than continuing to report the dead thread's activity as if it were live. And Codex's own built-in tools, web search, tool
  search and image generation, are not published, because their records carry an end with no start and
  no key that joins the halves.

  What is published is worth stating plainly: an observer of the events channel sees every tool call's
  arguments and outputs verbatim, so withholding user authored text does not make the stream safe to
  widen.

  Two limits are worth knowing as well. A stream begins at the last complete record in the file at the
  moment the seat binds to it, never at the beginning of the thread, so anything written before that
  moment is not republished; the seat says so in its log when it happens. And a seat whose broker was
  unreachable when it started loses its emitter, reports that it did, and rebuilds it at a later turn
  boundary once the broker is there, so the outage costs the turns it covered rather than the rest of
  the seat's life.

  Migration: none. The plane is opt in per spawn, arming is separate from authorization, and a seat
  launched without `--events` behaves exactly as before.

- a4e4c49: Codex event plane: take the stream's starting boundary at the bind, not when the emitter finished starting

  An armed Codex seat announced its stream as started at the bind, then positioned itself wherever the
  rollout file happened to be once its asynchronous setup had finished: the write-ahead log directory,
  the subject frontier, the log open, then a channel resolve and a preflight. Every record the thread
  appended inside that window landed behind the cursor and was treated as already published, so a turn
  that completed inside it was dropped permanently and silently, underneath a line that had already
  said the stream was live. The boundary is now captured at the bind, before the announcement, and
  substituted on the emitter's first read, so the announced fact is true at the moment it is
  announced. A log that already carries a cursor is a resume and keeps it, because a cursor written by
  a live emitter is the honest one.

  It is substituted rather than written into the log, and that half is what keeps a failed start from
  changing what a later one publishes. A seat whose broker is not up yet loses its emitter at launch;
  a boundary written into the log before that start would outlive it, and the next bind would read it
  as a resume and republish everything the thread wrote while the seat was cut off, onto an events
  channel whose read ACL is not the input channel's. The log's cursor is now written only by an
  emitter that started.

  Migration: a rebind after a lost connection declines to publish two things, and readers who watched
  the old behaviour should expect both. It declines what the thread wrote during the outage. It also
  declines the turn whose own boundary triggered it, because Codex writes a turn's first record before
  it announces that the turn started, that announcement is what a rebind runs on, and a run is never
  opened from the middle of a turn. The first turn to start after the rebind is published in full.
  One case is different and is stated in full rather than in passing, because it is the one a reader
  is most likely to be surprised by: if the emitter had already been publishing this thread and then
  died, its position is in the log, and the rebind continues that log rather than starting where it
  binds. An outage there costs the wait, not the content: what the thread wrote while the plane was
  down, and what it wrote while the plane was already dead, is delivered once the plane is back. Two
  things follow that a reader should not have to discover. A tool result is published as the tool
  returned it, so text a tool read on the seat's behalf from a channel with a narrower reader set
  crosses into the events channel unredacted and unattributed; and a backlog written while the plane
  was terminal is delivered rather than discarded. The session's own record of the user's words and
  the developer instructions is not published in either case. Neither carrier is introduced here and
  neither changes shape; both are the same at the merge base and no new shape is added. What this
  change does alter, on every armed seat and not only the one whose emitter never started, is which
  records reach the stream: what the thread appended between the bind and the emitter's first read
  used to land behind the cursor and be dropped, and it is published now. A whole turn can sit in
  that window, tool results included, so the carrier above covers a stretch of the session it
  previously lost. The reader set that follows from all this is a requirement and not a guarantee:
  the grant does not enforce it. A spawn through the manager gives a seat publish rights on its own
  event channel and nothing else and a spawn naming a different agent's is refused at the door, but
  that fence is the manager's, it reads the concrete form rather than a pattern, and a foreground
  spawn on your own machine grants whatever you name. Read access is minted separately and out of
  band either way, so holding the events readers to at least the width of every channel the seat's
  tools can read is the operator's policy to keep. Nothing is sent twice in either case. A seat launched
  without the event plane armed is unaffected.

  The window above is now graded rather than argued. A test-only setting widens the emitter's setup
  so a fixture can release a whole completed turn into it and assert the turn reaches the wire;
  absent, empty, zero, negative and unparseable all mean no wait, so an uninstrumented seat runs the
  path it ran before. Measured, and the reason the cell was needed: the mutant that deletes the
  boundary rule passed the suite three times in five without it, failing on disjoint cells the two
  times it failed.

- a087c2b: A spawned agent now inherits the operator's environment. A harness you installed and configured
  should behave under `cotal spawn` the way it behaves when you run it yourself, and the alternative
  was Cotal maintaining a list of inference vendors: every new provider needed a change in Cotal
  before it would work through a managed spawn. `MODEL_PROVIDER_KEYS` and the per-connector lists
  that extended it are gone, and Cotal no longer names an inference vendor anywhere in its source.

  Cotal still resets its own `COTAL_*` namespace before the child starts, keeping the machine-wide
  knobs (`COTAL_HOME`, the feedback set, the default-agent pair, the `*_BIN` overrides, the timing
  knobs). That reset is not configurable, because it is identity and not preference: a connector
  supplies the per-session names for each child and does so conditionally, so an inherited value is
  never overwritten and would hand an agent another agent's credential path, ACL, or lifecycle uid.
  The whole prefix is stripped rather than a named list, because which names a connector sets varies
  between connectors and a deny-list only ever names what its author remembered.

  To confine a spawned agent instead, declare `spawn.env` in the cotal config file. The child then
  gets a fixed OS allow-list plus exactly the names you list. An empty array is a real policy meaning
  the OS allow-list alone. Note what this does and does not buy: `HOME` is forwarded either way, so
  an agent with a shell reads `~/.aws` and `~/.ssh` regardless, and this protects only secrets that
  live nowhere but the environment.

- 34caaf4: Agent seats no longer export their connection material into the environment every descendant
  process inherits. The broker URL, the creds path, the auth token, the user-mode identity and the
  local control token now ride a private 0600 launch-material file whose path is the only thing in the
  seat's environment; pi, codex and OpenCode drop even that path once they have read it (for OpenCode
  that happens in the `opencode serve` process its seat shim starts, which is also what runs the
  session's tool calls), while claude and hermes keep the reference because their readers are
  short-lived children that start later. A session driven by hand still sets `COTAL_CREDS` / `COTAL_SERVERS` itself, and a
  launch that carries both carriers is refused rather than resolved by precedence.

## 0.24.0

## 0.23.0

## 0.22.0

### Minor Changes

- 57d3a57: A Claude session publishes a structured event plane, and the `tr-<name>` transcript mirror is
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
  the session's principal. On a static mesh that is `events.local.<key>`, where the key is what the
  manager allocated and the spawn reply carries it as `id`; on a user-auth mesh it is
  `events.<your-owner>.<agent-name>`, where the actor half is the agent's own name. `connect-claude.md`
  gives both forms. `cotal console` and the web console render event frames directly. Unlike
  `tr-<name>`, you cannot simply subscribe: the plane needs an out-of-band grant, and the command for
  it is under "To let something read a plane" below.

  What you gain and what you lose, both stated. A tool call now arrives with its full arguments, its
  end and its result, in a vocabulary a program can read, where the mirror gave a truncated one-liner
  of glyph-prefixed text. What you lose is prompt text somebody else wrote: the mirror republished
  every prompt, and the event plane withholds the body of a turn the agent did not author, because
  republishing a peer's message onto a channel that peer may not read crosses an ACL boundary. A
  peer-authored turn still opens a run and still shows the work it caused. One stated limit on that,
  because the loss column is only useful if it is complete: a tool result is this session's own output
  and is republished, so peer text quoted inside one still reaches the wire. A cell in
  `agui-authorship.smoke.ts` holds that as a measured limit rather than leaving it to be discovered.

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
  wide default (`>` read, `>` post, `spawn,role:default` scope), not "leave it alone". On a static mesh there is no
  actor ledger for `actor grant` to write to, so mint the reader instead:
  `cotal mint watcher --profile agent --allow-subscribe '<channel>' --provision`, the agent profile and
  not the observer one, since `mint` reads `--allow-subscribe` only for that profile and refuses it off
  that profile.

  `cotal mint` now REFUSES `--allow-subscribe` / `--allow-publish` off the agent profile rather than
  ignoring them. Those profiles carry a FIXED read set, the chat plane for observer and the whole
  messaging plane for admin, so
  `--profile observer --allow-subscribe <one channel>` used to exit 0, print a success line, and hand
  out a credential that reads every channel in the space: an operator asking to narrow got the
  opposite, silently. `--role` and `--provision` were already refused there for the same reason. The
  rows in `cli.md` and the sentence in `build-a-client.md` now say the same thing.

## 0.21.0

### Patch Changes

- 219d33c: `cotal spawn --agent pi --prompt <text>` now delivers the prompt as Pi's initial message (its first turn) instead of silently dropping it; an empty prompt, or one starting with `-` or `@`, refuses the launch. The connector contract no longer describes an initial prompt as something a connector may ignore: a connector delivers it or throws at launch. The other connectors follow the same rule: Claude Code and Codex refuse a prompt that is empty after trimming instead of dropping it, and Hermes refuses an initial prompt outright until its first turn is wired.

## 0.20.1

## 0.20.0

## 0.19.0

### Minor Changes

- 4e8d776: The `cotal_*` tools now refuse an argument they do not model instead of silently
  dropping it. A call carrying an unmodelled key (`owner` or `actor` alongside the
  real arguments) previously succeeded with that key stripped before the tool ran,
  so the caller was told nothing and the tool did something other than what was
  asked. It is now refused by name, on every adapter and on every tool: the MCP
  renderers and pi publish a closed schema and the host rejects the call, while
  OpenCode and Hermes pass the caller's object through untouched and are closed at
  the connector's own dispatch. Tools that take no arguments are closed too: they
  were previously published with no schema at all, so a host had nothing to check
  against and forwarded the extras to be dropped, as is `cotal_inbox`, whose
  arguments four of the connectors replace with their own. Behaviourally breaking
  for any caller that was relying on extra keys being ignored. Every refusal names
  the rejected keys; where the connector is the one refusing it also lists the
  arguments the tool accepts, or says it takes none.

## 0.18.0

## 0.17.0

## 0.16.0

## 0.15.0

### Minor Changes

- f89560a: New Codex connector (`--agent codex`): an OpenAI Codex session as a full lateral mesh peer, in Codex's own TUI. A host-mode peer drives a `codex app-server` thread over JSON-RPC: inbound batches wake a real turn, and directed messages steer INTO a live turn mid-flight.

  `cotal spawn --agent codex` opens Codex's own TUI. The app-server runs as a loopback websocket listener guarded by a per-incarnation capability token (0600, inside the agent's private home), and the TUI attaches to the very thread the mesh drives, so mesh turns render as they happen and anything you type is a real user turn on that same thread. With no terminal (piped output, CI, a smoke) the host stays headless with an activity feed instead; `COTAL_CODEX_TUI=1|0` picks the mode explicitly when the tty check would guess wrong. Once Codex owns the terminal the host's own log moves to `host.log` in the agent's private home, and the handoff line names that path so a later failure is findable.

  The shared `cotal_*` tools are served by the host process itself over a bearer-authenticated loopback MCP endpoint, with the token passed to codex by env var name so it never reaches the process table. Because the app-server is the MCP client, the same tools work on a mesh-driven turn and on one typed into the TUI; the connector's own tools are pre-approved so an unattended agent never stalls on an approval prompt nobody is watching, and `mcp_servers.cotal.*` is reserved and refused rather than silently overridden.

  Autonomy defaults suit an agent woken by peer messages when nobody is watching: `approval_policy=never` (never ask before running a command, not refuse), `sandbox_mode=workspace-write`, and `sandbox_workspace_write={network_access=true}`. Network is on because Codex's own workspace-write default has it off, which breaks installing a dependency or pushing a branch with an error that reads like the task is impossible rather than the sandbox refusing; filesystem containment is kept, because a peer's message is a remote input that can make the agent run commands. The network default is applied only where the sandbox is actually `workspace-write`, so tightening the mode does not leave a network grant in the launch. All three are overridable per spawn with `--opt` (including `sandbox_mode=danger-full-access` for no sandbox at all), while an interactive `approval_policy` is refused loud rather than auto-answered on the operator's behalf.

  The guide states the sandbox's guarantee literally: it blocks out-of-workspace local filesystem writes, and does not block reads, exfiltration, or networked side effects. With the network on, a peer-driven turn can read broadly and send what it reads, reach loopback and link-local services, and act through any credential it can read, including irreversibly, via a force-push or an API delete. Containing filesystem writes is not the same as containing damage, and the docs say so rather than implying the residual is disclosure-only. The offline, tighter-mode, and separate-OS-user mitigations are named in both the autonomy section and Limits.

  At-least-once delivery with exact-id acks on turn completion: a failed turn retries with backoff, an interrupt redelivers, and an app-server crash restarts the child in place on the same mesh lifecycle and re-drives the un-acked batch (a crash loop is fatal, never an endless respawn). Presence from the event stream, an opt-in transcript mirror, model catalog + reasoning-effort variants (`cotal models --agent codex`, `--variant`), `--opt` passthrough to codex `-c` config overrides, and a private per-agent `CODEX_HOME` (operator config/hooks/MCP servers never load; auth.json symlinked; trust writes never touch the operator's config). Unwired options fail loud: `--resume` (a resumed codex thread comes up without its configured MCP servers, so the agent would be mute on the mesh) and tool-sharing.

  Also fixes the seed reconciler, which treated a generation match alone as up-to-date: a built-in connector added at an unchanged generation would never seed on an already-installed workstation (`--agent codex` reporting no connector installed). Both fast paths now also require every `SEED_BUILTINS` entry to be present in the ever-seeded set.

  A connector can now declare `launchHint`, the one line a foreground `cotal spawn` prints about what to expect next. That text used to be hard-coded to Claude Code's first-run gate for every agent type, telling operators of other harnesses to press Enter at a prompt that never appears.

  The web dashboard gains Codex branding (the OpenAI mark, from Simple Icons), so a codex agent renders with an icon and a label instead of a blank badge. That map was hand-maintained with nothing tying it to the connector set, so it is now covered by a test: every official connector must have a complete entry, and a new connector cannot ship icon-less with a green suite again.
