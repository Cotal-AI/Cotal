# @cotal-ai/web

## 0.29.1

## 0.29.0

## 0.28.2

## 0.28.1

## 0.28.0

### Minor Changes

- 316f84d: Cap the dashboard delete route's request body at 8 KiB.

  `POST /api/channel/delete` read its body with no size limit and no look at `content-length`, so the
  ceiling on a request was the process heap: a 30 MB post was read in full, answered with a 70 MB
  refusal, and cost 1.39 GB of peak RSS before the route formed any opinion.

  The read now refuses at the threshold with a `413` naming the limit and the size that met it, on
  both the declared length and the bytes as they arrive, so a body with no declared length is capped
  too. It is never truncated to fit: a shortened channel name is a name the caller did not send, which
  is the aliasing shape this route's validator already exists to refuse. Bodies under the cap, extra
  fields included, are untouched.

  The refusal also closes the connection the oversized body arrived on. Without that, a caller asking
  to keep the connection alive still got to send every byte, because the server reads the rest of a
  body to get the socket back for reuse: the refusal was early but the work was not bounded. Ordinary
  within-cap requests keep their connection and their socket stays reusable.

  `@cotal-ai/connector-core` is listed because it ships the docs bundle, which embeds the page this
  change updates and is regenerated here. Its only diff is that regenerated file.

## 0.27.0

## 0.26.0

## 0.25.0

### Minor Changes

- de4f0ee: Open the graph view's live feed as the page loads, not after it.

  The connection pill is driven by the `/feed` EventSource opening, and the page chained that behind
  its whole bootstrap. The bootstrap reads the activity and DM backfills, both bounded by the
  aggregation deadline, so on a slow link the graph's connection pill stayed down for the entire load
  window and only then went live. Measured in Chrome against a local broker behind an 80ms-each-way
  link with 40 channels: the pill first said `live` at 8052ms, tracking the slowest bootstrap read at
  8044ms. With the feed opened first it says `live` at 89ms while that read still runs to 8066ms. An earlier fix stopped the bootstrap from rejecting, which guaranteed the feed
  would be opened but not that it would be opened soon.

  The feed now opens first and the bootstrap fills in around it, which is what the Monitor page has
  always done. A page showing stale data is exactly the one that needs its live feed most.

  Opening it first introduces an ordering the chained boot could not produce, so the change carries the
  rule for it. Every bootstrap read is issued before its value is applied, so a snapshot is at least as
  old as the moment it was requested, while a live event is newer than that moment. A roster or
  membership arriving mid-bootstrap was therefore reverted when the older snapshot landed, and the
  agent the feed had just announced disappeared from the graph. Both channels carry a full snapshot
  through the same apply, so a live event now replaces the read rather than being overwritten by it.

  What is superseded is the source, not the snapshot. Membership speaks in two sentences, a snapshot
  and a refusal, and either side can say either one, so the rule covers all four: a live refusal is no
  longer erased by an older successful read, and a startup read that refuses no longer overrules a
  newer live snapshot. Both of those ended with the header pill making a claim about the mesh that was
  really a claim about one read, which is the one thing that pill exists not to do.

- b501ec5: Parse the dashboard's history limit once, and bound the single-channel read.

  Three history routes each re-derived the same limit parse, so a value that was not a whole number
  took a different wrong path through each of them. `Number("abc")` is `NaN` and every comparison
  against `NaN` is false, so the endpoint's `limit <= 0` guard never fired and its widening history
  search could never reach either exit: the read did not return everything, it never returned, and the
  abandoned request kept consuming CPU long after its caller had gone. `Infinity` reached the same
  hole from the other end and returned a channel's entire retained history.

  The limit is now parsed in one place and a value that is not a whole number is refused with a 400
  naming what it received, so a caller's mistake is no longer reported as a server fault. The same
  holds for the channel name in the URL: an escape that cannot be percent-decoded is a caller's typo
  and is answered as a bad request rather than as the server having broken.

  For every caller that does not go through those routes, the endpoint now requires a history limit to
  be a whole number of messages it can count exactly, not merely a finite one. A page is taken with
  `slice(-limit)` and slice truncates toward zero, so any limit between zero and one became `slice(0)`
  and returned the subject's entire retained history; a magnitude past exact counting did the same. The
  check sits above the empty-page check on purpose, since `-Infinity` is less than zero and would
  otherwise be folded into a silent empty page.

  The single-channel history read now carries the same per-request deadline as the aggregate routes,
  with a named refusal, because the console view re-reads it on every poll. Zero still means zero,
  negatives still mean an empty page, and an absent or empty limit still means the route's default.

