# The late freshness run — reddened before it was allowed to pass, and the tree was already in the state

Written 2026-08-15 (`date -u`). The same predicate now runs at chain entry 1 and entry 206,
immediately after entry 205, the last entry that rebuilds core.

## The baseline was RED, and that is the finding

The first attempt at this demonstration ran the early check expecting green and got **FAILED**:

    ✗ FAIL: implementations/cli dist/ is 723s OLDER than src/.
          newest src:  implementations/cli/src/commands/status.ts

Nothing had been constructed yet. **The tree had been in the detected state for over an hour**, caused
by this lane's own mutation-proof runs: a mutation harness rewrites a source file, then restores it,
and the restore stamps the file with the current time. Every read of that package's `dist` in the
intervening window was reading an artifact older than the source it was supposed to represent.

**So the scenario this cell exists for is not hypothetical and was not constructed. It was already
true, in this tree, unnoticed, while other work was being reported as measured.** The cells run in
that window import `src` directly and were unaffected, but nothing said so at the time — that was
luck about which import style those cells happened to use.

It also meant the demonstration had to start over: **an already-red baseline cannot prove anything,
because red for an unrelated reason is not a kill.**

## The sequence, after a rebuild established a genuine green

    BASELINE   rebuild            rc 0
               early run          rc 0   OK   [at the START of the chain]
               late run           rc 0   OK   [AFTER the last mid-chain build]

    CONSTRUCT  append a mutant line to a source file, then restore it from a copy
               sha256 before   c34e30eda3460ede
               sha256 after    c34e30eda3460ede      identical
               git sees        0 modified files      content unchanged, mtime moved

    RED        late run           rc 1   FAILED, naming implementations/cli, 18s skew

    INVERSE    rebuild            rc 0
               late run           rc 0   OK

The construction reproduces the **mechanism** (a restore stamps the mtime), not merely the symptom
(the mtime moved). A bare `touch` would have produced the same red without showing why it happens.

All rc values read from EXIT-trap artifacts, never from a pipe.

## What the late run catches, stated narrowly

Nothing in a normal chain edits `src`, so this run is usually a no-op, and its green must not be read
as more. It catches `src` moving **while the chain runs** — realistically a mutate-and-restore — and a
mid-chain build that silently produced nothing for a package. From the moment `src` moves, every
remaining suite that reads `dist` is reading an artifact that no longer corresponds to the tree, and
the entry-1 run passed long before.

## What was NOT measured

**The chain was not run.** No gate ran and none was available. So the entry at position 206 has been
proven to redden and to pass, **in isolation**, and has NOT been observed executing in situ. Its
placement after 205 is verified statically — by reading each script body, not by matching on the
word `build`, which matches an entry that does not build.

The predicate is unchanged from the entry-1 run; only the position and the label differ. This run
therefore inherits every limitation already recorded in the file's header, including the one that
matters most: newest-mtime proves an **ordering**, not an **identity**, so a `dist` built from the
wrong source passes at both positions.
