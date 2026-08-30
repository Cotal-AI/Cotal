# CI suite fragments

Add each new `smoke:*` gate as its own `<sha256(suite-name)>.txt` file containing exactly that one
script name. Derive the filename from the full public suite name; do not choose a shared topic slug.
Do not append to `../ci-suites.txt`; that list is frozen to preserve its positional assignments.

Fragment suites use a stable hash of the script name for sharding, so concurrent file additions and
filename ordering cannot move another suite between runners.

Run `pnpm smoke:ci-fragments`, `pnpm smoke:gate-inventory`, and
`pnpm check:shard-stability <base-sha> <head-sha>`. The shard verifier compares both the frozen
positional list and fragment hash assignments. CI also checks every committed fragment blob
immediately before the shard runner starts.