- 6959679: The dashboard survives a poll that fails, and its aggregation answers instead of failing.

  A failed poll used to clear the peers and the channels. A 500's body is valid JSON and `fetch` does
  not reject on one, so the refusal arrived as a successful parse and was stored as the snapshot. Reads
  now refuse a non-200 by name, a refused read leaves the value the page already holds exactly where it
  is, and the header says which source is stale and why. Recovery is the next successful read.

  `/api/activity` no longer fans out every channel's history at once with no upper bound, where one
  channel's rejection became the whole route's 500 and a slow link produced a 34-second success.
  Sources race one shared deadline through a bounded pool, and the page always carries `partial`, the
  counts, the named missing sources, and the deadline it used, so a short page cannot be mistaken for a
  complete one. `/api/dms` is one read with no subset to serve, so its bound is a 503 that names the
  deadline. A channel list that cannot be read is a refusal that says so rather than a page claiming
  the space is empty.

  The elevated observer/admin credential can now delete consumers on its own presence bucket. A KV
  watch rebuilds itself when the link stalls and each rebuild deletes its predecessor; without that
  grant the cleanup was refused, so orphaned consumers accumulated until their inactivity threshold and
  the broker logged a violation every time.

- 0f16f21: web: a refusal renders the value it names, instead of echoing it back invisibly

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

  A second review pass found the property boundary still short: the interlinear annotation controls
  U+FFF9 to U+FFFB are format characters and not default-ignorable, so they arrived raw. They are the
  clearest form of the harm in the issue, since they mark a span as base text plus its gloss and a
  reader whose terminal does not implement them sees the two runs concatenated into a sentence nobody
  wrote. The class now carries both properties, which adds 32 codepoints, none of them a letter or a
  digit. A swept cell puts every codepoint from 0 to 0x10FFFF through the quoter and compares the
  result against the union the code claims, so a dropped alternative or a mistyped range is caught for
  every codepoint rather than for the ones a list happens to name.

  Review then pushed on the boundary from the other side, with U+0338 COMBINING LONG SOLIDUS OVERLAY
  arriving raw, which is a fair question against the harm as it was first stated: it does change what
  a reader sees. It is excluded, and the exclusion is now asserted rather than described. A combining
  mark makes a visible mark on a visible base, and the property carrying it also carries the accent
  in a name written in NFD, the Devanagari vowel signs, the Arabic and Hebrew points and the
  Vietnamese tones; escaping marks would take about 2280 codepoints of ordinary written language and
  render an accented name as its escapes, which is the same defect this change refuses to open on the
  letter side. The stated class is narrowed to say what the code does, characters that produce no
  glyph of their own or that reorder the text around them, and three cells pin the exclusion,
  including the strongest case against it, a mark over an equals sign rendering as a not-equals sign.
  That case is the confusable problem, which needs no combining mark to exist and is not answered by
  a quoter.

## 0.24.0

## 0.23.0

## 0.22.0

## 0.21.0

## 0.20.1

## 0.20.0

### Minor Changes

