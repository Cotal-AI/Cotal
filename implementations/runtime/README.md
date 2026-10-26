# @cotal-ai/runtime

The host that runs a cotal-lang program on the mesh: the effect handler, the durable step-journal
store, and the run driver. Importing it registers the `cotal run` command and the `run-host` the
manager drives runs through.

**Tier:** `implementations/` (a self-contained surface over core). Depends on core, lang, and
workspace. Implementations never import each other; they meet at runtime over NATS.

The manager hosts runs through the registered `run-host` by name and never imports this package.
The `cotal` binary imports it to get the `cotal run` command.

Besides the command and the host, the package exports the pieces a trusted embedding host uses:
`MeshHandler` (the effect handler over the mesh planes), `startRun` and `driveRun`, the
`RunJournalStore`, the migrate check (`migrateRun`) and its commit (`commitMigration`), and fork
planning (`planFork`, `commitFork`). Migration commit and fork have no CLI or MCP verb yet; only
the check is reachable, as `cotal run check <run-id> <file>`.

See [docs/workflows.md](../../docs/workflows.md) and the [root AGENTS.md](../../AGENTS.md) for the
tier rules.
