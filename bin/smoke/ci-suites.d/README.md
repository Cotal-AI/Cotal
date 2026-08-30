# CI suite fragments

Add each new `smoke:*` gate as its own `<topic>.txt` file containing exactly one script name.
Do not append to `../ci-suites.txt`; that list is frozen to preserve its positional shard assignments.

Fragment suites use a stable hash of the script name for sharding, so concurrent file additions and
filename ordering cannot move another suite between runners.