- 757e322: Order event frames on the dashboard, and stop listing and backfilling every agent's event channel.

  The dashboard opens its live feed and only then fetches the backfill, so it is the surface that runs
  the two-phase bootstrap rather than one that can assume an ordered stream. A frame's position in its
  stream is its sequence number, and that is the only thing that can say a frame is MISSING; message-id
  dedupe cannot, because two ids are either equal or they are not, which says nothing about what
  belongs between them. Frames arriving while the fetch is in flight are now held and released in
  sequence order once the batch settles, the baseline is the settled batch's minimum rather than the
  first frame observed, and sequence checking is not armed until the boundary passes. Baselining on
  arrival would read the entire backfill as running backwards, and arming early would read the same
  backfill as a hole.

  A baseline above the first sequence means the retained prefix has rolled, so the chain is marked
  incomplete and applied forward. A discontinuity after the baseline is a fault, reported with both
  ends named. The two are never reported as one thing, because the first is what always happens and the
  second is what must never pass unnoticed. A detected gap still draws its frame: holding it back until
  a missing predecessor arrives would hold it forever when that frame is genuinely gone, which turns a
  visible gap into a silent loss. The retained batch is audited across its whole range and not only at
  its ends, because a hole inside retained history leaves the baseline and the frontier both correct
  and every later frame following contiguously, which is the one discontinuity no live arrival can
  reveal.

  What the bootstrap finds is now DRAWN, above the rows, in the all-activity feed and in a channel
  view. Four things are said separately rather than as one warning: frames are missing, a start-up hole
  could not be attributed, a retained prefix had rolled before this reader joined, and history was
  unavailable. The live tap and the history read are two reads with no shared cut, so the first frame
  buffered during the fetch can sit above the retained top with nothing lost at all; that one hole is
  reported as unconfirmed rather than as loss, and a hole between two buffered frames, which arrived
  through the same subscription, still is a fault. A history read that fails is treated as the empty
  batch it cannot be distinguished from, and the surface says so, so the ordering degrades in the open
  rather than quietly.

  The all-activity feed and the selected-channel view now MERGE their backfill with what arrived live
  during the fetch instead of assigning over it. The assignment discarded every live arrival in that
  window. Retention hid it, since the backfill re-read the same messages from the broker and they came
  back, and the filter below is what would have turned it into a real loss.

  The channel list and the all-activity backfill carry chat only. A channel row is derived from every
  retained concrete subject and the chat stream caps per subject rather than by age, so an unfiltered
  list grows by one row per agent that has ever run and never shrinks: the sidebar fills with machine
  streams, the graph page grows a node for each, and the activity route pays one history round trip per
  event channel to merge results nobody reading chat asked for. The filter runs before the fetch, not
  on its output, so the round trips are not paid and then discarded, and it uses the shared classifier
  rather than a local prefix test, because a human channel called `events.standup` is not
  principal-shaped and must stay where it was being read.

  Two things are deliberately left unfiltered. The live feed still carries frames, marked rather than
  dropped, since dropping them would delete the only traffic this surface was just taught to draw.
  History for a channel named explicitly is still served, or the dashboard could render a frame it
  could never fetch.

## 0.19.0

### Minor Changes

- a1bc784: Display an agent event frame, and separate event channels from chat.

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

- b3295d2: The membership pill said "unreadable" while the layout kept acting on the snapshot it had just
  disowned: `hide empty` was gated on `feed.available`, which an unreadable feed leaves true, so a hub
  was still collapsed as empty on the strength of a reading the page could no longer make. Hiding now
  requires the feed to be authoritative, meaning available and readable. The snapshot itself is kept:
  `asOf` still records when the feed was last read successfully, which is true and worth showing.

### Patch Changes

- c3dd6a5: fix(web): route on the channel the broker policed, not the one the publisher claimed

  The browser dashboard decided which channel a message belonged to by reading `msg.channel` off the
  payload. That field is written by the publisher, and the broker polices **subjects**, not payload
  fields, so a sender could put any channel name in a message body and have the dashboard file it
  into that channel's transcript, including a channel the sender had no permission to publish to.

  The verified channel was already available and was being discarded: the observer parses the subject
  to recover the authenticated sender, then dropped the rest of it. Routing now uses the channel
  derived from the subject the broker actually enforced. Where no authoritative channel exists
  (direct messages and anycast carry none), the publisher's claim is cleared rather than trusted, so a
  forged value cannot survive into a transcript, a channel list, or an unread badge.

  Two rendering fixes ride along, because a message whose content vanishes is the same class of defect
  one surface over. A part kind the surface has no renderer for previously produced an empty body, so
  a message with content displayed as a blank line; it now renders a marker naming the kind, and a
  part carrying data keeps that data instead of having it replaced by the marker. A surface that
  prints a marker while dropping the content looks like successful rendering, which is precisely the
  failure being removed. The two dashboard surfaces now share one parts renderer so they cannot drift
  apart on what a part looks like; that drift is how the original defect reached both of them.

  **Limits worth stating.** The new suites drive the served JavaScript directly: they execute the
  shipped handler and backfill functions and assert message content and destination, but no cell opens
  a browser or asserts rendered HTML, so this proves the routing and the renderer's return value, not
  that either survives to the pixels. Rendering of external observer/UI event frames, and the filter
  that selects them, are separate work and are untouched here. The dashboard's loopback HTTP surface
  is unauthenticated and this change does not alter that; a failed membership read still renders as a
  successful empty result, so a viewer cannot distinguish "nobody is subscribed" from "the read
  failed". Both predate this change and are named so the routing fix is not mistaken for making that
  surface safe.

