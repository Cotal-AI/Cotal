---
"@cotal-ai/connector-core": minor
---

Add the event channel, the durable substrate, and the emitter that publishes a frame.

The per-agent event channel is `events.<owner>.<actor>`, keyed on the principal. A display name is
not an identity: names may legally repeat, and they permit spaces, dots and mixed case, so a
name-keyed channel fuses distinct principals onto one subject and a grant minted from that value
authorizes both of them onto it. Keyed on the principal the mapping is injective by construction
rather than by digest length. Resolving a channel from a display name refuses an ambiguous name
instead of picking a match, because returning the first one shows one agent's stream under another's
name with nothing on the wire looking wrong.

The write-ahead log is one file and one state machine. It freezes the retry id, the expected subject
tip, the bracket state and the source cursor before a publish, so a restart re-publishes the same
frame rather than a new one, and a frame is either on the wire and folded into the frontier or on
neither. It refuses the states its own writer cannot produce, since those are the states corruption
produces.

The durable source returns a cursor per record rather than per read, so a crash between two records
of one batch resumes after the last record actually consumed.

The emitter reads that source forward from the WAL's cursor, packs records into frames that provably
fit, and appends them under an optimistic-concurrency expectation with a frozen dedup id. At startup
it reads the chat stream's replica count and refuses to run where the ordering its retry rule depends
on does not hold. A duplicate acknowledgement arriving on a retry is a halt, not a success: accepting
it would advance the frontier over a frame nobody received, and neither the wire nor the consumer's
sequence would show a gap.

Frame sizing is measured by the endpoint that builds the envelope and sets the headers, never
recomputed here. A splitter that sized a frame itself would be measuring the frame while the broker
measures the message, and the part it produced would be rejected, which turns a labelled truncation
back into a silent loss.

One emitter writes one principal's log, and that is enforced rather than described. The lock beside
the log is acquired and held for the life of the process, so a second start on the same principal is
refused by name; a lock whose recorded owner is provably gone is reclaimed, so one crash does not
leave a principal unstartable, and a record naming another host or naming nobody checkable is
refused rather than reclaimed on a guess. A lock cannot see a handle that predates it, so every
durable replace also carries a generation the writer bumps and verifies: a handle holding an older
view of the document is refused instead of overwriting a newer one. Without both, two logs opened on
one file let the loser rewrite a folded frontier to a subject sequence the broker never assigned,
which reads back as a healthy log and wedges every later publish. The document version moves to 3
for that generation; older documents migrate forward, and there is no downgrade.

Nothing in production emits yet: no connector constructs an emitter, and the transcript mirror is
untouched.
