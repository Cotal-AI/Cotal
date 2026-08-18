---
"@cotal-ai/auth": patch
"@cotal-ai/connector-core": patch
---

Fix two refusals that told an operator to run a grant which silently widened the row

`cotal actor grant` is an upsert of the WHOLE row. Every flag the operator does not name is filled
from the wide default: `>` read, `>` post, `spawn,role:default` scope. Two refusals printed a
re-grant that named `--scope` and nothing else, so following either one reset the row's channel ACLs
to everything.

The elevated-view refusal is the sharper of the two. Asked for a view the grant lacks, it printed
`cotal actor grant <actor> --owner <owner> --scope <current+needed>` and called that "the upsert
replaces the scope list". An operator adding one view to a deliberately narrow row reset that row's
read and post sets to `>` and `>` in the same paste, and the same sentence sent them to
`cotal actor list` to confirm, where the widened row reads as confirmation that it worked. The row
is a human operator's, and the ACL is minted fresh at every connect, so it takes effect on the next
one with no restart.

The missing-spawner refusal has the longer reach. Repairing a broken delegation chain, it printed
`cotal actor grant <actor> --owner <owner> --scope spawn` and stopped, authoring a spawner that
reads and posts on every channel. A spawner's own ACL is the ceiling every agent beneath it is
attenuated against, so one pasted repair set a whole-plane ceiling for everything spawned under it
from then on.

The two doors now differ, on purpose. The elevated-view refusal has the row in hand, so it prints
every field it is replacing, values included. The two delegation refusals have no row to copy from,
so they print NO runnable command at all and name the flags and the wide default in prose instead:
a line carrying channel values would invent them, and a line short of all three flags widens on
paste. Both say what leaving a flag off means. `docs/cli.md` no
longer tells a reader that a re-grant adds to the current scope, the `cotal actor grant` usage line
now states what an omitted flag defaults to, and the two remaining hints that name a bare grant say
that it is the full envelope, matching the wording `cotal login` already used.

Both refusals are gated by cells that parse the service's own refusal string rather than matching a
hardcoded command, so the text and the assertion cannot drift apart, and a mutation per site reverts
each refusal to its shipped text and reddens that cell.

The strings are not new. Every release from v0.11.0 to v0.21.0 carries all three, which is the whole
life of the per-user actor ledger. Nothing about the on-disk row changes here, so no migration is
needed, but an operator who followed either refusal should check the affected rows with
`cotal actor list`: a widened row cannot be told from a deliberately full one, since the row records
only when it was granted, not what it held before.