- 0e44e37: fix(web): tell the browser a membership read failed instead of serving it as empty

  The dashboard's `/api/membership` route answered a failed read with `{asOf: undefined, members: []}`
  and a 200. `JSON.stringify` drops a key whose value is `undefined`, so those bytes are
  `{"members":[]}`, byte-identical to a successful read of a space where nobody is subscribed. The
  graph then reported the feed as `membership: traffic-only`, which asserts that the mesh publishes no
  membership feed, when the truth was that the read did not answer.

  A failed read now carries a 503 and names its condition; the two server-sent-event paths emit a
  named event instead of swallowing the rejection; and the page stops manufacturing an empty snapshot
  from a failed fetch or a non-200. The freshness pill gains an `unreadable` state, tested before
  `traffic-only` so a refusal cannot borrow that phrase.

## 0.18.0

## 0.17.0

## 0.16.0

### Minor Changes

- 498055c: Stop paying one network round trip per record, and return the recent messages history claimed to return.

  Several read paths issued one sequential round trip per record, which is invisible against a loopback
  broker and ruinous on any ordinary cross-continent link. Measured against a mesh at 534ms RTT with
  healthy uplinks at both ends, reading the membership feed took 30 to 34 seconds for 89 entries; it
  now takes under a second for 93.

  - `liveKvEntries` is the one sanctioned full-bucket KV read: a single pass whose request count is
    independent of record count, which collapses by greatest revision with tombstones so a deleted key
    cannot resurrect, and which binds its own consumer so that an empty result is PROVEN by the
    bind-time pending count rather than inferred from silence. A pass that is cut short raises rather
    than returning what arrived. That distinction is load-bearing on the ACL path: read this way, a
    dropped link mid-scan would otherwise report a provisioned principal as having no ACL row, and a
    durable join would be refused as "not provisioned" instead of as "could not read". The membership
    feed, the members and channel registries, and the ACL alias enumeration all read through it. No
    change to broker authority: the same ordered push consumer over the same subject.
  - `channelHistory` and `dmHistory` returned the OLDEST messages on any channel holding more than the
    requested limit, while being documented as recent and rendered everywhere as the latest. They now
    return the newest, read through a bounded window rather than by draining the backlog.
  - `cotal status` started the Claude CLI twice for data one listing contains.

  Two optimisations were attempted and REVERTED during review, and are not part of this change: the
  dashboard's activity feed still fetches a full page per channel (the cheaper version dropped
  genuinely-newer messages, because saturation counts messages rather than recency), and control
  commands still open a probe connection before the real one (skipping it flattened typed auth
  failures and lost the probe's deadline).

  This is the read-path half of the work. The registry-safety half — a failed network probe must not
  delete a mesh record — is a separate change on top of the `origin`/`pruneMesh` model from
  `cotal meshes add`.

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

## 0.14.11

## 0.14.10

## 0.14.9

### Patch Changes

- a4c082a: `cotal down web` now works from any directory. The dashboard starts target-resolved (registry current mesh first) and records its pidfile under the target mesh's root, but a selective `down` only looked under the folder it ran in and reported "Nothing running for web" while the dashboard kept running. A `LocalProcess` can now declare `rootedAt: "target"`; `down` resolves such components through the same mesh-target resolution the start side uses, with a new `cotal down web --space <name>` to name the mesh explicitly. Bare `cotal down` remains a folder-scoped sweep, and folder-rooted components refuse `--space`.

## 0.14.8

## 0.14.7

## 0.14.6

## 0.14.5

## 0.14.4

## 0.14.3

### Patch Changes

- fce3199: Report which machine an agent runs on, and fix three defects that only appear once a mesh spans hosts.

  **`meta.host` on the agent card.** A mesh can span machines: a manager on another box launches
  agents into its own host, so "where is this agent actually running" was unanswerable from the
  roster. Each session now publishes its own `os.hostname()` as `meta.host`, overlaid last like
  `meta.connector` so an agent file cannot claim a host it is not on. It is advisory display
  metadata only, never an authorization or routing input, and the dashboard renders it with no
  change (unknown meta keys already display generically). `SPEC.md` records it alongside the other
  reserved `meta` keys.

  **`cotal up --host <addr>` killed the broker it had just started.** The bind address and the
  broker URL were tracked independently, so `--host` bound one address while the readiness probe
  still used the loopback default. The probe found nothing, timed out, and the caller SIGTERM'd a
  broker that had started correctly, which made `--host` alone impossible to use. The two are now
  reconciled: with no explicit `--server`, the URL is derived from the host; a contradicting pair is
  refused with one sentence instead of starting something unreachable; and wildcard binds
  (`0.0.0.0`, `::`) correctly keep a dialable loopback URL rather than advertising the wildcard. The
  manifest path (`broker.host` without `broker.servers`) had the same defect and shares the fix.

  **One slow probe silently unregistered a live mesh.** `pruneStaleMeshes` deleted any registry
  entry that failed a single reachability check whose budget is 1s, which a healthy broker across a
  slow or jittery link misses routinely. Deletion is destructive and, for a mesh this machine did
  not start, unrecoverable, since only `cotal up` writes registry records. A first failure now only
  makes an entry a candidate; it is pruned only if a second, longer probe also fails. A genuinely
  dead mesh still prunes.

  **A timed-out request killed the whole dashboard.** `cotal web` passed an async listener to
  `createServer`, so a rejection inside any route (for example a JetStream call timing out against a
  slow broker) became an unhandled rejection and took the process down on the first slow request.
  The dashboard is a read-only observer: a failing route now returns 500 and the server stays up.

## 0.14.2

## 0.14.1

## 0.14.0

## 0.13.2

### Patch Changes

- 6960658: The web dashboard now ships and versions with the `cotal-ai` binary. Previously `@cotal-ai/web` was fetched separately on its own version line, so upgrading the CLI (`npm i -g cotal-ai@new`) left the dashboard stale, and the documented `cotal ext add @cotal-ai/web` could not cross the 0.x caret to reach the new release, leaving customers on an old dashboard with no clean way forward.

  web is now a bundled first-party extension alongside the connectors: it is carried inside the `cotal-ai` package and the boot reconcile installs and version-refreshes it from that bundled payload at the binary's own version. So `npm i -g cotal-ai@X` brings the dashboard to X automatically and offline on the normal upgrade path, exactly like the connectors (a deliberate operator pin or a rollback is the operator's choice, same as any connector). To make this possible, web is repackaged to be self-contained — its marked/DOMPurify browser builds are copied into its own `dist` and served from there instead of resolving `node_modules` at runtime — so it seeds with no runtime dependencies.

  The bundle path is hardened so the update stays clean and verifiable: the prepack asserts every seeded payload's `name` and `version` match the umbrella (the `fixed` group keeps them lockstep), the reconcile verifies each (re)installed extension is recorded, on disk, and at the generation version before it stamps success (a version-skewed payload fails loud), and web publishes a `vendor-manifest.json` (name/version/license/sha512) of its bundled marked/DOMPurify so the shipped browser libs stay auditable.

