---
"@cotal-ai/lang": minor
"@cotal-ai/runtime": minor
"@cotal-ai/core": minor
---

The caller half of a durable spawn's physical working directory, pinned to one manager instance

A durable spawn can name a physical working directory with `cwd`, and doing so requires an explicit
`placement` target naming one manager instance as `{ endpoint, instanceId }`. A directory is
host-local, so a `cwd` with no target would ride the class anycast queue and land wherever the
anycast fell; that combination refuses rather than guessing, with no fallback. The target is
hashed into the step identity beside the directory, so a replay retargeted at a different instance
diverges as a migration instead of replaying a resolution taken against the old host. Logical
`worktree` keeps its meaning and its exclusivity, and a spawn that names neither option hashes
exactly the object it hashed before, byte for byte, so recorded runs replay unchanged.

**Explicit `cwd` placement does not resolve yet on a shipped manager, and refuses by name until it
does.** What ships here is the caller half: the language forwards and hashes the options, the
runtime asks its pinned target to state the directory's canonical form before it submits anything,
and the core grant builder mints the instance-pinned rails that ask would need. The question is
asked with a `resolve-cwd` command, and **no manager in this release serves `resolve-cwd`** — the
only servers of it are the smoke suites that grade this code. So on a real manager every explicit
`cwd` placement ends in a named refusal saying that this manager serves no `resolve-cwd` command
and can therefore state no canonical form. That is the intended direction and it is not a crash:
nothing is submitted, allocated or launched, and the caller is told why. A non-`ok` reply and a
reply whose path is not absolute are refused the same way. Until a manager serves the command,
treat `cwd` with `placement` as unavailable rather than as a directory that silently differs from
the one you named.

The grant surface and the serving surface are deliberately asymmetric, and it is worth stating
plainly: `runMediatorGrants` does mint the three placement capabilities (`describe`, `resolve-cwd`,
`spawn`) for the one named instance when a program names a target, bounded to that instance with
no anycast rail and no wildcard, but the manager's hosted-run credential minting never passes a
program's placement into it, so an authenticated hosted run receives none of those rows today. The
rails are built and graded; nothing production yet asks for them or answers them.

A malformed `placement` is now refused by name at the call. `placement: null` used to raise a raw
`TypeError` from inside the interpreter's identity projection, with no code, no effect kind and no
journal entry, because the option reader guarded the option bag being null rather than the value it
held. A primitive, an empty record and a half-filled record were quieter and worse: they were
forwarded, projected two undefined fields into the step identity, and the run carried on under an
identity describing a placement the program never named. All of these are now `L3048`, raised
before the step key is minted, so nothing is journalled and the repair is an edit to the program.
