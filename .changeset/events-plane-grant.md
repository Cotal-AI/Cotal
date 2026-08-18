---
"@cotal-ai/core": minor
"@cotal-ai/connector-core": minor
"@cotal-ai/workspace": minor
"@cotal-ai/cli": minor
"@cotal-ai/manager": minor
"@cotal-ai/connector-claude-code": minor
---

Give a session's structured event plane a way to be turned on, and a channel that names who is publishing.

An agent can now be launched with `cotal spawn --events`, foreground or detached, which publishes
that session's structured event stream, what it did rather than the prose it wrote, on a channel of
its own so an external observer or UI can read it. Off by default. Nothing about an existing launch
changes.

**The channel is named after the principal, never the display name.** It is `events.<owner>.<actor>`,
derived from the principal the manager actually allocated. A display name is UI convenience: this
mesh permits two live agents to carry one, and the manager itself auto-numbers a collision, so a
name-keyed channel would fuse two principals onto one subject and, in auth mode, would authorize both
onto it from a value that identifies neither. The derivation is a single function on the connector
contract, `eventChannel`, so the subject the manager grants and the subject the session publishes to
cannot drift apart. A connector that does not implement it refuses `--events` before any provisioning
rather than starting a session whose events have nowhere legal to land, and the refusal releases the
name it had already reserved.

**The flag and the grant are deliberately separate.** Holding publish rights on a channel is not a
request to publish to it. An agent file or a manifest can hand-write anything into `allowPublish`, so
if a grant could arm the plane, any author who could write an agent file could turn on a full
transcript of another seat's tool inputs and outputs without ever touching the launch grammar. Only
the launch arms the session; the grant is what makes the arming useful. `cotal_spawn`, the peer-facing
tool, does not expose the option at all, because arming another agent's plane needs an admin precheck
ahead of connector resolution and that precheck does not exist yet.

**The flag rides the whole launch path, including the record a restart reads.** It is on the
foreground launch, the detached spawn payload, the manager service contract, and the resume document,
so a manager restart brings an armed session back armed. The foreground path mints its own grant, from
the principal it allocated, and passes the workspace root the emitter's write-ahead log needs: a
session armed by one launch surface and not the other would be a flag that means two different
things. A resume adopts the credential the spawn wrote rather than minting a new
one, so what a restart can lose is the record: either the channel leaves `allowPublish`, or the
arming flag does and the session returns holding publish rights it will never use, which reads as a
working system with an empty panel. Both halves are now carried and both are asserted.

**One behaviour change to state plainly.** The foreground launch now passes the mesh's root as the
launch's workspace root, on every foreground spawn rather than only on an armed one, which is what the
manager has always done. One connector already reads that field: the Codex connector roots its
per-agent home at it, and previously fell back to the directory the operator happened to run the
command in. A foreground Codex session therefore moves its home from that directory to the mesh root,
which is where its detached counterpart has always put it. Operators who ran `cotal spawn` from
somewhere other than the mesh root will find that session's local state under the mesh root instead.

**Supporting pieces in the shared connector runtime.** The event vocabulary is exported from
`@cotal-ai/connector-core` for the first time, so a connector can reach it by package name instead of
by deep path. The emitter gained a way to close an open run out of band: a harness reports the end of
a turn through a lifecycle hook that writes no record, so a record-sourced stream previously had no
vehicle for a turn terminal. The closing frame is an ordinary frame with one exception, it republishes
the source cursor unchanged, because advancing it would mark records consumed that were never mapped
and leave a consumer no gap to notice it by. The emitter refuses to close while a message or a tool
call is still open under the run, while a frame is still pending recovery, and after a halt.

**One pre-existing limit this makes visible earlier.** In user mode the allocated actor is the display
name, and principal tokens forbid `-`, which is reserved as the principal name form's separator. The
manager's collision handling appends `-2`, so the second user-mode launch of any persona has never
been principal-keyable; it already failed at the identity and provisioning sites. The event grant is
derived before provisioning, so that launch now fails before it leaves a footprint rather than after.
The underlying naming limit is unchanged and is not addressed here.