## 0.13.1

## 0.13.0

### Minor Changes

- d15b357: Substantially improve the observability dashboard: Markdown rendering in message
  bodies (with expand/collapse-all), attention (dnd/focus) and per-channel
  quiet/muted indicators, channel replay + delivery-class shown at a glance and in
  detail, model·variant + harness badges on the roster and graph, richer graph
  node cards (agent description/tags, channel durability), resizable sidebars and
  nav sections, and assorted layout/legibility fixes.

  Adapt the observer tap for v0.4: subscribe the messaging planes (chat, inst, svc)
  individually instead of the space-wide `>`, so the dashboard no longer taps the
  v0.4 endpoint request rails.

## 0.12.0

## 0.11.6

## 0.11.5

## 0.11.4

## 0.11.3

### Patch Changes

- Version alignment: `@cotal-ai/web` joined the workspace's fixed release group, so its version now tracks the rest of the packages. It had lagged at 0.11.1 while the group reached 0.11.3; this republishes it at 0.11.3 to close the gap. No functional changes.

## 0.11.1

### Patch Changes

- 93fd521: Add the installable Orca runtime, registry-driven extension providers and local-process lifecycle,
  selective shutdown, and `cotal endpoints` for the complete live presence roster.

## 0.11.0

### Minor Changes

