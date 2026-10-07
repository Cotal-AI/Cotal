# Carrying a resumed session to another manager

> **Design** (non-normative) · Phase 1 for [#1499](https://github.com/Cotal-AI/Cotal/issues/1499).
> Measured against `22e210acd`. Status: the carry for `cotal spawn --resume <id> --detach --on <instance>`
> shipped in 0.67.0. Streaming over the same path (section 8) is not built, and #1499 stays open for it.

## 0. What this settles

| Question | Decision | Section |
|---|---|---|
| Where transcript bytes travel | A per-space JetStream Object Store, one bucket per target manager instance. Manager control requests never carry them, and the space's artifact store is not used | [3](#3-the-transfer-store) |
| How a payload larger than `max_payload` moves | Chunks of at most 128 KiB, lowered to fit the connection's `max_payload` | [4.1](#41-chunks) |
| How an interrupted transfer resumes | A chain of chunks on one stable subject per transcript, each publish pinned to the previous chunk's sequence; the stock `put` is not used to write | [4.2](#42-checkpoint-and-resume) |
| How long a transfer lives | Until the target stages it, or ten minutes after its last write. It is removed whole by the target manager; no message expires by age | [4.5](#45-retention) |
| How duplicates are decided | The object name is `sha256:<hex>`; the manager's private staging copy is the dedupe index, so a re-run moves zero bytes | [4.4](#44-hits), [5.2](#52-staging) |
| Who can read a transfer | Only the target instance, through grants that name its own bucket. The operator's writer is pinned to one object. Seats and peers hold nothing | [6](#6-grants) |
| How a launch names carried bytes | A one-time claim from an operator-only manager command; a transcript hash alone launches nothing | [5.3](#53-the-claim) |
| Where the transcript lands | A seat-private Claude config home, never the manager's shared Claude home | [7](#7-placement-a-seat-private-claude-home) |
| How that home keeps login working | An environment credential only; no stored login is copied or linked | [7.3](#73-login) |
| How plugins keep working | Unchanged: the cotal plugin and the mesh MCP server never load from the config home | [7.4](#74-plugins-settings-and-first-run-state) |
| Provenance | Source host, session id, title, transcript hash and transfer time on the seat's resume document; shown by `ps` and `attach` | [9](#9-provenance) |
| Which connectors | Claude only. Every other connector never receives a carried transcript | [10](#10-source-side) |
| Streaming | The same chunk chain read while it is written. Designed, not built here | [8](#8-streaming) |

## 1. What exists today

Measured at `22e210acd`.

**A detached resume carries an id, not a session.** `spawnDetached` forwards `--resume` to the manager
as a string (`implementations/cli/src/commands/spawn.ts:480`, "host-local session id"), and the
manager hands it to the connector (`implementations/manager/src/manager.ts:716`). The Claude connector
renders `--resume <id> --fork-session` (`extensions/connector-claude-code/src/extension.ts:316`), so the
id resolves in whatever Claude home the manager host runs with. A transcript that exists only on the
operator's machine cannot be resumed on a manager on another host. The issue's reproduction at this
base showed that, and a manual copy into the target's Claude home made the same launch work.

**The space already has an Object Store, and nothing reads or writes it.** Setup creates
`cotal_artifacts_<space>` with create-or-verify discipline (`packages/core/src/streams.ts:562`):
file storage, `discard: new`, `max_age: 0`, rollup headers allowed. `fromObjectStoreDigest`
(`packages/core/src/artifact.ts:54`) converts the store's `SHA-256=<base64url>` digest header to
Cotal's `sha256:<hex>`. No production code puts or gets bytes.

**The provisioner is deliberately kept off the store's data.** It holds `STREAM.CREATE`, `INFO` and
one `UPDATE` on `OBJ_cotal_artifacts_<space>`, and no consumer or publish grant, because the Object
Store client reads through a push consumer whose `deliver_subject` the caller chooses; a
`CONSUMER.CREATE` grant on the stream exports every object in it (`packages/core/src/provision.ts:2214-2221`).
No standing credential holds Object Store data grants.

**The pinned client cannot resume a failed put.** In `@nats-io/obj` 3.4.0
(`lib/objectstore.js`), `put` draws a fresh random NUID for every call (line 360), writes chunks to
`$O.<bucket>.C.<nuid>`, and on any error purges every chunk that call wrote (lines 463-465). A
second attempt starts from byte zero. `get` reads the meta record, creates a push consumer filtered
on `$O.<bucket>.C.<nuid>` (lines 554-557), and verifies the whole-object SHA-256 before it closes
the stream.

**Provenance has a home.** A resumed seat's fork record (`source`, `title`, `transcriptSha256`) is
read through `LaunchSpec.resumeRecordPath` (`packages/core/src/connector.ts:154`), kept on the seat's
resume document (`implementations/manager/src/resume.ts:90`), returned by `ps` as the `resume` object
(`implementations/manager/src/manager-service-contract.ts:249-257`, cluster document revision 20),
and printed as `forked from <id>` (`implementations/cli/src/commands/agents.ts:367`).

**Resume is an operator surface.** `cotal_spawn` does not expose it to peers
(`extensions/connector-core/src/tool-specs.ts:1350`). The manager's `spawn` row is in the
`manager.spawn` class, which a peer with the spawn capability holds.

**The Claude connector does not depend on the config home for its mesh surface.** The cotal plugin
loads with `--plugin-dir` (`extension.ts:245`), and MCP servers come only from `--mcp-config` under
`--strict-mcp-config` (`extension.ts:295`). Provider credentials reach the seat through the
forwarded environment keys (`CLAUDE_PROVIDER_KEYS`, `extension.ts:19`).

**Claude documents a per-directory home.** From Claude Code's own documentation, read on 2026-10-05:
each `CLAUDE_CONFIG_DIR` has its own settings, session history and login, and the credentials file and
the macOS Keychain entry are keyed to that directory. `CLAUDE_CODE_PROJECT_DIR_NAME`, set with
`CLAUDE_CONFIG_DIR`, pins the `projects/<name>/` directory transcripts are stored under, for "a host
that embeds Claude Code and gives each session its own config directory" (v2.1.234 or later).
`claude --resume <session-id>` looks in the current project and then in every other project under the
config directory, and the session picker widens to all projects with `Ctrl+A`. A transcript placed
anywhere in a shared home is therefore findable by every seat that runs in that home.

## 2. The flow

`cotal spawn --resume <id> --detach --on <instance>` on the host that holds the session:

1. The CLI resolves `--on` to a manager instance, as it does today.
2. The CLI asks its own Claude connector for the transcript of `<id>` on this host (section 10). None
   found: the launch proceeds as today and the id resolves on the manager's host. Found: the CLI reads
   the bytes once and computes `sha256` and `size`.
3. The CLI calls `transcript-receive` on the target instance with the digest, size, source id,
   source host and title. The manager creates or verifies its transfer bucket, then answers `staged`
   with a claim (a hit, zero bytes move) or `upload`.
4. On `upload`, the CLI writes the chunk chain and the commit into the target's bucket (section 4),
   continuing any chain an earlier attempt left, then calls `transcript-receive` again. It makes the
   same call when its commit is refused or the target removes its chain mid-write, and follows the
   answer (sections 4.2, 4.3).
5. The manager reads the committed object with the stock `get`, checks its digest against the
   requested `sha256`, stages it privately, deletes the broker object, and answers `staged` with a
   claim.
6. The CLI calls `spawn` with `resume: <id>` and `resumeClaim: <claim>`.
7. The manager consumes the claim, creates the seat's private Claude home, copies the staged
   transcript into it, and launches the connector's fork path there. The source transcript on the
   operator's host is only ever read.
8. When the seat records its fork, the manager checks that the fork record's `transcriptSha256` is
   the claimed digest and keeps the provenance on the seat's resume document.

## 3. The transfer store

### 3.1 Layout

| Item | Value |
|---|---|
| Bucket | `cotal_xfer_<space>_<instanceId>`, one per manager instance that receives a transfer |
| Backing stream | `OBJ_cotal_xfer_<space>_<instanceId>` |
| Subjects | `$O.cotal_xfer_<space>_<instanceId>.C.>` (chunks), `$O.cotal_xfer_<space>_<instanceId>.M.>` (meta) |
| Storage | file |
| Discard | `new` |
| `max_age` | `0`: no message expires by age, because a per-message age can drop the start of a chain and keep its end (section 4.5) |
| Rollup headers | allowed (the commit is a subject rollup) |
| Direct get | allowed (the hit check and the resume read use it) |
| `max_bytes`, `max_msgs`, `max_msg_size` | `-1`, so the broker's file store is the bound, as for the artifact store |

`<space>` is the space token the other per-space names use and `<instanceId>` is the lifecycle token
the manager lease key already uses (`managerLeaseKey`), so both are valid stream-name and subject
tokens. Core gains `transferBucket(space, instanceId)` beside `artifactBucket`, and the stream name
comes from the existing `objectStoreStream`.

The target manager creates or verifies its bucket on its first `transcript-receive`, with the
`ensureArtifactStore` discipline: create, read the config back, and refuse on drift. Space teardown
deletes every transfer bucket by name, enumerating the instance ids the space's manager records hold,
because these streams sit outside `cotal.<space>.>` and a prefix sweep cannot see them. The backup
inventory lists them as excluded: an object is deleted once staged and is not state to restore.

### 3.2 Why not the artifact store

The artifact store holds bytes that published `artifact` parts reference. It never deletes an object
whose reference may exist, and every reader the space admits will eventually read it. A carried
transcript is the opposite: private to one target, deleted once staged, never referenced by a
message. Sharing one bucket would make its grants serve both rules, and section 3.3 shows the grants
cannot separate objects inside one bucket.

### 3.3 Why one bucket per instance

The issue's rule is that only the target manager instance can read the object. A NATS grant matches
whole subject tokens, and inside one Object Store bucket nothing carries the target in a whole token:

- The meta subject is `$O.<bucket>.M.<base64url(name)>`. Any target prefix in the name is encoded
  into one token, so no wildcard can select it.
- `STREAM.MSG.GET` (the stock client's info read) and `STREAM.PURGE` (its delete) carry their subject
  filter in the request body, so a grant on either reaches every object in the stream.
- A `CONSUMER.CREATE` grant without a pinned filter exports the stream, which is the hazard the
  provisioner comment records.

A bucket per instance moves the partition to the stream name, where every grant names it. The
instance's reader can be given the whole of its own bucket and nothing else. The cost is one stream per
receiving instance and the teardown enumeration in section 3.1.

## 4. Chunk and checkpoint protocol

The writer is Cotal's own, because the stock `put` purges a failed upload and picks a random chunk
subject. It writes objects in the stock layout, so the stock `get` reads them.

### 4.1 Chunks

- The object name is the transcript's identity, `sha256:<hex>`.
- The chunk subject is `$O.<bucket>.C.<hex>`. The object's `nuid` field is the 64-character hex
  digest, a token Cotal sets in place of a random NUID, so every attempt at the same bytes writes the
  same subject.
- A chunk is at most 128 KiB, the stock default, lowered when the connection's `max_payload` minus
  4 KiB of header room is smaller. A resumed chain continues under its own connection's limit, so
  chunks need not be equal: the reader streams them in order and verifies the whole digest. The
  commit records the committing writer's limit in `options.max_chunk_size`, which the stock `get`
  does not read.
- Each chunk is a JetStream publish with three headers:
  - `Cotal-Offset`: the number of transcript bytes acknowledged through this chunk.
  - `Cotal-Chunk`: the number of chunks acknowledged through this chunk.
  - `Nats-Expected-Last-Subject-Sequence`: the stream sequence of the previous chunk on this subject,
    `0` for the first. The broker refuses a publish whose expectation does not hold.

The publish acknowledgement is the checkpoint. A chunk is acknowledged when the broker has stored it,
and the chain on the subject is the record of how far the upload got.

### 4.2 Checkpoint and resume

Before writing, the CLI reads the last message on the chunk subject with a last-by-subject direct get
(`$JS.API.DIRECT.GET.<stream>.<chunk subject>`). No message: start at byte 0 with expected sequence
`0`. A message: continue at its `Cotal-Offset` with its sequence as the expectation.

A refused expectation means another writer advanced the chain or the target removed it (section 4.5).
The writer reads the last chunk again. When a chunk is left it continues from there: the subject is
derived from the digest of the bytes, so both writers are writing the same bytes. When no chunk is
left, the target removed the transfer, and only the target knows whether it staged the bytes first,
so the writer calls `transcript-receive` and follows its answer (section 4.3). A transcript that
changed between attempts has a different digest and therefore a different subject; it never extends
the old chain.

Nothing on the source host records a checkpoint. The broker's chain is the only state, so an attempt
from another terminal, or after a reboot, resumes from the same place while the target keeps the chain
(section 4.5).

### 4.3 Commit

When `Cotal-Offset` reaches the size, the writer publishes the meta record on
`$O.<bucket>.M.<base64url("sha256:<hex>")>`, padded as the stock client encodes it, in the stock
shape: `bucket`, `name`, `nuid`, `size`, `chunks` (the last `Cotal-Chunk`), `mtime`, `deleted: false`,
`options.max_chunk_size`, and `digest` as `SHA-256=<base64url>` of the whole transcript. The publish
carries `Nats-Rollup: sub`, as the stock client's does, and `Nats-Expected-Last-Subject-Sequence` set
to the meta subject's last sequence as the writer's hit check read it: `0` when there was no record,
or the sequence of the delete marker a previous removal left (the stock `delete` writes one and
purges the chunks). Only one commit lands.

Whether its commit lands or is refused, the writer then calls `transcript-receive`, and that answer
ends the write: `staged` carries a claim, and `upload` means the target removed the transfer without
staging it, so the writer starts again at section 4.2, reading the chain and the meta subject's
sequence afresh. A refused writer does not decide from the record, because by the time it reads it
the target may have staged the winning commit and removed it, leaving a delete marker.

The meta record is a claim made by the writer. The reader does not stage bytes on its word: the stock
`get` recomputes SHA-256 over the chunks it streams, and the manager then compares the record's digest,
converted with `fromObjectStoreDigest`, to the `sha256` the operator asked for.

### 4.4 Hits

A hit is checked twice before any chunk is written:

1. The manager's staging index (section 5.2), through `transcript-receive`. This is the hit a re-run
   takes: the broker object was deleted after the first run, and the staged copy remains.
2. A live meta record in the target's bucket, read with a direct get on the meta subject. The writer
   then calls `transcript-receive` instead of writing: another writer's commit landed after the
   target answered `upload`.

### 4.5 Retention

A transfer is the chain on `$O.<bucket>.C.<hex>` together with the meta record named `sha256:<hex>`.
It is removed only whole, and only by the target manager:

- A whole removal is the stock `delete` when the transfer has a live meta record (the delete marker,
  then one filtered `STREAM.PURGE` of the chunk subject the record names). When the record is a delete
  marker, or there is none, it is that purge alone, issued only when the chunk subject holds a
  message. One purge removes every chunk on the subject, so a chain either starts at its first chunk
  or is empty.
- A transfer with no live record and no chunk is already removed, and nothing is written for it. The
  stock `delete` of a deleted record publishes another marker, so repeating it would move the stream
  on every staged hit (hand test H2).
- The manager sweeps its bucket at the start of every `transcript-receive`, when it starts, and at the
  next deadline. It lists the bucket's subjects with `STREAM.INFO` and `subjects_filter`, reads the
  last message of each, and removes a transfer whole when its bytes are already staged or its last
  write is older than ten minutes. An `upload` answer sets a deadline ten minutes later, and a
  transfer the sweep leaves in place, other than one already removed, sets one ten minutes after its
  last write.
- A writer whose chain was removed has its next publish refused and calls `transcript-receive`
  (section 4.2), which answers `staged` when the bytes were staged before the removal and `upload`
  when the chain was abandoned.
- A sweep can remove a chain after its last chunk and before its commit. The commit then names chunks
  that do not exist, and the stock `get` of such an object waits for them and never returns. Before
  fetching, the manager therefore counts the messages on the chunk subject the record names, with
  `STREAM.INFO` and `subjects_filter`. A committed object whose count differs from the record's
  `chunks`, or that the stock `get` or the digest check refuses, is removed whole and the receive
  answers `upload`.

A transfer therefore lives until its bytes are staged, or ten minutes after its last write. While the
target manager is down nothing removes any part of it. A skewed manager clock moves when a whole
transfer is removed and never removes part of one.

## 5. Manager surface

### 5.1 `transcript-receive`

A new row in the `manager.admin` class, minted into the operator instruments only:

- Input: `sha256` (64 lowercase hex), `size`, `source` (the session id), `sourceHost`, and `title`
  when the source has one.
- Output: `{ state: "upload" }` or `{ state: "staged", claim, fetched }`.

The handler creates or verifies the instance's bucket, sweeps it (section 4.5), then answers in this
order:

1. A staged copy of that size is present: `staged` with `fetched: false`. The sweep has already
   removed any object of those bytes, including one a crash between staging and deletion left.
2. A committed object is present: fetch it, verify it, stage it, remove it whole, and answer `staged`
   with `fetched: true`. An object whose chunk count differs from its record, or that the stock `get`
   or the digest check refuses, is removed whole and the answer is `upload` (section 4.5).
3. Otherwise `upload`.

A removal that fails fails the receive with the broker's error, and no claim is issued; the next
sweep removes the object. The manager runs one `transcript-receive` or sweep at a time, so two
receives of one digest never fetch, stage or remove it together, and the second takes the staged
hit. The manager cluster document moves to revision 21.

### 5.2 Staging

Staged transcripts live at `<root>/.cotal/transcripts/<hex>`, mode `0600` in a `0700` directory, where
`<root>` is the manager's workspace root. A fetch writes a temporary file named for the instance and
unique to that fetch, checks the digest, and renames it to `<hex>`. A rename that replaces a staged
copy replaces it with the same verified bytes, so the managers of two spaces that share a root still
publish one correct copy. A manager removes its own instance's leftover temporary files when it
starts. No seat reads this directory: placement copies out of it. The staged copy is kept so a re-run
moves zero bytes, and the broker object is removed once the copy is renamed into place, which meets
the issue's rule that the transfer object does not outlive its delivery. Staged copies have no
automatic expiry in this change (section 13).

### 5.3 The claim

`spawn` gains `resumeClaim`. A claim is 128 random bits issued by `transcript-receive`, held in the
manager's memory, bound to the `sha256`, `source`, `sourceHost`, `title` and the staging time, valid
for ten minutes, and consumed by the `spawn` that names it. `spawn` refuses a claim that is unknown,
expired, consumed, or bound to a source other than `resume`. A manager restart drops outstanding
claims; a re-run receives a new one from the staged copy and moves no bytes.

The claim is needed because `spawn` is a `manager.spawn` row, which a peer can hold, and `ps` shows
transcript hashes. If a digest alone could launch a carried session, any peer that can read `ps` and
spawn could open a seat on another operator's transcript. Only a caller of an operator-only row can
obtain a claim, and the manager never logs one.

## 6. Grants

| Credential | On the transfer store | Pinning |
|---|---|---|
| Operator transfer instrument (one-shot, per CLI call) | Publish `$O.<bucket>.C.<hex>` and `$O.<bucket>.M.<base64url(name)>`; `$JS.API.DIRECT.GET.<stream>.` followed by each of those two subjects | One instance (`--on`), one object. Minted after the CLI has computed the digest |
| Target manager transfer reader (one-shot, per `transcript-receive` or sweep) | `STREAM.CREATE` and `INFO` on its own stream; `CONSUMER.CREATE` on its own stream; `STREAM.MSG.GET` and `STREAM.PURGE` on its own stream; publish `$O.<bucket>.M.>` for the stock delete marker | One instance, its own bucket. A local manager mints it from the host's signing seed, as it mints its provisioner; a remote manager receives it over its authenticated provisioning protocol, as it receives its other exact one-shot grants |
| Space teardown | `STREAM.INFO` and `DELETE` on each enumerated transfer stream | By name |
| Every other credential, including seats, the spawn capability, the supervisor, other instances' readers, and the provisioner | Nothing that names `OBJ_cotal_xfer_` or `$O.cotal_xfer_` | |

The reader's push consumer delivers to its own `_INBOX_<connId>` subjects. A caller-chosen
`deliver_subject` can only export the reader's own bucket, which is the data it is entitled to read.

## 7. Placement: a seat-private Claude home

### 7.1 Where

The manager creates `<root>/.cotal/seat-homes/<lifecycleUid>/`, mode `0700`, for a launch that carries
a claim, and passes it to the connector in `LaunchOpts` together with the staged file. The connector
copies the staged transcript to `<home>/projects/seat/<id>.jsonl` (mode `0600`) and launches with:

- `CLAUDE_CONFIG_DIR=<home>` and `CLAUDE_CODE_PROJECT_DIR_NAME=seat`, which pin where Claude stores
  and finds this seat's transcripts;
- the argv it renders today, `--resume <id> --fork-session`.

The home lives for the seat's lifecycle, including supervised restarts, and the manager removes it
when the seat is despawned. A refused launch removes it before returning. The connector refuses a
carried launch when `claude --version` is below 2.1.234, where `CLAUDE_CODE_PROJECT_DIR_NAME` is
ignored.

### 7.2 Why not the manager's shared Claude home

In the shared home, `claude --resume <id>` from any seat on the host finds the placed transcript (the
lookup searches every project in the config directory), the picker lists it, and the seat's fork is
written beside it, findable the same way. The issue's rule is that no peer can fetch another seat's
transcript, so placement there is refused by design, whatever directory inside the home it uses.

### 7.3 Login

A seat-private home holds no login, and this design does not give it one. The seat authenticates with
an environment credential the connector already forwards:

- `CLAUDE_CODE_OAUTH_TOKEN`, the one-year token `claude setup-token` prints; or
- `ANTHROPIC_AUTH_TOKEN`; or
- a cloud provider selection (`CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`,
  `CLAUDE_CODE_USE_FOUNDRY`, `CLAUDE_CODE_USE_ANTHROPIC_AWS`, `CLAUDE_CODE_USE_MANTLE`) with its
  credentials.

A carried launch whose manager environment carries none of these is refused before the claim is
consumed, with the remedy: run `claude setup-token` and set `CLAUDE_CODE_OAUTH_TOKEN` in the manager's
environment. `ANTHROPIC_API_KEY` alone is refused too: Claude asks once to approve a key and remembers
the answer in its config home, so a fresh home asks again and nothing would answer.

The stored login is never copied or linked into the seat home:

- Claude documents one login per config directory and keys the macOS Keychain entry to the directory,
  so there is no file to copy on macOS and no supported way to share one.
- A copy of a refreshable login has two holders, each able to refresh it, and the seat home is a
  directory the manager deletes.
- A link into the shared home would let the seat's Claude write the operator's login.

The setup token only makes model requests: it cannot open Remote Control or fetch claude.ai
connectors. A mesh seat needs neither; its tools come from the local MCP server.

### 7.4 Plugins, settings and first-run state

The mesh surface does not change. The cotal plugin loads with `--plugin-dir` and MCP servers come only
from `--mcp-config` under `--strict-mcp-config`; neither reads the config home.

Nothing else from the operator's shared home is carried: installed plugins and marketplaces, user
`settings.json`, user `CLAUDE.md`, agents and skills. A carried seat runs the mesh persona and the
carried conversation. Carrying operator configuration would make each seat home a partial mirror of the
shared one, and the launch already scopes MCP servers to the mesh for the same reason.

A fresh config home starts Claude's first-run setup and asks to trust the working directory. The
connector writes `<home>/.claude.json` with two facts: onboarding is complete, and the launch `cwd` is
trusted when, and only when, the Claude home the manager's environment names already trusts it. An untrusted `cwd` is
refused with the remedy of opening `claude` in that directory on the manager host once. A seat
launched in the shared home is refused the same way, so the rule keeps parity and grants nothing
new. The keys are internal to Claude, so the connector pins them to its supported Claude
range, and hand test H6 proves a carried seat reaches its first turn with no prompt.

### 7.5 What this boundary is

The boundary is Claude's session index and Cotal's own surfaces. No other seat's Claude lists, finds or
writes this transcript, no mesh credential other than the target's can read the broker object, and no
peer can obtain a claim. Seats on one host run as one OS user, so a process that deliberately opens
another seat's home by path can read it. That holds today for the operator's whole shared home, and
separating seats by OS user is a runtime decision outside this change.

## 8. Streaming

The chunk chain is also the streaming path. A reader that creates an ordered consumer on
`$O.<bucket>.C.<hex>` before the commit receives each chunk as the broker acknowledges it, in order,
with JetStream flow control and idle heartbeats. The commit record ends the stream and gives the
reader the digest to verify against. A reader that joins late replays from the first chunk, because
the stream keeps the whole chain until the transfer is staged or abandoned (section 4.5).

The consumers that would use it are oversized inbox messages (#613, which also needs final-slice-only
acknowledgement), large tool output, and attachments on DMs and channel posts. Each brings its own
read grants: a channel attachment is readable by the channel's members, which the per-instance
transfer bucket does not model. None of them is built in this change, and #1499 stays open for them.

## 9. Provenance

The seat's resume document keeps today's `source`, `title` and `transcriptSha256`, and a carried
launch adds `sourceHost` (from the claim) and `transferredAt` (the staging time of those bytes, so a
re-run that moved nothing still names when they arrived). The `ps` row's `resume` object gains
`host` and `transferredAt`, which is a changed output contract and part of revision 21.

When the seat writes its fork record, the manager compares its `transcriptSha256` to the claimed
digest. A different digest means the seat forked bytes the operator did not carry; the manager stops
the seat and records the refusal.

Operator output:

- `cotal ps --wide`: `forked from <host>:<id> "<title>" sha256:<hex> carried <time>`.
- `cotal attach`: `attached to <name> (resumed from <host>:<id>) - <key> to detach`.

Two forks of one title on a target are two seats with two fork ids, and `ps` lists both with their
provenance.

## 10. Source side

The connector declares where its transcripts live with an optional `resumeTranscript` locator on
`Connector`. Claude implements `find(id, env)` over `<config>/projects/*/<id>.jsonl`, the layout Claude
documents, and keeps the refusals the withdrawn implementation was reviewed into:

- regular files only, and a link cycle in the projects tree is skipped;
- an id held by two different transcripts is refused;
- a session name passed in place of an id is refused, listing each session on this host that carries
  it with host, id, SHA-256 and modification time, so the operator resumes by id.

A connector without the locator (jcode, OpenCode, Hermes, Codex, pi) never receives a carried
transcript: the CLI does not look for one, the id resolves on the manager's host as it does today,
and the manager refuses a `resumeClaim` for that connector. When the CLI cannot load its connector it
refuses, because only the connector can tell a local session from one that lives on the manager's
host. The CLI looks with `--agent`, else the default agent, and sends that agent as `resumeAgent`;
the manager refuses a launch that resolves a different connector, such as a persona pinned to another
agent.

The CLI prints `carried session <id> to <instance>: sha256:<hex>, <sent> of <size> bytes sent in
<chunks> chunks`, with `<sent>` and `<chunks>` zero on a hit and the remainder after a resumed chain.

## 11. What changes where

| Place | Change |
|---|---|
| `packages/core` | `transferBucket`; the chunk writer, resume read, commit and hit read; the transfer instrument and transfer reader grant sets; the `transcript-receive` row in the admin instrument set; `Connector.resumeTranscript` and the carried-launch fields on `LaunchOpts` |
| `implementations/manager` | `transcript-receive` and its sweep, staging, claims, seat-home lifecycle, the provenance check, revision 21 |
| `implementations/cli` | The carry step in `spawnDetached`; provenance in `ps` and `attach` |
| `extensions/connector-claude-code` | The locator, the seat-home launch, the login and first-run checks |
| `SPEC.md` | Section 8: the transfer bucket and the chunk chain headers. Section 9 and Appendix B: the two new credentials. Section 13: the new row and the `spawn` and `ps` fields |
| `docs/` | `connect-claude.md` (resume across hosts, the login requirement), `cli.md`, `control-surface.md`, `security.md` (the boundary in 7.5), `UPGRADING.md` (a carried resume needs a manager and credentials from this release) |

The changeset is a minor bump: `spawn` and `ps` contracts change, and a new manager row and two new
credentials ship.

## 12. Acceptance: hand tests

An operator runs these live against two hosts, A (holds the session) and B (runs the target manager),
on one broker. Each records the command, the output lines named, and the broker evidence. A carried
seat's "source context" is checked by asking it a question only the source conversation answers.

| Test | Steps | Pass when |
|---|---|---|
| H1, larger than `max_payload` | Broker with `max_payload: 65536`. On A, a Claude session whose transcript is at least 4 MiB. `cotal spawn --resume <id> --detach --on <B instance>` | The seat joins on B and answers from the source context; the CLI reports all bytes sent in more than 64 chunks; `ps --wide` on A shows `forked from <A host>:<id>`; B's bucket holds no object after staging |
| H2, re-run moves zero bytes | Repeat H1's command | The CLI reports `0 of <size> bytes sent`; a second seat joins with a different fork id; the transfer stream's last sequence did not move |
| H3, interrupted transfer resumes | Repeat H1 with a new session; kill the CLI after at least 10 acknowledged chunks; run the command again | The second run sends `<size> - <offset>` bytes, where `<offset>` is the last chunk's `Cotal-Offset`; the commit verifies; the seat forks the source |
| H4, a seat cannot read another seat's transcript | With H1's seat S1 live, launch S2 on B without a claim | From S2's environment, `claude --resume <source id>` and `claude --resume <S1 fork id>` report no conversation found; S2's credential is refused `CONSUMER.CREATE` and direct get on B's transfer stream; a raw `spawn` from S2's credential with S1's `resumeClaim` or a fabricated one is refused; a second manager instance's reader is refused on B's stream |
| H5, title-only resume | On A, two sessions carry one name. `cotal spawn --resume <name> --detach --on <B instance>` | The CLI refuses and lists both with host, id, SHA-256 and modification time; after carrying both by id, `ps` on B lists two seats with distinct fork ids and provenance |
| H6, the seat home starts clean | H1's seat, then a launch with no environment credential, then one with only `ANTHROPIC_API_KEY`, then one whose `cwd` the manager's Claude home does not trust | H1's seat reached its first turn with no login, onboarding or trust prompt; each of the three is refused before the claim is consumed, naming its remedy |
| H7, unsupported connector | `--agent jcode` (and each other connector without the locator), then a raw `spawn` naming that agent with a valid `resumeClaim` | The CLI moves no byte and the id resolves on B as it does today; the raw `spawn` is refused |
| H8, retention follows the transfer | Repeat H3's interruption with a new session and run the command again within ten minutes. Then interrupt a carry of another new session the same way, wait more than ten minutes, and run that command again | The first resumed run sends `<size> - <offset>` bytes. Before the second rerun, B's transfer stream holds no message on that chain's chunk subject; the rerun sends all `<size>` bytes and the commit verifies |
| H9, concurrent carries and a leftover object | From two terminals on A, run H1's command for one new session at the same moment. Then, for another new session, run the command in one terminal, stop it with `SIGSTOP` after at least 10 acknowledged chunks, run the same command to completion in the other terminal, and resume the stopped one with `SIGCONT`. Then put H1's transcript bytes into B's bucket under the name `sha256:<hex>` with an admin credential (`nats object put`), the state a manager crash between staging and removal leaves, and repeat H1's command | All four carries launch a seat, with distinct fork ids; the resumed run reports fewer than `<size>` bytes sent; B's staging directory holds one `<hex>` per session and no temporary file; the repeated run reports `0 of <size> bytes sent` and B's bucket then holds no live object |

## 13. Not in this change

- Streaming consumers (section 8): #613's inbox half, tool output, and attachments.
- The issue's committed smokes and mutation proofs. This change is accepted by the hand tests in
  section 12; the issue stays open for the committed suites.
- Expiry of staged copies. They are kept so a re-run moves zero bytes, and a time limit would make that
  depend on when it runs. Pruning is a later operator command.
- Separating seats on one host by OS user (section 7.5).
- Moving a live seat between managers (#783) and syncing a fork back to its source, which the issue
  places out of scope.

## 14. For the operator

1. The login rule in 7.3 means a manager host that resumes carried sessions needs
   `CLAUDE_CODE_OAUTH_TOKEN` (or a provider credential) in its environment. Interactive `/login` on that
   host does not reach a seat-private home.
2. The first-run seeding in 7.4 writes two Claude-internal keys. If a Claude release moves them, carried
   launches fail H6 until the connector follows; they do not fall back to the shared home.
