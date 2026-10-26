---
"@cotal-ai/cli": patch
---

`cotal status` reports what is set up and what needs attention, not every known part

This machine listed one row per known agent application whether or not it was set up, every
extension with the same version spelled out on each, and the broker executable's bundled path on a
healthy machine. Brokers grouped the spaces under their broker addresses and repeated `not checked`
on every row that status does not dial.

This machine is now the version line, one Agent applications line naming what is set up with a count
of the others `cotal setup` adds, one Extensions line at the version they share, and the rows that
need attention: an application's own pieces when they are stale or failed, the broker executable when
it is missing or refused, the dashboard when its record cannot be read. Brokers becomes Spaces: the
space being reported first with its connection state, then one line per space with how it signs in,
one note that unselected spaces are not dialed, and one line per account whose space catalog could
not be refreshed, named by the account. `status --all` and the new `status --wide` report every row
in full. `--json` is unchanged apart from `meshes.catalogs[].account`, which the error line names.