- 9061d0e: feat: per-user authentication (owner+actor identity, IdP login, credential death)

  Add per-user auth as a first-class mesh mode. A mesh brought up with `cotal up --user-auth --idp <url>`
  authenticates humans against an identity provider and issues short-lived, ledger-scoped bearers through an
  auth callout, in place of long-lived static credential files.

  - **owner+actor identity.** An instance's wire identity becomes the two-token principal `(owner, actor)`:
    every subject carries the sender as `<owner>.<actor>`, and grants, durables, presence, and `from.id`
    re-key onto the pair. Cross-owner and same-owner cross-actor forge/read isolation is enforced by the
    broker; the connection nkey survives only as the transport credential.
  - **Login and delegation.** Humans sign in with `cotal login --idp <url>` (device-code); operators grant
    access with `cotal actor grant`. Agents are spawned under the signed-in human as managed `(owner, actor)`
    children whose scope is a subset of the spawner's (the delegation envelope rule). Agent identities live in
    a separate managed-actor ledger space, exchanged via their own per-agent secret, so they outlive the
    human's login session.
  - **Credential death.** Every managed credential is now lifetime-bounded, with supervisor and delivery
    standing renewal, `$SYS` rotation-renewal, live connection eviction on revoke, and a `cotal doctor auth`
    repair surface. On a user-auth mesh, static agent creds are retired (the flip): revocation closes the live
    window at the next connect.
  - **Elevated operator surfaces.** `cotal web`, `console`, `history clear`, `channels set/default`, and
    `spawn -f` come online in user mode via server-authored elevated view bearers, minted only by the
    signed-in human exchange and gated on ledger scope (`admin` / `spawn`); `ps` and `status` are
    owner-domain scoped.
  - **Connectors.** Add the `cotal_docs` tool (version-exact Cotal docs the agent reads natively) and an
    opaque `launchOptions` raw passthrough for the Claude Code, OpenCode, and Hermes adapters.

## 0.10.0

### Minor Changes

- 6c40280: Release the 0.10 line with the onboarding and local-stack work since 0.9.1:

  - Rework the CLI around dispatcher-parsed commands, operator-installed extensions (`cotal ext`), and extension-packaged web/demo surfaces.
  - Make `cotal setup` configure-only: it checks prerequisites, installs the Claude plugin and web dashboard extension, seeds one default persona, and keeps the guided david/sven/me team behind `--demo` or `--full`.
  - Have `cotal up` own the local stack (broker, delivery daemon, and manager), with safer teardown, manifest launch handling, and automatic free-port selection for default-port collisions.
  - Collapse foreground and detached launches into one `spawn` grammar, with hardened manager readiness behavior and default persona / default agent environment overrides.
  - Strengthen auth, credential lifetime/rotation, delivery, and OpenCode cancellation handling.
  - Refresh README and getting-started onboarding around `npx cotal-ai setup`, then `cotal up --detach`, `cotal web`, `cotal spawn`, and `cotal down`.
